// Агент №2 «Репутация» (владелец — организация): по тексту отзыва определяет оценку автора и нужен ли срочный ответ.
// Разбор как в поддержке: агент сначала сам оценивает отзыв; если для группы (негатив / середина / позитив)
// есть потомок-специалист — передаёт ему отзыв через шлюз оркестратора, подписывая вызов своим ключом.
// Учится на ошибках: примеры добавляются в навыки, ёмкость ограничена (SKILL_EXAMPLE_LIMIT на весь запрос).
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as G from "../skills/xonta-geo.js";
import { startAgent, sign } from "../lab/agentkit.js";
import { jcs, sha256hex } from "../src/crypto.js";
import { connectMcp } from "../src/scan.js";
import { signingFetch } from "../src/callerauth.js";

const hashSkills = (s) => sha256hex(jcs(s)).slice(0, 16);
const Item = z.object({ id: z.string().max(40), text: z.string().max(6000) });
const Labeled = z.object({ id: z.string().max(40), text: z.string().max(6000), rating: z.number().int().min(1).max(5), category: z.string().max(40), predicted: z.number().int().min(1).max(5).nullable().optional() });
// GEO_LEARN=rules — агент копит все размеченные отзывы и переписывает правила группы по накопленным ошибкам;
// новая версия правил остаётся, только если на отложенной половине его данных она не хуже прежней (парное сравнение)
const RULES = process.env.GEO_LEARN === "rules";
const MEMORY_LIMIT = Number(process.env.GEO_MEMORY_LIMIT || 600), RULES_FROM = Number(process.env.GEO_RULES_MISTAKES || 40), RULES_CHECK = Number(process.env.GEO_RULES_CHECK || 60);
const foldOf = (id) => parseInt(String(id).slice(-2), 16) % 2;
// GEO_ROUTER=1 — распределение отдельным навыком с блокировкой при несогласии (skills/xonta-geo.js: route)
const ROUTER = process.env.GEO_ROUTER === "1";
// GEO_RULE_CANDIDATES — сколько вариантов правил просить за одну попытку (OPRO); проверяются все, остаётся лучший
const CANDIDATES = Number(process.env.GEO_RULE_CANDIDATES || 1), HISTORY_LIMIT = Number(process.env.GEO_RULE_HISTORY || 8);
// правила распределения меняются не чаще одного раза за ROUTING_COOLDOWN раундов: иначе потомки не успевают под них подстроиться
const ROUTING_COOLDOWN = Number(process.env.GEO_ROUTING_COOLDOWN || 2);
function pushHistory(list, rules, acc) {
  if (!Array.isArray(rules) || !rules.length) return list;
  const key = JSON.stringify(rules);
  const out = list.filter((x) => JSON.stringify(x.rules) !== key);
  out.push({ rules, acc, at: new Date().toISOString() });
  return out.sort((a, b) => b.acc - a.acc).slice(0, HISTORY_LIMIT);
}

export async function startGeoAgent({ port, name, ownerDid, dataDir, llm, specialization = null, skills = null, parentDid = null, parentVersion = 0 }) {
  mkdirSync(dataDir, { recursive: true });
  const stateFile = join(dataDir, "state.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {
    skills: skills || G.baseSkills(), base: skills || G.baseSkills(), version: 0, baseVersion: parentVersion,
    delegates: {}, feedbackItems: 0, examplesLearned: 0, ingested: 0, history: [],
  };
  state.memory ||= []; state.rulesTried ||= 0; state.rulesKept ||= 0; state.refineIdx ||= 0;
  // советы оркестратора: проверенные версии навыков (для отката), строгость самопроверки, цель узла, группы для обучения распределению
  state.versions ||= {}; state.policy ||= { min_margin: Number(process.env.GEO_MIN_MARGIN || 1) }; state.objective ||= null; state.routingFocus ||= []; state.lastOwn ||= {};
  state.ruleHistory ||= {}; state.routeHistory ||= []; state.routeMemory ||= []; state.lastRoute ||= {}; state.routingTried ||= 0; state.routingKept ||= 0;
  const canRoute = () => ROUTER && !!G.routeChoices(specialization);
  const ROOT_SEES_ALL = process.env.ROOT_SEES_ALL === "1";
  const save = () => writeFileSync(stateFile, JSON.stringify(state));

  async function delegate(gw, category, items) {
    const client = await connectMcp(gw.url, { name: `${name}-delegate`, fetch: signingFetch({ did: agent.did, privateKey: agent.privateKey, extraHeaders: { "x-task-category": encodeURIComponent(category), "x-task-id": `d-${Date.now()}` } }) });
    try {
      const out = await client.callTool({ name: "rate_reviews", arguments: { reviews: items } }, undefined, { timeout: Number(process.env.MCP_TOOL_TIMEOUT_MS || 600000) });
      const text = (out.content || []).map((c) => c.text || "").join("");
      if (out.isError) throw new Error(text.slice(0, 200));
      return JSON.parse(text).ratings;
    } finally { await client.close().catch(() => {}); }
  }

  // оценка с разбором на любом уровне дерева: свой прогноз → путь отзыва (группа → оценка → длина) → следующий узел;
  // если для него есть потомок — отзыв уходит ему через шлюз. Категория задачи в заголовке — полный путь по прогнозу,
  // по нему оркестратор считает долю трафика подгрупп у потомка.
  async function rateWithTriage(items) {
    const own = await G.rate(llm, state.skills, items);
    // собственный прогноз до передачи: по нему корень учится распределению (куда отправлять отзыв)
    if (!specialization) { for (const r of own) if (r.rating != null) state.lastOwn[r.id] = r.rating; const ks = Object.keys(state.lastOwn); if (ks.length > 3000) for (const k of ks.slice(0, ks.length - 3000)) delete state.lastOwn[k]; }
    if (!Object.keys(state.delegates).length) return own.map((r) => ({ ...r, by: agent.did, route: "own" }));
    // маршрутизатор: второй независимый ответ «к какой группе отзыв»; передача — только при согласии с собственной оценкой
    let rk = null;
    if (canRoute()) {
      rk = new Map((await G.route(llm, state.skills, specialization, items)).map((x) => [x.id, x.key]));
      for (const [id, k] of rk) state.lastRoute[id] = k;
      const ks = Object.keys(state.lastRoute); if (ks.length > 3000) for (const k of ks.slice(0, ks.length - 3000)) delete state.lastRoute[k];
    }
    const routes = {}, blocked = new Set(); // ключ потомка → { полный путь → отзывы }
    own.forEach((r, i) => {
      if (r.rating == null) return;
      const path = G.pathOf(items[i].text, r.rating), key = G.nextKey(specialization, path);
      if (rk) { const k2 = rk.get(r.id); if (k2 !== key) { if (state.delegates[key] || state.delegates[k2]) blocked.add(r.id); return; } }
      if (key && state.delegates[key]) ((routes[key] ||= {})[path.at(-1)] ||= []).push(items[i]);
    });
    const final = new Map(own.map((r) => [r.id, { ...r, by: agent.did, route: blocked.has(r.id) ? "blocked" : "own" }]));
    for (const [key, byPath] of Object.entries(routes)) for (const [full, list] of Object.entries(byPath)) {
      try { for (const r of await delegate(state.delegates[key], full, list)) final.set(r.id, { ...r, by: r.by || state.delegates[key].did, routed_as: key, route: "delegated" }); }
      catch (e) { state.history.push({ at: new Date().toISOString(), event: "delegate_failed", group: key, error: e.message }); }
    }
    return items.map((it) => final.get(it.id));
  }

  // ---------- обучение правилами ----------
  function remember(items) {
    const byId = new Map(state.memory.map((m) => [m.id, m]));
    for (const f of items) byId.set(f.id, { id: f.id, text: String(f.text).slice(0, 1200), rating: f.rating, category: G.groupOf(f.rating),
      predicted: (!specialization && state.lastOwn[f.id] != null ? state.lastOwn[f.id] : f.predicted) ?? null, fold: foldOf(f.id) });
    state.memory = [...byId.values()].slice(-MEMORY_LIMIT);
  }
  async function learnRules(feedback) {
    remember(feedback);
    state.feedbackItems += feedback.length;
    // корень уточняет правила только групп, которые не переданы потомкам: правила потомков приходят к нему через слияния
    const groups = specialization ? [specialization] : G.GROUPS.filter((g) => !state.delegates[g] || (!ROUTER && state.routingFocus.includes(g)));
    if (!groups.length) { remember([]); save(); return { learned: 0, reason: "все группы у потомков" }; }
    // для группы, отданной потомку, корню важны только ошибки распределения: отзыв попал не в ту группу (в неё или из неё)
    const routingOnly = (cat) => !ROUTER && !specialization && state.delegates[cat] && state.routingFocus.includes(cat);
    const wrongIn = (cat) => state.memory.filter((m) => m.fold === 0 && m.predicted != null && m.predicted !== m.rating && (specialization || (routingOnly(cat)
      ? G.groupOf(m.predicted) !== m.category && (m.category === cat || G.groupOf(m.predicted) === cat) : m.category === cat)));
    // по очереди та группа, где накопилось хотя бы 3 ошибки
    let category = null;
    for (let i = 0; i < groups.length; i++) { const c = groups[(state.refineIdx + i) % groups.length]; if (wrongIn(c).length >= 3) { category = c; state.refineIdx = (state.refineIdx + i + 1) % groups.length; break; } }
    if (!category) { save(); return { learned: 0, reason: "мало ошибок", memory: state.memory.length }; }
    const objective = specialization ? state.objective : routingOnly(category) ? `Ты распределяешь отзывы по группам. Правила для группы «${G.labelOf(category)}» должны помогать безошибочно отнести отзыв к этой группе или к соседней — точная оценка внутри группы здесь не важна.` : null;
    const hist = state.ruleHistory[category] || [];
    const cands = await G.refineRulesCandidates(llm, state.skills, category, wrongIn(category).slice(-RULES_FROM), { objective, history: hist, candidates: CANDIDATES });
    state.rulesTried++;
    if (!cands.length) { save(); return { learned: 0, reason: "модель не вернула правила" }; }
    let check = state.memory.filter((m) => m.fold === 1).slice(-RULES_CHECK);
    if (check.length < 20) check = state.memory.slice(-RULES_CHECK);
    // правила распределения проверяются по попаданию в группу, остальные — по точной оценке
    const gi = (r) => (r == null ? null : G.GROUPS.indexOf(G.groupOf(r)) + 1);
    const mode = routingOnly(category);
    const view = (preds) => (mode ? preds.map((p) => ({ ...p, rating: gi(p.rating) })) : preds);
    const items = mode ? check.map((m) => ({ ...m, rating: gi(m.rating) })) : check;
    const accOf = (preds) => { const P = new Map(view(preds).map((p) => [p.id, p.rating])); return items.length ? Math.round(1000 * items.filter((m) => P.get(m.id) === m.rating).length / items.length) / 10 : 0; };
    const cur = await G.evaluateSkills(llm, state.skills, check);
    let h = pushHistory(hist, state.skills.blocks?.[category]?.notes, accOf(cur.preds)), best = null;
    for (const cand of cands) {
      const ev = await G.evaluateSkills(llm, cand, check);
      const t = G.pairedCompare(items, view(cur.preds), view(ev.preds));
      h = pushHistory(h, cand.blocks[category].notes, accOf(ev.preds));
      if (!best || t.b - t.c > best.t.b - best.t.c) best = { cand, t };
    }
    state.ruleHistory[category] = h;
    const t = best.t;
    const keep = t.b - t.c >= (state.policy.min_margin || 1);
    state.history.push({ at: new Date().toISOString(), event: "rules", category, kept: keep, candidates: cands.length, check: t, rules: best.cand.blocks[category].notes });
    if (keep) { state.skills = best.cand; state.version++; state.rulesKept++; state.examplesLearned++; }
    save();
    return { learned: keep ? 1 : 0, category, check: t, candidates: cands.length, rules: state.skills.blocks?.[category]?.notes?.length || 0, memory: state.memory.length };
  }

  // ---------- обучение распределению (GEO_ROUTER=1, по совету оркестратора) ----------
  function rememberRoutes(items) {
    if (!canRoute()) return;
    const byId = new Map(state.routeMemory.map((m) => [m.id, m]));
    for (const f of items) {
      const routed = state.lastRoute[f.id];
      if (routed === undefined || !(f.rating >= 1)) continue;
      const truth = G.nextKey(specialization, G.pathOf(f.text, f.rating));
      if (!truth) continue;
      byId.set(f.id, { id: f.id, text: String(f.text).slice(0, 1200), truth, routed, fold: foldOf(f.id) });
    }
    state.routeMemory = [...byId.values()].slice(-MEMORY_LIMIT);
  }
  async function learnRouting(round) {
    if (!canRoute() || !state.routingFocus.length || round == null) return null;
    if (state.routingTriedRound === round) return null;
    if (state.routingChangedRound != null && round - state.routingChangedRound < ROUTING_COOLDOWN) return { learned: 0, reason: `правила распределения менялись в раунде ${state.routingChangedRound}` };
    const wrong = state.routeMemory.filter((m) => m.fold === 0 && m.routed !== m.truth);
    if (wrong.length < 5) return { learned: 0, reason: "мало ошибок распределения", memory: state.routeMemory.length };
    state.routingTriedRound = round;
    const cand = await G.refineRouting(llm, state.skills, specialization, wrong.slice(-RULES_FROM), { history: state.routeHistory });
    state.routingTried++;
    if (!cand) { save(); return { learned: 0, reason: "модель не вернула правила распределения" }; }
    let check = state.routeMemory.filter((m) => m.fold === 1).slice(-RULES_CHECK);
    if (check.length < 20) check = state.routeMemory.slice(-RULES_CHECK);
    const A = new Map((await G.route(llm, state.skills, specialization, check)).map((x) => [x.id, x.key]));
    const B = new Map((await G.route(llm, cand, specialization, check)).map((x) => [x.id, x.key]));
    let b = 0, c = 0, okA = 0, okB = 0;
    for (const m of check) { const was = A.get(m.id) === m.truth, now = B.get(m.id) === m.truth; if (was) okA++; if (now) okB++; if (!was && now) b++; if (was && !now) c++; }
    const acc = (k) => (check.length ? Math.round(1000 * k / check.length) / 10 : 0);
    state.routeHistory = pushHistory(pushHistory(state.routeHistory, state.skills.routing?.[G.routeKey(specialization)]?.notes, acc(okA)), cand.routing[G.routeKey(specialization)].notes, acc(okB));
    const t = { b, c, n: check.length, gain_pp: acc(b - c), p_value: Number(G.mcnemar(b, c).toPrecision(3)) };
    const keep = b - c >= (state.policy.min_margin || 1);
    state.history.push({ at: new Date().toISOString(), event: "routing_rules", round, kept: keep, check: t, rules: cand.routing[G.routeKey(specialization)].notes });
    if (keep) { state.skills = cand; state.version++; state.routingKept++; state.routingChangedRound = round; }
    save();
    return { learned: keep ? 1 : 0, check: t };
  }

  async function learn(feedback) {
    if (RULES) return learnRules(feedback);
    // специалист учится на всех отзывах, которые ему передали (их группа — по прогнозу родителя), и хранит их в своём блоке
    const byCat = {};
    for (const f of feedback) (byCat[specialization || f.category] ||= []).push(f);
    let added = 0;
    for (const [category, list] of Object.entries(byCat)) {
      const before = JSON.stringify(state.skills);
      state.skills = G.learnFrom(state.skills, list, { category });
      if (JSON.stringify(state.skills) !== before) added += list.length;
      state.feedbackItems += list.length;
    }
    if (added) { state.version++; state.examplesLearned += added; }
    save();
    return { learned: added, version: state.version, examples: Object.fromEntries(Object.entries(state.skills.blocks).map(([c, b]) => [c, b.examples.length])) };
  }

  const tools = [
    { name: "rate_reviews", description: "Определяет по тексту отзыва оценку автора (1–5) и нужен ли срочный ответ (оценка 1–2). Отзыв может быть передан специалисту-потомку.",
      input: { reviews: z.array(Item).max(200) }, annotations: { readOnlyHint: true },
      run: async ({ reviews }) => ({ ratings: await rateWithTriage(reviews), version: state.version }) },
    { name: "learn", description: "Обратная связь: отзывы, где агент ошибся, с оценкой автора. Агент добавляет их в свои примеры (ёмкость ограничена).",
      input: { feedback: z.array(Labeled.extend({ error: z.number().optional() })).max(50), routing: z.array(Labeled).max(400).optional(), round: z.number().int().min(0).optional() },
      run: async ({ feedback, routing = [], round }) => {
        rememberRoutes([...routing, ...feedback]);
        const res = feedback.length ? await learn(feedback) : { learned: 0 };
        const r = await learnRouting(round);
        save();
        return r ? { ...res, routing: r } : res;
      } },
    { name: "ingest", description: "Принимает размеченные отзывы от поставщика данных: агент проверяет себя на них и учится на своих ошибках (в пределах бюджета).",
      input: { reviews: z.array(Labeled).max(500), budget: z.number().int().min(0).max(50).optional(), source: z.string().max(200).optional() },
      run: async ({ reviews, budget = Number(process.env.FEEDBACK_BUDGET || 4), source }) => {
        const preds = await rateWithTriage(reviews.map(({ id, text }) => ({ id, text })));
        const P = new Map(preds.map((p) => [p.id, p]));
        const wrong = reviews.filter((r) => P.get(r.id)?.rating !== r.rating).map((r) => ({ ...r, predicted: P.get(r.id)?.rating ?? null, error: Math.abs((P.get(r.id)?.rating ?? 3) - r.rating), by: P.get(r.id)?.by }));
        state.ingested += reviews.length;
        rememberRoutes(reviews);
        state.history.push({ at: new Date().toISOString(), event: "ingest", count: reviews.length, wrong: wrong.length, source: source || null });
        save();
        // ошибки, сделанные самим агентом, — себе; сделанные потомком — возвращаются вызывающему для передачи потомку
        const per = {}; for (const r of reviews) { const c = (per[r.category] ||= { n: 0, ok: 0 }); c.n++; if (P.get(r.id)?.rating === r.rating) c.ok++; }
        if (RULES) {
          // правилам нужны и верные, и неверные ответы: агент запоминает всё, что оценил сам; потомкам уходит всё, что оценили они
          const all = reviews.map((r) => ({ ...r, predicted: P.get(r.id)?.rating ?? null, error: Math.abs((P.get(r.id)?.rating ?? 3) - r.rating), by: P.get(r.id)?.by }));
          const res = await learn(all.filter((x) => x.by === agent.did || (!specialization && ROOT_SEES_ALL)).map(({ by, ...x }) => x));
          return { checked: reviews.length, correct: reviews.length - wrong.length, by_category: per, learned: res.learned,
            for_delegates: all.filter((x) => x.by && x.by !== agent.did).map(({ by, ...x }) => ({ ...x, to: by })) };
        }
        const mine = wrong.filter((w) => w.by === agent.did).sort((a, b) => b.error - a.error).slice(0, budget);
        const res = mine.length ? await learn(mine) : { learned: 0 };
        return { checked: reviews.length, correct: reviews.length - wrong.length, by_category: per, learned: res.learned,
          for_delegates: wrong.filter((w) => w.by !== agent.did).map(({ by, ...w }) => ({ ...w, to: by })) };
      } },
    { name: "get_skills", description: "Текущие навыки агента (примеры по группам) и их версия.", input: {}, annotations: { readOnlyHint: true },
      run: () => {
        const hash = hashSkills(state.skills);
        if (!state.versions[hash]) { state.versions[hash] = structuredClone(state.skills); const ks = Object.keys(state.versions); if (ks.length > 40) delete state.versions[ks[0]]; save(); }
        // действия, которые агент умеет выполнять по совету оркестратора: советник не даёт советов, которые нельзя исполнить
        const supported_actions = ["restore", ...(specialization ? ["set_objective"] : []), ...((ROUTER ? canRoute() : !specialization) ? ["routing_focus"] : []),
          ...(!specialization || !/\/(short|long)$/.test(specialization) ? ["spawn"] : [])]; // лист дерева (длина отзыва) делить дальше нечем
        return { language: G.LANGUAGE, version: state.version, hash, skills: state.skills, specialization, objective: state.objective, policy: state.policy, routing_focus: state.routingFocus, supported_actions,
          routing: canRoute() ? { tried: state.routingTried, kept: state.routingKept, rules: state.skills.routing?.[G.routeKey(specialization)]?.notes?.length || 0 } : null };
      } },
    { name: "propose", description: "Подписанное предложение улучшения для родителя: свой блок навыков сверх базовой версии.", input: {},
      run: () => {
        if (!parentDid) return { proposal: null, reason: "нет родителя" };
        // свой блок и блоки поддерева (знания потомков, уже слитые в этого агента), если они отличаются от базы родителя
        const cat = specialization, blocks = state.skills.blocks || {}, base = state.base.blocks || {};
        const changed = Object.keys(blocks).filter((k) => G.underScope(cat, k) && JSON.stringify(blocks[k]) !== JSON.stringify(base[k]));
        if (!blocks[cat] || !changed.length) return { proposal: null, reason: "нечего предложить" };
        const keys = [...new Set([cat, ...changed])];
        return { proposal: sign(agent, "ImprovementProposal", { id: parentDid, from: agent.did, base_version: state.baseVersion, skill_language: G.LANGUAGE, category: cat,
          rules: Object.fromEntries(keys.map((k) => [k, { block: blocks[k] }])), evidence: { feedback_items: state.feedbackItems, examples: blocks[cat].examples?.length || 0, rules: blocks[cat].notes?.length || 0, blocks: keys.length } }, { validDays: 7 }) };
      } },
  ];

  const agent = await startAgent({
    port, name, tools, ownerDid, keyFile: join(dataDir, "agent.jwk"),
    instructions: "Агент мониторинга репутации: оценка автора отзыва и срочность ответа. Прогноз модели, а не факт.",
    ownerRoutes: {
      // у корня применённые навыки становятся базой; у специалиста база — навыки его родителя, она не меняется,
      // поэтому слитые в специалиста знания внуков уходят родителю в следующем предложении
      apply: async ({ skills, source }) => { state.skills = structuredClone(skills); if (!specialization) state.base = structuredClone(skills); state.version++; state.history.push({ at: new Date().toISOString(), event: "apply", source, version: state.version, hash: hashSkills(state.skills) }); save(); return { version: state.version, hash: hashSkills(state.skills) }; },
      rebase: async ({ skills, parent_version }) => {
        // новая база родителя + свои блоки (свой и поддерева) поверх неё
        const cat = specialization, mine = Object.entries(state.skills.blocks || {}).filter(([k]) => cat && G.underScope(cat, k));
        const myRoute = state.skills.routing?.[G.routeKey(specialization)];
        state.skills = structuredClone(skills);
        for (const [k, b] of mine) (state.skills.blocks ||= {})[k] = b;
        if (myRoute) (state.skills.routing ||= {})[G.routeKey(specialization)] = myRoute;
        state.base = structuredClone(skills); state.baseVersion = parent_version; save();
        return { base_version: state.baseVersion };
      },
      "sign-lineage": async ({ child_did, mandate, scope, depth }) => {
        if (mandate?.credentialSubject?.id !== agent.did) throw new Error("мандат выдан не этому агенту");
        return { lineage: sign(agent, "AgentLineage", { id: child_did, parent: agent.did, mandate: mandate.id, depth, scope }, { validDays: 365 }) };
      },
      // действия по советам оркестратора (решает владелец)
      restore: async ({ hash, min_margin }) => {
        const v = state.versions[hash];
        if (!v) throw new Error(`версии ${hash} нет среди проверенных`);
        state.skills = structuredClone(v); state.version++;
        if (min_margin) state.policy.min_margin = min_margin;
        state.history.push({ at: new Date().toISOString(), event: "restore", hash, policy: state.policy }); save();
        return { version: state.version, hash: hashSkills(state.skills), policy: state.policy };
      },
      "set-objective": async ({ text }) => { state.objective = String(text || "").slice(0, 600) || null; state.history.push({ at: new Date().toISOString(), event: "objective", text: state.objective }); save(); return { objective: state.objective }; },
      "routing-focus": async ({ category }) => { if (!state.routingFocus.includes(category)) state.routingFocus.push(category); state.history.push({ at: new Date().toISOString(), event: "routing_focus", category }); save(); return { routing_focus: state.routingFocus }; },
      "set-delegate": async ({ category, gateway_url, did }) => { if (gateway_url) state.delegates[category] = { url: gateway_url, did }; else delete state.delegates[category]; save(); return { delegates: state.delegates }; },
    },
  });
  agent.state = state;
  agent.llm = llm;
  return agent;
}
