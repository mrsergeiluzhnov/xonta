// Каркас лабораторного агента: свой ключ Ed25519, свой did:web (документ отдаёт сам агент), MCP-сервер,
// код подтверждения домена и «канал владельца» — команды, которые агент выполняет только с подписью владельца.
import express from "express";
import { generateKeyPairSync } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { didDocument, urlToDidWeb, makeResolver } from "../src/did.js";
import { verifyCaller, signRequest } from "../src/callerauth.js";
import { signCredential, credential } from "../src/vc.js";
import { randomUUID } from "node:crypto";
import { loadOrCreateKey } from "../src/crypto.js";

// контекст примеров W3C задаёт @vocab — для лабораторных аттестатов этого достаточно
export const LAB_CONTEXT = ["https://www.w3.org/ns/credentials/v2", "https://www.w3.org/ns/credentials/examples/v2"];

// keyFile — постоянный ключ (DID не меняется между перезапусками); без него ключ одноразовый
export function identity(baseUrl, keyFile = null) {
  const { privateKey, publicKey } = keyFile ? loadOrCreateKey(keyFile) : generateKeyPairSync("ed25519");
  const did = urlToDidWeb(baseUrl);
  return { did, vm: `${did}#key-1`, privateKey, publicKey, doc: didDocument(did, publicKey) };
}

export function sign(id, type, subject, { validDays = 365, context } = {}) {
  const vc = credential({ id: `urn:uuid:${randomUUID()}`, type, issuer: id.did, subject, validDays });
  vc["@context"] = context || [...LAB_CONTEXT];
  return signCredential(vc, { privateKey: id.privateKey, verificationMethod: id.vm });
}

// Подписанный запрос владельца к агенту (тот же формат подписи, что у шлюза A2O2A)
export async function ownerCall(owner, url, body) {
  const raw = JSON.stringify(body);
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...signRequest({ did: owner.did, privateKey: owner.privateKey, url, body: raw }) }, body: raw });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${url}: ${r.status} ${j.error || ""}`);
  return j;
}

export async function startAgent({ port, name, tools, ownerDid, ownerRoutes = {}, keyFile = null, instructions, version = "0.1.0" }) {
  const baseUrl = `http://localhost:${port}`;
  const id = identity(baseUrl, keyFile);
  const resolver = makeResolver({ allowHttp: true });
  let challenge = null;
  const app = express();
  app.use(express.json({ limit: "5mb", verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.get("/.well-known/did.json", (_q, s) => s.json(id.doc));
  app.get("/.well-known/xonta-challenge.txt", (_q, s) => (challenge ? s.type("text/plain").send(challenge) : s.status(404).end()));

  // канал владельца: подпись проверяется по DID владельца
  const routes = { challenge: async ({ token }) => { challenge = String(token); return { ok: true }; }, ...ownerRoutes };
  app.post("/owner/:action", async (req, res) => {
    const who = await verifyCaller(req, resolver);
    if (!who.verified || who.did !== ownerDid) return res.status(403).json({ error: "только владелец с подписью" });
    const fn = routes[req.params.action];
    if (!fn) return res.status(404).json({ error: "нет такой команды" });
    try { res.json(await fn(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post("/mcp", async (req, res) => {
    const s = new McpServer({ name, version }, instructions ? { instructions } : undefined);
    for (const t of tools) s.registerTool(t.name, { description: t.description, inputSchema: t.input, annotations: t.annotations }, async (args) => {
      try { return { content: [{ type: "text", text: JSON.stringify(await t.run(args)) }] }; }
      catch (e) { return { content: [{ type: "text", text: `Ошибка: ${e.message}` }], isError: true }; }
    });
    const tr = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { tr.close(); s.close(); });
    await s.connect(tr); await tr.handleRequest(req, res, req.body);
  });
  const server = await new Promise((ok) => { const srv = app.listen(port, () => ok(srv)); });
  return { ...id, url: baseUrl, mcp: `${baseUrl}/mcp`, close: () => server.close() };
}

// Владелец — человек или организация: только DID и ключ, без MCP
export async function startOwner({ port, keyFile = null }) {
  const baseUrl = `http://localhost:${port}`;
  const id = identity(baseUrl, keyFile);
  const app = express();
  app.get("/.well-known/did.json", (_q, s) => s.json(id.doc));
  const server = await new Promise((ok) => { const srv = app.listen(port, () => ok(srv)); });
  return { ...id, url: baseUrl, close: () => server.close() };
}
