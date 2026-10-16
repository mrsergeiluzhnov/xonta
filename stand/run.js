// Стенд «Отзывы»: оркестратор + агент №2 (отзывы, владелец — потребитель) + с 11-го раунда агент №3 (поставщик данных).
//
// Раунды 1–10: агент отзывов сам собирает отзывы на Яндекс Маркете, клиент присылает товары, судья оркестратора
// размечает выборку, агент учится на расхождениях, оркестратор оценивает его по категориям товаров и подаёт сигналы;
// владелец рождает потомков по сигналу «специалист для отстающей категории».
// Раунды 11+: подключается поставщик, который приносит отзывы с других площадок через шлюз; категории — площадки;
// оркестратор переоценивает агента и подаёт сигналы о потомках уже по площадкам.
//
// Состояние сохраняется после каждого раунда: при перезапуске стенд продолжает с того же места.
// Запуск: node stand/run.js   (настройки — переменные окружения, см. stand/README.md)
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMcp } from "../src/scan.js";
import { signRequest, signingFetch } from "../src/callerauth.js";
import { startOwner, ownerCall, sign } from "../lab/agentkit.js";
import { createLLM } from "./llm.js";
import { createFetcher } from "./fetcher.js";
import { startReviewsAgent } from "./reviews-agent.js";
import { startSupplier, SUPPLIER_PLATFORMS } from "./supplier-agent.js";
import * as R from "../skills/xonta-reviews.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const E = process.env;
const DIR = E.STAND_DIR || join(ROOT, "stand-data");
const FIXTURE = E.STAND_MODE === "fixture";
const P = {
  phase1_rounds: Number(E.PHASE1_ROUNDS || 10), total_rounds: Number(E.TOTAL_ROUNDS || 20),
  products_per_round: Number(E.PRODUCTS_PER_ROUND || 3), feedback_budget: Number(E.FEEDBACK_BUDGET || 4), judge_sample: Number(E.JUDGE_SAMPLE || 12),
  merge_every: Number(E.MERGE_EVERY || 2), phase1_platform: E.PHASE1_PLATFORM || "otzovik", phase2_mode: E.PHASE2_MODE || "goods", round_pause_min: Number(E.ROUND_PAUSE_MIN || 0), example_limit: Number(E.SKILL_EXAMPLE_LIMIT || 8),
  mandate: { max_children: Number(E.MAX_CHILDREN || 4), max_depth: 1 },
};
const ADMIN = E.ADMIN_TOKEN || "stand-admin-" + Math.random().toString(36).slice(2);
const PORT = { orch: 4040, ownerR: 4301, ownerS: 4302, client: 4303, root: 4310, child0: 4311, supplier: 4320, fixture: 4399 };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
mkdirSync(DIR, { recursive: true });
const RUN = join(DIR, "run.json");
const run = existsSync(RUN) ? JSON.parse(readFileSync(RUN, "utf8")) : { round: 0, ids: {}, children: [], rounds: [], merges: [], signals: [], heldout: [], params: P, mode: FIXTURE ? "fixture" : "live", started: new Date().toISOString() };
const saveRun = () => { writeFileSync(RUN, JSON.stringify(run, null, 1)); writeFileSync(join(DIR, "REPORT.md"), report()); };

// ---------- товары ----------
async function loadProducts() {
  if (FIXTURE) {
    const { fixtureSources } = await import("./fixture-site.js");
    const cats = ["goods:smartphones", "goods:headphones", "goods:vacuums", "goods:kettles"];
    const mk = (i, split) => { const category = cats[i % cats.length]; const key = `${split}${i}`; return { key, title: `Учебный товар ${key} (${category.slice(6)})`, model: `MODEL-${key}`, category, sources: fixtureSources(key) }; };
    return { eval: Array.from({ length: 8 }, (_, i) => mk(i, "e")), traffic: Array.from({ length: 24 }, (_, i) => mk(i, "t")) };
  }
  const f = E.PRODUCTS_FILE || join(HERE, "products.json");
  if (!existsSync(f)) throw new Error(`нет файла товаров ${f} — скопируйте stand/products.example.json в stand/products.json и заполните адреса`);
  const p = JSON.parse(readFileSync(f, "utf8"));
  const keys = new Set(p.eval.map((x) => x.key));
  if (p.traffic.some((x) => keys.has(x.key))) throw new Error("товары оценки и трафика не должны пересекаться");
  return p;
}

// ---------- инфраструктура ----------
async function startOrchestrator() {
  const env = { ...E, PORT: String(PORT.orch), PUBLIC_URL: `http://localhost:${PORT.orch}`, DATA_DIR: join(DIR, "orchestrator"), ALLOW_PRIVATE_TARGETS: "1", AUTO_ANCHOR: "1",
    SIGNAL_COOLDOWN_MIN: E.SIGNAL_COOLDOWN_MIN || "0", ADMIN_TOKEN: ADMIN, TRUST_PROXY: "0", LLM_PROVIDER: E.LLM_PROVIDER || "mock", OWNER_HMAC_SECRET: E.OWNER_HMAC_SECRET || "stand" };
  const child = spawn(process.execPath, [join(ROOT, "src/server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let errOut = ""; child.stderr.on("data", (d) => { errOut += d; process.stderr.write(`[orch] ${d}`); });
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`http://localhost:${PORT.orch}/health`)).ok) return { url: `http://localhost:${PORT.orch}`, child }; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("оркестратор не запустился: " + errOut);
}
function makeApi(base) {
  return async (method, path, body, { token, signer } = {}) => {
    const url = base + path, raw = body === undefined ? "" : JSON.stringify(body);
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (signer) Object.assign(headers, signRequest({ did: signer.did, privateKey: signer.privateKey, method, url, body: raw }));
    const r = await fetch(url, { method, headers, body: method === "GET" ? undefined : raw });
    return { status: r.status, ok: r.ok, body: await r.json().catch(() => ({})) };
  };
}
const must = (res, what) => { if (!res.ok) throw new Error(`${what}: ${res.status} ${res.body?.error || JSON.stringify(res.body).slice(0, 200)}`); return res.body; };
async function mcp(url, tool, args, { signer, headers = {} } = {}) {
  const c = await connectMcp(url, { name: "xonta-stand", fetch: signer ? signingFetch({ did: signer.did, privateKey: signer.privateKey, extraHeaders: headers }) : undefined });
  try {
    const out = await c.callTool({ name: tool, arguments: args });
    const text = (out.content || []).map((x) => x.text || "").join("");
    if (out.isError) throw new Error(`${tool}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally { await c.close().catch(() => {}); }
}

function llmFor(role) {
  const provider = E.LLM_PROVIDER || "mock";
  return createLLM({ provider, model: E.AGENT_MODEL || "mock-agent", role, usageFile: join(DIR, "llm-usage.jsonl"), budgetTokens: Number(E.AGENT_LLM_BUDGET_TOKENS || 3_000_000),
    mock: provider === "mock" ? (s, u) => mockMod.mockAgent(s, u) : null });
}
let mockMod = null;

// ---------- стенд ----------
const { eval: EVAL, traffic: TRAFFIC } = await loadProducts();
if ((E.LLM_PROVIDER || "mock") === "mock") mockMod = await import("./mock-llm.js");
let fixture = null, overrides = {};
if (FIXTURE) { const f = await import("./fixture-site.js"); fixture = await f.startFixtureSite({ port: PORT.fixture, products: [...EVAL, ...TRAFFIC] }); overrides = f.fixtureOverrides(fixture.url); }
if (!FIXTURE && (E.LLM_PROVIDER || "mock") === "mock") throw new Error("для работы с настоящими площадками нужна языковая модель: задайте LLM_PROVIDER, LLM_API_KEY, AGENT_MODEL, JUDGE_MODEL");

const orch = await startOrchestrator();
const api = makeApi(orch.url);
const ownerR = await startOwner({ port: PORT.ownerR, keyFile: join(DIR, "keys", "owner-consumer.jwk") });
const ownerS = await startOwner({ port: PORT.ownerS, keyFile: join(DIR, "keys", "owner-supplier.jwk") });
const client = await startOwner({ port: PORT.client, keyFile: join(DIR, "keys", "client.jwk") });
const fetcherR = createFetcher({ dir: join(DIR, "agents", "root", "fetch"), overrides, intervalMs: FIXTURE ? 0 : undefined });
const root = await startReviewsAgent({ port: PORT.root, name: "xonta-reviews", ownerDid: ownerR.did, dataDir: join(DIR, "agents", "root"), llm: llmFor("root"), fetcher: fetcherR, platforms: [P.phase1_platform], skills: R.baseSkills(P.example_limit) });
const kids = []; // { id, did, category, agent, gw }
let supplier = null;

async function onboard(agent, owner, name, extra = {}) {
  const reg = must(await api("POST", "/v1/agents", { name, mcp_url: agent.mcp, did: agent.did, owner_did: owner.did, ...extra }, { signer: owner }), `регистрация ${name}`);
  await ownerCall(owner, `${agent.url}/owner/challenge`, { token: reg.domain_challenge.content });
  must(await api("POST", `/v1/agents/${reg.id}/domain-check`, {}, { signer: owner }), `домен ${name}`);
  const scan = must(await api("POST", `/v1/agents/${reg.id}/scan`, {}, { signer: owner }), `проверка ${name}`);
  return { id: reg.id, owner_token: reg.owner_token, scan: scan.report.result };
}
const gw = (id) => `${orch.url}/gw/${id}/mcp`;

if (!run.ids.root) {
  const r = await onboard(root, ownerR, "xonta-reviews");
  must(await api("POST", `/v1/admin/agents/${r.id}/owner-verified`, { kind: "company", note: "владелец-потребитель стенда" }, { token: ADMIN }), "проверка владельца");
  run.ids.root = r;
  log(`агент отзывов ${r.id}: домен ✓, проверка MCP: ${r.scan}`);
}
const ROOT_ID = run.ids.root.id;
const allCats = [...new Set([...EVAL, ...TRAFFIC].map((p) => p.category)), ...[P.phase1_platform, ...SUPPLIER_PLATFORMS].map((p) => `platform:${p}`)];
const mandate = run.mandate || (run.mandate = sign(ownerR, "AgentMandate", { id: root.did, ...P.mandate, categories: allCats, auto_apply: false, note: "потомки только по сигналу оркестратора и решению владельца" }));

// восстановление потомков после перезапуска
for (const c of run.children) {
  const agent = await startReviewsAgent({ port: c.port, name: `xonta-reviews-${c.category}`, ownerDid: ownerR.did, dataDir: join(DIR, "agents", c.tmpId), llm: llmFor(c.tmpId), fetcher: null, platforms: [], specialization: c.category, parentDid: root.did });
  kids.push({ ...c, agent });
}

async function spawnChild(category, round, signalId) {
  if (signalId) must(await api("POST", `/v1/signals/${signalId}`, { action: "accept" }, { token: run.ids.root.owner_token }), "решение по сигналу");
  const port = PORT.child0 + kids.length;
  const tmpId = `child-${kids.length}`;
  const agent = await startReviewsAgent({ port, name: `xonta-reviews-${category}`, ownerDid: ownerR.did, dataDir: join(DIR, "agents", tmpId), llm: llmFor(tmpId), fetcher: null, platforms: [],
    specialization: category, skills: { ...structuredClone(root.state.skills), limit: P.example_limit }, parentDid: root.did, parentVersion: root.state.version });
  const { lineage } = await ownerCall(ownerR, `${root.url}/owner/sign-lineage`, { child_did: agent.did, mandate, scope: { category }, depth: 1 });
  const reg = must(await api("POST", `/v1/agents/${ROOT_ID}/children`, { name: `xonta-reviews-${category}`, mcp_url: agent.mcp, did: agent.did, mandate, lineage, specialization: category }, { signer: ownerR }), `потомок ${category}`);
  await ownerCall(ownerR, `${agent.url}/owner/challenge`, { token: reg.domain_challenge.content });
  must(await api("POST", `/v1/agents/${reg.id}/domain-check`, {}, { signer: ownerR }), "домен потомка");
  const scan = must(await api("POST", `/v1/agents/${reg.id}/scan`, {}, { signer: ownerR }), "проверка потомка");
  await ownerCall(ownerR, `${root.url}/owner/set-delegate`, { category, gateway_url: gw(reg.id), did: agent.did });
  const rec = { id: reg.id, tmpId, did: agent.did, category, port, born_round: round, signal: signalId || null, scan: scan.report.result, lineage_credential: reg.lineage.id, parent_signature: lineage.id };
  run.children.push(rec); kids.push({ ...rec, agent });
  log(`  ↳ потомок ${reg.id} «${category}» (раунд ${round}): мандат ✓, подпись родителя ✓, домен ✓, MCP: ${rec.scan}; корень делегирует ему категорию через шлюз`);
}

async function heldout(source, tool, products, mode) {
  const res = must(await api("POST", "/v1/heldout", { source, tool, products, mode }, { token: ADMIN }), "отложенная выборка");
  run.heldout.push({ at: new Date().toISOString(), source, tool, mode, added: res.added, total: res.total, by_category: res.by_category, statuses: res.statuses });
  log(`отложенная выборка (${mode}): +${res.added}, всего ${res.total}`, JSON.stringify(res.by_category));
}

async function startSupplierAgent() {
  const fetcherS = createFetcher({ dir: join(DIR, "agents", "supplier", "fetch"), overrides, intervalMs: FIXTURE ? 0 : undefined });
  supplier = await startSupplier({ port: PORT.supplier, ownerDid: ownerS.did, dataDir: join(DIR, "agents", "supplier"), llm: llmFor("supplier"), fetcher: fetcherS });
  if (!run.ids.supplier) { run.ids.supplier = await onboard(supplier, ownerS, "xonta-reviews-supplier"); log(`поставщик данных ${run.ids.supplier.id}: домен ✓, MCP: ${run.ids.supplier.scan}`); }
}
if (run.round >= P.phase1_rounds) await startSupplierAgent();

// ---------- раунд ----------
const agentByDid = (did) => (did === root.did ? { id: ROOT_ID, agent: root } : kids.find((k) => k.did === did));

async function round(r) {
  const phase = r <= P.phase1_rounds ? 1 : 2;
  const row = { round: r, phase, at: new Date().toISOString(), traffic: {}, feedback: {}, eval: {}, sources: {}, signals: [], merges: [] };
  // переход к фазе 2: поставщик, режим «площадки», выборка по площадкам
  if (phase === 2 && !supplier) {
    await startSupplierAgent();
    if (P.phase2_mode === "platform") await ownerCall(ownerR, `${root.url}/owner/set-mode`, { mode: "platform" });
    await heldout(run.ids.supplier.id, "supply", EVAL, P.phase2_mode);
    if (P.phase2_mode === "platform") await heldout(ROOT_ID, "collect_reviews", EVAL, "platform");
    row.note = `подключён поставщик данных; категории оценки — ${P.phase2_mode === "platform" ? "площадки" : "категории товаров"}`;
  }
  const start = ((r - 1) * P.products_per_round) % TRAFFIC.length;
  const products = Array.from({ length: P.products_per_round }, (_, i) => TRAFFIC[(start + i) % TRAFFIC.length]);
  const fb = new Map(); // agent did → [feedback]

  for (const product of products) {
    if (phase === 2) {
      const d = await ownerCall(ownerS, `${supplier.url}/owner/deliver`, { gateway_url: gw(ROOT_ID), product });
      for (const [p, x] of Object.entries(d.delivered)) row.sources[p] = { ...(row.sources[p] || {}), [product.key]: x.accepted ? `${x.accepted} отзывов` : x.status };
    }
    const plats = phase === 1 ? [P.phase1_platform] : [P.phase1_platform, ...SUPPLIER_PLATFORMS];
    for (const platform of plats) {
      const category = phase === 2 && P.phase2_mode === "platform" ? `platform:${platform}` : product.category;
      let res;
      try { res = await mcp(gw(ROOT_ID), "analyze_product", { product, platform }, { signer: client, headers: { "x-task-category": encodeURIComponent(category), "x-task-id": `r${r}-${product.key}-${platform}` } }); }
      catch (e) { row.sources[platform] = { ...(row.sources[platform] || {}), [product.key]: `ошибка: ${e.message.slice(0, 120)}` }; continue; }
      if (phase === 1) row.sources[P.phase1_platform] = { ...(row.sources[P.phase1_platform] || {}), [product.key]: res.sources[P.phase1_platform] };
      for (const g of res.groups) {
        const t = (row.traffic[g.category] ||= { products: 0, reviews: 0, assessed_by: {} });
        t.products++; t.reviews += g.reviews.length; t.assessed_by[g.assessed_by] = (t.assessed_by[g.assessed_by] || 0) + g.reviews.length;
        // обратная связь: судья размечает выборку из ответа, расхождения уходят тому, кто оценивал
        const sample = g.reviews.slice(0, P.judge_sample);
        if (!sample.length) continue;
        const { labels } = must(await api("POST", `/v1/agents/${ROOT_ID}/judge`, { product, category: g.category, reviews: sample }, { signer: ownerR }), "судья");
        const A = new Map(g.assessments.map((a) => [a.id, a]));
        for (const l of labels) {
          const a = A.get(l.id); if (!a || R.agrees(a, l)) continue;
          const err = R.DIMENSIONS.reduce((s, d) => s + Math.abs(a[d] - l[d]), 0);
          (fb.get(g.assessed_by) || fb.set(g.assessed_by, []).get(g.assessed_by)).push({ product, category: g.category, review: sample.find((x) => x.id === l.id), label: l, error: err });
        }
        const s = R.score(g.assessments.filter((a) => sample.some((x) => x.id === a.id)), labels);
        const tr = row.traffic[g.category]; tr.judged = (tr.judged || 0) + s.n; tr.agreed = (tr.agreed || 0) + Math.round(s.agreement * s.n);
      }
    }
  }
  // обучение: не больше FEEDBACK_BUDGET исправлений на агента за раунд, самые грубые первыми
  for (const [did, list] of fb) {
    const who = agentByDid(did); if (!who) continue;
    const send = list.sort((a, b) => b.error - a.error).slice(0, P.feedback_budget);
    const res = await mcp(gw(who.id), "learn", { feedback: send }, { signer: client });
    row.feedback[who.id] = { mistakes: list.length, sent: send.length, learned: res.learned, examples: res.examples };
  }
  // предложения и слияние
  if (kids.length && r % P.merge_every === 0) {
    let submitted = 0;
    // потомки прошлого режима (категории товаров после перехода к площадкам) остаются, но в слияние не идут
    const modePrefix = phase === 2 && P.phase2_mode === "platform" ? "platform:" : "goods:";
    for (const k of kids.filter((x) => x.category.startsWith(modePrefix))) {
      const { proposal } = await mcp(k.agent.mcp, "propose", {});
      if (!proposal) continue;
      const res = await api("POST", "/v1/proposals", { proposal });
      if (res.ok) submitted++; else log(`  предложение ${k.id}: ${res.body.error}`);
    }
    if (submitted) {
      const m = must(await api("POST", `/v1/agents/${ROOT_ID}/merge`, { round: r }, { signer: ownerR }), "слияние");
      const { merged_skills, ...rec } = m;
      run.merges.push(rec); row.merges.push(rec.id);
      log(`  ⇄ слияние ${m.id}: ${m.status}; корень ${m.before.overall}% → ${m.after.overall}%; принято ${m.accepted.length}, отклонено ${m.rejected.length}`);
      for (const x of m.rejected) log(`     ✗ ${x.from}/${x.category}: ${x.reason}`);
      if (m.status === "recommended") {
        await ownerCall(ownerR, `${root.url}/owner/apply`, { skills: merged_skills, source: m.id });
        for (const k of kids) await ownerCall(ownerR, `${k.agent.url}/owner/rebase`, { skills: root.state.skills, parent_version: root.state.version });
      }
    }
  }
  // аттестованная оценка и сигналы
  for (const who of [{ id: ROOT_ID, agent: root }, ...kids]) {
    const res = await api("POST", `/v1/agents/${who.id}/evaluate`, { round: r }, { signer: ownerR });
    if (!res.ok) { row.eval[who.id] = { error: res.body.error }; continue; }
    const ev = res.body;
    row.eval[who.id] = { overall: ev.overall, categories: Object.fromEntries(ev.categories.map((c) => [c.category, c.score])), credential: ev.credential.id, version: ev.skills.version };
    for (const s of ev.signals) {
      const entry = { round: r, agent: who.id, id: s.id, type: s.type, evidence: s.evidence, decision: null };
      run.signals.push(entry); row.signals.push(`${s.type}:${s.evidence?.category || ""}`);
      if (s.type === "spawn_specialist" && who.id === ROOT_ID) {
        const cat = s.evidence.category;
        const can = kids.length < P.mandate.max_children && !kids.some((k) => k.category === cat);
        entry.decision = can ? "accepted" : "skipped (лимит мандата или потомок уже есть)";
        if (can) await spawnChild(cat, r, s.id);
      }
    }
  }
  row.llm = { root: root.llm.usage, kids: Object.fromEntries(kids.map((k) => [k.id, k.agent.llm.usage])) };
  run.rounds.push(row); run.round = r; saveRun();
  log(`раунд ${r} (фаза ${phase}): оценка корня ${row.eval[ROOT_ID]?.overall ?? "—"}% ${JSON.stringify(row.eval[ROOT_ID]?.categories || {})} | обратная связь ${JSON.stringify(Object.fromEntries(Object.entries(row.feedback).map(([k, v]) => [k, v.sent])))}`);
}

// ---------- главный цикл ----------
try {
  if (!run.heldout.length) await heldout(ROOT_ID, "collect_reviews", EVAL, "goods");
  for (let r = run.round + 1; r <= P.total_rounds; r++) {
    await round(r);
    if (P.round_pause_min && r < P.total_rounds) { log(`пауза ${P.round_pause_min} мин`); await new Promise((ok) => setTimeout(ok, P.round_pause_min * 60_000)); }
  }
  // итог: паспорта и проверка
  run.final = { verify: {}, lineage: must(await api("GET", `/v1/agents/${ROOT_ID}/lineage`), "родословная").tree };
  for (const id of [ROOT_ID, ...kids.map((k) => k.id), ...(run.ids.supplier ? [run.ids.supplier.id] : [])]) {
    const rec = must(await api("GET", `/v1/agents/${id}/passport`), "паспорт");
    const v = must(await api("POST", "/v1/verify", { agent: rec.passport.id }), "verify");
    run.final.verify[id] = { name: rec.name, level: v.level, lineage: v.lineage, owner_inherited_from: v.owner_inherited_from, contributions: v.contributions, missing: v.missing_for_next_level, credentials: rec.credentials.length };
  }
  run.finished = new Date().toISOString();
  saveRun();
  log(`готово: ${join(DIR, "REPORT.md")}`);
} finally {
  orch.child.kill(); fixture?.close();
}
process.exit(0);

// ---------- отчёт ----------
function report() {
  const L = [];
  L.push(`# Стенд «Отзывы» — ${run.mode === "fixture" ? "ПРОВЕРКА НА УЧЕБНЫХ СТРАНИЦАХ (не результат)" : "работа с площадками"}`);
  L.push(`\nНачат ${run.started}${run.finished ? `, завершён ${run.finished}` : `, выполнено раундов: ${run.round}`}. Модель агентов: ${E.AGENT_MODEL || "заглушка"}, судья: ${E.JUDGE_MODEL || "заглушка"}.`);
  L.push(`\nОценка — доля отзывов отложенной выборки, где агент совпал с судьёй. Судья — более сильная модель, не истина.\n`);
  L.push(`| Раунд | Фаза | Оценка корня, % | По категориям | Обратная связь (отправлено) | Сигналы |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const x of run.rounds) L.push(`| ${x.round} | ${x.phase} | ${x.eval[ROOT_ID]?.overall ?? "—"} | ${Object.entries(x.eval[ROOT_ID]?.categories || {}).map(([c, v]) => `${c} ${v}`).join("; ")} | ${Object.entries(x.feedback).map(([k, v]) => `${k}: ${v.sent}/${v.mistakes}`).join("; ") || "—"} | ${x.signals.join(", ") || "—"} |`);
  L.push(`\n## Потомки\n`);
  for (const c of run.children) L.push(`- ${c.id} «${c.category}» — рождён в раунде ${c.born_round} по сигналу ${c.signal}; MCP: ${c.scan}; родословная ${c.lineage_credential}`);
  if (!run.children.length) L.push("Пока нет.");
  L.push(`\n## Слияния\n`);
  for (const m of run.merges) L.push(`- раунд ${m.round}: ${m.status}, ${m.before.overall}% → ${m.after.overall}%; принято: ${m.accepted.map((a) => a.category).join(", ") || "—"}; отклонено: ${m.rejected.map((a) => `${a.category} (${a.reason})`).join("; ") || "—"}`);
  if (!run.merges.length) L.push("Пока нет.");
  L.push(`\n## Источники\n`);
  const last = run.rounds.at(-1);
  if (last) for (const [p, v] of Object.entries(last.sources)) L.push(`- ${p}: ${Object.values(v).slice(0, 3).join("; ")}`);
  return L.join("\n") + "\n";
}
