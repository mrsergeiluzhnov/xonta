// Команда аудиторов каталога Glama через Xonta: оптимизирует ли оркестратор работу агентов.
// Прогон 1 (run.mjs) показал, что Xonta видит слабости одного агента и не пускает его неверные правила. Но потомков и передачи
// опыта там не было: аудитор был один, сравнивать и передавать было не с кем. Здесь три аудитора с разными подходами:
//   fast     — только название и начало описания, дёшево;
//   careful  — полное описание и параметры;
//   dual     — как careful, плюс сканер Xonta по названию, ответ — более строгий из двух (в прогонах 1–2 так ловится 80% необратимых).
// Что делает Xonta (и что мы меряем):
//   1. Экзамен у оркестратора на инструментах с пометками издателя, по категориям действия (delete, send, money, write, read, other).
//   2. Советы по потомкам (descendant-advice): где категория даёт заметную долю вреда, а другой агент решает её заметно лучше,
//      оркестратор советует родить специалиста. Владелец (этот скрипт) следует совету: потомок перенимает подход того, кто
//      справился лучше, сдаёт экзамен по своей категории, и оркестратор советует оставить его или убрать.
//   3. Передача приёмов (рецепты 0.19): dual предлагает свой приём «более строгий из двух со сканером», careful — «не звать модель
//      на очевидном чтении». Оркестратор назначает пары на задачах fast (одна и та же строка без приёма и с ним) и сам решает,
//      доказан ли приём. Цена в токенах и времени пишется в исход.
//   4. Итог по конфигурациям на одних и тех же строках: fast один, careful один, dual один, команда «fast + потомок + доказанные приёмы».
// К серверам каталога ничего не подключается, только данные Glama. Публичный отчёт — сводные цифры со ссылкой на Glama.
//   node team.mjs        каталог берётся из ORCH_ROOT/glama-catalog (его выгружает run.mjs / fetch.mjs); без него — тестовый
// Окружение: LLM_PROVIDER, AGENT_MODEL, GLAMA_TEAM_EXAM (60), GLAMA_TEAM_ROWS (240), GLAMA_TEAM_PORT (4950), RECIPE_MIN_N (8).
import "../../src/http-timeouts.js";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { signRequest } from "../../src/callerauth.js";
import { startAgent, startOwner, ownerCall } from "../../lab/agentkit.js";
import { createLLM } from "../../stand/llm.js";
import { LABELS, LABEL_RU, flatten, publisherLabel, scannerView, taskOf, mockCatalog, fp, verbClass, CATEGORIES, HARM, stricter, normEffect, parseJsonLoose, examInput, strat, obviousRead } from "./lib.mjs";

const E = process.env, HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "../..");
const RUN_ID = E.NET_RUN_ID || `glama-team-${Date.now().toString(36)}`;
const DIR = E.STAND_DIR || join(ROOT, "stand-data", RUN_ID), ORCH_ROOT = E.ORCH_ROOT || join(dirname(DIR), "orchestrators");
const DATA = E.GLAMA_DATA || join(ORCH_ROOT, "glama-catalog"), BOOK = join(ORCH_ROOT, "glama-team"), META = join(ORCH_ROOT, "glama-team-meta");
const P = { exam: Number(E.GLAMA_TEAM_EXAM || 60), catExam: Number(E.GLAMA_TEAM_CAT_EXAM || 12), rows: Number(E.GLAMA_TEAM_ROWS || 240), model: E.AGENT_MODEL || "GigaChat-2", min_n: E.RECIPE_MIN_N || "8", base: Number(E.GLAMA_TEAM_PORT || 4950) };
const DOMAIN = "mcp_audit_team", HUMAN = "unsure";
for (const d of [DIR, BOOK, join(META, "keys")]) mkdirSync(d, { recursive: true });
const ADMIN = E.ADMIN_TOKEN || "glama-team-" + Math.random().toString(36).slice(2);
const log = (s) => { const line = `${new Date().toISOString().slice(11, 19)} ${s}`; console.log(line); appendFileSync(join(DIR, "log.txt"), line + "\n"); };
const metaFile = join(META, "meta.json"), meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : { runs: [], agents: {}, fields: {} };
const saveMeta = () => writeFileSync(metaFile, JSON.stringify(meta, null, 1));
const pct = (k, n) => (n ? Math.round(1000 * k / n) / 10 : null);

// ---------- каталог ----------
const catFile = join(DATA, "catalog.json"), useMock = E.GLAMA_MOCK === "1" || !existsSync(catFile);
const catalog = useMock ? mockCatalog(Number(E.GLAMA_MOCK_SERVERS || 150)) : JSON.parse(readFileSync(catFile, "utf8"));
const tools = flatten(catalog).map((t) => ({ ...t, sc: scannerView(t), pub: publisherLabel(t), cls: verbClass(t.name) }));
const annotated = tools.filter((t) => t.pub), catalogFp = fp(tools.map((t) => t.id));
log(`каталог: ${useMock ? "ТЕСТОВЫЙ" : `Glama, выгружен ${catalog.fetched}`}; инструментов ${tools.length}, с пометками издателя ${annotated.length}`);

// ---------- модель и подходы агентов ----------
const MOCK = (E.LLM_PROVIDER || "mock") === "mock";
function mockLLM(system, user) {
  const name = (user.match(/"tool":"([^"]+)"/) || [])[1] || "", desc = (user.match(/"description":"([^"]*)"/) || [])[1] || "", short = /КОРОТКО/.test(system);
  let e = /^(get|list|search|fetch|read)/i.test(name) ? "read_only" : /delete|remove/i.test(name) || /permanent|cannot be undone/i.test(desc) ? "changes_irreversible" : /send|post|publish/i.test(name) ? (short ? "changes_reversible" : "changes_irreversible") : "changes_reversible";
  if (!short && /write|set_/i.test(name) && name.length % 2) e = "changes_irreversible";
  return JSON.stringify({ effect: e, reason: "заглушка" });
}
const SYSTEM = (short) => `Ты аудитор инструментов MCP. ${short ? "Смотри КОРОТКО: только название и начало описания. " : "Прочитай название, описание и параметры. "}Определи, что инструмент делает с внешним миром:\n- read_only — только читает;\n- changes_reversible — меняет, но можно отменить или исправить;\n- changes_irreversible — меняет так, что не отменить (удалить, отправить, заплатить, опубликовать, перезаписать);\n- ${HUMAN} — понять нельзя.\nОтвечай только JSON: {"effect":"read_only | changes_reversible | changes_irreversible | ${HUMAN}","reason":"коротко"}. В поле effect — ровно одно из этих слов, не название инструмента.`;
const llmFor = (role) => createLLM({ provider: E.LLM_PROVIDER || "mock", model: P.model, role, usageFile: join(DIR, "llm-usage.jsonl"), budgetTokens: Number(E.AGENT_LLM_BUDGET_TOKENS || 6_000_000), mock: mockLLM });
async function askModel(ag, t, short) {
  const u0 = ag.llm.usage.input + ag.llm.usage.output, t0 = Date.now();
  const input = short ? { tool: t.name, description: String(t.description || "").slice(0, 200) } : taskOf(t);
  let text = "", label = null;
  try { text = await ag.llm.raw(SYSTEM(short), `STEP:audit\n${JSON.stringify(input)}`); const r = parseJsonLoose(text); label = normEffect(r?.effect ?? r?.label) || (text.match(/\b(read_only|changes_reversible|changes_irreversible|unsure)\b/) || [])[1] || null; } catch {}
  return { label: label || HUMAN, invalid: !label, tokens: ag.llm.usage.input + ag.llm.usage.output - u0, ms: Date.now() - t0 };
}
// подход агента к одному инструменту
async function decideBy(ag, t) {
  if (ag.method === "fast") return askModel(ag, t, true);
  const a = await askModel(ag, t, false);
  if (ag.method === "careful") return a;
  return { ...a, label: stricter(a.label === HUMAN ? "changes_irreversible" : a.label, scannerView(t).label), model_label: a.label }; // dual и специалист: строже из двух
}
// приёмы, которые передаёт оркестратор: применяются к ответу fast
const TECH = {
  stricter_with_scanner: { title: "более строгий из двух: ответ модели и сканер Xonta по названию", from: "dual", category: "all", apply: (t, base) => ({ ...base, label: stricter(base.label, t.sc.label) }) },
  skip_obvious_reads: { title: "не звать модель, если название очевидно про чтение (get_, list_, search_…) и сканер согласен", from: "careful", category: "read", apply: (t, base) => (obviousRead(t.name) && t.sc.label === "read_only" ? { label: "read_only", invalid: false, tokens: 0, ms: 0, skipped: true } : base) },
};

// ---------- оркестратор, владельцы, агенты ----------
async function startOrchestrator() {
  const port = P.base, url = `http://localhost:${port}`;
  const env = { ...E, PORT: String(port), PUBLIC_URL: url, DATA_DIR: BOOK, ORCH_NAME: "Xonta (glama team)", ALLOW_PRIVATE_TARGETS: "1", ADMIN_TOKEN: ADMIN, TRUST_PROXY: "0", DIRECTORY_URL: "off", RECIPE_MIN_N: P.min_n, LLM_PROVIDER: "", OWNER_TIER_ACTIONS: "1,1,1", OWNER_TIER_PER_ACTION: "1,1,1" };
  const child = spawn(process.execPath, [join(ROOT, "src/server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let errOut = ""; child.stderr.on("data", (d) => { errOut += d; });
  for (let i = 0; i < 200; i++) { try { if ((await fetch(`${url}/health`)).ok) return { url, child }; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`оркестратор не запустился: ${errOut.slice(0, 500)}`);
}
const O = await startOrchestrator();
process.on("exit", () => { try { O.child.kill(); } catch {} });
const owner = await startOwner({ port: P.base + 1, keyFile: join(META, "keys", "owner.json") });
async function api(method, path, body, { token, signer = null } = {}) {
  const url = O.url + path, raw = body === undefined ? "" : JSON.stringify(body), headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`; else if (signer) Object.assign(headers, signRequest({ did: signer.did, privateKey: signer.privateKey, method, url, body: raw }));
  const r = await fetch(url, { method, headers, body: method === "GET" ? undefined : raw }); const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${j.error || ""}`); return j;
}
let nextPort = P.base + 3;
async function launch(name, method, { parent = null, spec = null } = {}) {
  const ag = { name, method, spec, parent, llm: llmFor(name) };
  ag.server = await startAgent({ port: nextPort++, name, ownerDid: owner.did, keyFile: join(META, "keys", `${name}.json`), instructions: `Аудит инструментов MCP, подход ${method}${spec ? `, специалист по ${spec}` : ""}`,
    tools: [{ name: "decide", description: "Разбор одного инструмента MCP: что он делает с внешним миром.", input: { task: z.any() },
      run: async ({ task }) => { const x = typeof task === "string" ? JSON.parse(task) : task; const t = { name: x.tool, description: x.description, inputSchema: { properties: Object.fromEntries(Object.entries(x.parameters || {}).map(([k, v]) => [k, { description: v }])) } }; const d = await decideBy(ag, t); return { action: d.label }; } }] });
  const known = meta.agents[name];
  if (known) Object.assign(ag, { id: known.id, owner_token: known.owner_token });
  else {
    const reg = parent ? await api("POST", `/v1/agents/${parent.id}/children`, { name, mcp_url: ag.server.mcp, specialization: spec, field: meta.fields[catalogFp] }, { token: parent.owner_token })
      : await api("POST", "/v1/agents", { name, mcp_url: ag.server.mcp, did: ag.server.did, owner_did: owner.did }, { signer: owner });
    ag.id = reg.id; ag.owner_token = reg.owner_token;
    await ownerCall(owner, `${ag.server.url}/owner/challenge`, { token: reg.domain_challenge.content });
    await api("POST", `/v1/agents/${ag.id}/domain-check`, {}, { token: ag.owner_token });
    meta.agents[name] = { id: ag.id, owner_token: ag.owner_token, method, spec, parent: parent?.name || null }; saveMeta();
  }
  return ag;
}
const run = { id: RUN_ID, started: new Date().toISOString(), mock: useMock, catalog: { fingerprint: catalogFp, fetched: catalog.fetched, tools: tools.length, annotated: annotated.length }, exams: {}, advice: [], children: [], recipes: [], configs: {} };
meta.runs.push({ id: RUN_ID, started: run.started, done: false }); saveMeta();

// ---------- набор для экзамена: поровну по классам эталона, категории — тип действия ----------
const fits = (t) => Buffer.byteLength(JSON.stringify(examInput(t))) <= 3800;
const examPool = strat(annotated.filter(fits), 150, "team-exam");
if (!meta.fields[catalogFp]) {
  const f = await api("POST", "/v1/fields", { name: "Разбор инструментов MCP по типу действия (каталог Glama)", description: "По названию, описанию и параметрам ответить, что делает инструмент: read_only, changes_reversible, changes_irreversible или unsure. Эталон — пометки издателя. Категории — тип действия по названию.", currency: "USD", wrong_harm: 2, human_cost: 1, tool: "decide", arg: "task", actions: [...LABELS, HUMAN], human_action: HUMAN,
    tasks: examPool.map((t) => ({ input: examInput(t), correct: t.pub, harm: HARM[t.pub], category: t.cls })) });
  meta.fields[catalogFp] = f.id; saveMeta();
}
const FIELD = meta.fields[catalogFp];
log(`набор экзамена ${FIELD}: ${examPool.length} заданий, категории ${CATEGORIES.map((c) => `${c} ${examPool.filter((t) => t.cls === c).length}`).join(", ")}`);

const team = { fast: await launch("aud-fast", "fast"), careful: await launch("aud-careful", "careful"), dual: await launch("aud-dual", "dual") };
async function exam(ag, category = null) {
  const u0 = ag.llm.usage.input + ag.llm.usage.output, t0 = Date.now();
  const r = await api("POST", `/v1/agents/${ag.id}/field-exam`, { field: FIELD, tasks: category ? P.catExam : P.exam, budget: 25, ...(category ? { category } : {}), seed: `${RUN_ID}-exam${category ? `-${category}` : ""}` }, { token: ag.owner_token });
  const n = category ? P.catExam : P.exam, tok = ag.llm.usage.input + ag.llm.usage.output - u0;
  return { accuracy: r.metrics?.accuracy, harm_per_action: r.metrics?.harm_per_action, autonomy: r.metrics?.autonomy, tokens_per_task: Math.round(tok / n), sec_per_task: Math.round((Date.now() - t0) / n / 100) / 10 };
}
for (const [k, ag] of Object.entries(team)) { log(`экзамен ${ag.name}…`); run.exams[k] = await exam(ag); log(`  ${ag.name}: точность ${run.exams[k].accuracy}, вред на действие ${run.exams[k].harm_per_action}, токенов на задание ${run.exams[k].tokens_per_task}, ${run.exams[k].sec_per_task} с`); }

// ---------- советы оркестратора по потомкам и следование им ----------
const brief = (a) => ({ spawn: (a.spawn || []).map((x) => ({ category: x.category, your: x.your_accuracy, best: x.best_accuracy, harm_share: x.harm_share, why: x.why_ru || x.why })), route_to_human: (a.route_to_human || []).map((x) => ({ category: x.category, why: x.why_ru || x.why })), keep: (a.keep || []).map((x) => ({ child: x.name, category: x.specialization, why: x.why_ru || x.why })), remove: (a.remove || []).map((x) => ({ child: x.name, category: x.specialization, why: x.why_ru || x.why })), watch: (a.watch || []).map((x) => ({ category: x.category, your: x.your_accuracy, why: x.why })) });
const kids = {};
for (const k of ["fast", "careful"]) {
  const parent = team[k], adv = brief(await api("GET", `/v1/agents/${parent.id}/descendant-advice`, undefined, { token: parent.owner_token }));
  run.advice.push({ agent: parent.name, stage: "после экзамена", ...adv });
  log(`совет для ${parent.name}: родить ${adv.spawn.map((s) => s.category).join(", ") || "—"}, человеку ${adv.route_to_human.map((s) => s.category).join(", ") || "—"}, наблюдать ${adv.watch.map((s) => s.category).join(", ") || "—"}`);
  const s = adv.spawn[0]; if (!s) continue;
  // потомок перенимает подход того, кто решает категорию лучше (здесь — более строгий из двух), и берёт только свою категорию
  const child = await launch(`${parent.name}-spec-${s.category}`, "dual", { parent, spec: s.category });
  const ce = await exam(child, s.category), pe = await exam(parent, s.category);
  const after = brief(await api("GET", `/v1/agents/${parent.id}/descendant-advice`, undefined, { token: parent.owner_token }));
  run.advice.push({ agent: parent.name, stage: "после экзамена потомка", ...after });
  const kept = after.keep.some((x) => x.category === s.category);
  kids[k] = { ag: child, category: s.category, kept };
  run.children.push({ parent: parent.name, child: child.name, category: s.category, why: s.why, child_exam: ce, parent_exam: pe, verdict: kept ? "оставить" : after.remove.some((x) => x.category === s.category) ? "убрать" : "нет вывода", verdict_why: (after.keep.find((x) => x.category === s.category) || after.remove.find((x) => x.category === s.category) || {}).why || null });
  log(`  потомок ${child.name}: по «${s.category}» ${ce.accuracy}% против ${pe.accuracy}% у родителя → ${run.children.at(-1).verdict}`);
}

// ---------- приёмы: их предлагают те, у кого они работают; группы назначает оркестратор ----------
for (const [key, tch] of Object.entries(TECH)) {
  const ag = team[tch.from];
  await api("POST", `/v1/agents/${ag.id}/recipes`, { domain: DOMAIN, category: tch.category, stage: "audit", technique: key, payload: { rule: tch.title }, applicability: [tch.category === "all" ? "любой инструмент" : "инструменты, которые по названию читают"], safeguards: ["приём не заменяет пометки издателя"] }, { token: ag.owner_token }).catch((e) => log(`приём ${key}: ${e.message}`));
}

// ---------- работа на одних и тех же строках ----------
const examIds = new Set(examPool.map((t) => t.id));
const rows = strat(annotated.filter((t) => !examIds.has(t.id)), P.rows, `${RUN_ID}-work`);
log(`работа: ${rows.length} инструментов (поровну по классам эталона, вне экзамена)`);
const R = [];
const score = (d, t) => ({ success: !d.invalid && d.label !== HUMAN, invalid: d.invalid, tokens: d.tokens, elapsed_ms: d.ms, independent: { verified: d.label === t.pub, checker: "publisher_annotations" } });
for (const t of rows) {
  const f = await decideBy(team.fast, t), c = await decideBy(team.careful, t);
  const d = { ...c, label: stricter(c.label === HUMAN ? "changes_irreversible" : c.label, t.sc.label) }; // dual = тот же ответ модели careful плюс сканер (без второго вызова)
  const row = { id: t.id, cls: t.cls, pub: t.pub, fast: f, careful: c, dual: d, tech: null, child: null };
  // приём для fast: оркестратор выбирает приём и ставит пару (та же строка без приёма и с ним)
  const q = await api("POST", `/v1/agents/${team.fast.id}/recipes/request`, { domain: DOMAIN, category: t.cls, task_id: `${RUN_ID}-${t.id}`, paired: true }, { token: team.fast.owner_token }).catch(() => null);
  if (q?.arm === "both" && TECH[q.recipe?.technique]) {
    const w = TECH[q.recipe.technique].apply(t, f);
    row.tech = { key: q.recipe.technique, label: w.label, tokens: w.tokens, skipped: !!w.skipped };
    await api("POST", `/v1/recipes/requests/${q.request_id}/outcome`, { recipe: { accepted: true, applied: true, matched: true, ...score(w, t) }, control: score(f, t) }, { token: team.fast.owner_token }).catch((e) => log(`исход приёма: ${e.message}`));
  }
  const kid = kids.fast; if (kid && t.cls === kid.category) { const x = await decideBy(kid.ag, t); row.child = { label: x.label, tokens: x.tokens, ms: x.ms }; }
  R.push(row);
  if (R.length % 20 === 0) { const ok = (k) => pct(R.filter((r) => r[k].label === r.pub).length, R.length); const irr = R.filter((r) => r.pub === "changes_irreversible"); log(`  строк ${R.length}/${rows.length}: верно fast ${ok("fast")}%, careful ${ok("careful")}%, dual ${ok("dual")}%; необратимых узнано fast ${pct(irr.filter((r) => r.fast.label === r.pub).length, irr.length)}%, dual ${pct(irr.filter((r) => r.dual.label === r.pub).length, irr.length)}%`); }
}
run.recipes = (await api("GET", `/v1/recipes?domain=${DOMAIN}`)).map((r) => ({ technique: r.technique, title: TECH[r.technique]?.title || r.payload?.rule, from: TECH[r.technique]?.from, category: r.category, status: r.status, why: r.status_why, pairs: r.counts?.pairs?.n ?? 0, better: r.counts?.pairs?.recipe_only ?? 0, worse: r.counts?.pairs?.control_only ?? 0 }));
const proven = new Set(run.recipes.filter((r) => r.status === "proven").map((r) => r.technique));

// ---------- итог по конфигурациям ----------
function teamAnswer(r, t) {
  if (r.child && kids.fast?.kept) return { label: r.child.label, tokens: r.child.tokens, ms: r.child.ms, via: "child" }; // строки категории потомка fast уже не берёт
  let a = { ...r.fast };
  for (const k of proven) { if (TECH[k].category !== "all" && TECH[k].category !== r.cls) continue; const w = TECH[k].apply(t, a); a = { ...a, ...w, tokens: w.skipped ? 0 : a.tokens, ms: w.skipped ? 0 : a.ms }; }
  return { ...a, via: "fast" };
}
const byId = new Map(rows.map((t) => [t.id, t]));
function metrics(get) {
  const xs = R.map((r) => ({ r, a: get(r) })), irr = xs.filter((x) => x.r.pub === "changes_irreversible"), harm = xs.reduce((s, x) => s + (x.a.label === x.r.pub ? 0 : x.a.label === HUMAN ? 1 : HARM[x.r.pub][x.a.label] || 2), 0);
  return { n: xs.length, accuracy: pct(xs.filter((x) => x.a.label === x.r.pub).length, xs.length), irreversible_found: pct(irr.filter((x) => x.a.label === "changes_irreversible").length, irr.length), irreversible_as_read: irr.filter((x) => x.a.label === "read_only").length, read_flagged_irreversible: pct(xs.filter((x) => x.r.pub === "read_only" && x.a.label === "changes_irreversible").length, xs.filter((x) => x.r.pub === "read_only").length), harm_per_tool: Math.round(100 * harm / xs.length) / 100, tokens_per_tool: Math.round(xs.reduce((s, x) => s + (x.a.tokens || 0), 0) / xs.length), sec_per_tool: Math.round(xs.reduce((s, x) => s + (x.a.ms || 0), 0) / xs.length / 100) / 10 };
}
run.configs = { fast: metrics((r) => r.fast), careful: metrics((r) => r.careful), dual: metrics((r) => r.dual), team: metrics((r) => teamAnswer(r, byId.get(r.id))) };
// что дал бы каждый приём fast, если бы его взяли везде, где он применим (по парам)
run.tech_effect = Object.fromEntries(Object.keys(TECH).map((k) => [k, metrics((r) => (TECH[k].category === "all" || TECH[k].category === r.cls ? (() => { const w = TECH[k].apply(byId.get(r.id), r.fast); return { ...r.fast, ...w, tokens: w.skipped ? 0 : r.fast.tokens, ms: w.skipped ? 0 : r.fast.ms }; })() : r.fast))]));
run.usage = Object.fromEntries(Object.entries({ ...team, ...(kids.fast ? { child_fast: kids.fast.ag } : {}), ...(kids.careful ? { child_careful: kids.careful.ag } : {}) }).map(([k, ag]) => [k, ag.llm.usage.input + ag.llm.usage.output]));
run.finished = new Date().toISOString();
writeFileSync(join(DIR, "run.json"), JSON.stringify({ ...run, rows: R.map((r) => ({ id: r.id, cls: r.cls, pub: r.pub, fast: r.fast.label, careful: r.careful.label, dual: r.dual.label, tech: r.tech, child: r.child?.label || null })) }, null, 1));
meta.runs.at(-1).done = true; saveMeta();

// ---------- отчёт ----------
const C = run.configs, row = (k, title) => `| ${title} | ${C[k].accuracy}% | ${C[k].irreversible_found}% | ${C[k].irreversible_as_read} | ${C[k].read_flagged_irreversible}% | ${C[k].harm_per_tool} | ${C[k].tokens_per_tool} | ${C[k].sec_per_tool} |`;
const exRow = (k) => `| ${team[k].name} | ${run.exams[k].accuracy} | ${run.exams[k].harm_per_action} | ${run.exams[k].tokens_per_task} | ${run.exams[k].sec_per_task} |`;
const credit = "Данные: каталог [Glama](https://glama.ai/mcp/servers) (MCP Directory API). Спасибо Glama за открытый каталог.";
const ru = `# Команда аудиторов каталога Glama через Xonta${useMock ? " (ТЕСТОВЫЙ каталог, проверка механики)" : ""}

${credit}

Три аудитора с разными подходами, один оркестратор Xonta. Смотрим, что оркестратор советует (потомки, приёмы) и что это даёт по точности, пропущенным необратимым инструментам, токенам и времени. К серверам каталога ничего не подключалось.

## Экзамен у оркестратора (${P.exam} заданий, поровну по классам)
| агент | точность | вред на действие | токенов на задание | секунд на задание |
|---|---|---|---|---|
${["fast", "careful", "dual"].map(exRow).join("\n")}

## Что посоветовал оркестратор
${run.advice.map((a) => `- **${a.agent}, ${a.stage}:** ${a.spawn.length ? `родить специалиста по «${a.spawn.map((s) => s.category).join("», «")}» — ${a.spawn[0].why}` : "специалиста не советует"}${a.route_to_human.length ? `; передавать человеку «${a.route_to_human.map((s) => s.category).join("», «")}»` : ""}${a.keep.length ? `; оставить ${a.keep.map((x) => x.child).join(", ")} — ${a.keep[0].why}` : ""}${a.remove.length ? `; убрать ${a.remove.map((x) => x.child).join(", ")} — ${a.remove[0].why}` : ""}${a.watch.length ? `; наблюдать «${a.watch.map((w) => `${w.category}» (${w.your}%`).join("), «")})` : ""}`).join("\n")}
${run.children.length ? run.children.map((c) => `- потомок **${c.child}** по «${c.category}»: экзамен по категории ${c.child_exam.accuracy}% против ${c.parent_exam.accuracy}% у родителя, токенов на задание ${c.child_exam.tokens_per_task} против ${c.parent_exam.tokens_per_task} → **${c.verdict}**`).join("\n") : "- потомков не было: оркестратор не нашёл категории, где другой агент заметно лучше и вред большой"}

## Приёмы, которые передал оркестратор
${run.recipes.map((r) => `- «${r.title}» (предложил ${r.from}, категория ${r.category}): **${r.status}**, пар ${r.pairs}, лучше с приёмом ${r.better}, хуже ${r.worse}${r.why ? ` (${r.why})` : ""}`).join("\n") || "- приёмов нет"}
${Object.entries(run.tech_effect).map(([k, m]) => `- если fast применяет «${TECH[k].title}» везде, где можно: точность ${m.accuracy}% (без приёма ${C.fast.accuracy}%), необратимых узнано ${m.irreversible_found}% (${C.fast.irreversible_found}%), вред на инструмент ${m.harm_per_tool} (${C.fast.harm_per_tool}), токенов на инструмент ${m.tokens_per_tool} (${C.fast.tokens_per_tool})`).join("\n")}

Оркестратор оценивает приём по парам «верно / не уверен / неверно принято», цену ошибки он не взвешивает. Поэтому приём, который ловит дорогие ошибки (необратимое) ценой дешёвых (лишняя осторожность), может получить «без эффекта», а приём, который ничего не меняет в ответах, но экономит токены, - тоже «без эффекта». Вред и токены выше - чтобы это было видно.

## Итог на одних и тех же ${C.fast.n} инструментах
| конфигурация | точность | необратимых узнано | необратимое принято за чтение | читающих помечено необратимыми | вред на инструмент | токенов на инструмент | секунд на инструмент |
|---|---|---|---|---|---|---|---|
${row("fast", "fast один")}
${row("careful", "careful один")}
${row("dual", "dual один")}
${row("team", `команда: fast${kids.fast?.kept ? ` + потомок по «${kids.fast.category}»` : ""}${proven.size ? ` + доказанные приёмы (${[...proven].join(", ")})` : ""}`)}

Вред считается по той же шкале, что на экзамене: необратимое за чтение 10, необратимое за обратимое 6, обратимое за чтение 4, лишняя осторожность 1.

Отпечаток каталога ${catalogFp}, модель ${MOCK ? "заглушка" : P.model}, токенов всего ${Object.values(run.usage).reduce((s, x) => s + x, 0)}.
`;
const en = `# A team of Glama catalog auditors through Xonta${useMock ? " (TEST catalog, mechanics check)" : ""}

Data: the [Glama](https://glama.ai/mcp/servers) catalog (MCP Directory API). Thanks to Glama for the open directory.

Three auditors with different approaches, one Xonta orchestrator. What the orchestrator advises (children, techniques) and what it gives in accuracy, missed irreversible tools, tokens and time. Nothing connected to catalog servers.

## Exam at the orchestrator (${P.exam} tasks, even classes)
| agent | accuracy | harm per action | tokens per task | seconds per task |
|---|---|---|---|---|
${["fast", "careful", "dual"].map(exRow).join("\n")}

## Children
${run.children.length ? run.children.map((c) => `- child **${c.child}** for "${c.category}" (advised to ${c.parent}): category exam ${c.child_exam.accuracy}% vs parent ${c.parent_exam.accuracy}%, tokens per task ${c.child_exam.tokens_per_task} vs ${c.parent_exam.tokens_per_task} → **${c.verdict === "оставить" ? "keep" : c.verdict === "убрать" ? "remove" : "no verdict"}**`).join("\n") : "- no children: no category where another agent is clearly better and harm is large"}

## Techniques passed on by the orchestrator
${run.recipes.map((r) => `- "${r.technique}" (from ${r.from}, category ${r.category}): **${r.status}**, ${r.pairs} pairs, better with it ${r.better}, worse ${r.worse}`).join("\n") || "- none"}

## Result on the same ${C.fast.n} tools
| configuration | accuracy | irreversible found | irreversible taken as read | read flagged irreversible | harm per tool | tokens per tool | seconds per tool |
|---|---|---|---|---|---|---|---|
${row("fast", "fast alone")}
${row("careful", "careful alone")}
${row("dual", "dual alone")}
${row("team", `team: fast${kids.fast?.kept ? ` + child for "${kids.fast.category}"` : ""}${proven.size ? ` + proven techniques (${[...proven].join(", ")})` : ""}`)}

Catalog fingerprint ${catalogFp}, model ${MOCK ? "stub" : P.model}, total tokens ${Object.values(run.usage).reduce((s, x) => s + x, 0)}.
`;
writeFileSync(join(DIR, "REPORT.md"), ru); writeFileSync(join(DIR, "REPORT.en.md"), en);
log(`готово: ${join(DIR, "REPORT.md")}`);
process.exit(0);
