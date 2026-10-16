// Эволюция агентов (уровень 2 «Советник»): потомки по мандату владельца, предложения улучшений, слияние с проверкой
// на отложенной выборке, вклад потомков. Оркестратор оценивает предложения и рекомендует слияние — применяет владелец.
//
// Навыки оцениваются как ДАННЫЕ на открытом интерпретаторе языка навыков (skills/*.js): чужой код не запускается.
import { randomId, jcs, sha256hex } from "./crypto.js";
import { verifyProof, checkValidity } from "./vc.js";
import { connectMcp } from "./scan.js";
import { signingFetch } from "./callerauth.js";
import { assertPublicUrl } from "./net.js";
import * as normalize from "../skills/xonta-normalize.js";
import * as reviews from "../skills/xonta-reviews.js";
import * as geo from "../skills/xonta-geo.js";
import { createAdvisor } from "./advisor.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const types = (vc) => [].concat(vc?.type || []);
const issuerOf = (vc) => (typeof vc?.issuer === "string" ? vc.issuer : vc?.issuer?.id);
const hashSkills = (s) => sha256hex(jcs(s)).slice(0, 16);
const pp = (x) => Math.round(x * 1000) / 10; // доля → процентные пункты с одним знаком

// Реестр языков навыков: оркестратор принимает предложения только на языках, интерпретатор которых у него есть
export const SKILL_LANGUAGES = { [normalize.LANGUAGE]: normalize, [reviews.LANGUAGE]: reviews, [geo.LANGUAGE]: geo };

export const MERGE_DEFAULTS = {
  min_gain_pp: 1, // предложение принимается, если улучшает свою категорию не меньше чем на 1 п.п.
  max_regression_pp: 0.5, // и не ухудшает другие категории больше чем на 0,5 п.п.
  heldout_cases: 400,
};

export function createEvolution({ store, issuer, orch, signals, resolver, publicUrl, allowPrivate, cfg = MERGE_DEFAULTS, llms = null }) {
  const agents = () => store.get("agents", {});
  const save = (rec) => store.update("agents", {}, (a) => { a[rec.id] = rec; });
  const childrenOf = (rec) => Object.values(agents()).filter((a) => a.parent === rec.id);
  const byDid = (did) => { const l = Object.values(agents()).filter((a) => a.did === did); return l.find((a) => a.status !== "retired") || l[0] || null; }; // «retired» — регистрация прошлого прогона
  // ADVISOR=1 — советник: советы владельцу с проверкой исхода и опытом (src/advisor.js)
  const advisor = process.env.ADVISOR === "1" ? createAdvisor({ store, issuer, orch }) : null;

  async function checkVc(vc, { type, issuer: expectedIssuer }) {
    if (!types(vc).includes(type)) throw err(400, `ожидается аттестат типа ${type}`);
    if (issuerOf(vc) !== expectedIssuer) throw err(400, `${type}: выдан не ${expectedIssuer}`);
    const p = await verifyProof(vc, (vm) => resolver.keyFor(vm));
    if (!p.ok) throw err(400, `${type}: подпись не прошла проверку (${p.reason})`);
    const v = checkValidity(vc);
    if (!v.ok) throw err(400, `${type}: ${v.reason}`);
    return vc.credentialSubject || {};
  }

  // Вызов инструмента агента через шлюз A2O2A от имени тестера оркестратора (подписанный, помечен как синтетика)
  async function call(rec, tool, args = {}) {
    const fetch = signingFetch({ did: orch.tester.did, privateKey: orch.tester.privateKey });
    const client = await connectMcp(`${publicUrl}/gw/${rec.id}/mcp`, { name: "xonta-evolution", fetch });
    try {
      const out = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: Number(process.env.MCP_TOOL_TIMEOUT_MS || 600000) });
      const text = (out.content || []).map((c) => c.text || "").join("");
      if (out.isError) throw err(502, `${rec.name}.${tool}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } finally { await client.close().catch(() => {}); }
  }

  // Отложенная выборка от зарегистрированного агента-генератора: чистые метки, seed известен только оркестратору
  async function heldout(generatorId, { round, n = cfg.heldout_cases, category = null, purpose }) {
    const gen = orch.get(generatorId);
    if (!gen.domain_verified_at) throw err(409, "генератор данных должен подтвердить домен");
    // seed выборки неизвестен агентам заранее; HELDOUT_SEED (только для воспроизводимых экспериментов) делает его детерминированным
    const seed = cfg.heldout_seed ? `${cfg.heldout_seed}-${purpose}-${round}-${gen.name}-${category || "all"}` : `${purpose}-${randomId(8)}`;
    const { tasks, skill_language } = await call(gen, "generate_tasks", { round, n, seed, clean: true, ...(category ? { only_category: category } : {}) });
    if (!SKILL_LANGUAGES[skill_language]) throw err(422, `язык навыков ${skill_language} не поддерживается`);
    return { tasks, lang: SKILL_LANGUAGES[skill_language], source: { generator: gen.did, data: "synthetic", seed, cases: tasks.length, hash: sha256hex(jcs(tasks.map(({ category, input, expected }) => ({ category, input, expected })))) } };
  }

  // ---------- потомки ----------
  // Потомка регистрирует владелец: мандат (подписан владельцем родителя) + родословная (подписана родителем).
  async function registerChild(parentId, body, caller) {
    const parent = orch.get(parentId);
    if (parent.status !== "active") throw err(409, `родитель ${parent.status}: потомки не регистрируются`);
    if (!parent.owner_did) throw err(409, "у родителя не указан owner_did — мандат проверить не по чему");
    if (!caller?.verified || caller.did !== parent.owner_did) throw err(403, "регистрировать потомка может только владелец родителя (подписанный запрос)");
    const { name, mcp_url, did, mandate, lineage, specialization } = body || {};
    const m = await checkVc(mandate, { type: "AgentMandate", issuer: parent.owner_did });
    if (m.id !== parent.did) throw err(400, "мандат выдан другому агенту");
    const depth = (parent.depth || 0) + 1;
    if (depth > (m.max_depth ?? 1)) throw err(403, `мандат разрешает глубину ${m.max_depth ?? 1}, а потомок был бы на глубине ${depth}`);
    const live = childrenOf(parent).filter((c) => c.status !== "revoked");
    if (live.length >= (m.max_children ?? 1)) throw err(403, `мандат разрешает не больше ${m.max_children ?? 1} потомков, уже ${live.length}`);
    if (!Array.isArray(m.categories) || !m.categories.includes(specialization)) throw err(403, `категория ${specialization} не входит в мандат`);
    // потомок специалиста специализируется только внутри области родителя: «rating:middle» → «rating:middle/3»
    if (parent.specialization && !String(specialization).startsWith(parent.specialization + "/")) throw err(403, `категория ${specialization} вне области родителя ${parent.specialization}`);
    const l = await checkVc(lineage, { type: "AgentLineage", issuer: parent.did });
    if (l.id !== did) throw err(400, "родословная выдана другому DID");
    if (l.mandate !== mandate.id) throw err(400, "родословная ссылается на другой мандат");
    if (l.scope?.category !== specialization) throw err(400, "область потомка в родословной не совпадает");
    const reg = await orch.register({ name, mcp_url, did, owner_did: parent.owner_did, level: parent.level }, { caller });
    const rec = orch.get(reg.id);
    const root = parent.root ? orch.get(parent.root) : parent;
    Object.assign(rec, { parent: parent.id, root: root.id, depth, specialization, mandate_id: mandate.id, lineage_vc: lineage.id, skills_version: 0 });
    save(rec);
    store.update("documents", {}, (d) => { d[mandate.id] = mandate; d[lineage.id] = lineage; });
    const vc = issuer.issue("AgentLineage", {
      id: rec.did, parent: parent.did, root: root.did, depth, owner: parent.owner_did, scope: { category: specialization },
      mandate: { id: mandate.id, hash: sha256hex(jcs(mandate)), max_children: m.max_children, max_depth: m.max_depth },
      parent_signature: { id: lineage.id, hash: sha256hex(jcs(lineage)) }, inherits: ["owner.verified"],
    }, { validDays: 365, agentId: rec.id });
    issuer.event("child_registered", { agent: rec.id, parent: parent.id, depth, category: specialization });
    return { ...reg, lineage: vc };
  }

  // ---------- предложения ----------
  async function submitProposal({ proposal } = {}) {
    const from = byDid(issuerOf(proposal));
    if (!from) throw err(403, "предложение подписано незарегистрированным агентом");
    if (!from.parent) throw err(403, "предложения принимаются только от потомков");
    if (from.status !== "active") throw err(409, `потомок ${from.status}`);
    const parent = orch.get(from.parent);
    const s = await checkVc(proposal, { type: "ImprovementProposal", issuer: from.did });
    if (s.id !== parent.did) throw err(400, "предложение адресовано не родителю этого потомка");
    if (!SKILL_LANGUAGES[s.skill_language]) throw err(422, `язык навыков ${s.skill_language} не поддерживается`);
    const cats = Object.keys(s.rules || {});
    if (!cats.length) throw err(400, "в предложении нет правил");
    const lang = SKILL_LANGUAGES[s.skill_language];
    const BAD_KEYS = ["__proto__", "constructor", "prototype"];
    let total = 0;
    const llmLang = lang.KIND === "llm";
    for (const c of cats) {
      if (llmLang ? !/^(goods|platform|rating):[a-z0-9_-]{1,40}(\/[a-z0-9_-]{1,20}){0,4}$/.test(c) : !lang.CATEGORIES.includes(c)) throw err(400, `неизвестная категория: ${c}`);
      const sigs = s.rules[c];
      if (!sigs || typeof sigs !== "object" || Array.isArray(sigs)) throw err(400, `rules.${c}: ожидается объект`);
      for (const [k, r] of Object.entries(sigs)) {
        if (BAD_KEYS.includes(k) || k.length > 200 || !r || typeof r !== "object" || Array.isArray(r) || JSON.stringify(r).length > (llmLang ? 60000 : 1000)) throw err(400, `rules.${c}: недопустимое правило`);
        total++;
      }
    }
    if (total > 200) throw err(413, "не больше 200 правил в одном предложении");
    // потомок может предложить свой блок и блоки своего поддерева (знания внуков, уже слитые в него)
    const outside = cats.filter((c) => c !== from.specialization && !String(c).startsWith(from.specialization + "/"));
    if (outside.length) throw err(403, `правила вне области потомка: ${outside.join(", ")}`);
    const all = store.get("proposals", {});
    if (Object.hasOwn(all, proposal.id)) throw err(409, "это предложение уже получено");
    const rec = { id: proposal.id, from: from.id, parent: parent.id, category: from.specialization, base_version: s.base_version, rules: s.rules,
      rules_count: cats.reduce((n, c) => n + Object.keys(s.rules[c]).length, 0), status: "pending", received: new Date().toISOString(), hash: sha256hex(jcs(proposal)) };
    store.update("proposals", {}, (p) => { p[rec.id] = rec; });
    issuer.event("proposal_received", { proposal: rec.id, from: from.id, parent: parent.id, rules: rec.rules_count, credential_hash: rec.hash });
    return { id: rec.id, status: rec.status, rules: rec.rules_count };
  }

  // ---------- слияние ----------
  const overlay = (base, rules) => { const s = structuredClone(base); for (const [c, sigs] of Object.entries(rules)) for (const [k, r] of Object.entries(sigs)) (s[c] ||= {})[k] = r; return s; };
  const without = (base, rules, original) => {
    const s = structuredClone(base);
    for (const [c, sigs] of Object.entries(rules)) for (const k of Object.keys(sigs)) { if (original[c]?.[k]) s[c][k] = original[c][k]; else delete s[c]?.[k]; }
    return s;
  };

  async function merge(parentId, { generator, round = 0 } = {}) {
    if (!generator) return mergeLLM(parentId, { round });
    const parent = orch.get(parentId);
    if (parent.status !== "active") throw err(409, `агент ${parent.status}`);
    const pending = Object.values(store.get("proposals", {})).filter((p) => p.parent === parent.id && p.status === "pending");
    if (!pending.length) throw err(422, "нет предложений в окне слияния");
    const { tasks, lang, source } = await heldout(generator, { round, purpose: "merge" });
    const current = await call(parent, "get_skills");
    if (current.language !== lang.LANGUAGE) throw err(422, "язык навыков родителя не совпадает с языком выборки");
    const base = current.skills;
    const A = (skills) => lang.accuracy(skills, tasks);
    const before = A(base);

    // 1) конфликты: разные правила для одной сигнатуры от разных потомков — побеждает лучшее на задачах этой сигнатуры
    const bySig = {};
    for (const p of pending) for (const [c, sigs] of Object.entries(p.rules)) for (const [k, rule] of Object.entries(sigs)) (bySig[`${c}\u0000${k}`] ||= []).push({ p, c, k, rule });
    const conflicts = [], lost = new Set();
    for (const [key, list] of Object.entries(bySig)) {
      if (new Set(list.map((x) => JSON.stringify(x.rule))).size < 2) continue;
      const [c, k] = key.split("\u0000");
      const catTasks = tasks.filter((t) => t.category === c);
      const score = (rule) => catTasks.filter((t) => lang.solve(overlay(base, { [c]: { [k]: rule } }), t) === t.expected).length;
      const ranked = list.map((x) => ({ ...x, score: score(x.rule) })).sort((a, b) => b.score - a.score);
      conflicts.push({ category: c, signature: k, winner: ranked[0].p.from, candidates: ranked.map((x) => ({ from: x.p.from, correct: x.score })) });
      for (const x of ranked.slice(1)) if (JSON.stringify(x.rule) !== JSON.stringify(ranked[0].rule)) lost.add(`${x.p.id}\u0000${c}\u0000${k}`);
    }
    // 2) каждое правило отдельно: сколько случаев отложенной выборки оно исправляет и сколько портит
    const accepted = [], rejected = [];
    for (const p of pending) {
      const keep = {}, rules = [];
      for (const [c, sigs] of Object.entries(p.rules)) for (const [k, rule] of Object.entries(sigs)) {
        const v = { category: c, signature: k, rule, parent_rule: base[c]?.[k] ?? null };
        if (lost.has(`${p.id}\u0000${c}\u0000${k}`)) { rules.push({ ...v, verdict: "уступило в конфликте" }); continue; }
        if (JSON.stringify(base[c]?.[k]) === JSON.stringify(rule)) { rules.push({ ...v, verdict: "уже есть у родителя" }); continue; }
        const cand = overlay(base, { [c]: { [k]: rule } });
        let fixed = 0, broken = 0;
        for (const t of tasks) if (t.category === c) {
          const was = lang.solve(base, t) === t.expected, now = lang.solve(cand, t) === t.expected;
          if (now && !was) fixed++; else if (was && !now) broken++;
        }
        Object.assign(v, { fixed, broken });
        if (broken > fixed) rules.push({ ...v, verdict: "ухудшает" });
        else if (!fixed && !broken) rules.push({ ...v, verdict: "не проверено: в выборке нет случаев, где оно что-то меняет" });
        else if (!fixed) rules.push({ ...v, verdict: "не меняет результат" });
        else { rules.push({ ...v, verdict: "принято" }); (keep[c] ||= {})[k] = rule; }
      }
      const after = A(overlay(base, keep));
      const gain = (after.categories[p.category] ?? 0) - (before.categories[p.category] ?? 0);
      const regress = Object.entries(before.categories).filter(([c, v]) => c !== p.category && (after.categories[c] ?? 0) < v - cfg.max_regression_pp / 100).map(([c]) => c);
      const bad = rules.filter((x) => x.verdict === "ухудшает");
      const reason = !Object.keys(keep).length ? (bad.length ? `все правила отклонены: ${bad.length} ухудшают результат` : "нет правил, улучшающих результат")
        : regress.length ? `ухудшает другие категории: ${regress.join(", ")}`
        : pp(gain) < cfg.min_gain_pp ? `прирост ${pp(gain)} п.п. меньше порога ${cfg.min_gain_pp} п.п.` : null;
      (reason ? rejected : accepted).push({ p, keep, rules, gain_pp: pp(gain), reason });
    }
    // 3) решение по предложению: принимается часть, прошедшая проверку; отклонённые правила перечисляются с причиной
    // 4) общий кандидат и вклад каждого (абляция: насколько хуже без его правил)
    let merged = base;
    for (const a of accepted) merged = overlay(merged, a.keep);
    const after = A(merged);
    const regressAll = Object.entries(before.categories).filter(([c, v]) => (after.categories[c] ?? 0) < v - cfg.max_regression_pp / 100).map(([c]) => c);
    const ok = accepted.length > 0 && after.overall > before.overall && !regressAll.length;
    const mergeId = `mg_${randomId(6)}`;
    const marginal = accepted.map((a) => Math.max(0, after.overall - A(without(merged, a.keep, base)).overall));
    const sum = marginal.reduce((s, x) => s + x, 0) || 1;
    const contributions = [];
    if (ok) accepted.forEach((a, i) => {
      const child = orch.get(a.p.from);
      const vc = issuer.issue("AgentContribution", {
        id: child.did, to: parent.did, merge: mergeId, category: a.p.category, proposal: { id: a.p.id, hash: a.p.hash },
        rules_accepted: Object.values(a.keep).reduce((n, x) => n + Object.keys(x).length, 0), rules_rejected: a.rules.filter((x) => x.verdict === "ухудшает").length, gain_pp: pp(marginal[i]), share: +(marginal[i] / sum).toFixed(3),
        heldout: source, method: "xonta-merge/0.1 (ablation)",
      }, { validDays: 365, agentId: child.id });
      contributions.push({ agent: child.id, category: a.p.category, gain_pp: pp(marginal[i]), share: +(marginal[i] / sum).toFixed(3), credential: vc.id });
    });
    const now = new Date().toISOString();
    store.update("proposals", {}, (all) => {
      for (const a of accepted) Object.assign(all[a.p.id], { rules_verdicts: a.rules, status: ok ? (a.rules.every((x) => x.verdict === "принято") ? "accepted" : "partially_accepted") : "rejected", decided: now, merge: mergeId, gain_pp: a.gain_pp, reason: ok ? null : "общий кандидат не дал прироста" });
      for (const r of rejected) Object.assign(all[r.p.id], { rules_verdicts: r.rules, status: "rejected", decided: now, merge: mergeId, gain_pp: r.gain_pp, reason: r.reason });
    });
    const record = {
      id: mergeId, parent: parent.id, at: now, round, status: ok ? "recommended" : "rejected", heldout: source,
      base: { version: current.version, hash: hashSkills(base) }, merged_hash: ok ? hashSkills(merged) : null,
      before: { overall: pp(before.overall), categories: Object.fromEntries(Object.entries(before.categories).map(([c, v]) => [c, pp(v)])) },
      after: { overall: pp(after.overall), categories: Object.fromEntries(Object.entries(after.categories).map(([c, v]) => [c, pp(v)])) },
      gain_pp: pp(after.overall - before.overall),
      accepted: ok ? accepted.map((a) => ({ proposal: a.p.id, from: a.p.from, category: a.p.category, gain_pp: a.gain_pp, rules: a.rules })) : [],
      rejected: [...rejected, ...(ok ? [] : accepted.map((a) => ({ ...a, reason: "общий кандидат не дал прироста" })))].map((r) => ({ proposal: r.p.id, from: r.p.from, category: r.p.category, gain_pp: r.gain_pp, reason: r.reason, rules: r.rules })),
      conflicts, contributions,
    };
    store.update("merges", {}, (m) => { m[mergeId] = { ...record, merged_skills: ok ? merged : null }; });
    issuer.event("merge_evaluated", { merge: mergeId, parent: parent.id, status: record.status, gain_pp: record.gain_pp, accepted: record.accepted.length, rejected: record.rejected.length, heldout_hash: source.hash });
    // рекомендация, а не изменение: владелец решает и применяет сам
    return { ...record, merged_skills: ok ? merged : null, note: ok ? "Оркестратор ничего не применяет: примените merged_skills у родителя и обновите потомков, если согласны." : undefined };
  }

  // ---------- оценка на отложенной выборке ----------
  async function evaluate(agentId, { generator, round = 0, n = cfg.heldout_cases } = {}) {
    if (!generator) return evaluateLLM(agentId, { round });
    const rec = orch.get(agentId);
    if (!["active", "deprecated"].includes(rec.status)) throw err(409, `агент ${rec.status}: новые аттестаты не выдаются`);
    if (!rec.domain_verified_at) throw err(409, "сначала подтвердите управление доменом агента");
    const { tasks, lang, source } = await heldout(generator, { round, n, category: rec.specialization || null, purpose: "eval" });
    const answers = [];
    for (let i = 0; i < tasks.length; i += 500) {
      const chunk = tasks.slice(i, i + 500);
      const res = await call(rec, "solve", { tasks: chunk.map(({ id, category, input }) => ({ id, category, input })) });
      answers.push(...res.answers);
    }
    const out = new Map(answers.map((a) => [a.id, a.output]));
    const per = {};
    for (const t of tasks) { const c = (per[t.category] ||= { passed: 0, total: 0 }); c.total++; if (out.get(t.id) === t.expected) c.passed++; }
    const categories = Object.entries(per).map(([category, c]) => ({ category, passed: c.passed, total: c.total, score: Math.round((1000 * c.passed) / c.total) / 10 }));
    const passed = categories.reduce((s, c) => s + c.passed, 0);
    const skills = await call(rec, "get_skills");
    const vc = issuer.issue("AgentEvaluation", {
      id: rec.did, categories, overall: Math.round((1000 * passed) / tasks.length) / 10,
      evaluation: { ...source, suite: lang.LANGUAGE, round }, skills: { version: skills.version, hash: skills.hash },
      tester: orch.tester.did,
    }, { validDays: 30, agentId: rec.id });
    rec.last_evaluation = { categories, evaluation: { ...source, suite: lang.LANGUAGE, round }, at: new Date().toISOString() };
    // слияние считается применённым, когда отпечаток навыков родителя совпал с рекомендованным
    const applied = [];
    store.update("merges", {}, (m) => { for (const x of Object.values(m)) if (x.parent === rec.id && x.status === "recommended" && x.merged_hash && skills.hash && x.merged_hash === skills.hash) { x.status = "applied"; x.applied_seen = new Date().toISOString(); applied.push(x.id); } });
    for (const id of applied) issuer.event("merge_applied", { merge: id, parent: rec.id, skills_hash: skills.hash });
    save(rec);
    const specialists = childrenOf(rec).filter((c) => c.status === "active").map((c) => c.specialization);
    const sig = signals.analyze(rec, rec.last_evaluation, { skip: specialists });
    return { credential: vc, overall: vc.credentialSubject.overall, categories, skills: { version: skills.version, hash: skills.hash }, merges_applied: applied, signals: sig.emitted };
  }


  // ================= языки навыков на языковых моделях (xonta-reviews/1) =================
  // Эталон — разметка судьи (более сильная модель оркестратора). Судья не истина: это записано в каждом аттестате.
  const LLM_CFG = { min_gain_pp: Number(process.env.MERGE_MIN_GAIN_PP || 2), max_regression_pp: Number(process.env.MERGE_MAX_REGRESSION_PP || 5) };
  const needLLM = () => { if (!llms?.judge || !llms?.interp) throw err(503, "у оркестратора не настроена языковая модель (LLM_PROVIDER, LLM_API_KEY)"); };
  const heldoutItems = (split) => Object.values(store.get("heldout_reviews", {})).filter((x) => !split || x.split === split);
  const heldoutHash = (items) => sha256hex(jcs(items.map((x) => [x.review.id, x.category, x.label]))).slice(0, 32);

  // Отложенная выборка: сырые отзывы берутся у зарегистрированного агента-источника, размечает судья оркестратора.
  // Товары выборки не должны совпадать с товарами трафика (это проверяет тот, кто составляет списки).
  async function buildHeldout({ source, tool = "collect_reviews", products = [], mode = "goods", platforms = null } = {}) {
    needLLM();
    const src = orch.get(source);
    if (!src.domain_verified_at) throw err(409, "источник данных должен подтвердить домен");
    if (!Array.isArray(products) || !products.length || products.length > 50) throw err(400, "products: от 1 до 50 товаров");
    const added = [], statuses = {}, seenPerCat = {};
    for (const product of products) {
      // половина товаров каждой категории — для оценки, половина — для проверки слияний
      const split = (seenPerCat[product.category] = (seenPerCat[product.category] || 0) + 1) % 2 === 1 ? "eval" : "merge";
      const res = tool === "supply" ? (await call(src, "supply", { product, ...(platforms ? { platforms } : {}) })).results : [await call(src, "collect_reviews", { product })];
      for (const r of res) {
        statuses[`${product.key}/${r.platform}`] = r.status;
        if (!r.reviews?.length) continue;
        const category = mode === "platform" ? `platform:${r.platform}` : product.category;
        const sample = r.reviews.slice(0, Number(process.env.HELDOUT_PER_PRODUCT || 20));
        const labels = await reviews.judge(llms.judge, { product, category, reviews: sample });
        const L = new Map(labels.map((l) => [l.id, l]));
        store.update("heldout_reviews", {}, (all) => { for (const rv of sample) if (L.has(rv.id)) { all[`${category}|${rv.id}`] = { product: { key: product.key, title: product.title, model: product.model, category: product.category }, category, mode, review: rv, label: L.get(rv.id), split, source: src.did, added: new Date().toISOString() }; added.push(rv.id); } });
      }
    }
    const items = heldoutItems();
    issuer.event("heldout_built", { source: src.did, added: added.length, total: items.length, hash: heldoutHash(items), judge_model: llms.judge.model });
    return { added: added.length, total: items.length, by_category: items.reduce((m, x) => ((m[x.category] = (m[x.category] || 0) + 1), m), {}), statuses };
  }

  // Разметка судьи для обратной связи: владелец агента присылает отзывы из его трафика
  async function judgeFor(agentId, { product, category, reviews: list = [] } = {}) {
    needLLM(); orch.get(agentId);
    if (!Array.isArray(list) || list.length > 40) throw err(400, "reviews: не больше 40 за вызов");
    return { labels: await reviews.judge(llms.judge, { product, category, reviews: list }), judge_model: llms.judge.model };
  }

  async function assessVia(rec, items) {
    const groups = new Map();
    for (const it of items) { const k = `${it.category}|${it.product.key}`; (groups.get(k) || groups.set(k, { product: it.product, category: it.category, items: [] }).get(k)).items.push(it); }
    const per = {};
    for (const g of groups.values()) {
      const res = await call(rec, "assess_reviews", { product: g.product, category: g.category, reviews: g.items.map((x) => x.review) });
      const sc = reviews.score(res.assessments, g.items.map((x) => x.label));
      const c = (per[g.category] ||= { passed: 0, total: 0 });
      c.passed += Math.round(sc.agreement * sc.n); c.total += sc.n;
    }
    return per;
  }

  async function evaluateLLM(agentId, { round = 0 } = {}) {
    needLLM();
    const rec = orch.get(agentId);
    if ((await call(rec, "get_skills")).language === geo.LANGUAGE) return evaluateGeo(rec, { round });
    if (!["active", "deprecated"].includes(rec.status)) throw err(409, `агент ${rec.status}: новые аттестаты не выдаются`);
    if (!rec.domain_verified_at) throw err(409, "сначала подтвердите управление доменом агента");
    const skillsNow = await call(rec, "get_skills");
    const mode = skillsNow.mode || "goods";
    // оценка — в текущем режиме агента: по категориям товаров или по площадкам; специалист — только в своей категории
    const items = heldoutItems("eval").filter((x) => (rec.specialization ? x.category === rec.specialization : (x.mode || "goods") === mode));
    if (!items.length) throw err(422, "нет размеченной отложенной выборки для категорий агента (POST /v1/heldout)");
    const per = await assessVia(rec, items);
    const categories = Object.entries(per).map(([category, c]) => ({ category, passed: c.passed, total: c.total, score: Math.round((1000 * c.passed) / c.total) / 10 }));
    const passed = categories.reduce((s, c) => s + c.passed, 0), total = categories.reduce((s, c) => s + c.total, 0);
    const skills = await call(rec, "get_skills");
    const evaluation = { data: "real-reviews", labels: "judge-model", judge_model: llms.judge.model, cases: total, hash: heldoutHash(items), suite: reviews.LANGUAGE, round,
      sources: [...new Set(items.map((x) => x.source))], metric: "доля отзывов, где оценки агента совпали с судьёй (±0,25 по релевантности и полезности, тот же вывод о признаках накрутки)" };
    const vc = issuer.issue("AgentEvaluation", { id: rec.did, categories, overall: Math.round((1000 * passed) / total) / 10, evaluation, skills: { version: skills.version, hash: skills.hash }, tester: orch.tester.did }, { validDays: 30, agentId: rec.id });
    rec.last_evaluation = { categories, evaluation, at: new Date().toISOString() };
    const applied = [];
    store.update("merges", {}, (m) => { for (const x of Object.values(m)) if (x.parent === rec.id && x.status === "recommended" && x.merged_hash && x.merged_hash === skills.hash) { x.status = "applied"; x.applied_seen = new Date().toISOString(); applied.push(x.id); } });
    for (const id of applied) issuer.event("merge_applied", { merge: id, parent: rec.id, skills_hash: skills.hash });
    save(rec);
    const specialists = childrenOf(rec).filter((c) => c.status === "active").map((c) => c.specialization);
    const sig = signals.analyze(rec, rec.last_evaluation, { skip: specialists });
    return { credential: vc, overall: vc.credentialSubject.overall, categories, skills: { version: skills.version, hash: skills.hash }, merges_applied: applied, signals: sig.emitted };
  }

  // Наложение блока потомка на навыки родителя с соблюдением ёмкости родителя (лишнее вытесняется из самых больших чужих блоков)
  // все блоки предложения: свой и поддерева (в порядке от общего к частному)
  function overlayAll(base, rules) {
    let s = base;
    for (const k of Object.keys(rules || {}).sort((a, b) => a.length - b.length)) if (rules[k]?.block) s = overlayBlock(s, k, rules[k].block);
    return s;
  }
  function overlayBlock(base, category, block) {
    const s = structuredClone(base);
    (s.blocks ||= {})[category] = structuredClone(block);
    const limit = s.limit ?? 8;
    const total = () => Object.values(s.blocks).reduce((n, b) => n + (b.examples?.length || 0), 0);
    while (total() > limit) {
      const others = Object.entries(s.blocks).filter(([c, b]) => c !== category && b.examples?.length).sort((a, b) => b[1].examples.length - a[1].examples.length);
      if (others.length) others[0][1].examples.shift(); else s.blocks[category].examples.shift();
    }
    return s;
  }

  async function mergeLLM(parentId, { round = 0 } = {}) {
    needLLM();
    const parent = orch.get(parentId);
    if ((await call(parent, "get_skills")).language === geo.LANGUAGE) return mergeGeo(parent, { round });
    if (parent.status !== "active") throw err(409, `агент ${parent.status}`);
    const pending = Object.values(store.get("proposals", {})).filter((p) => p.parent === parent.id && p.status === "pending");
    if (!pending.length) throw err(422, "нет предложений в окне слияния");
    const current = await call(parent, "get_skills");
    const items = heldoutItems("merge").filter((x) => (x.mode || "goods") === (current.mode || "goods"));
    if (!items.length) throw err(422, "нет размеченной выборки для слияния");
    const base = current.skills;
    const pctOf = (r) => Object.fromEntries(Object.entries(r.categories).map(([c, v]) => [c, pp(v)]));
    const before = await reviews.evaluateSkills(llms.interp, base, items);
    const accepted = [], rejected = [];
    for (const p of pending) {
      const cat = p.category, block = p.rules?.[cat]?.block;
      if (!block) { rejected.push({ p, reason: "в предложении нет блока навыков" }); continue; }
      const cand = overlayBlock(base, cat, block);
      const after = await reviews.evaluateSkills(llms.interp, cand, items);
      const gain = pp((after.categories[cat] ?? 0) - (before.categories[cat] ?? 0));
      const regress = Object.keys(before.categories).filter((c) => c !== cat && (after.categories[c] ?? 0) < before.categories[c] - LLM_CFG.max_regression_pp / 100);
      const reason = !(cat in before.categories) ? `в выборке нет случаев категории ${cat}` : regress.length ? `вытесняет примеры и ухудшает: ${regress.join(", ")} (ёмкость родителя ${base.limit ?? 8} примеров)` : gain < LLM_CFG.min_gain_pp ? `прирост ${gain} п.п. меньше порога ${LLM_CFG.min_gain_pp} п.п.` : null;
      (reason ? rejected : accepted).push({ p, cand, after, gain_pp: gain, reason, regress });
    }
    let merged = base;
    for (const a of accepted) merged = overlayBlock(merged, a.p.category, a.p.rules[a.p.category].block);
    const after = accepted.length ? await reviews.evaluateSkills(llms.interp, merged, items) : before;
    const ok = accepted.length > 0 && after.overall > before.overall;
    const mergeId = `mg_${randomId(6)}`;
    const source = { data: "real-reviews", labels: "judge-model", judge_model: llms.judge.model, interpreter_model: llms.interp.model, cases: items.length, hash: heldoutHash(items) };
    const contributions = [];
    if (ok) for (const a of accepted) {
      const child = orch.get(a.p.from);
      const vc = issuer.issue("AgentContribution", { id: child.did, to: parent.did, merge: mergeId, category: a.p.category, proposal: { id: a.p.id, hash: a.p.hash }, gain_pp: a.gain_pp, heldout: source, method: "xonta-merge/0.1 (llm, judge labels)" }, { validDays: 365, agentId: child.id });
      contributions.push({ agent: child.id, category: a.p.category, gain_pp: a.gain_pp, credential: vc.id });
    }
    const now = new Date().toISOString();
    store.update("proposals", {}, (all) => {
      for (const a of accepted) Object.assign(all[a.p.id], { status: ok ? "accepted" : "rejected", decided: now, merge: mergeId, gain_pp: a.gain_pp, reason: ok ? null : "общий кандидат не дал прироста" });
      for (const r of rejected) Object.assign(all[r.p.id], { status: "rejected", decided: now, merge: mergeId, gain_pp: r.gain_pp ?? null, reason: r.reason });
    });
    const record = { id: mergeId, parent: parent.id, at: now, round, status: ok ? "recommended" : "rejected", heldout: source, base: { version: current.version, hash: hashSkills(base) }, merged_hash: ok ? hashSkills(merged) : null,
      before: { overall: pp(before.overall), categories: pctOf(before) }, after: { overall: pp(after.overall), categories: pctOf(after) }, gain_pp: pp(after.overall - before.overall),
      accepted: ok ? accepted.map((a) => ({ proposal: a.p.id, from: a.p.from, category: a.p.category, gain_pp: a.gain_pp, })) : [],
      rejected: [...rejected, ...(ok ? [] : accepted.map((a) => ({ ...a, reason: "общий кандидат не дал прироста" })))].map((r) => ({ proposal: r.p.id, from: r.p.from, category: r.p.category, gain_pp: r.gain_pp ?? null, reason: r.reason })),
      contributions, llm_usage: { judge: llms.judge.usage, interp: llms.interp.usage } };
    store.update("merges", {}, (m) => { m[mergeId] = { ...record, merged_skills: ok ? merged : null }; });
    issuer.event("merge_evaluated", { merge: mergeId, parent: parent.id, status: record.status, gain_pp: record.gain_pp, heldout_hash: source.hash });
    return { ...record, merged_skills: ok ? merged : null, note: ok ? "Оркестратор ничего не применяет: примените merged_skills у родителя, если согласны." : undefined };
  }


  // ================= xonta-geo/1: эталон — оценка автора отзыва, судья не нужен =================
  // Эталонную выборку загружает оператор оркестратора (администратор) с указанием источника; она хранится у оркестратора
  // и агентам не передаётся целиком. Половина — для оценки, половина — для проверки слияний.
  function loadGeoHeldout({ items = [], source = {} } = {}) {
    if (!Array.isArray(items) || !items.length || items.length > 5000) throw err(400, "items: от 1 до 5000");
    let added = 0;
    store.update("heldout_geo", {}, (all) => {
      items.forEach((x, i) => {
        if (typeof x?.text !== "string" || !(x.rating >= 1 && x.rating <= 5)) return;
        const id = geo.reviewId(x.text);
        if (all[id]) return;
        // split/window можно задать явно: пул свежих отзывов для слияний делится на окна (каждое окно — свои отзывы)
        const split = ["eval", "merge"].includes(x.split) ? x.split : i % 2 === 0 ? "eval" : "merge";
        all[id] = { id, text: x.text.slice(0, 6000), rating: x.rating, category: geo.groupOf(x.rating), split, ...(split === "merge" && Number.isInteger(x.window) && x.window > 0 ? { window: x.window } : {}) };
        added++;
      });
    });
    const all = Object.values(store.get("heldout_geo", {}));
    const hash = sha256hex(jcs(all.map((x) => [x.id, x.rating]))).slice(0, 32);
    // отпечаток только оценочной части — по нему результаты сравнимы с прошлыми прогонами, даже если пул слияний расширен
    const eval_hash = sha256hex(jcs(all.filter((x) => x.split === "eval").map((x) => [x.id, x.rating]))).slice(0, 32);
    const windows = [...new Set(all.filter((x) => x.split === "merge").map((x) => x.window || 0))].sort((a, b) => a - b);
    store.put("heldout_geo_meta", { source, hash, eval_hash, windows, total: all.length, at: new Date().toISOString() });
    issuer.event("heldout_built", { language: geo.LANGUAGE, added, total: all.length, hash, eval_hash, source });
    return { added, total: all.length, by_category: all.reduce((m, x) => ((m[x.category] = (m[x.category] || 0) + 1), m), {}), hash, eval_hash, merge_windows: windows.length,
      by_split: all.reduce((m, x) => ((m[x.split] = (m[x.split] || 0) + 1), m), {}) };
  }
  const geoItems = (split) => Object.values(store.get("heldout_geo", {})).filter((x) => x.split === split);
  const geoSource = () => { const m = store.get("heldout_geo_meta", {}); return { data: "real-reviews", labels: "author-rating", dataset: m.source?.dataset || null, split: m.source?.split || null, hash: m.hash, ...(m.eval_hash ? { eval_hash: m.eval_hash } : {}), cases_total: m.total }; };
  // окно свежих отзывов для слияний: MERGE_ROTATE_EVERY раундов на окно, потом следующее (по кругу)
  function mergeWindow(round) {
    const ws = store.get("heldout_geo_meta", {}).windows || [0];
    const every = Number(process.env.MERGE_ROTATE_EVERY || 0);
    return every > 0 ? ws[Math.floor(Math.max(0, round - 1) / every) % ws.length] : ws[0];
  }

  async function evaluateGeo(rec, { round = 0 } = {}) {
    if (!["active", "deprecated"].includes(rec.status)) throw err(409, `агент ${rec.status}: новые аттестаты не выдаются`);
    if (!rec.domain_verified_at) throw err(409, "сначала подтвердите управление доменом агента");
    // область узла — по истинному пути отзыва; категории оценки — следующий уровень дерева (у корня — группы)
    const items = geoItems("eval").filter((x) => geo.inScope(rec.specialization, geo.pathOf(x.text, x.rating)));
    if (!items.length) throw err(422, "нет эталонной выборки (POST /v1/heldout)");
    const catOf = (it) => (rec.specialization ? geo.nextKey(rec.specialization, geo.pathOf(it.text, it.rating)) || rec.specialization : it.category);
    const preds = [];
    for (let i = 0; i < items.length; i += 50) preds.push(...(await call(rec, "rate_reviews", { reviews: items.slice(i, i + 50).map(({ id, text }) => ({ id, text })) })).ratings);
    const P = new Map(preds.map((p) => [p.id, p.rating]));
    // страж для узла с потомками: сколько отзывов отправлено потомку, сколько из них не тому, сколько оставлено себе при сомнении
    const R = new Map(preds.map((p) => [p.id, p]));
    let routing = null;
    if (preds.some((p) => p.routed_as || p.route === "blocked")) {
      routing = { n: items.length, routed: 0, wrong: 0, blocked: 0 };
      for (const it of items) {
        const p = R.get(it.id); if (!p) continue;
        if (p.route === "blocked") routing.blocked++;
        if (p.routed_as) { routing.routed++; if (p.routed_as !== geo.nextKey(rec.specialization, geo.pathOf(it.text, it.rating))) routing.wrong++; }
      }
      routing.wrong_pp = Math.round(1000 * routing.wrong / items.length) / 10;
    }
    // отзывы без ответа (модель не ответила или ошиблась форматом) считаются неверными — их число видно в аттестате
    const unanswered = items.filter((it) => P.get(it.id) == null).length;
    // много отзывов без ответа — замер испорчен (сбой модели): аттестат не выдаётся, советник замер не видит
    if (unanswered > items.length * Number(process.env.EVAL_MAX_UNANSWERED ?? 0.1)) throw err(502, `оценка не выдана: без ответа ${unanswered} из ${items.length} отзывов`);
    const per = {}; let urgentOk = 0;
    for (const it of items) { const c = (per[catOf(it)] ||= { passed: 0, total: 0 }); c.total++; if (P.get(it.id) === it.rating) c.passed++; if ((P.get(it.id) != null && P.get(it.id) <= 2) === (it.rating <= 2)) urgentOk++; }
    const categories = Object.entries(per).map(([category, c]) => ({ category, passed: c.passed, total: c.total, score: Math.round((1000 * c.passed) / c.total) / 10 }));
    const passed = categories.reduce((s, c) => s + c.passed, 0);
    const skills = await call(rec, "get_skills");
    const evaluation = { ...geoSource(), cases: items.length, suite: geo.LANGUAGE, round, metric: "доля отзывов, где оценка агента совпала с оценкой автора; urgent — совпадение решения «нужен срочный ответ» (оценка 1–2)" };
    const vc = issuer.issue("AgentEvaluation", { id: rec.did, categories, overall: Math.round((1000 * passed) / items.length) / 10, urgent_accuracy: Math.round((1000 * urgentOk) / items.length) / 10,
      ...(routing ? { routing } : {}), unanswered, evaluation, skills: { version: skills.version, hash: skills.hash }, tester: orch.tester.did }, { validDays: 30, agentId: rec.id });
    rec.last_evaluation = { categories, evaluation, at: new Date().toISOString() };
    const applied = [];
    store.update("merges", {}, (m) => { for (const x of Object.values(m)) if (x.parent === rec.id && x.status === "recommended" && x.merged_hash === skills.hash) { x.status = "applied"; x.applied_seen = new Date().toISOString(); applied.push(x.id); } });
    save(rec);
    const specialists = childrenOf(rec).filter((c) => c.status === "active").map((c) => c.specialization);
    const sig = signals.analyze(rec, rec.last_evaluation, { skip: specialists });
    const predMap = Object.fromEntries(items.map((it) => [it.id, P.get(it.id) ?? null]));
    const adv = advisor ? advisor.onEval(rec, round, predMap, { hash: skills.hash, version: skills.version, supported_actions: skills.supported_actions }, sig.emitted, routing) : null;
    return { credential: vc, overall: vc.credentialSubject.overall, urgent_accuracy: vc.credentialSubject.urgent_accuracy, categories, routing, unanswered, skills: { version: skills.version, hash: skills.hash }, merges_applied: applied, signals: sig.emitted,
      ...(adv ? { advice: adv.created, advice_resolved: adv.resolved } : {}),
      ...(process.env.EVAL_RETURN_PREDS === "1" ? { preds: Object.fromEntries(items.map((it) => [it.id, P.get(it.id) ?? null])) } : {}) };
  }

  async function mergeGeo(parent, { round = 0 } = {}) {
    if (parent.status !== "active") throw err(409, `агент ${parent.status}`);
    const pending = Object.values(store.get("proposals", {})).filter((p) => p.parent === parent.id && p.status === "pending");
    if (!pending.length) throw err(422, "нет предложений в окне слияния");
    // MERGE_SAMPLE — сколько отзывов из части «merge» берётся для проверки слияния (по умолчанию 120; первые по порядку — воспроизводимо)
    // MERGE_SAMPLE=0 — вся часть «merge»; MERGE_TEST=mcnemar — парное сравнение на одних и тех же отзывах с проверкой значимости
    const sampleN = Number(process.env.MERGE_SAMPLE ?? 120);
    const win = mergeWindow(round);
    const scoped = geoItems("merge").filter((x) => (x.window || 0) === win && geo.inScope(parent.specialization, geo.pathOf(x.text, x.rating)));
    const items = sampleN > 0 ? scoped.slice(0, sampleN) : scoped;
    const PAIRED = process.env.MERGE_TEST === "mcnemar", ALPHA = Number(process.env.MERGE_ALPHA || 0.05);
    // MERGE_SEQUENTIAL=1 — поправка на повторные проверки: k-я попытка потомка в одном окне отзывов проверяется на уровне
    // ALPHA / (k(k+1)); сумма по всем попыткам не больше ALPHA, поэтому «подглядывание» не накапливает ложные слияния
    const SEQ = process.env.MERGE_SEQUENTIAL === "1";
    const priorTries = (from) => Object.values(store.get("proposals", {})).filter((p) => p.from === from && p.decided && p.window === win).length;
    const triesNow = {}; // несколько предложений одного потомка в одном слиянии — разные попытки
    const alphaFor = (from) => { if (!SEQ) return ALPHA; const k = priorTries(from) + 1 + (triesNow[from] = (triesNow[from] ?? -1) + 1); return ALPHA / (k * (k + 1)); };
    if (!items.length) throw err(422, "нет эталонной выборки для слияния");
    const current = await call(parent, "get_skills");
    const base = current.skills;
    const pctOf = (r) => Object.fromEntries(Object.entries(r.categories).map(([c, v]) => [c, pp(v)]));
    const before = await geo.evaluateSkills(llms.interp, base, items);
    const accepted = [], rejected = [];
    for (const p of pending) {
      const cat = p.category, block = p.rules?.[cat]?.block;
      if (!block) { rejected.push({ p, reason: "в предложении нет блока навыков" }); continue; }
      const after = await geo.evaluateSkills(llms.interp, overlayAll(base, p.rules), items);
      if (PAIRED) {
        const t = geo.pairedCompare(items, before.preds, after.preds), a = alphaFor(p.from);
        t.alpha = Number(a.toPrecision(3));
        const reason = t.b <= t.c ? `нет прироста: стало верно ${t.b}, стало неверно ${t.c} из ${t.n}` : t.p_value >= a ? `прирост ${t.gain_pp} п.п. незначим (p = ${t.p_value} ≥ ${t.alpha}${SEQ ? `, попытка ${priorTries(p.from) + 1 + (triesNow[p.from] || 0)} в окне ${win}` : ""}; +${t.b} / −${t.c})` : null;
        (reason ? rejected : accepted).push({ p, gain_pp: t.gain_pp, test: t, after, reason });
        continue;
      }
      const gain = pp((after.categories[cat] ?? 0) - (before.categories[cat] ?? 0));
      const regress = Object.keys(before.categories).filter((c) => c !== cat && (after.categories[c] ?? 0) < before.categories[c] - LLM_CFG.max_regression_pp / 100);
      const reason = regress.length ? `вытесняет примеры и ухудшает: ${regress.join(", ")} (ёмкость родителя ${base.limit ?? 8} примеров)` : gain < LLM_CFG.min_gain_pp ? `прирост ${gain} п.п. меньше порога ${LLM_CFG.min_gain_pp} п.п.` : null;
      (reason ? rejected : accepted).push({ p, gain_pp: gain, reason });
    }
    let merged = base;
    for (const a of accepted) merged = overlayAll(merged, a.p.rules);
    // одно принятое предложение уже проверено на тех же отзывах — повторно модель не вызываем
    const after = PAIRED && accepted.length === 1 ? accepted[0].after : accepted.length ? await geo.evaluateSkills(llms.interp, merged, items) : before;
    const total = PAIRED && accepted.length ? (accepted.length === 1 ? accepted[0].test : geo.pairedCompare(items, before.preds, after.preds)) : null;
    const afterR = after;
    const ok = accepted.length > 0 && (PAIRED ? total.b > total.c : after.overall > before.overall);
    const mergeId = `mg_${randomId(6)}`;
    const source = { ...geoSource(), interpreter_model: llms.interp.model, cases: items.length };
    const contributions = [];
    if (ok) for (const a of accepted) {
      const child = orch.get(a.p.from);
      const vc = issuer.issue("AgentContribution", { id: child.did, to: parent.did, merge: mergeId, category: a.p.category, proposal: { id: a.p.id, hash: a.p.hash }, gain_pp: a.gain_pp, ...(a.test ? { test: { kind: "mcnemar-exact", n: a.test.n, improved: a.test.b, worsened: a.test.c, p_value: a.test.p_value, alpha: a.test.alpha ?? ALPHA, sequential: SEQ, window: win } } : {}), heldout: source, method: PAIRED ? (SEQ ? "xonta-merge/0.3 (paired, McNemar, sequential alpha)" : "xonta-merge/0.2 (paired, McNemar)") : "xonta-merge/0.1 (llm, author labels)" }, { validDays: 365, agentId: child.id });
      contributions.push({ agent: child.id, category: a.p.category, gain_pp: a.gain_pp, p_value: a.test?.p_value ?? null, credential: vc.id });
    }
    const now = new Date().toISOString();
    store.update("proposals", {}, (all) => {
      for (const a of accepted) Object.assign(all[a.p.id], { status: ok ? "accepted" : "rejected", decided: now, merge: mergeId, window: win, gain_pp: a.gain_pp, reason: ok ? null : "общий кандидат не дал прироста" });
      for (const r of rejected) Object.assign(all[r.p.id], { status: "rejected", decided: now, merge: mergeId, window: win, gain_pp: r.gain_pp ?? null, reason: r.reason });
    });
    const record = { id: mergeId, parent: parent.id, at: now, round, status: ok ? "recommended" : "rejected", heldout: { ...source, window: win }, base: { version: current.version, hash: hashSkills(base) }, merged_hash: ok ? hashSkills(merged) : null,
      before: { overall: pp(before.overall), categories: pctOf(before) }, after: { overall: pp(afterR.overall), categories: pctOf(afterR) }, gain_pp: pp(afterR.overall - before.overall),
      test: total ? { kind: "mcnemar-exact", ...total, alpha: ALPHA, sequential: SEQ } : null,
      accepted: ok ? accepted.map((a) => ({ proposal: a.p.id, from: a.p.from, category: a.p.category, gain_pp: a.gain_pp, p_value: a.test?.p_value ?? null, alpha: a.test?.alpha ?? null })) : [],
      rejected: [...rejected, ...(ok ? [] : accepted.map((a) => ({ ...a, reason: "общий кандидат не дал прироста" })))].map((r) => ({ proposal: r.p.id, from: r.p.from, category: r.p.category, gain_pp: r.gain_pp ?? null, p_value: r.test?.p_value ?? null, reason: r.reason })),
      contributions };
    store.update("merges", {}, (m) => { m[mergeId] = { ...record, merged_skills: ok ? merged : null }; });
    issuer.event("merge_evaluated", { merge: mergeId, parent: parent.id, status: record.status, gain_pp: record.gain_pp, heldout_hash: source.hash });
    return { ...record, merged_skills: ok ? merged : null, note: ok ? "Оркестратор ничего не применяет: примените merged_skills у родителя, если согласны." : undefined };
  }

  // ---------- каскад ----------
  // Отзыв родителя не отзывает потомков молча: они приостанавливаются до решения владельца (у них могут быть пользователи)
  async function cascade(id, status, reason) {
    if (status !== "revoked") return [];
    const out = [];
    const walk = async (rec) => {
      for (const c of childrenOf(rec)) {
        if (["active", "deprecated"].includes(c.status)) { await orch.setAgentStatus(c.id, { status: "suspended", reason: `предок отозван: ${reason || rec.id}` }, { admin: true }); out.push(c.id); }
        await walk(c);
      }
    };
    await walk(orch.get(id));
    return out;
  }

  function lineageOf(id) {
    const rec = orch.get(id);
    const chain = [];
    for (let r = rec; r; r = r.parent ? orch.get(r.parent) : null) chain.push({ id: r.id, did: r.did, depth: r.depth || 0, status: r.status, specialization: r.specialization || null });
    const tree = (r) => ({ id: r.id, name: r.name, did: r.did, status: r.status, specialization: r.specialization || null, children: childrenOf(r).map(tree) });
    return { chain, tree: tree(chain.at(-1) ? orch.get(chain.at(-1).id) : rec) };
  }

  const listProposals = (parentId) => Object.values(store.get("proposals", {})).filter((p) => p.parent === parentId).map(({ rules, ...p }) => p);
  const listMerges = (parentId) => Object.values(store.get("merges", {})).filter((m) => m.parent === parentId).map(({ merged_skills, ...m }) => m);

  return { registerChild, submitProposal, merge, evaluate, cascade, lineageOf, listProposals, listMerges, assertPublicUrl, buildHeldout, judgeFor, loadGeoHeldout, advisor };
}
