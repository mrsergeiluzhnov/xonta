// Шлюз A2O2A: вызывающий агент → оркестратор → целевой агент. Оркестратор проверяет подпись вызывающего,
// статус целевого агента, пропускает только проверенные инструменты и пишет трассу (без содержимого — отпечатки и размеры).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectMcp } from "./scan.js";
import { verifyCaller } from "./callerauth.js";
import { jcs, sha256hex } from "./crypto.js";

export function mountGateway(app, { store, resolver, testerDid, guardian = null }) {
  const clients = new Map(); // agentId → Promise<Client>
  const inflight = new Map();

  function clientFor(rec) {
    if (!clients.has(rec.id)) clients.set(rec.id, connectMcp(rec.mcp_url, { name: "xonta-a2o2a-gateway" }).catch((e) => { clients.delete(rec.id); throw Object.assign(e, { connectFailed: true }); }));
    return clients.get(rec.id);
  }

  async function forward(rec, name, args) {
    let client;
    try { client = await clientFor(rec); } catch (e) { throw e; }
    try {
      return await client.callTool({ name, arguments: args }, undefined, { timeout: Number(process.env.MCP_TOOL_TIMEOUT_MS || 600000) });
    } catch (e) {
      // повтор только если соединение не состоялось (сеть, сброс), чтобы не выполнить инструмент дважды
      if (/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|session/i.test(String(e?.message)) && !e?.code) {
        clients.delete(rec.id);
        return (await clientFor(rec)).callTool({ name, arguments: args }, undefined, { timeout: Number(process.env.MCP_TOOL_TIMEOUT_MS || 600000) });
      }
      throw e;
    }
  }

  const gwHits = new Map(), GW_RATE = Number(process.env.GW_RATE_PER_MIN || 0); // 0 — без предела (стенд: все агенты с одного адреса)
  app.post("/gw/:id/mcp", async (req, res) => {
    const agents = store.get("agents", {});
    const rec = Object.hasOwn(agents, req.params.id) ? agents[req.params.id] : null;
    if (!rec) return res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "agent is not registered", data: { ru: "агент не зарегистрирован" } }, id: null });
    if (["suspended", "revoked"].includes(rec.status))
      return res.status(403).json({ jsonrpc: "2.0", error: { code: -32002, message: `agent is ${rec.status === "revoked" ? "revoked" : "suspended"}`, data: { ru: `агент ${rec.status === "revoked" ? "отозван" : "приостановлен"}` } }, id: null });
    // 0.15: шлюз ведёт только к агенту с подтверждённым доменом — иначе при открытой регистрации его можно было бы направить
    // на чужой сервер. И предел частоты с одного адреса на одного агента
    if (!rec.domain_verified_at && !rec.parent) return res.status(403).json({ jsonrpc: "2.0", error: { code: -32004, message: "the agent's domain is not verified, the gateway does not lead to it", data: { ru: "домен агента не подтверждён: шлюз к нему не ведёт" } }, id: null });
    if (GW_RATE) { const k = `${rec.id}|${req.ip}`, now = Date.now(), w = (gwHits.get(k) || []).filter((t) => now - t < 60_000);
      if (w.length >= GW_RATE) return res.status(429).json({ jsonrpc: "2.0", error: { code: -32005, message: `at most ${GW_RATE} calls per minute`, data: { ru: `не больше ${GW_RATE} вызовов в минуту` } }, id: null });
      w.push(now); gwHits.set(k, w); if (gwHits.size > 20000) gwHits.clear(); }
    if (rec.status === "deprecated" && rec.sunset) res.set("Sunset", new Date(rec.sunset).toUTCString());
    if (rec.status === "deprecated" && rec.successor) res.set("Link", `<${rec.successor}>; rel="successor-version"`);

    const caller = await verifyCaller(req, resolver);
    if (rec.require_signed_callers && !caller.verified)
      return res.status(401).json({ jsonrpc: "2.0", error: { code: -32003, message: "a signed request from the calling agent is required", data: { ru: "нужна подпись вызывающего агента" } }, id: null });
    // метки задачи учитываются только от проверенных вызывающих: иначе сигналы можно было бы подделать
    let task = null, category = null;
    if (caller.verified) {
      task = String(req.get("x-task-id") || "").slice(0, 64) || null;
      try { category = decodeURIComponent(String(req.get("x-task-category") || "")).slice(0, 64) || null; } catch {}
    }
    const allowed = new Set((rec.tools || []).map((t) => t.name));

    const server = new Server({ name: `gateway:${rec.name}`, version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: rec.tools || [] }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      if (!allowed.has(params.name)) return { content: [{ type: "text", text: `Инструмент «${params.name}» не проходил проверку оркестратора — вызов не пропущен` }], isError: true };
      // надзор: мандат потомка (разрешённые вызовы, частота) и карантин вызывающего
      const g = guardian ? guardian.gate(caller, rec, params.name) : { ok: true };
      if (!g.ok) { store.log("traces", { agent: rec.id, caller: caller.did, caller_verified: caller.verified, tool: params.name, args_hash: sha256hex(jcs(params.arguments || {})), ok: false, error: "guardian_blocked", reason: g.reason }); return { content: [{ type: "text", text: `Оркестратор не пропустил вызов: ${g.reason}` }], isError: true }; }
      const t0 = Date.now();
      inflight.set(rec.id, (inflight.get(rec.id) || 0) + 1);
      const trace = { agent: rec.id, caller: caller.did, caller_verified: caller.verified, synthetic: caller.verified && caller.did === testerDid, tool: params.name, task, category, args_hash: sha256hex(jcs(params.arguments || {})), concurrent: inflight.get(rec.id) };
      try {
        const out = await forward(rec, params.name, params.arguments || {});
        const text = (out.content || []).map((c) => c.text || "").join("");
        store.log("traces", { ...trace, ok: !out.isError, ms: Date.now() - t0, out_hash: sha256hex(text), out_bytes: text.length, error: out.isError ? "tool_error" : undefined });
        if (guardian) guardian.scan(rec, caller, text);
        return out;
      } catch (e) {
        store.log("traces", { ...trace, ok: false, ms: Date.now() - t0, error: e.connectFailed ? "unreachable" : "gateway_error" });
        return { content: [{ type: "text", text: e.connectFailed ? "Целевой агент недоступен" : "Ошибка при вызове целевого агента" }], isError: true };
      } finally {
        inflight.set(rec.id, inflight.get(rec.id) - 1);
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });

  const notAllowed = (_req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  app.get("/gw/:id/mcp", notAllowed);
  app.delete("/gw/:id/mcp", notAllowed);
  return { resetClient: (id) => clients.delete(id) };
}
