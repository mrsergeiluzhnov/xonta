// The refunds desk as an MCP server over HTTP, plus admin endpoints for the experiment harness.
//   node stand/biz/biz-mcp.mjs --port 4970 --seed 1 --mix mixed
// MCP:   POST /mcp
// Admin: POST /admin/reset {seed, mix, n}   GET /admin/score   GET /admin/ledger   GET /admin/tickets
//        POST /admin/context {ticket}       POST /admin/human {tool, args}
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { makeWorld, callTool, assess, score, TOOLS } from "./world.mjs";

export function startBiz({ port = 4970, seed = 1, mix = "mixed", n = null } = {}) {
  let W = makeWorld({ seed, mix, n });
  const app = express(); app.use(express.json({ limit: "8mb" }));
  app.post("/mcp", async (req, res) => {
    const s = new Server({ name: "acme-refunds", version: "1.0.0" }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    s.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const text = callTool(W, params.name, params.arguments || {}, { by: "agent" });
      return { content: [{ type: "text", text }], isError: /^error:|^unknown tool/.test(text) };
    });
    const tr = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { tr.close(); s.close(); });
    await s.connect(tr); await tr.handleRequest(req, res, req.body);
  });
  app.post("/admin/reset", (req, res) => { W = makeWorld({ seed: req.body?.seed ?? seed, mix: req.body?.mix ?? mix, n: req.body?.n ?? n }); res.json({ ok: true, tickets: W.tickets.map((t) => ({ id: t.id, kind: t.kind })) }); });
  app.post("/admin/context", (req, res) => { W.ctx = req.body?.ticket || null; res.json({ ok: true }); });
  // a human who looked at a held request does it only if it is actually right; a wrong one is turned down and costs nothing
  app.post("/admin/human", (req, res) => { const a = assess(W, req.body.tool, req.body.args || {}); if (a.legit && a.harm === 0) callTool(W, req.body.tool, req.body.args || {}, { by: "human" }); res.json({ done: a.legit && a.harm === 0, ...a }); });
  app.get("/admin/score", (_req, res) => res.json(score(W)));
  app.get("/admin/ledger", (_req, res) => res.json({ ledger: W.ledger, tickets: W.tickets.map((t) => ({ id: t.id, kind: t.kind, done: W.done[t.id] || null, status: t.status })) }));
  app.get("/admin/tickets", (_req, res) => res.json(W.tickets.map((t) => ({ id: t.id, kind: t.kind }))));
  return new Promise((ok) => { const srv = app.listen(port, "127.0.0.1", () => ok({ close: () => srv.close(), world: () => W })); });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flag = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  await startBiz({ port: Number(flag("--port", 4970)), seed: Number(flag("--seed", 1)), mix: flag("--mix", "mixed"), n: flag("--n", null) ? Number(flag("--n")) : null });
  process.stderr.write(`acme refunds desk at http://127.0.0.1:${flag("--port", 4970)}/mcp\n`);
}
