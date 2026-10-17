#!/usr/bin/env node
// Xonta Gate CLI. Usage:
//   xonta-gate [options] -- <command> [args...]   wrap a stdio MCP server (Claude Desktop, Cursor)
//   xonta-gate [options] --url https://host/mcp   wrap a remote MCP server
//   xonta-gate check -- <command> [args...]       only scan the tools and print what would be blocked
//   xonta-gate verify [--dir DIR]                 verify the signed audit log
//   xonta-gate report [--dir DIR]                 summary of the audit log
// Options: --policy file.json  --dir DIR (default ~/.xonta-gate)  --http PORT (serve over HTTP instead of stdio)
//          --budget N (actions per period)  --period SECONDS
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { startGate, verifyAudit, createPolicy } from "../src/gate.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const argv = process.argv.slice(2), dash = argv.indexOf("--");
const opts = dash >= 0 ? argv.slice(0, dash) : argv, cmd = dash >= 0 ? argv.slice(dash + 1) : [];
const flag = (k) => { const i = opts.indexOf(k); return i >= 0 ? opts[i + 1] : null; };
const sub = ["check", "verify", "report", "help", "--help", "-h"].includes(opts[0]) ? opts[0] : "run";
const dir = flag("--dir") || process.env.XONTA_GATE_DIR || join(homedir(), ".xonta-gate");
const policy = flag("--policy") ? JSON.parse(readFileSync(flag("--policy"), "utf8")) : {};
if (flag("--budget")) policy.actions_per_period = Number(flag("--budget"));
if (flag("--period")) policy.period_seconds = Number(flag("--period"));
const upstream = flag("--url") ? { url: flag("--url") } : cmd.length ? { command: cmd[0], args: cmd.slice(1) } : null;
const out = (s) => process.stdout.write(s + "\n");

if (sub === "help" || sub === "--help" || sub === "-h") {
  out(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n")); process.exit(0);
}
if (sub === "verify") {
  const f = join(dir, "audit.jsonl"), k = join(dir, "gate-key.pub.pem");
  if (!existsSync(f)) { out(`no audit log in ${dir}`); process.exit(1); }
  const r = verifyAudit(f, readFileSync(k, "utf8"));
  out(r.ok ? `audit log OK: ${r.entries} entries, chain intact, signatures valid. last hash ${r.last_hash}` : `audit log BROKEN at entry ${r.at}: ${r.why}`);
  process.exit(r.ok ? 0 : 2);
}
if (sub === "report") {
  const f = join(dir, "audit.jsonl"); if (!existsSync(f)) { out(`no audit log in ${dir}`); process.exit(1); }
  const rows = readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)), calls = rows.filter((r) => r.event === "call");
  const by = (k) => calls.reduce((m, r) => ((m[r[k]] = (m[r[k]] || 0) + 1), m), {});
  out(`sessions: ${rows.filter((r) => r.event === "start").length}`);
  out(`calls: ${calls.length}, allowed ${calls.filter((r) => r.decision === "allowed").length}, refused ${calls.filter((r) => r.decision === "refused").length}`);
  out(`refusals by reason: ${JSON.stringify(calls.filter((r) => r.decision === "refused").reduce((m, r) => ((m[r.kind] = (m[r.kind] || 0) + 1), m), {}))}`);
  out(`actions allowed: ${calls.filter((r) => r.decision === "allowed" && r.action).length}`);
  out(`hidden commands seen in outputs: ${calls.filter((r) => r.hidden_command).length}`);
  out(`tool description changes during a session: ${rows.filter((r) => r.event === "tools_changed").length}`);
  out(`calls per tool: ${JSON.stringify(by("tool"))}`);
  process.exit(0);
}
if (!upstream) { out("nothing to wrap. Example: xonta-gate -- npx -y @modelcontextprotocol/server-filesystem ~/Documents   (or --url https://host/mcp). See xonta-gate help"); process.exit(1); }
if (sub === "check") {
  const client = new Client({ name: "xonta-gate-check", version: "0.1.0" });
  await client.connect(upstream.url ? new StreamableHTTPClientTransport(new URL(upstream.url)) : new StdioClientTransport({ command: upstream.command, args: upstream.args, stderr: "inherit" }), { timeout: 300000 });
  const { tools } = await client.listTools(undefined, { timeout: 300000 }), pol = createPolicy(policy), r = pol.setTools(tools);
  out(`${tools.length} tools`);
  for (const t of tools) { const h = r.hidden.find((x) => x.tool === t.name); out(`  ${h ? "BLOCK " : pol.isAction(t.name) ? "action" : "read  "}  ${t.name}${h ? `  (${h.why})` : ""}`); }
  const warn = r.findings.filter((f) => f.severity !== "low" && !r.hidden.some((h) => h.tool === f.tool));
  if (warn.length) { out("warnings (not blocked):"); for (const f of warn) out(`  ${f.tool}: ${f.rule} (${f.severity})`); }
  out(`budget: ${pol.P.actions_per_period} actions per ${pol.P.period_seconds}s`);
  await client.close(); process.exit(0);
}
await startGate({ upstream, policy, dir, serve: flag("--http") ? "http" : "stdio", port: Number(flag("--http") || 4950) });
