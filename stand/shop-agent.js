// Агент-закупщик (xonta-shop/1): тратит деньги владельца по поручению — товары и платные инструменты.
// Варианты запрашивает у поставщика (агент №3) через шлюз оркестратора, решает моделью, платит тестовым эквайером
// (лимит в токене задаёт владелец — по рекомендации оркестратора или вручную). Учится на разборах сделок от владельца:
// переписывает правила категории, новая версия остаётся, только если на прошлых сделках она даёт меньше сожаления.
//
// role: "buyer" — покупатель; "senior" — старший закупщик на сильной модели (потомок покупателя): ему покупатель передаёт
// решения по категориям или суммам, которые укажет владелец (по совету оркестратора).
import { z } from "zod";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as S from "../skills/xonta-shop.js";
import { startAgent, sign } from "../lab/agentkit.js";
import { jcs, sha256hex } from "../src/crypto.js";
import { connectMcp } from "../src/scan.js";
import { signingFetch } from "../src/callerauth.js";

const hashOf = (x) => sha256hex(jcs(x)).slice(0, 16);
const MEMORY_LIMIT = Number(process.env.SHOP_MEMORY_LIMIT || 200), RULES_CHECK = Number(process.env.SHOP_RULES_CHECK || 24);
const CANDIDATES = Number(process.env.SHOP_RULE_CANDIDATES || 2), MIN_MARGIN = Number(process.env.SHOP_MIN_MARGIN || 2);
const PublicTask = z.object({ id: z.string().max(40), category: z.string().max(20), item: z.string().max(120), qty: z.number(), mandate: z.object({ cap: z.number(), min_rating: z.number(), deadline_days: z.number() }), want: z.record(z.any()).optional(), text: z.string().max(2000) });
const Offer = z.object({ id: z.string().max(10) }).passthrough();

async function mcpCall(url, tool, args, signer, headers = {}) {
  const c = await connectMcp(url, { name: "xonta-shop-agent", fetch: signer ? signingFetch({ did: signer.did, privateKey: signer.privateKey, extraHeaders: headers }) : undefined });
  try {
    const out = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: Number(process.env.MCP_TOOL_TIMEOUT_MS || 600000) });
    const text = (out.content || []).map((x) => x.text || "").join("");
    if (out.isError) throw new Error(`${tool}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally { await c.close().catch(() => {}); }
}

export async function startShopAgent({ port, name, ownerDid, dataDir, llm, role = "buyer", skills = null, parentDid = null, supplierUrl = null, railUrl = null }) {
  mkdirSync(dataDir, { recursive: true });
  const stateFile = join(dataDir, "state.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { skills: skills || S.baseSkills(), version: 0, memory: [], rulesTried: 0, rulesKept: 0, history: [] };
  state.config ||= { escalate: { categories: [], above: null }, senior: null };
  state.ruleHistory ||= {}; state.versions ||= {}; state.cache ||= {}; state.token ||= null; state.pending ||= {}; state.stats ||= { decided: 0, escalated: 0, cache_hits: 0 };
  const save = () => { writeFileSync(stateFile + ".tmp", JSON.stringify(state)); renameSync(stateFile + ".tmp", stateFile); }; // атомарно: обрыв процесса не портит файл
  const cfgHash = () => hashOf({ config: state.config, objective: state.skills.objective || null });

  // решение с кэшем: та же версия навыков и настроек, то же задание — тот же ответ (модель детерминирована при temperature 0)
  async function baseDecision(task, offers, answer, skills = state.skills) {
    let d = null;
    const sen = state.config.senior;
    const escCat = sen && state.config.escalate.categories.includes(task.category);
    if (!escCat) d = await S.decide(llm, skills, task, offers, { answer });
    const chosen = d?.offer ? offers.find((o) => o.id === d.offer) : null;
    const escSum = sen && state.config.escalate.above != null && chosen && S.totalOf(chosen, task.qty) > state.config.escalate.above;
    if (escCat || escSum) {
      try { const r = await mcpCall(sen.url, "decide", { task, offers, ...(answer ? { answer } : {}) }, agent); d = { ...r.decision, escalated: true, junior: d ? { action: d.action, offer: d.offer } : null }; state.stats.escalated++; }
      catch (e) { state.history.push({ at: new Date().toISOString(), event: "escalation_failed", error: e.message }); if (!d) d = await S.decide(llm, skills, task, offers, { answer }); }
    }
    return d;
  }
  // рой проверяющих: главный проверяющий проверяет карточки (платно, токеном payer), перед оплатой — опровержение
  // url — рой на время подбора (пробный рой оператора, по которому оркестратор ищет окупаемый размер)
  async function decideCached(task, offers, answer = null, { payer = null, size = null, url = null, skills = state.skills } = {}) {
    const sw = url ? { url } : state.config.swarm, n = size ?? (sw?.size || 0);
    const useSwarm = n > 0 && sw?.url && payer;
    const key = `${hashOf(skills)}|${cfgHash()}|${task.id}|${answer ? "a" : "-"}|s${useSwarm ? n : 0}`;
    if (state.cache[key]) { state.stats.cache_hits++; return state.cache[key]; }
    let work = offers, checks = 0, distorted = 0, checkedBy = {}, refuted = 0, excluded = {}, rejected = 0;
    if (useSwarm) {
      // повторное решение по тому же заданию после ответа владельца — проверки уже оплачены, берём их результат
      const memo = answer ? state.inspected?.[`${task.id}|${n}`] : null;
      if (memo) ({ work, checkedBy } = memo), (excluded = { ...(memo.exclude || {}) });
      else {
        const r = await mcpCall(sw.url, "inspect_offers", { task, offers, size: n, payer_token: payer }, agent);
        work = r.offers; checks = r.checks; distorted = r.distorted; checkedBy = r.checked; excluded = { ...(r.exclude || {}) };
        (state.inspected ||= {})[`${task.id}|${n}`] = { work, checkedBy, exclude: r.exclude || {} };
        const ks = Object.keys(state.inspected); if (ks.length > 400) for (const k of ks.slice(0, ks.length - 400)) delete state.inspected[k];
      }
    }
    // варианты, которые рой признал негодными (вердикт проверяющих), модель не видит
    const shown = () => work.filter((o) => !excluded[o.id]);
    let d = await baseDecision(task, shown(), answer, skills);
    // перед оплатой: выбранный вариант, который ещё никто не проверял, перепроверяет проверяющий — и искажения карточки,
    // и саму сделку (поручение, репутация продавца). Не прошёл — вариант исключается, решение принимается заново.
    for (let i = 0; useSwarm && d?.action === "buy" && i < 3; i++) {
      if (checkedBy[d.offer] !== undefined) break;
      const card = work.find((o) => o.id === d.offer);
      const r = await mcpCall(sw.url, "refute", { task_id: task.id, card, payer_token: payer, task }, agent);
      if (r.status !== "ok") break;
      checks++; checkedBy[d.offer] = r.by;
      if (r.result.distorted) { refuted++; distorted++; work = work.map((o) => (o.id === d.offer ? r.result.card : o)); }
      if (r.reject?.length) { rejected++; excluded[d.offer] = r.reject; }
      if (!r.result.distorted && !r.reject?.length) break;
      d = await baseDecision(task, shown(), answer, skills);
    }
    d = { ...d, ...(useSwarm ? { checks, distorted, refuted, swarm: n, excluded: Object.keys(excluded).length, rejected, checked_ids: Object.keys(checkedBy) } : {}) };
    state.stats.decided++;
    state.cache[key] = d;
    const ks = Object.keys(state.cache); if (ks.length > 6000) for (const k of ks.slice(0, ks.length - 6000)) delete state.cache[k];
    return d;
  }

  // ---------- обучение правилами ----------
  function remember(items) {
    const byId = new Map(state.memory.map((m) => [m.full.id, m]));
    for (const f of items) byId.set(f.full.id, { full: f.full, offers: f.offers, outcome: f.outcome, regret_pct: f.regret_pct, explain: f.explain, fold: parseInt(String(f.full.id).slice(-2), 16) % 2 });
    state.memory = [...byId.values()].slice(-MEMORY_LIMIT);
  }
  // сожаление навыков на проверочных сделках (по полной информации, которую владелец сообщил после сделок)
  // решения на проверке кэшируются по версии навыков: текущие правила не переспрашиваются у модели при каждой попытке
  async function decideFor(skills, pub, offers, answer = null) {
    const key = `${hashOf(skills)}|learn|${pub.id}|${answer ? "a" : "-"}`;
    if (state.cache[key]) { state.stats.cache_hits++; return state.cache[key]; }
    return (state.cache[key] = await S.decide(llm, skills, pub, offers, { answer }));
  }
  async function regretOn(skills, check) {
    let total = 0; const per = {};
    for (const m of check) {
      const pub = { ...publicOf(m.full) };
      let d = await decideFor(skills, pub, m.offers);
      let g;
      if (d.action === "ask") { const d2 = await decideFor(skills, pub, m.offers, S.answerFor(m.full)); g = S.grade(m.full, m.offers, d, { second: { decision: d2 } }); }
      else g = S.grade(m.full, m.offers, d);
      per[m.full.id] = g.regret_pct; total += g.regret_pct;
    }
    return { mean: check.length ? Math.round(100 * total / check.length) / 100 : 0, per };
  }
  async function learnRules(feedback, { propose = false } = {}) {
    remember(feedback);
    // категория с наибольшим числом ошибок (не меньше 3) на половине памяти для обучения
    const bad = state.memory.filter((m) => m.fold === 0 && m.regret_pct > 0.01);
    const byCat = {}; for (const m of bad) (byCat[m.full.category] ||= []).push(m);
    const [category, mistakes] = Object.entries(byCat).sort((a, b) => b[1].length - a[1].length)[0] || [];
    if (!category || mistakes.length < 3) { save(); return { learned: 0, reason: "мало ошибок" }; }
    const hist = state.ruleHistory[category] || [];
    const cands = await S.refineRules(llm, state.skills, category, mistakes.slice(-30).map((m) => ({ text: S.taskText(m.full), explain: m.explain })), { history: hist, candidates: CANDIDATES });
    state.rulesTried++;
    if (!cands.length) { save(); return { learned: 0, category, reason: "модель не вернула правила" }; }
    // проверка — на сделках той же категории (правила категории влияют только на них): сначала отложенная половина памяти,
    // если её мало — вся память категории (оценка оптимистичнее, поэтому запас самопроверки не ниже 2)
    let check = state.memory.filter((m) => m.fold === 1 && m.full.category === category).slice(-RULES_CHECK);
    if (check.length < 8) check = state.memory.filter((m) => m.full.category === category).slice(-RULES_CHECK);
    const cur = await regretOn(state.skills, check);
    const push = (rules, score) => { const key = JSON.stringify(rules); const h = (state.ruleHistory[category] || []).filter((x) => JSON.stringify(x.rules) !== key); h.push({ rules, score }); state.ruleHistory[category] = h.sort((a, b) => a.score - b.score).slice(0, 8); };
    if (state.skills.blocks?.[category]?.notes?.length) push(state.skills.blocks[category].notes, cur.mean);
    let best = null;
    for (const cand of cands) {
      const r = await regretOn(cand, check);
      // парно: на скольких сделках сожаление стало меньше / больше
      let b = 0, c = 0; for (const id of Object.keys(r.per)) { if (r.per[id] < cur.per[id] - 0.01) b++; else if (r.per[id] > cur.per[id] + 0.01) c++; }
      push(cand.blocks[category].notes, r.mean);
      if (!best || b - c > best.b - best.c) best = { cand, b, c, mean: r.mean };
    }
    const keep = best.b - best.c >= (state.minMargin ?? MIN_MARGIN);
    state.history.push({ at: new Date().toISOString(), event: "rules", category, kept: keep, candidates: cands.length, check: { n: check.length, b: best.b, c: best.c, before: cur.mean, after: best.mean }, rules: best.cand.blocks[category].notes });
    const check_info = { n: check.length, b: best.b, c: best.c, before: cur.mean, after: best.mean };
    // режим предложения: правило не применяется сразу — его проверяет оркестратор на своих отложенных заданиях
    if (keep && propose) { state.proposal = { skills: best.cand, hash: hashOf(best.cand), category, check: check_info, at: new Date().toISOString() }; save(); return { learned: 0, proposed: true, hash: state.proposal.hash, category, candidates: cands.length, check: check_info }; }
    if (keep) { state.skills = best.cand; state.version++; state.rulesKept++; }
    save();
    return { learned: keep ? 1 : 0, category, candidates: cands.length, check: check_info };
  }
  const publicOf = (t) => ({ id: t.id, category: t.category, item: t.item, qty: t.qty, mandate: t.mandate, text: S.taskText(t) });

  const tools = [
    { name: "decide", description: "Решение по заданию на покупку: купить вариант, отказаться или задать вопрос владельцу. Ничего не оплачивает (экзамен, старший закупщик).",
      input: { task: PublicTask, offers: z.array(Offer).max(40), answer: z.string().max(400).optional(), payer_token: z.string().max(80).optional(), swarm_size: z.number().int().min(0).max(16).optional(), swarm_url: z.string().max(300).optional() }, annotations: { readOnlyHint: true },
      run: async ({ task, offers, answer, payer_token, swarm_size, swarm_url }) => { const d = await decideCached(task, offers, answer || null, { payer: payer_token || null, size: swarm_size ?? null, url: swarm_url || null }); save(); return { decision: d, version: state.version }; } },
    { name: "decide_many", description: "Несколько решений подряд (экзамен оркестратора): то же, что decide, для списка заданий.",
      input: { items: z.array(z.object({ task: PublicTask, offers: z.array(Offer).max(40), answer: z.string().max(400).optional() })).max(40), payer_token: z.string().max(80).optional(), swarm_size: z.number().int().min(0).max(16).optional(), swarm_url: z.string().max(300).optional(), use_proposal: z.boolean().optional() }, annotations: { readOnlyHint: true },
      run: async ({ items, payer_token, swarm_size, swarm_url, use_proposal }) => {
        if (use_proposal && !state.proposal) throw new Error("нет предложенных правил");
        const skills = use_proposal ? state.proposal.skills : state.skills;
        const out = []; for (const x of items) out.push({ id: x.task.id, decision: await decideCached(x.task, x.offers, x.answer || null, { payer: payer_token || null, size: swarm_size ?? null, url: swarm_url || null, skills }) }); save(); return { decisions: out, version: state.version }; } },
    { name: "handle_task", description: "Задание владельца: агент берёт варианты у поставщика, решает и платит тестовым эквайером в пределах поручения и лимита.",
      input: { task: PublicTask, answer: z.string().max(400).optional() },
      run: async ({ task, answer }) => {
        if (role !== "buyer") throw new Error("старший закупщик только советует");
        const offers = state.pending[task.id]?.offers || (await mcpCall(supplierUrl, "offers", { task_id: task.id }, agent, { "x-task-category": encodeURIComponent(task.category), "x-task-id": task.id })).offers;
        state.pending[task.id] = { offers, at: Date.now() };
        // проверки роя оплачиваются отдельным бюджетом на инструменты (если владелец его выдал), а не лимитом покупок
        const d = await decideCached(task, offers, answer || null, { payer: state.check_token || state.token });
        let payment = null;
        if (d.action === "buy") {
          const o = offers.find((x) => x.id === d.offer);
          if (!state.token) payment = { status: "declined", reason: "нет платёжного токена" };
          else payment = await mcpCall(railUrl, "pay", { token: state.token, amount: S.totalOf(o, d.qty), merchant: o.seller, category: task.category, order: task.id, offer: o.id }, agent);
        }
        if (d.action !== "ask") delete state.pending[task.id];
        const ks = Object.keys(state.pending); if (ks.length > 200) for (const k of ks.slice(0, ks.length - 200)) delete state.pending[k];
        save();
        return { decision: d, payment, offers_count: offers.length };
      } },
    { name: "learn", description: "Разбор сделок от владельца: что купил агент, чем это обернулось и какой вариант был лучшим. Агент переписывает правила категории.",
      input: { feedback: z.array(z.object({ full: z.object({}).passthrough(), offers: z.array(Offer), outcome: z.string(), regret_pct: z.number(), explain: z.string() })).max(60), propose: z.boolean().optional() },
      run: async ({ feedback, propose }) => learnRules(feedback, { propose: !!propose }) },
    { name: "get_skills", description: "Текущие навыки (правила по категориям), настройки эскалации и версия.", input: {}, annotations: { readOnlyHint: true },
      run: () => {
        const hash = hashOf(state.skills);
        if (!state.versions[hash]) { state.versions[hash] = structuredClone(state.skills); const ks = Object.keys(state.versions); if (ks.length > 30) delete state.versions[ks[0]]; save(); }
        // действия по советам оркестратора, которые агент умеет выполнять
        const supported_actions = ["restore", "set_objective", ...(role === "buyer" ? ["escalate", "spawn_senior", "set_limit", "swarm"] : [])];
        return { language: S.LANGUAGE, version: state.version, hash, config_hash: cfgHash(), skills: state.skills, role, config: state.config, supported_actions, stats: state.stats, rules: { tried: state.rulesTried, kept: state.rulesKept }, proposal: state.proposal ? { hash: state.proposal.hash, category: state.proposal.category, check: state.proposal.check } : null };
      } },
  ];

  const agent = await startAgent({
    port, name, tools, ownerDid, keyFile: join(dataDir, "agent.jwk"),
    instructions: role === "buyer" ? "Агент-закупщик: покупает товары и платные инструменты по поручению владельца, деньги тестовые." : "Старший закупщик: решает сложные и дорогие покупки по запросу младшего.",
    ownerRoutes: {
      restore: async ({ hash, min_margin }) => { const v = state.versions[hash]; if (!v) throw new Error(`версии ${hash} нет среди проверенных`); state.skills = structuredClone(v); state.version++; if (min_margin) state.minMargin = min_margin; save(); return { version: state.version, hash: hashOf(state.skills) }; },
      "set-objective": async ({ text }) => { state.skills.objective = String(text || "").slice(0, 600) || null; state.version++; save(); return { objective: state.skills.objective }; },
      "set-escalation": async ({ categories = null, above = undefined }) => { if (categories) state.config.escalate.categories = [...new Set([...state.config.escalate.categories, ...categories])]; if (above !== undefined) state.config.escalate.above = above; save(); return { escalate: state.config.escalate }; },
      "set-swarm": async ({ gateway_url, did, size }) => { state.config.swarm = gateway_url ? { url: gateway_url, did, size: Number(size) || 0 } : null; save(); return { swarm: state.config.swarm }; },
      "set-senior": async ({ gateway_url, did }) => { state.config.senior = gateway_url ? { url: gateway_url, did } : null; save(); return { senior: state.config.senior }; },
      "set-token": async ({ token }) => { state.token = token || null; save(); return { ok: true }; },
      "set-check-token": async ({ token }) => { state.check_token = token || null; save(); return { ok: true }; },
      // решение владельца по предложенным правилам (после проверки оркестратором): применить или отбросить
      "apply-proposal": async ({ hash }) => { const p = state.proposal; if (!p || p.hash !== hash) throw new Error("нет такого предложения"); state.skills = p.skills; state.version++; state.rulesKept++; state.proposal = null; save(); return { version: state.version, hash: hashOf(state.skills) }; },
      "discard-proposal": async () => { state.proposal = null; save(); return { ok: true }; },
      "sign-lineage": async ({ child_did, mandate, scope, depth }) => {
        if (mandate?.credentialSubject?.id !== agent.did) throw new Error("мандат выдан не этому агенту");
        return { lineage: sign(agent, "AgentLineage", { id: child_did, parent: agent.did, mandate: mandate.id, depth, scope }, { validDays: 365 }) };
      },
    },
  });
  agent.state = state; agent.llm = llm; agent.role = role; agent.parentDid = parentDid;
  return agent;
}
