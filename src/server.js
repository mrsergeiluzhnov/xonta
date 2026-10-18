// Xonta Agent Passport — оркестратор A2O2A: паспорта агентов, проверка MCP-серверов, агент-тестер, сигналы владельцу.
import "./http-timeouts.js";
import express from "express";
import { timingSafeEqual, createHash } from "node:crypto";
import { join } from "node:path";
import { openStore } from "./store.js";
import { createIssuer } from "./issuer.js";
import { makeResolver } from "./did.js";
import { createVerifier } from "./verify.js";
import { createNotifier } from "./notify.js";
import { createSignals, DEFAULTS as SIGNAL_DEFAULTS } from "./analyzer.js";
import { createEvolution, MERGE_DEFAULTS } from "./evolution.js";
import { createShop, mountShop } from "./shop.js";
import { createSupport, mountSupport } from "./support.js";
import { createExperience, mountExperience } from "./experience.js";
import { createGuardian, mountGuardian } from "./guardian.js";
import { verifyCaller } from "./callerauth.js";
import { createLLM } from "../stand/llm.js";
import { createOrchestrator } from "./orchestrator.js";
import { mountGateway } from "./gateway.js";
import { mountMcp } from "./mcp.js";
import { scanMcpServer } from "./scan.js";
import { publicKeyFromMultibase } from "./crypto.js";
import * as xontaDocsSuite from "../suites/xonta-docs.js";

export const VERSION = "0.14.2";
const env = process.env;
const PORT = Number(env.PORT || 4040);
const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DATA_DIR = env.DATA_DIR || join(process.cwd(), "data");
const ALLOW_PRIVATE = env.ALLOW_PRIVATE_TARGETS === "1"; // только для разработки: разрешает http и локальные адреса
const ADMIN_TOKEN = env.ADMIN_TOKEN || "";
const REG_TOKEN = env.REGISTRATION_TOKEN || "";

const store = openStore(DATA_DIR);
const issuer = createIssuer({ store, publicUrl: PUBLIC_URL, dataDir: DATA_DIR });
const notify = createNotifier({ store, allowPrivate: ALLOW_PRIVATE });
// SIGNAL_COOLDOWN_MIN — пауза между одинаковыми сигналами (по умолчанию 30 мин; в лаборатории 0)
const signals = createSignals({ store, notify, cfg: { ...SIGNAL_DEFAULTS, cooldown_min: Number(env.SIGNAL_COOLDOWN_MIN ?? SIGNAL_DEFAULTS.cooldown_min),
  // пороги сигнала В: доля категории в трафике и отставание качества от лучшей категории (п.п.)
  c: { ...SIGNAL_DEFAULTS.c, min_share: Number(env.SIGNAL_C_MIN_SHARE ?? SIGNAL_DEFAULTS.c.min_share), gap: Number(env.SIGNAL_C_GAP ?? SIGNAL_DEFAULTS.c.gap), min_n: Number(env.SIGNAL_C_MIN_N ?? 0), window_days: Number(env.SIGNAL_C_WINDOW_DAYS ?? SIGNAL_DEFAULTS.c.window_days) } } });
const local = new Map();
const orch = createOrchestrator({ store, issuer, notify, signals, publicUrl: PUBLIC_URL, dataDir: DATA_DIR, allowPrivate: ALLOW_PRIVATE, suites: { "xonta-docs": xontaDocsSuite } });
// свои документы разрешаем без сети: эмитент, тестер и агенты, размещённые у оркестратора
local.set(issuer.did, () => issuer.doc);
const resolverBase = makeResolver({ allowHttp: ALLOW_PRIVATE, local });
async function resolve(did) {
  const prefix = `${issuer.did}:agents:`;
  if (did.startsWith(prefix)) { const d = orch.didDoc(did.slice(prefix.length)); if (d) return d; }
  return resolverBase.resolve(did);
}
async function keyFor(vm, relationship = "assertionMethod") {
  const did = String(vm).split("#")[0];
  const doc = await resolve(did);
  const allowed = [].concat(doc[relationship] || []).map((x) => (typeof x === "string" ? x : x.id));
  const m = doc.verificationMethod?.find((x) => x.id === vm);
  if (!allowed.includes(vm) || !m?.publicKeyMultibase || m.controller !== did) throw new Error("ключ не найден в DID-документе");
  return publicKeyFromMultibase(m.publicKeyMultibase);
}
const resolver = { resolve, keyFor };
const verifier = createVerifier({ issuer, store, resolver, allowPrivate: ALLOW_PRIVATE });
// Языковые модели оркестратора (для языков навыков на моделях): судья размечает эталон, интерпретатор проверяет предложения потомков
let llms = null;
if (env.LLM_PROVIDER) {
  const mock = env.LLM_PROVIDER === "mock" ? await import(env.MOCK_LLM_MODULE || "../stand/mock-llm.js") : null;
  const usageFile = join(DATA_DIR, "llm-usage.jsonl");
  llms = {
    judge: createLLM({ model: env.JUDGE_MODEL || "mock-judge", role: "judge", usageFile, mock: mock?.mockJudge, budgetTokens: Number(env.ORCH_LLM_BUDGET_TOKENS || 4_000_000) }),
    interp: createLLM({ model: env.AGENT_MODEL || "mock-agent", role: "interpreter", usageFile, mock: mock?.mockAgent, budgetTokens: Number(env.ORCH_LLM_BUDGET_TOKENS || 4_000_000) }),
  };
}
const evo = createEvolution({ store, issuer, orch, signals, resolver, publicUrl: PUBLIC_URL, allowPrivate: ALLOW_PRIVATE, cfg: { ...MERGE_DEFAULTS, heldout_seed: env.HELDOUT_SEED || null }, llms });

const shop = createShop({ store, issuer, orch, resolver, publicUrl: PUBLIC_URL });
// книга опыта оркестратора и послужной список: переживают прогоны (постоянный DATA_DIR), обмен опытом с другими оркестраторами
const exp = createExperience({ store, issuer, resolver, publicUrl: PUBLIC_URL, name: env.ORCH_NAME || "xonta" });
const support = createSupport({ store, issuer, orch, resolver, publicUrl: PUBLIC_URL, exp });
// надзор за потомками: мандат на шлюзе, контрольные обращения, скрытые команды, лестница карантина
const guardian = createGuardian({ store, issuer, orch, publicUrl: PUBLIC_URL, exp });
const app = express();
app.set("trust proxy", Number(env.TRUST_PROXY ?? 1)); // за одним обратным прокси (nginx); без прокси задайте TRUST_PROXY=0
app.use(express.json({ limit: "8mb", verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } })); // тело нужно для проверки подписи запроса
app.use((e, _req, res, next) => (e ? res.status(400).json({ error: "Некорректный JSON" }) : next()));

const bearer = (req) => (req.get("authorization") || "").replace(/^Bearer\s+/i, "") || null;
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); if (!e.status) console.error(e); }
};
const h = (x) => createHash("sha256").update(String(x)).digest();
const isAdmin = (req) => !!ADMIN_TOKEN && !!bearer(req) && timingSafeEqual(h(bearer(req)), h(ADMIN_TOKEN));
const admin = (req) => { if (!isAdmin(req)) throw Object.assign(new Error("нужен ключ администратора"), { status: 403 }); };
const ownerOrAdmin = (req, id) => { if (isAdmin(req)) return; orch.checkOwner(orch.get(id), bearer(req)); };
// владелец подтверждает себя ключом владельца или запросом, подписанным его DID (owner_did)
async function ownerAuth(req, id) {
  if (isAdmin(req)) return;
  const rec = orch.get(id);
  if (bearer(req)) return orch.checkOwner(rec, bearer(req));
  const who = await verifyCaller(req, resolver);
  if (!rec.owner_did || !who.verified || who.did !== rec.owner_did) throw Object.assign(new Error("нужен ключ владельца или подпись owner_did"), { status: 403 });
}

// простой лимит для открытой проверки чужих MCP-серверов
const hits = new Map();
function limit(req, max = 20, windowMs = 3600_000) {
  const k = req.ip, now = Date.now();
  if (hits.size > 10000) for (const [key, arr] of hits) if (!arr.some((t) => now - t < windowMs)) hits.delete(key);
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw Object.assign(new Error("слишком много проверок, попробуйте позже"), { status: 429 });
  arr.push(now); hits.set(k, arr);
}
const scanPublic = async (url) => { const { _tools, ...r } = await scanMcpServer(url, { allowPrivate: ALLOW_PRIVATE }); return r; };

// --- идентификаторы и статусы ---
app.get("/.well-known/did.json", (_req, res) => res.json(issuer.doc));
app.get("/agents/:id/did.json", (req, res) => { const d = orch.didDoc(req.params.id); return d ? res.json(d) : res.status(404).json({ error: "not found" }); });
app.get("/status/:purpose", (req, res) => { const vc = issuer.statusListCredential(req.params.purpose); return vc ? res.set("Cache-Control", "max-age=300").json(vc) : res.status(404).json({ error: "not found" }); });

// --- агенты ---
// регистрация: по ключу регистрации; без него в рабочем режиме — только администратор
app.post("/v1/agents", wrap(async (req) => {
  const open = ALLOW_PRIVATE && !REG_TOKEN;
  if (!open && !isAdmin(req) && !(REG_TOKEN && bearer(req) && timingSafeEqual(h(bearer(req)), h(REG_TOKEN)))) throw Object.assign(new Error("регистрация по приглашению: нужен ключ регистрации"), { status: 403 });
  return orch.register(req.body, { caller: await verifyCaller(req, resolver) });
}));
app.get("/v1/agents/:id/passport", wrap((req) => orch.passport(req.params.id)));
app.post("/v1/agents/:id/domain-check", wrap(async (req) => { await ownerAuth(req, req.params.id); return orch.domainCheck(req.params.id); }));
app.post("/v1/agents/:id/scan", wrap(async (req) => { await ownerAuth(req, req.params.id); return orch.scan(req.params.id); }));
app.post("/v1/agents/:id/test", wrap((req) => { ownerOrAdmin(req, req.params.id); return orch.test(req.params.id, req.body || {}); }));
app.post("/v1/agents/:id/reputation", wrap((req) => { ownerOrAdmin(req, req.params.id); return orch.reputation(req.params.id, req.body || {}); }));
app.post("/v1/agents/:id/status", wrap(async (req) => {
  await ownerAuth(req, req.params.id);
  const r = await orch.setAgentStatus(req.params.id, req.body || {}, { admin: isAdmin(req) });
  return { ...r, descendants_suspended: await evo.cascade(req.params.id, r.status, req.body?.reason) };
}));
// --- потомки, предложения, слияние (уровень 2: оркестратор оценивает и рекомендует, применяет владелец) ---
app.post("/v1/agents/:id/children", wrap(async (req) => evo.registerChild(req.params.id, req.body || {}, await verifyCaller(req, resolver))));
app.post("/v1/proposals", wrap((req) => { limit(req, 300); return evo.submitProposal(req.body || {}); }));
app.post("/v1/agents/:id/evaluate", wrap(async (req) => { await ownerAuth(req, req.params.id); return evo.evaluate(req.params.id, req.body || {}); }));
app.post("/v1/agents/:id/merge", wrap(async (req) => { await ownerAuth(req, req.params.id); return evo.merge(req.params.id, req.body || {}); }));
app.post("/v1/heldout", wrap(async (req) => { admin(req); return evo.buildHeldout(req.body || {}); }));
app.post("/v1/heldout/geo", wrap(async (req) => { admin(req); return evo.loadGeoHeldout(req.body || {}); }));
app.post("/v1/agents/:id/judge", wrap(async (req) => { await ownerAuth(req, req.params.id); limit(req, 2000); return evo.judgeFor(req.params.id, req.body || {}); }));
app.get("/v1/agents/:id/lineage", wrap((req) => evo.lineageOf(req.params.id)));
// советник: публичная история советов оркестратора (его «паспорт»), советы агенту — владельцу, решение по совету — владелец цели
const needAdvisor = () => { if (!evo.advisor) throw Object.assign(new Error("советник выключен (ADVISOR=1)"), { status: 404 }); return evo.advisor; };
app.get("/v1/advisor", wrap((req) => needAdvisor().stats({ split_round: req.query?.split_round != null ? Number(req.query.split_round) : null })));
app.get("/v1/agents/:id/advice", wrap(async (req) => { await ownerAuth(req, req.params.id); return needAdvisor().list(orch.get(req.params.id).id); }));
app.post("/v1/advice/:aid", wrap(async (req) => { const adv = needAdvisor(); const a = adv.list().find((x) => x.id === req.params.aid); if (!a) throw Object.assign(new Error("совет не найден"), { status: 404 }); await ownerAuth(req, a.target); return adv.decide(a.id, req.body?.action); }));
// агенты, которые тратят деньги (xonta-shop/1): экзамен, уровень доверия и лимит, история платежей, советник v3
mountShop(app, { shop, wrap, admin, ownerAuth, orch });
// агенты поддержки (xonta-support/1): бюджет вреда, подбор команды потомков, рецепты для новичков, расхождение экзамена и работы
mountSupport(app, { support, wrap, admin, ownerAuth, orch });
// опыт оркестратора: каталог по областям и категориям, подписанный пакет опыта, послужной список, доказательства, обмен
mountExperience(app, { exp, wrap, admin });
mountGuardian(app, { guardian, wrap, admin });
app.get("/v1/agents/:id/proposals", wrap((req) => evo.listProposals(orch.get(req.params.id).id)));
app.get("/v1/agents/:id/merges", wrap((req) => evo.listMerges(orch.get(req.params.id).id)));
app.get("/v1/agents/:id/signals", wrap((req) => { ownerOrAdmin(req, req.params.id); return orch.listSignals(req.params.id); }));
app.post("/v1/signals/:sid", wrap((req) => orch.actOnSignal(req.params.sid, req.body?.action, bearer(req))));
app.post("/v1/admin/agents/:id/owner-verified", wrap((req) => { admin(req); return orch.ownerVerified(req.params.id, req.body || {}); }));
app.post("/v1/admin/credentials/:cid/status", wrap((req) => { admin(req); return issuer.setStatus(decodeURIComponent(req.params.cid), req.body?.purpose, req.body?.value !== false, req.body?.reason); }));
app.post("/v1/admin/anchor", wrap((req) => { admin(req); return issuer.anchor(); }));

// --- проверка ---
app.post("/v1/verify", wrap((req) => { limit(req, 300); return verifier.verifyAgent(req.body || {}); }));
app.post("/v1/scan", wrap((req) => { limit(req); return scanPublic(req.body?.url); }));
app.get("/v1/credentials/:cid/inclusion", wrap((req) => issuer.inclusion(decodeURIComponent(req.params.cid)) || Promise.reject(Object.assign(new Error("не найдено"), { status: 404 }))));
app.get("/v1/anchors", wrap(() => store.get("anchors", []).map(({ file, ...a }) => ({ ...a, method: a.method.map((m) => ({ type: m.type, ok: !!m.proof, error: m.error })) }))));

// JSON-LD контекст терминов паспорта (VC 2.0 требует, чтобы все термины были определены)
app.get("/ns/v0", (_req, res) => res.type("application/ld+json").set("Cache-Control", "public, max-age=86400").json({
  "@context": { "@version": 1.1, "@vocab": `${PUBLIC_URL}/ns/v0#` },
}));
app.get("/health", (_req, res) => res.json({ ok: true, version: VERSION, issuer: issuer.did, name: env.ORCH_NAME || "xonta" }));
app.get("/", (_req, res) => res.type("html").send(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Паспорт ИИ-агента — Xonta</title>
<body style="font:16px/1.55 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px">
<h1>Паспорт ИИ-агента</h1><p>Оркестратор A2O2A от <a href="https://xonta.ru">Xonta</a>: проверяемые аттестаты для ИИ-агентов (W3C VC), проверка MCP-серверов на скрытые инструкции, агент-тестер и сигналы владельцу. Оркестратор рекомендует, но ничего не меняет в агентах сам.</p>
<ul><li>Эмитент: <code>${issuer.did}</code> — <a href="/.well-known/did.json">DID-документ</a></li><li>MCP: <code>${PUBLIC_URL}/mcp</code> — verify_agent, get_passport, scan_mcp_server</li><li>Статусы: <a href="/status/revocation">отзыв</a>, <a href="/status/suspension">приостановка</a></li><li>Фиксации: <a href="/v1/anchors">/v1/anchors</a></li></ul>
<p>Версия ${VERSION}. Спецификация и код — Apache 2.0.</p></body></html>`));

mountGateway(app, { store, resolver, testerDid: orch.tester.did, guardian });
mountMcp(app, { version: VERSION, verifier, orch, scanPublic, limit });

// суточная фиксация контрольной суммы: проверка раз в час, фиксация — если с прошлой прошло больше суток (переживает перезапуски)
function maybeAnchor() {
  const last = store.get("anchors", []).at(-1);
  if (last && Date.now() - Date.parse(last.at) < 24 * 3600 * 1000) return;
  try { issuer.anchor(); } catch (e) { console.error("anchor", e.message); }
}
if (env.AUTO_ANCHOR !== "0") { setTimeout(maybeAnchor, 60_000).unref(); setInterval(maybeAnchor, 3600_000).unref(); }

app.listen(PORT, () => console.log(`Xonta Agent Passport ${VERSION} on :${PORT} | issuer ${issuer.did} | ${PUBLIC_URL}`));
