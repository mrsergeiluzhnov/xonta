// Xonta Gate - a seatbelt for any MCP server.
// Sits between an MCP client (Claude Desktop, Cursor, your own agent) and an upstream MCP server and:
//  - scans tool descriptions for hidden instructions and blocks high-risk tools;
//  - notices when tool descriptions change mid-session (rug pull) and freezes actions;
//  - counts "actions" (tools that change things: delete, send, pay...) against a budget per period, over the
//    budget the call is refused with "needs a human";
//  - rate-limits every tool;
//  - flags hidden commands in tool outputs, and after a few of them stops allowing actions;
//  - writes a signed, hash-chained audit log that can be verified later (xonta-gate verify).
// It never rewrites tool output and never runs anything by itself, it only allows, refuses and records.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { analyzeTools, toolsFingerprint } from "./scan.js";
import { hasInjection } from "./guardian.js";
import { jcs, sha256hex } from "./crypto.js";

export const ACTION_WORDS = /(^|[_\-.\s])(create|delete|remove|update|write|send|post|pay|payment|refund|transfer|execute|exec|run|deploy|merge|push|drop|insert|modify|edit|move|rename|commit|publish|charge|cancel|approve|purchase|buy|order|invite|share|upload|kill|terminate|destroy|reset|set)([_\-.\s]|$)/i;
export const DEFAULT_POLICY = {
  period_seconds: 3600,        // budget period
  actions_per_period: 20,      // how many "action" calls are allowed per period without a human
  rate_per_minute: 60,         // any tool
  block_high_risk: true,       // tools whose descriptions show high-risk hidden-instruction signs are hidden and refused
  freeze_on_change: true,      // tool descriptions changed mid-session -> actions are refused until restart / review
  injections_to_freeze: 3,     // hidden commands seen in outputs before actions are refused
  tools: {},                   // per tool: { allow: false } | { action: true|false, max_per_period: n, rate_per_minute: n }
};
const log = (...a) => process.stderr.write(`[xonta-gate] ${a.join(" ")}\n`);

// ---------- signed, hash-chained audit log ----------
export function openAudit(dir) {
  mkdirSync(dir, { recursive: true });
  const keyFile = join(dir, "gate-key.pem"), file = join(dir, "audit.jsonl");
  if (!existsSync(keyFile)) { const { privateKey } = generateKeyPairSync("ed25519"); writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" })); try { chmodSync(keyFile, 0o600); } catch {} }
  const priv = createPrivateKey(readFileSync(keyFile)), pub = createPublicKey(priv).export({ type: "spki", format: "pem" });
  writeFileSync(join(dir, "gate-key.pub.pem"), pub);
  let prev = "0".repeat(64), seq = 0;
  if (existsSync(file)) { const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean); if (lines.length) { const last = JSON.parse(lines.at(-1)); prev = last.hash; seq = last.seq; } }
  return {
    file, pub,
    write(entry) {
      const body = { seq: ++seq, ts: new Date().toISOString(), ...entry, prev };
      const hash = sha256hex(jcs(body)), sig = sign(null, Buffer.from(hash, "hex"), priv).toString("base64");
      appendFileSync(file, JSON.stringify({ ...body, hash, sig }) + "\n"); prev = hash;
      return body;
    },
  };
}
// checks every entry: hash matches content, chain is unbroken, signature is valid
export function verifyAudit(file, pubPem) {
  const pub = createPublicKey(pubPem), lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  let prev = "0".repeat(64), seq = 0;
  for (const [i, l] of lines.entries()) {
    const { hash, sig, ...body } = JSON.parse(l);
    if (body.prev !== prev) return { ok: false, at: i + 1, why: "chain broken (an entry was removed or reordered)" };
    if (body.seq !== seq + 1) return { ok: false, at: i + 1, why: "sequence gap" };
    if (sha256hex(jcs(body)) !== hash) return { ok: false, at: i + 1, why: "entry was changed after it was written" };
    if (!verify(null, Buffer.from(hash, "hex"), pub, Buffer.from(sig, "base64"))) return { ok: false, at: i + 1, why: "bad signature" };
    prev = hash; seq = body.seq;
  }
  return { ok: true, entries: lines.length, last_hash: prev };
}

// ---------- policy decisions (pure, testable) ----------
export function createPolicy(policy = {}) {
  const P = { ...DEFAULT_POLICY, ...policy, tools: { ...(policy.tools || {}) } };
  const calls = new Map(), actions = [], perTool = new Map();
  const state = { frozen: null, injections: 0, fingerprint: null, hidden: new Map(), tools: [] };
  const isAction = (name) => (P.tools[name]?.action ?? ACTION_WORDS.test(name));
  function setTools(tools, now = Date.now()) {
    const fp = toolsFingerprint(tools);
    const changed = state.fingerprint && state.fingerprint !== fp;
    if (changed && P.freeze_on_change) state.frozen = { why: "tool descriptions changed during the session", at: now };
    state.fingerprint = fp;
    const { findings } = analyzeTools(tools);
    state.hidden = new Map();
    if (P.block_high_risk) for (const f of findings) if (f.severity === "high" && P.tools[f.tool]?.allow !== true) state.hidden.set(f.tool, f.rule);
    for (const [name, cfg] of Object.entries(P.tools)) if (cfg.allow === false) state.hidden.set(name, "denied by policy");
    state.tools = tools;
    return { changed, findings, hidden: [...state.hidden.entries()].map(([tool, why]) => ({ tool, why })), visible: tools.filter((t) => !state.hidden.has(t.name)) };
  }
  function decide(name, now = Date.now()) {
    if (state.hidden.has(name)) return { allow: false, reason: `tool is blocked (${state.hidden.get(name)})`, kind: "blocked" };
    if (!state.tools.some((t) => t.name === name)) return { allow: false, reason: "unknown tool", kind: "blocked" };
    const cfg = P.tools[name] || {}, rate = cfg.rate_per_minute ?? P.rate_per_minute;
    const w = (calls.get(name) || []).filter((t) => now - t < 60_000);
    if (w.length >= rate) return { allow: false, reason: `rate limit ${rate}/min`, kind: "rate" };
    const action = isAction(name);
    if (action) {
      if (state.frozen) return { allow: false, reason: `actions frozen: ${state.frozen.why}. A human has to review and restart the gate`, kind: "frozen", action };
      const since = now - P.period_seconds * 1000, used = actions.filter((x) => x.t > since), mine = used.filter((x) => x.name === name);
      if (used.length >= P.actions_per_period) return { allow: false, reason: `action budget used up (${P.actions_per_period} per ${P.period_seconds}s). Needs a human to approve or raise the budget`, kind: "budget", action };
      if (cfg.max_per_period != null && mine.length >= cfg.max_per_period) return { allow: false, reason: `budget for this tool used up (${cfg.max_per_period} per period). Needs a human`, kind: "budget", action };
    }
    return { allow: true, action };
  }
  function record(name, d, now = Date.now()) {
    if (!d.allow) return;
    calls.set(name, [...(calls.get(name) || []).filter((t) => now - t < 60_000), now]);
    if (d.action) actions.push({ name, t: now });
    perTool.set(name, (perTool.get(name) || 0) + 1);
  }
  function sawOutput(text) {
    if (!hasInjection(text)) return false;
    state.injections++;
    if (state.injections >= P.injections_to_freeze && !state.frozen) state.frozen = { why: `${state.injections} hidden commands seen in tool outputs`, at: Date.now() };
    return true;
  }
  const summary = () => ({ frozen: state.frozen, injections: state.injections, fingerprint: state.fingerprint, hidden: [...state.hidden.entries()], actions_in_period: actions.filter((x) => x.t > Date.now() - P.period_seconds * 1000).length, budget: P.actions_per_period, calls: Object.fromEntries(perTool) });
  return { P, isAction, setTools, decide, record, sawOutput, summary, state };
}

// ---------- upstream ----------
async function connectUpstream({ url = null, command = null, args = [], env = {} }) {
  const client = new Client({ name: "xonta-gate", version: "0.1.0" });
  const transport = url ? new StreamableHTTPClientTransport(new URL(url)) : new StdioClientTransport({ command, args, env: { ...process.env, ...env }, stderr: "inherit" });
  await client.connect(transport);
  return client;
}

// ---------- the gate ----------
export async function startGate({ upstream, policy = {}, dir = join(homedir(), ".xonta-gate"), serve = "stdio", port = 4950, name = "xonta-gate" } = {}) {
  const pol = createPolicy(policy), audit = openAudit(dir), up = await connectUpstream(upstream);
  const refresh = async () => {
    const { tools } = await up.listTools();
    const r = pol.setTools(tools);
    if (r.changed) { audit.write({ event: "tools_changed", fingerprint: pol.state.fingerprint, frozen: !!pol.state.frozen }); log("tool descriptions CHANGED during the session, actions frozen"); }
    for (const h of r.hidden) log(`blocked tool ${h.tool}: ${h.why}`);
    return r;
  };
  const first = await refresh();
  audit.write({ event: "start", upstream: upstream.url || [upstream.command, ...(upstream.args || [])].join(" "), tools: first.visible.length + first.hidden.length, hidden: first.hidden, fingerprint: pol.state.fingerprint, budget: pol.P.actions_per_period, period_seconds: pol.P.period_seconds });
  log(`upstream has ${first.visible.length + first.hidden.length} tools, ${first.hidden.length} blocked, ${first.visible.filter((t) => pol.isAction(t.name)).length} counted as actions; audit log ${audit.file}`);

  const makeServer = () => {
    const server = new Server({ name, version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => { const r = await refresh(); return { tools: r.visible }; });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const tool = params.name, args_sha = sha256hex(jcs(params.arguments || {}));
      const d = pol.decide(tool);
      if (!d.allow) {
        audit.write({ event: "call", tool, args_sha, decision: "refused", kind: d.kind, reason: d.reason, action: !!d.action });
        return { content: [{ type: "text", text: `Xonta Gate refused this call: ${d.reason}.` }], isError: true };
      }
      pol.record(tool, d);
      try {
        const out = await up.callTool({ name: tool, arguments: params.arguments || {} }, undefined, { timeout: Number(process.env.MCP_TOOL_TIMEOUT_MS || 600000) });
        const text = (out.content || []).map((c) => c.text || "").join("");
        const inj = pol.sawOutput(text);
        audit.write({ event: "call", tool, args_sha, decision: "allowed", action: !!d.action, out_sha: sha256hex(text), out_bytes: text.length, tool_error: !!out.isError, hidden_command: inj || undefined, frozen_after: inj && pol.state.frozen ? true : undefined });
        if (inj) log(`hidden command in output of ${tool}${pol.state.frozen ? ", actions are now frozen" : ""}`);
        return out;
      } catch (e) {
        audit.write({ event: "call", tool, args_sha, decision: "allowed", action: !!d.action, error: String(e?.message || e).slice(0, 200) });
        return { content: [{ type: "text", text: `Upstream error: ${String(e?.message || e).slice(0, 200)}` }], isError: true };
      }
    });
    return server;
  };

  if (serve === "stdio") { await makeServer().connect(new StdioServerTransport()); log("serving over stdio"); return { pol, audit, up }; }
  const { default: express } = await import("express");
  const app = express(); app.use(express.json({ limit: "4mb" }));
  app.post("/mcp", async (req, res) => {
    const server = makeServer(), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport); await transport.handleRequest(req, res, req.body);
  });
  app.get("/gate/status", (_req, res) => res.json(pol.summary()));
  const srv = app.listen(port, "127.0.0.1", () => log(`serving MCP at http://127.0.0.1:${port}/mcp, status at /gate/status`));
  return { pol, audit, up, close: () => srv.close() };
}
