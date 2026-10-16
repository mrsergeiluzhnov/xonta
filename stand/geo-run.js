// Стенд «Репутация»: оркестратор + деревья агентов репутации (организация: оценка отзыва и срочность ответа) + с 11-го
// раунда поставщик размеченных отзывов. Эталон точный — оценка, которую поставил автор (Georeview, MIT); судья не нужен.
//
// TREES — сколько независимых деревьев работает под одним оркестратором (прогон 4: 3). У каждого дерева свой владелец,
// свой корень, свои потомки и свой срез трафика; общий у них только оркестратор — и его опыт советов. Так стенд
// моделирует рынок: опыт, набранный на одних агентах, должен делать советы точнее для других.
//
// Раунды 1–10: клиент присылает отзывы (validation), агент оценивает, ответы с оценками автора возвращаются ему.
// Оркестратор оценивает каждый узел на своём эталоне (test), подаёт сигналы и советы; владелец исполняет советы,
// кроме контрольных (их выбирает советник). Раунды 11+: поставщик приносит каждому дереву порцию размеченных отзывов (train).
// Состояние сохраняется после каждого раунда: при перезапуске стенд продолжает с того же места.
import "../src/http-timeouts.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMcp } from "../src/scan.js";
import { signRequest, signingFetch } from "../src/callerauth.js";
import { startOwner, ownerCall, sign } from "../lab/agentkit.js";
import { createLLM } from "./llm.js";
import { createGeoData } from "./geo-data.js";
import { startGeoAgent } from "./geo-agent.js";
import { startGeoSupplier } from "./geo-supplier.js";
import * as G from "../skills/xonta-geo.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const E = process.env;
const DIR = E.STAND_DIR || join(ROOT, "stand-data", "geo");
const FIXTURE = E.STAND_MODE === "fixture";
const MOCK = (E.LLM_PROVIDER || "mock") === "mock";
const P = {
  trees: Math.max(1, Math.min(6, Number(E.TREES || 1))), tree_parallel: E.TREE_PARALLEL !== "0",
  phase1_rounds: Number(E.PHASE1_ROUNDS || 10), total_rounds: Number(E.TOTAL_ROUNDS || 20),
  traffic_per_round: Number(E.TRAFFIC_PER_ROUND || 30), supply_per_round: Number(E.SUPPLY_PER_ROUND || 120),
  feedback_budget: Number(E.FEEDBACK_BUDGET || 4), heldout: Number(E.HELDOUT_SIZE || 400), merge_pool_extra: Number(E.MERGE_POOL_EXTRA || 0),
  learn: E.GEO_LEARN || "examples", merge_test: E.MERGE_TEST || "threshold", merge_sample: Number(E.MERGE_SAMPLE ?? 120), feedback_all: E.FEEDBACK_ALL === "1",
  merge_every: Number(E.MERGE_EVERY || 2), merge_rotate_every: Number(E.MERGE_ROTATE_EVERY || 0), merge_sequential: E.MERGE_SEQUENTIAL === "1",
  round_pause_min: Number(E.ROUND_PAUSE_MIN || 0), example_limit: Number(E.SKILL_EXAMPLE_LIMIT || 8),
  mandate: { max_children: Number(E.MAX_CHILDREN || 3), max_depth: Number(E.MAX_DEPTH || 1), categories: G.GROUPS },
  max_children_total: Number(E.MAX_CHILDREN_TOTAL || E.MAX_CHILDREN || 3), // на одно дерево
  advisor: E.ADVISOR === "1", root_sees_all: E.ROOT_SEES_ALL === "1", router: E.GEO_ROUTER === "1",
  rule_candidates: Number(E.GEO_RULE_CANDIDATES || 1), min_margin: Number(E.GEO_MIN_MARGIN || 1),
};
const ADMIN = E.ADMIN_TOKEN || "stand-admin-" + Math.random().toString(36).slice(2);
const PORT = { orch: 4040, ownerS: 4302, client: 4303, supplier: 4390, owner0: 4350, tree0: 4400, treeStep: 50 };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
mkdirSync(DIR, { recursive: true });
const RUN = join(DIR, "run.json");
const run = existsSync(RUN) ? JSON.parse(readFileSync(RUN, "utf8")) : { round: 0, ids: {}, trees: [], rounds: [], merges: [], signals: [], advice: [], params: P, mode: FIXTURE ? "fixture" : "live", started: new Date().toISOString() };
run.trees ||= []; run.advice ||= [];
const saveRun = () => { writeFileSync(RUN, JSON.stringify(run, null, 1)); writeFileSync(join(DIR, "REPORT.md"), report()); };
if (!FIXTURE && MOCK) throw new Error("для работы на настоящих данных нужна языковая модель: LLM_PROVIDER, LLM_API_KEY, AGENT_MODEL");

const mock = MOCK ? await import("./geo-mock.js") : null;
const data = createGeoData({ dir: join(DIR, "dataset"), fixture: FIXTURE ? mock.fixtureRows : null });
// бюджеты: на каждого агента и общий на всех агентов стенда (STAND_LLM_BUDGET_TOKENS); расход прошлых запусков учитывается при перезапуске
const SHARED = { used: (() => { try { return readFileSync(join(DIR, "llm-usage.jsonl"), "utf8").split("\n").filter(Boolean).reduce((n, l) => { const x = JSON.parse(l); return n + (x.in || 0) + (x.out || 0); }, 0); } catch { return 0; } })(),
  limit: Number(E.STAND_LLM_BUDGET_TOKENS || Infinity) };
const llmFor = (role, isRoot) => createLLM({ provider: E.LLM_PROVIDER || "mock", model: E.AGENT_MODEL || "mock-agent", role, usageFile: join(DIR, "llm-usage.jsonl"),
  budgetTokens: Number((isRoot ? E.AGENT_LLM_BUDGET_TOKENS : E.CHILD_LLM_BUDGET_TOKENS || E.AGENT_LLM_BUDGET_TOKENS) || 2_000_000), mock: mock ? mock.mockAgent : null, shared: SHARED });

// ---------- инфраструктура ----------
async function startOrchestrator() {
  const env = { ...E, PORT: String(PORT.orch), PUBLIC_URL: `http://localhost:${PORT.orch}`, DATA_DIR: join(DIR, "orchestrator"), ALLOW_PRIVATE_TARGETS: "1", AUTO_ANCHOR: "1",
    SIGNAL_COOLDOWN_MIN: E.SIGNAL_COOLDOWN_MIN || "0", ADMIN_TOKEN: ADMIN, TRUST_PROXY: "0", LLM_PROVIDER: E.LLM_PROVIDER || "mock", OWNER_HMAC_SECRET: E.OWNER_HMAC_SECRET || "stand",
    MOCK_LLM_MODULE: E.MOCK_LLM_MODULE || join(HERE, "geo-mock.js") };
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
  const c = await connectMcp(url, { name: "xonta-geo-stand", fetch: signer ? signingFetch({ did: signer.did, privateKey: signer.privateKey, extraHeaders: headers }) : undefined });
  try {
    const out = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: Number(process.env.MCP_TOOL_TIMEOUT_MS || 600000) });
    const text = (out.content || []).map((x) => x.text || "").join("");
    if (out.isError) throw new Error(`${tool}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally { await c.close().catch(() => {}); }
}
// поставщик один на все деревья, его порция хранится у него до передачи — шаги поставки идут строго по очереди
let supplyLock = Promise.resolve();
const serial = (fn) => { const p = supplyLock.then(fn, fn); supplyLock = p.catch(() => {}); return p; };

// ---------- участники ----------
const orch = await startOrchestrator();
const api = makeApi(orch.url);
const ownerS = await startOwner({ port: PORT.ownerS, keyFile: join(DIR, "keys", "owner-supplier.jwk") });
const client = await startOwner({ port: PORT.client, keyFile: join(DIR, "keys", "client.jwk") });
let supplier = null;
const gw = (id) => `${orch.url}/gw/${id}/mcp`;

async function onboard(agent, owner, name) {
  const reg = must(await api("POST", "/v1/agents", { name, mcp_url: agent.mcp, did: agent.did, owner_did: owner.did }, { signer: owner }), `регистрация ${name}`);
  await ownerCall(owner, `${agent.url}/owner/challenge`, { token: reg.domain_challenge.content });
  must(await api("POST", `/v1/agents/${reg.id}/domain-check`, {}, { signer: owner }), `домен ${name}`);
  const scan = must(await api("POST", `/v1/agents/${reg.id}/scan`, {}, { signer: owner }), `проверка ${name}`);
  return { id: reg.id, owner_token: reg.owner_token, scan: scan.report.result };
}
// все узлы дерева специализаций: группа → оценка → длина отзыва
const ALL_KEYS = [...new Set([1, 2, 3, 4, 5].flatMap((r) => ["short", "long"].flatMap((l) => G.pathOf(l === "short" ? "x" : "x".repeat(G.LEN_SPLIT + 1), r))))];

// одно дерево: владелец, корень, потомки; состояние — в run.trees[t]
async function createTree(t) {
  const st = (run.trees[t] ||= { ids: {}, children: [], mandates: {}, spawn_hold: {}, routing_focus: [] });
  // прогон 3 и раньше: одно дерево хранилось в корне run.json
  if (t === 0 && !st.ids.root && run.ids.root) Object.assign(st, { ids: run.ids, children: run.children || [], mandates: run.mandates || {}, spawn_hold: run.spawn_hold || {} });
  const name = P.trees > 1 ? `xonta-reputation-t${t + 1}` : "xonta-reputation";
  const tag = P.trees > 1 ? `[Д${t + 1}] ` : "";
  const base = PORT.tree0 + t * PORT.treeStep;
  const owner = await startOwner({ port: PORT.owner0 + t, keyFile: join(DIR, "keys", P.trees > 1 ? `owner-t${t + 1}.jwk` : "owner-org.jwk") });
  const agentsDir = join(DIR, "agents", ...(P.trees > 1 ? [`t${t + 1}`] : []));
  const root = await startGeoAgent({ port: base, name, ownerDid: owner.did, dataDir: join(agentsDir, "root"), llm: llmFor(P.trees > 1 ? `t${t + 1}-root` : "root", true), skills: G.baseSkills(P.example_limit) });
  if (!st.ids.root) {
    st.ids.root = await onboard(root, owner, name);
    must(await api("POST", `/v1/admin/agents/${st.ids.root.id}/owner-verified`, { kind: "company", note: `организация-владелец дерева ${t + 1}` }, { token: ADMIN }), "проверка владельца");
    log(`${tag}агент репутации ${st.ids.root.id}: домен ✓, проверка MCP: ${st.ids.root.scan}`);
  }
  const T = { t, st, name, tag, base, owner, root, kids: [], agentsDir, rootId: st.ids.root.id };
  for (const c of st.children) {
    T.kids.push({ ...c, agent: await startGeoAgent({ port: c.port, name: `${name}-${c.category}`, ownerDid: owner.did, dataDir: join(agentsDir, c.tmpId), llm: llmFor(P.trees > 1 ? `t${t + 1}-${c.tmpId}` : c.tmpId, false), specialization: c.category, parentDid: c.parent_did || root.did }) });
  }
  return T;
}
const rootWho = (T) => ({ id: T.rootId, agent: T.root, did: T.root.did, depth: 0, category: null, owner_token: T.st.ids.root.owner_token });
const childrenOfWho = (T, who) => T.kids.filter((k) => (k.parent_did || T.root.did) === who.did);
const whoByDid = (T, did) => (did === T.root.did ? rootWho(T) : T.kids.find((k) => k.did === did));
const whoById = (T, id) => (id === T.rootId ? rootWho(T) : T.kids.find((k) => k.id === id));
const descendantsOf = (T, who) => { const out = new Set(), q = [who]; while (q.length) for (const k of childrenOfWho(T, q.shift())) { out.add(k.did); q.push(k); } return out; };

// мандат владельца выдаётся каждому родителю отдельно: глубина — общая, категории — только внутри области родителя
function mandateFor(T, who) {
  if (!T.st.mandates[who.did]) {
    const categories = who.category ? ALL_KEYS.filter((k) => k.startsWith(who.category + "/")) : G.GROUPS;
    T.st.mandates[who.did] = sign(T.owner, "AgentMandate", { id: who.did, max_children: P.mandate.max_children, max_depth: P.mandate.max_depth, categories, auto_apply: false, note: "потомки только по сигналу оркестратора и решению владельца" });
  }
  return T.st.mandates[who.did];
}

async function spawnChild(T, parent, category, round, signalId) {
  if (signalId) must(await api("POST", `/v1/signals/${signalId}`, { action: "accept" }, { token: parent.owner_token }), "решение по сигналу");
  // tmpId уникален: после сбоя посреди рождения повторная попытка не возьмёт ключ (и DID) уже зарегистрированного потомка
  const port = T.base + 1 + T.kids.length, tmpId = `child-${T.kids.length}-${randomBytes(3).toString("hex")}`, depth = (parent.depth || 0) + 1;
  const mandate = mandateFor(T, parent);
  const agent = await startGeoAgent({ port, name: `${T.name}-${category}`, ownerDid: T.owner.did, dataDir: join(T.agentsDir, tmpId), llm: llmFor(P.trees > 1 ? `t${T.t + 1}-${tmpId}` : tmpId, false),
    specialization: category, skills: structuredClone(parent.agent.state.skills), parentDid: parent.did, parentVersion: parent.agent.state.version });
  // родословную потомка подписывает родитель своим ключом (на любом уровне дерева), регистрирует — владелец дерева
  const { lineage } = await ownerCall(T.owner, `${parent.agent.url}/owner/sign-lineage`, { child_did: agent.did, mandate, scope: { category }, depth });
  const reg = must(await api("POST", `/v1/agents/${parent.id}/children`, { name: `${T.name}-${category}`, mcp_url: agent.mcp, did: agent.did, mandate, lineage, specialization: category }, { signer: T.owner }), `потомок ${category}`);
  await ownerCall(T.owner, `${agent.url}/owner/challenge`, { token: reg.domain_challenge.content });
  must(await api("POST", `/v1/agents/${reg.id}/domain-check`, {}, { signer: T.owner }), "домен потомка");
  const scan = must(await api("POST", `/v1/agents/${reg.id}/scan`, {}, { signer: T.owner }), "проверка потомка");
  await ownerCall(T.owner, `${parent.agent.url}/owner/set-delegate`, { category, gateway_url: gw(reg.id), did: agent.did });
  const rec = { id: reg.id, tmpId, did: agent.did, category, port, depth, parent_id: parent.id, parent_did: parent.did, owner_token: reg.owner_token, born_round: round, signal: signalId || null, scan: scan.report.result, lineage_credential: reg.lineage.id, parent_signature: lineage.id };
  T.st.children.push(rec); T.kids.push({ ...rec, agent }); saveRun();
  log(`${T.tag}  ↳ ${"  ".repeat(depth - 1)}потомок ${reg.id} «${G.labelOf(category)}» (глубина ${depth}, родитель ${parent.id}, раунд ${round}): мандат ✓, подпись родителя ✓, домен ✓, MCP: ${rec.scan}`);
}

async function sendFeedback(T, row, mistakesByDid) {
  for (const [did, list] of Object.entries(mistakesByDid)) {
    const who = whoByDid(T, did); if (!who) continue;
    if (P.root_sees_all && who.id === T.rootId) continue; // корень получает весь трафик отдельно
    const send = list.sort((a, b) => b.error - a.error).slice(0, P.feedback_budget);
    const res = await mcp(gw(who.id), "learn", { feedback: send.map(({ to, by, ...x }) => x) }, { signer: client });
    const f = (row.feedback[who.id] ||= { mistakes: 0, sent: 0, learned: 0 });
    f.mistakes += list.filter((x) => x.error > 0).length; f.sent += send.length; f.learned += res.learned; f.examples = res.examples;
    if (res.check) (f.rules ||= []).push({ category: res.category, kept: !!res.learned, candidates: res.candidates, ...res.check });
  }
}

function spawnBlocker(T, who, cat) {
  const depth = (who.depth || 0) + 1;
  return depth > P.mandate.max_depth ? `глубина ${depth} больше разрешённой ${P.mandate.max_depth}` : T.kids.length >= P.max_children_total ? `уже ${T.kids.length} потомков (лимит дерева)`
    : childrenOfWho(T, who).length >= P.mandate.max_children ? "у родителя предел потомков по мандату" : T.kids.some((k) => k.category === cat) ? "специалист уже есть" : null;
}

// ---------- советы оркестратора ----------
// Группу совета (выполнить / контроль) выбирает советник: блочная рандомизация по типу и сэмплирование Томпсона.
// Владелец исполняет выполняемые и отклоняет контрольные — от содержания совета это не зависит.
async function handleAdvice(T, row, r, ev) {
  const bySignal = {};
  if (!P.advisor) return bySignal;
  for (const a of ev.advice_resolved || []) {
    const x = run.advice.find((y) => y.id === a.id); if (x) x.outcome = a.outcome;
    if (a.type === "spawn_specialist") delete T.st.spawn_hold[`${a.target}|${a.scope}`]; // контроль измерен — рождение снова разрешено
    (row.advice_resolved ||= []).push({ id: a.id, type: a.type, decision: a.status, arm_reason: a.arm_reason, predicted: a.predicted, success: a.outcome.success, gain_pp: a.outcome.gain_pp });
    log(`${T.tag}  ${a.outcome.success ? "✓" : "✗"} исход совета ${a.id} «${a.type}» (${a.status === "accepted" ? "выполнен" : "контроль"}, прогноз ${a.predicted}): ${a.outcome.before_pp}% → ${a.outcome.after_pp}% на ${a.outcome.n} отзывах, +${a.outcome.improved} / −${a.outcome.worsened}, p = ${a.outcome.p_value}`);
  }
  for (const a of ev.advice || []) {
    const target = whoById(T, a.target);
    // рождение, которое мандат или лимит дерева не позволят, — совет недействителен (void), а не «выполнен без действия»
    const blockedSpawn = a.type === "spawn_specialist" && target ? spawnBlocker(T, target, a.scope) : null;
    if (blockedSpawn) {
      must(await api("POST", `/v1/advice/${a.id}`, { action: "void" }, { signer: T.owner }), "совет недействителен");
      if (a.signal) bySignal[a.signal] = "void";
      log(`${T.tag}  💡 совет ${a.id} «spawn_specialist» [${a.scope}] недействителен: ${blockedSpawn}`);
      continue;
    }
    const decision = a.arm === "control" ? "decline" : "accept";
    must(await api("POST", `/v1/advice/${a.id}`, { action: decision }, { signer: T.owner }), "решение по совету");
    let done = null;
    try {
      if (decision === "accept" && target) {
        if (a.action.kind === "restore") done = await ownerCall(T.owner, `${target.agent.url}/owner/restore`, { hash: a.action.hash, min_margin: a.action.min_margin });
        if (a.action.kind === "set_objective") done = await ownerCall(T.owner, `${target.agent.url}/owner/set-objective`, { text: a.action.text });
        if (a.action.kind === "routing_focus") { done = await ownerCall(T.owner, `${target.agent.url}/owner/routing-focus`, { category: a.action.category }); if (!T.st.routing_focus.includes(target.id)) T.st.routing_focus.push(target.id); saveRun(); }
      }
    } catch (e) { done = { error: e.message }; }
    if (a.signal) bySignal[a.signal] = decision === "accept" ? "accepted" : "declined";
    if (a.type === "spawn_specialist" && decision === "decline") T.st.spawn_hold[`${a.target}|${a.scope}`] = a.id;
    run.advice.push({ id: a.id, tree: T.t + 1, round: r, type: a.type, agent: a.agent, target: a.target, scope: a.scope, confidence: a.confidence, predicted: a.predicted, arm: a.arm, arm_reason: a.arm_reason, thompson: a.thompson, prob_better: a.prob_better,
      track_record: a.track_record, evidence: a.evidence, action: a.action, decision: decision === "accept" ? "accepted" : "declined", done });
    (row.advice ||= []).push({ id: a.id, type: a.type, target: a.target, decision, arm_reason: a.arm_reason }); saveRun();
    const why = a.arm_reason === "block_control" ? "КОНТРОЛЬ (блок)" : a.arm_reason === "policy_withheld" ? `УДЕРЖАН политикой (выборка ${a.thompson?.treat} ≤ ${a.thompson?.control})` : "выполнен";
    log(`${T.tag}  💡 совет ${a.id} «${a.type}» → ${a.target === T.rootId ? "корень" : a.target} [${a.scope || "всё"}], прогноз успеха ${a.predicted}, P(лучше бездействия) ${a.prob_better} (опыт: ${a.track_record.success}/${a.track_record.accepted} выполненных, ${a.track_record.control_success}/${a.track_record.control} контроль): ${why}${done?.error ? ` (ошибка действия: ${done.error})` : ""}`);
  }
  return bySignal;
}

async function treeRound(T, r, phase) {
  const row = { traffic: {}, feedback: {}, eval: {}, supply: null, signals: [], merges: [] };
  const labeled = []; // все размеченные отзывы раунда с тем, кто их в итоге оценил — для обучения распределению
  // 1) трафик клиента: у каждого дерева свой срез validation
  const offset = T.t * P.total_rounds * P.traffic_per_round + (r - 1) * P.traffic_per_round;
  const batch = await data.slice("validation", offset, P.traffic_per_round);
  const groups = {}; for (const x of batch) (groups[x.category] ||= []).push(x);
  const mistakes = {};
  for (const [category, list] of Object.entries(groups)) {
    const res = await mcp(gw(T.rootId), "rate_reviews", { reviews: list.map(({ id, text }) => ({ id, text })) }, { signer: client, headers: { "x-task-category": encodeURIComponent(category), "x-task-id": `t${T.t + 1}-r${r}-${category}` } });
    const Pm = new Map(res.ratings.map((x) => [x.id, x]));
    const t = (row.traffic[category] ||= { n: 0, ok: 0, by: {}, blocked: 0 });
    for (const x of list) {
      const p = Pm.get(x.id); t.n++; if (p?.rating === x.rating) t.ok++;
      t.by[p?.by || "?"] = (t.by[p?.by || "?"] || 0) + 1; if (p?.route === "blocked") t.blocked++;
      if (p?.by) labeled.push({ ...x, by: p.by });
      if (p && (P.feedback_all || p.rating !== x.rating)) (mistakes[p.by] ||= []).push({ ...x, predicted: p.rating ?? null, error: Math.abs((p.rating ?? 3) - x.rating) });
    }
  }
  await sendFeedback(T, row, mistakes);
  if (P.root_sees_all) {
    const res = await mcp(gw(T.rootId), "learn", { feedback: batch.slice(0, 50).map((x) => ({ ...x, predicted: null, error: 0 })), round: r }, { signer: client });
    const f = (row.feedback[T.rootId] ||= { mistakes: 0, sent: 0, learned: 0 }); f.sent += Math.min(50, batch.length); f.learned += res.learned;
    if (res.check) (f.rules ||= []).push({ category: res.category, kept: !!res.learned, candidates: res.candidates, ...res.check });
    if (res.routing) f.routing = res.routing;
  }
  // 2) поставщик (фаза 2): порция размеченных отзывов дереву через шлюз корня; ответы потомков передаются им
  if (phase === 2 && T.st.supply_done !== r) {
    const d = await serial(async () => {
      if (T.st.supply_prepared?.round !== r) { const pr = await ownerCall(ownerS, `${supplier.url}/owner/prepare`, { n: P.supply_per_round, key: `t${T.t}` }); T.st.supply_prepared = { round: r, ...pr }; saveRun(); }
      const out = { delivered: T.st.supply_prepared.delivered, cursor: T.st.supply_prepared.cursor, results: {} };
      for (const category of T.st.supply_prepared.categories) out.results[category] = (await ownerCall(ownerS, `${supplier.url}/owner/send`, { gateway_url: gw(T.rootId), category, budget: P.feedback_budget, key: `t${T.t}` })).result;
      T.st.supply_done = r; saveRun();
      return out;
    });
    row.supply = { delivered: d.delivered, cursor: d.cursor, by_category: Object.fromEntries(Object.entries(d.results).map(([c, x]) => [c, x.error ? { error: x.error } : { checked: x.checked, correct: x.correct, learned: x.learned }])) };
    const forKids = {};
    for (const x of Object.values(d.results)) for (const w of x.for_delegates || []) { (forKids[w.to] ||= []).push(w); labeled.push({ ...w, by: w.to }); }
    await sendFeedback(T, row, forKids);
  }
  // 2б) обучение распределению по совету: узлу с потомками — отзывы, которые он передал вниз, с оценкой автора
  for (const id of T.st.routing_focus || []) {
    const who = whoById(T, id); if (!who || (P.root_sees_all && id === T.rootId)) continue;
    const D = descendantsOf(T, who);
    const routing = labeled.filter((x) => D.has(x.by)).slice(0, 400).map(({ id: rid, text, rating, category }) => ({ id: rid, text, rating, category }));
    const res = await mcp(gw(who.id), "learn", { feedback: [], routing, round: r }, { signer: client });
    if (res.routing) (row.feedback[who.id] ||= { mistakes: 0, sent: 0, learned: 0 }).routing = res.routing;
  }
  // 3) предложения потомков и слияния снизу вверх
  if (T.kids.length && r % P.merge_every === 0) {
    const parents = [rootWho(T), ...T.kids].filter((w) => childrenOfWho(T, w).length).sort((a, b) => (b.depth || 0) - (a.depth || 0));
    for (const par of parents) {
      let submitted = 0;
      for (const k of childrenOfWho(T, par)) {
        const { proposal } = await mcp(k.agent.mcp, "propose", {});
        if (!proposal) continue;
        const res = await api("POST", "/v1/proposals", { proposal });
        if (res.ok) submitted++; else log(`${T.tag}  предложение ${k.id}: ${res.body.error}`);
      }
      if (!submitted) continue;
      let m = null;
      try { m = must(await api("POST", `/v1/agents/${par.id}/merge`, { round: r }, { signer: T.owner }), "слияние"); }
      catch (e) { log(`${T.tag}  слияние у ${par.id} не выполнено: ${e.message} — раунд продолжается`); (row.merge_errors ||= []).push({ parent: par.id, error: e.message }); continue; }
      const { merged_skills, ...rec } = m;
      run.merges.push({ ...rec, tree: T.t + 1, parent_depth: par.depth || 0, parent_category: par.category || null }); row.merges.push(rec.id);
      log(`${T.tag}  ⇄ слияние ${m.id} у ${par.id === T.rootId ? "корня" : `«${G.labelOf(par.category)}»`} (окно ${m.heldout?.window ?? 0}): ${m.status}; ${m.before.overall}% → ${m.after.overall}% на ${m.heldout?.cases ?? "?"} отзывах; принято ${m.accepted.length}, отклонено ${m.rejected.length}`);
      for (const x of m.accepted) log(`${T.tag}     ✓ ${x.from}/${x.category}: +${x.gain_pp} п.п.${x.p_value != null ? `, p = ${x.p_value} < α ${x.alpha ?? ""}` : ""}`);
      for (const x of m.rejected) log(`${T.tag}     ✗ ${x.from}/${x.category}: ${x.reason}`);
      if (m.status === "recommended") {
        await ownerCall(T.owner, `${par.agent.url}/owner/apply`, { skills: merged_skills, source: m.id });
        const queue = [par];
        while (queue.length) {
          const p0 = queue.shift();
          for (const k of childrenOfWho(T, p0)) { await ownerCall(T.owner, `${k.agent.url}/owner/rebase`, { skills: p0.agent.state.skills, parent_version: p0.agent.state.version }); queue.push(k); }
        }
      }
    }
  }
  // 4) аттестованная оценка на эталоне оркестратора, советы и сигналы
  for (const who of [rootWho(T), ...T.kids]) {
    const res = await api("POST", `/v1/agents/${who.id}/evaluate`, { round: r }, { signer: T.owner });
    if (!res.ok) { row.eval[who.id] = { error: res.body.error }; log(`${T.tag}  оценка ${who.id}: ${res.body.error}`); continue; }
    const ev = res.body;
    row.eval[who.id] = { overall: ev.overall, urgent: ev.urgent_accuracy, categories: Object.fromEntries(ev.categories.map((c) => [c.category, c.score])), credential: ev.credential.id, version: ev.skills.version, unanswered: ev.unanswered || 0, ...(ev.routing ? { routing: ev.routing } : {}), ...(ev.preds ? { preds: ev.preds } : {}) };
    const bySignal = await handleAdvice(T, row, r, ev);
    for (const s of ev.signals) {
      const entry = { tree: T.t + 1, round: r, agent: who.id, id: s.id, type: s.type, evidence: s.evidence, decision: null };
      run.signals.push(entry); row.signals.push(`${s.type}:${s.evidence?.category || ""}`);
      if (s.type === "spawn_specialist") {
        const cat = s.evidence.category, depth = (who.depth || 0) + 1;
        const why = spawnBlocker(T, who, cat);
        // без советника рождение по сигналу; с советником — только если совет о рождении не контрольный
        const control = bySignal[s.id] === "declined" || !!T.st.spawn_hold[`${who.id}|${cat}`] || (P.advisor && !(s.id in bySignal));
        entry.decision = why ? `skipped: ${why}` : control ? (bySignal[s.id] === "declined" || T.st.spawn_hold[`${who.id}|${cat}`] ? "control: совет о рождении в контрольной группе" : "skipped: советник не выдал совет (уже есть открытый)") : "accepted";
        if (!why && !control) await spawnChild(T, who, cat, r, s.id);
      }
    }
  }
  // советы, оставшиеся без решения (вызов оценки оборвался после того, как оркестратор их выдал), решаются сейчас
  if (P.advisor) {
    const seen = new Set((row.advice || []).map((a) => a.id)), left = [];
    for (const who of [rootWho(T), ...T.kids]) {
      const res = await api("GET", `/v1/agents/${who.id}/advice`, undefined, { signer: T.owner });
      if (res.ok) for (const a of res.body) if (a.status === "new" && a.target === who.id && !seen.has(a.id)) { seen.add(a.id); left.push(a); }
    }
    if (left.length) {
      log(`${T.tag}  советы без решения: ${left.length} — решаются сейчас`);
      await handleAdvice(T, row, r, { advice: left });
      // рождение по такому совету: сигнал уже прошёл, поэтому исполняется здесь
      for (const a of left.filter((x) => x.type === "spawn_specialist" && x.arm !== "control")) {
        const who = whoById(T, a.target);
        if (who && !spawnBlocker(T, who, a.scope)) { try { await spawnChild(T, who, a.scope, r, a.signal); } catch (e) { log(`${T.tag}  рождение по совету ${a.id} не выполнено: ${e.message}`); } }
      }
    }
  }
  row.rules = Object.fromEntries([[T.rootId, T.root], ...T.kids.map((k) => [k.id, k.agent])].map(([id, a]) => [id, { tried: a.state.rulesTried || 0, kept: a.state.rulesKept || 0, routing_tried: a.state.routingTried || 0, routing_kept: a.state.routingKept || 0 }]));
  row.llm = structuredClone({ root: T.root.llm.usage, kids: Object.fromEntries(T.kids.map((k) => [k.id, k.agent.llm.usage])) });
  return row;
}

async function round(r, trees) {
  const phase = r <= P.phase1_rounds ? 1 : 2;
  if (phase === 2 && !supplier) {
    supplier = await startGeoSupplier({ port: PORT.supplier, ownerDid: ownerS.did, dataDir: join(DIR, "agents", "supplier"), data });
    if (!run.ids.supplier) { run.ids.supplier = await onboard(supplier, ownerS, "xonta-geo-supplier"); log(`поставщик данных ${run.ids.supplier.id}: домен ✓, MCP: ${run.ids.supplier.scan}`); }
  }
  // деревья идут параллельно; при ошибке в одном раунд повторяется только для деревьев, которые его не завершили
  // завершённые деревья раунда сохраняются в run.json: после перезапуска процесса раунд повторяется только для остальных
  if (run.partial?.round !== r) run.partial = { round: r, rows: {} };
  const once = async (T) => { if (!run.partial.rows[T.t]) { run.partial.rows[T.t] = await treeRound(T, r, phase); saveRun(); } return run.partial.rows[T.t]; };
  let rows;
  if (P.tree_parallel) {
    const res = await Promise.allSettled(trees.map(once));
    const bad = res.find((x) => x.status === "rejected");
    if (bad) throw bad.reason;
    rows = res.map((x) => x.value);
  } else { rows = []; for (const T of trees) rows.push(await once(T)); }
  const row = { round: r, phase, at: new Date().toISOString(), trees: rows.map((x, i) => ({ tree: i + 1, root: trees[i].rootId, ...x })) };
  for (const T of trees) delete T.st.supply_prepared;
  delete run.partial;
  run.rounds.push(row); run.round = r; saveRun();
  for (const [i, x] of rows.entries()) {
    const T = trees[i], e = x.eval[T.rootId];
    const tr = Object.entries(x.traffic).map(([c, t]) => `${c.slice(7)} ${t.ok}/${t.n}${t.blocked ? ` (оставлено ${t.blocked})` : ""}`).join(", ");
    const lost = Object.values(x.eval).reduce((n, v) => n + (v.unanswered || 0), 0);
    log(`${T.tag}раунд ${r} (фаза ${phase}): эталон корня ${e?.overall ?? "—"}% (срочность ${e?.urgent ?? "—"}%)${lost ? ` ⚠ без ответа модели ${lost}` : ""} ${JSON.stringify(e?.categories || {})}${e?.routing ? ` | не тому потомку ${e.routing.wrong_pp}%, оставлено себе ${e.routing.blocked}` : ""} | трафик ${tr}${x.supply ? ` | поставщик ${x.supply.delivered}` : ""} | правила (оставлено/попыток) ${Object.entries(x.rules).map(([k, v]) => `${k.slice(-4)} ${v.kept}/${v.tried}${v.routing_tried ? ` р${v.routing_kept}/${v.routing_tried}` : ""}`).join(", ")}`);
  }
  if (trees.length > 1) { const v = rows.map((x, i) => x.eval[trees[i].rootId]?.overall).filter((x) => x != null); log(`раунд ${r}: среднее по корням ${v.length ? Math.round(10 * v.reduce((s, x) => s + x, 0) / v.length) / 10 : "—"}%`); }
}

let trees = [];
try {
  for (let t = 0; t < P.trees; t++) trees.push(await createTree(t));
  if (!run.heldout) {
    // эталон: первые HELDOUT_SIZE отзывов test (как в прогонах 1–3: чётные — оценка, нечётные — слияния) + пул свежих отзывов
    // для слияний (MERGE_POOL_EXTRA), разбитый на окна по числу отзывов слияний в базе; окна меняются каждые MERGE_ROTATE_EVERY раундов
    const items = await data.slice("test", 0, P.heldout + P.merge_pool_extra);
    const winSize = Math.max(1, Math.floor(P.heldout / 2));
    const body = items.map(({ text, rating }, i) => (i < P.heldout ? { text, rating } : { text, rating, split: "merge", window: 1 + Math.floor((i - P.heldout) / winSize) }));
    run.heldout = must(await api("POST", "/v1/heldout/geo", { items: body, source: { ...data.source, split: "test", n: items.length } }, { token: ADMIN }), "эталонная выборка");
    log(`эталон оркестратора: ${run.heldout.total} отзывов ${JSON.stringify(run.heldout.by_split || {})}, окон слияния ${run.heldout.merge_windows ?? 1}, отпечаток оценки ${run.heldout.eval_hash || run.heldout.hash}`);
    saveRun();
  }
  for (let r = run.round + 1; r <= P.total_rounds; r++) {
    // раунд не начинается, если его вероятный расход (как у прошлого раунда, с запасом 20%) не помещается в общий бюджет
    if (SHARED.used + 1.2 * (run.last_round_tokens || 0) >= SHARED.limit || SHARED.used >= SHARED.limit * 0.97) { log(`общий бюджет токенов почти исчерпан (${SHARED.used} из ${SHARED.limit}) — прогон остановлен после раунда ${r - 1}`); run.stopped = { after_round: r - 1, reason: "budget", used: SHARED.used }; saveRun(); break; }
    for (let attempt = 1; ; attempt++) {
      const before = SHARED.used;
      try { await round(r, trees); run.last_round_tokens = SHARED.used - before; saveRun(); break; }
      catch (e) {
        log(`раунд ${r}: ошибка (попытка ${attempt}/3): ${e.message}`);
        (run.errors ||= []).push({ round: r, attempt, at: new Date().toISOString(), error: String(e.message).slice(0, 300) }); saveRun();
        if (attempt >= 3) throw e;
        await new Promise((ok) => setTimeout(ok, FIXTURE ? 1000 : 120_000));
      }
    }
    if (P.round_pause_min && r < P.total_rounds) { log(`пауза ${P.round_pause_min} мин`); await new Promise((ok) => setTimeout(ok, P.round_pause_min * 60_000)); }
  }
  run.final = { verify: {}, lineage: {} };
  for (const T of trees) {
    run.final.lineage[T.t + 1] = must(await api("GET", `/v1/agents/${T.rootId}/lineage`), "родословная").tree;
    for (const id of [T.rootId, ...T.kids.map((k) => k.id)]) {
      const rec = must(await api("GET", `/v1/agents/${id}/passport`), "паспорт");
      const v = must(await api("POST", "/v1/verify", { agent: rec.passport.id }), "verify");
      run.final.verify[id] = { tree: T.t + 1, name: rec.name, level: v.level, lineage: v.lineage, owner_inherited_from: v.owner_inherited_from, contributions: v.contributions, missing: v.missing_for_next_level, credentials: rec.credentials.length };
    }
  }
  if (P.advisor) run.advisor = must(await api("GET", `/v1/advisor?split_round=${Math.floor(P.total_rounds / 2)}`), "советник");
  run.finished = new Date().toISOString();
  saveRun();
  log(`готово: ${join(DIR, "REPORT.md")}`);
} finally { orch.child.kill(); }
process.exit(0);

function report() {
  const NT = run.params?.trees || 1;
  const rootIds = (run.trees || []).map((t) => t.ids?.root?.id);
  const L = [`# Стенд «Репутация» — ${run.mode === "fixture" ? "ПРОВЕРКА НА УЧЕБНЫХ ДАННЫХ (не результат)" : "Georeview, оценки авторов"}`,
    `\nНачат ${run.started}${run.finished ? `, завершён ${run.finished}` : `, выполнено раундов: ${run.round}`}. Модель агентов: ${E.AGENT_MODEL || "заглушка"}. Деревьев: ${NT}.`,
    `Обучение: ${P.learn === "rules" ? `правила по накопленным ошибкам${P.rule_candidates > 1 ? `, ${P.rule_candidates} варианта за попытку с историей версий (OPRO)` : ""}, запас самопроверки ${P.min_margin}` : `примеры ошибок (не больше ${P.example_limit})`}; распределение: ${P.router ? "отдельный навык, при несогласии отзыв остаётся у узла" : "по собственной оценке узла"}.`,
    `Слияния: ${P.merge_test === "mcnemar" ? `парная проверка, тест Макнемара${P.merge_sequential ? " с поправкой на повторные попытки" : ""}` : "порог"}; ${P.merge_rotate_every ? `свежее окно отзывов каждые ${P.merge_rotate_every} раундов` : "одни и те же отзывы"}.`,
    `Эталон: ${run.heldout ? `${run.heldout.total} отзывов (test), отпечаток оценочной части ${run.heldout.eval_hash || run.heldout.hash}` : "—"}. Оценка — доля отзывов, где агент угадал оценку автора точно.\n`,
    `| Раунд | Фаза | ${rootIds.map((_, i) => `Корень Д${i + 1}, %`).join(" | ")}${NT > 1 ? " | Среднее, %" : ""} | Не тому потомку, % (по деревьям) | Сигналы |`, `|---|---|${rootIds.map(() => "---|").join("")}${NT > 1 ? "---|" : ""}---|---|`];
  for (const x of run.rounds) {
    const ts = x.trees || [];
    const v = ts.map((t) => t.eval?.[t.root]?.overall ?? null);
    const ok = v.filter((y) => y != null);
    L.push(`| ${x.round} | ${x.phase} | ${v.map((y) => y ?? "—").join(" | ")}${NT > 1 ? ` | ${ok.length ? Math.round(10 * ok.reduce((s, y) => s + y, 0) / ok.length) / 10 : "—"}` : ""} | ${ts.map((t) => t.eval?.[t.root]?.routing?.wrong_pp ?? "—").join(" / ")} | ${ts.flatMap((t) => t.signals.map((s) => `Д${t.tree}:${s}`)).join(", ") || "—"} |`);
  }
  L.push(`\n## Потомки\n`);
  (run.trees || []).forEach((t, i) => {
    L.push(`**Дерево ${i + 1}** (корень ${t.ids?.root?.id || "—"})`);
    for (const c of t.children || []) L.push(`- ${"  ".repeat((c.depth || 1) - 1)}${c.id} «${G.labelOf(c.category)}» — глубина ${c.depth || 1}, родитель ${c.parent_id}, раунд ${c.born_round}; MCP: ${c.scan}`);
    if (!(t.children || []).length) L.push("- пока нет");
  });
  if (P.advisor) {
    L.push(`\n## Советы оркестратора\n`, `| Раунд | Дерево | Совет | Цель | Область | Прогноз | Группа | Исход |`, `|---|---|---|---|---|---|---|---|`);
    const arm = (a) => (a.arm_reason === "block_control" ? "контроль (блок)" : a.arm_reason === "policy_withheld" ? "удержан политикой" : "выполнен");
    for (const a of run.advice || []) L.push(`| ${a.round} | ${a.tree} | ${a.type} | ${rootIds.includes(a.target) ? "корень" : a.target} | ${a.scope || "—"} | ${a.predicted ?? a.confidence} | ${arm(a)} | ${a.outcome ? `${a.outcome.success ? "успех" : "нет"}: ${a.outcome.before_pp}% → ${a.outcome.after_pp}% (+${a.outcome.improved}/−${a.outcome.worsened}, n=${a.outcome.n})` : "ещё не измерен"} |`);
    if (run.advisor) {
      const A = run.advisor, C = A.calibration;
      L.push(`\nИтог: советов ${A.given}, измерено ${A.resolved}; успешных среди выполненных ${A.accepted_success_rate ?? "—"}, среди контрольных ${A.control_success_rate ?? "—"}.`);
      if (C) L.push(`Калибровка: оценка Брайера ${C.brier} (базовая ${C.baseline_brier}, навык ${C.skill}); первая половина ${C.brier_first_half ?? "—"} (n=${C.n_first}), вторая ${C.brier_second_half ?? "—"} (n=${C.n_second}).`,
        `\n| Прогноз | Советов | Средний прогноз | Доля успехов |`, `|---|---|---|---|`, ...C.reliability.map((b) => `| ${b.bin} | ${b.n} | ${b.mean_predicted} | ${b.actual} |`));
      L.push("");
      for (const [t, x] of Object.entries(A.by_type)) L.push(`- ${t} (горизонт ${x.horizon_rounds}): дано ${x.given} (выполнено ${x.treatment}, контроль ${x.control_block}, удержано ${x.withheld}); успехи ${x.accepted.success}/${x.accepted.n} против ${x.control.success}/${x.control.n} в контроле; разница прироста ${x.diff_gain_pp ?? "—"} п.п.; P(лучше бездействия) ${x.prob_better}`);
    }
  }
  L.push(`\n## Слияния\n`);
  for (const m of run.merges) L.push(`- раунд ${m.round}, дерево ${m.tree ?? 1}, у ${rootIds.includes(m.parent) ? "корня" : m.parent}, окно ${m.heldout?.window ?? 0}: ${m.status}, ${m.before.overall}% → ${m.after.overall}%${m.test ? ` (+${m.test.b} / −${m.test.c} из ${m.test.n}, p = ${m.test.p_value})` : ""}; принято: ${m.accepted.map((a) => `${a.category}${a.p_value != null ? ` p=${a.p_value} α=${a.alpha}` : ""}`).join(", ") || "—"}; отклонено: ${m.rejected.map((a) => `${a.category} (${a.reason})`).join("; ") || "—"}`);
  if (!run.merges.length) L.push("Пока нет.");
  return L.join("\n") + "\n";
}
