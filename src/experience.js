// Книга опыта оркестратора и его послужной список. Хранится в постоянном хранилище оркестратора и переживает прогоны:
// оркестратор помнит, какие приёмы в каких областях и категориях работали, и набирает навыки от прогона к прогону.
//
//  • запись опыта: область (закупки, поддержка…) → категория (мошенники, возвраты…, «all» — по всем) → приём
//    (team:check, objective:fraud…); у записи — исходы у выполнивших и у контроля, средний выигрыш, доказательства
//    (подписанные исходы советов AdviceOutcome);
//  • пакет опыта по категориям — подписанный ответ на запрос другого оркестратора или агента;
//  • послужной список — подписанные итоги: сколько агентов вёл, насколько советы лучше контроля, сбывались ли прогнозы,
//    держали ли агенты назначенный бюджет, ложные тревоги, точность аудита, чей чужой опыт подтвердился;
//  • обмен опытом: запрос пакета у другого оркестратора, проверка подписи и доказательств, затем проверка приёма на своих
//    заданиях — только после неё чужой опыт входит в книгу (и доверие к источнику растёт или падает);
//  • направление агента к другому оркестратору, если в категории у того опыт сильнее.
import { jcs, sha256hex } from "./crypto.js";
import { verifyProof } from "./vc.js";
import { betaSample } from "./advisor.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const num = (k, d) => (process.env[k] != null && process.env[k] !== "" ? Number(process.env[k]) : d);
const blank = () => ({ n: 0, success: 0, gain: 0 });
const keyOf = (d, c, t) => `${d}|${c}|${t}`;
export const famOf = (t) => String(t).split(/[:@]/)[0];
// тот же приём: точное совпадение ключа; цели (objective:…) из разных областей считаются родственными — опыт переносится с весом
const sameTech = (a, b) => a.technique === b.technique || (a.domain !== b.domain && famOf(a.technique) === "objective" && famOf(b.technique) === "objective");
function rngOf(seed) { let s = parseInt(sha256hex(String(seed)).slice(0, 8), 16) || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967297; }
// P(выполнившие успешнее контроля) по бета-апостериорным
export function probBetter(t, c, seed = "pb") { const r = rngOf(`${seed}-${t.n}-${t.success}-${c.n}-${c.success}`); let k = 0; for (let i = 0; i < 400; i++) if (betaSample(1 + t.success, 1 + t.n - t.success, r) > betaSample(1 + c.success, 1 + c.n - c.success, r)) k++; return Math.round(k / 4) / 100; }

// направление: приём считается, только если у него есть успехи и хотя бы один контрольный случай (EXP_REFERRAL_MIN_CONTROL)
const REFERRAL_MIN_CONTROL = num("EXP_REFERRAL_MIN_CONTROL", 1);
export function measuredVsControl(e) { return (e.treated?.success || 0) > 0 && (e.control?.n || 0) >= REFERRAL_MIN_CONTROL; }
export function controlledBest(entries) { return Math.max(0, ...entries.filter(measuredVsControl).map((e) => e.prob_better ?? 0)); }

// выбор оркестратора по подписанному послужному списку: разница «выполненные против контроля» с поправкой на число измерений.
// 0.14.4: оценка есть, только если контрольных случаев не меньше EXP_TRACK_MIN_CONTROL. В run-series1-c у оркестратора 2 было
// 21 выполненный совет (почти все — рецепты новичкам, они выдаются без контроля) и 1 контрольный: 0.95 − 0 = 0.95 против 0.68 у оркестратора 1
const TRACK_MIN_CONTROL = num("EXP_TRACK_MIN_CONTROL", 3);
export function trackScore(t, minControl = TRACK_MIN_CONTROL) {
  const a = t?.advice || {}, served = Object.values(t?.agents_served || {}).reduce((x, y) => x + y, 0);
  if (!served || (a.measured || 0) < 3 || a.treated_success == null) return null;
  if (a.control_n != null && a.control_n < minControl) return null;
  return Math.round(100 * (a.treated_success - (a.control_success ?? 0)) * Math.min(1, (a.measured || 0) / 20)) / 100;
}

export function createExperience({ store, issuer, resolver, publicUrl, name = process.env.ORCH_NAME || "orchestrator" }) {
  const W = { decay: num("EXP_DECAY", 0.6), cross_domain: num("EXP_CROSS_DOMAIN_W", 0.3), foreign: num("EXP_FOREIGN_W", 0.5), recipe_prob: num("EXP_RECIPE_PROB", 0.8), recipe_min_n: num("EXP_RECIPE_MIN_N", 0) };
  const book = () => store.get("experience", { entries: {}, foreign: {}, evidence: {}, track: {}, runs: [] });
  let bookVer = 0; // 0.16: меняется при каждой записи в книгу — по нему сбрасывается кэш послужного списка
  const upd = (fn) => { bookVer++; return store.update("experience", { entries: {}, foreign: {}, evidence: {}, track: {}, runs: [] }, fn); };

  // ---------- запись собственного опыта ----------
  function record({ domain, category = "all", technique, arm, success, gain = 0, credential = null, run = null, payload = null, origin = "own" }) {
    upd((b) => {
      const e = (b.entries[keyOf(domain, category, technique)] ||= { domain, category, technique, treated: blank(), control: blank(), evidence: [], runs: [], origin });
      if (payload && !e.payload) e.payload = payload;
      const g = arm === "control" ? e.control : e.treated; g.n++; if (success) g.success++; g.gain += gain;
      // исходы по прогонам: свежие весят больше, а расхождение свежих со старыми — признак, что опыт устарел
      if (!e.byRun) { e.byRun = {}; if (e.treated.n + e.control.n > 1) e.byRun.legacy = { treated: { ...e.treated, n: e.treated.n - (arm === "control" ? 0 : 1), success: e.treated.success - (arm !== "control" && success ? 1 : 0) }, control: { ...e.control, n: e.control.n - (arm === "control" ? 1 : 0), success: e.control.success - (arm === "control" && success ? 1 : 0) }, runs: e.runs.slice() }; }
      const bk = (e.byRun[run || "none"] ||= { treated: blank(), control: blank() }), bg = arm === "control" ? bk.control : bk.treated; bg.n++; if (success) bg.success++;
      staleCheck(e, run || "none", b);
      if (credential && !e.evidence.includes(credential)) { e.evidence.push(credential); if (e.evidence.length > 40) e.evidence.splice(0, e.evidence.length - 40); }
      if (run && !e.runs.includes(run)) e.runs.push(run);
      e.updated = new Date().toISOString();
      if (credential) { const rec = store.get("credentials", {})[credential]; if (rec) b.evidence[credential] = { digest: rec.hash, issuer: issuer.did, live: true }; }
    });
  }
  // устаревание: история (прошлые прогоны) уверенно говорит «работает», а свежие исходы этого прогона — нет
  function staleCheck(e, run, b) {
    const fresh = e.byRun[run]; if (!fresh) return;
    const H = { treated: blank(), control: blank() };
    for (const [k, x] of Object.entries(e.byRun)) if (k !== run) { H.treated.n += x.treated.n; H.treated.success += x.treated.success; H.control.n += x.control.n; H.control.success += x.control.success; }
    if (H.treated.n < 2) return;
    const hp = probBetter(H.treated, H.control, `h-${e.technique}`), fp = probBetter(fresh.treated, fresh.control, `f-${e.technique}`);
    if (!e.stale && hp >= 0.8 && fresh.treated.n >= 3 && fp <= 0.4) { e.stale = { since: run, history_prob: hp, fresh_prob: fp, fresh: structuredClone(fresh), at: new Date().toISOString() }; (b.track.stale ||= []).push({ key: keyOf(e.domain, e.category, e.technique), run, history_prob: hp, fresh_prob: fp }); }
    else if (e.stale && fp >= 0.7 && fresh.treated.n >= 3) { e.recovered = { run, fresh_prob: fp }; delete e.stale; }
  }
  // вес исходов записи: прогон этого запуска — 1, каждый прогон назад — ×decay; у устаревшей записи старое ещё ×0.25
  function weighted(e, b) {
    const cur = b.runs.at(-1)?.id, ids = b.runs.map((r) => r.id), T = blank(), C = blank();
    const buckets = e.byRun ? Object.entries(e.byRun) : [["legacy", { treated: e.treated, control: e.control, runs: e.runs }]];
    for (const [k, x] of buckets) {
      let age; if (k === cur || k === "none") age = 0; else if (k === "legacy") age = (x.runs || []).includes(ids.at(-2)) ? 1 : 2; else { const i = ids.indexOf(k); age = i < 0 ? 2 : Math.max(1, ids.length - 1 - i); }
      const w = Math.pow(W.decay, age) * (e.stale && k !== cur ? 0.25 : 1);
      T.n += w * x.treated.n; T.success += w * x.treated.success; C.n += w * x.control.n; C.success += w * x.control.success;
    }
    return { treated: T, control: C };
  }
  function track(kind, data = {}) {
    upd((b) => {
      const t = b.track;
      if (kind === "agent") { (t.agents ||= {})[data.domain] = ((t.agents || {})[data.domain] || 0) + 1; }
      if (kind === "advice") { (t.advice ||= []).push({ pred: data.pred, raw: data.raw ?? data.pred, success: !!data.success, arm: data.arm, confounded: !!data.confounded, domain: data.domain, tagged: true, ...(data.recipe ? { recipe: true } : {}) }); if (t.advice.length > 3000) t.advice.splice(0, t.advice.length - 3000); }
      if (kind === "budget") { const x = ((t.budget ||= {})[data.domain] ||= { periods: 0, within: 0 }); x.periods++; if (data.within) x.within++; }
      if (kind === "drift_flag") (t.drift ||= { flags: [], verdicts: [] }).flags.push({ agent: data.agent, round: data.round, at: new Date().toISOString() });
      if (kind === "drift_verdict") (t.drift ||= { flags: [], verdicts: [] }).verdicts.push({ agent: data.agent, flagged_round: data.flagged_round, corrupted_round: data.corrupted_round ?? null, verdict: data.verdict });
      if (kind === "audit") { (t.audits ||= []).push({ source: data.source, estimate: data.estimate, ci95: data.ci95, truth: data.truth, inside: data.ci95 ? data.truth >= data.ci95[0] && data.truth <= data.ci95[1] : null, run: data.run }); }
      if (kind === "import") (t.imports ||= []).push({ peer: data.peer, key: data.key, status: data.status, reason: data.reason || null, at: new Date().toISOString() });
      if (kind === "referral") (t.referrals ||= []).push({ agent: data.agent, to: data.to, category: data.category, accepted: data.accepted ?? null });
      if (kind === "descendant_incident") (t.descendants ||= { incidents: [], verdicts: [] }).incidents.push({ agent: data.agent, round: data.round, level: data.level, signals: data.signals });
      if (kind === "descendant_verdict") (t.descendants ||= { incidents: [], verdicts: [] }).verdicts.push({ agent: data.agent, verdict: data.verdict, bad_from_round: data.bad_from_round ?? null, caught_round: data.caught_round ?? null });
      if (kind === "run") b.runs.push({ id: data.id, domain: data.domain, started: new Date().toISOString() });
    });
  }

  // ---------- приоры для советника: свой опыт, опыт других областей, подтверждённый чужой ----------
  // складываются исходы того же приёма: своя область — вес 1, другая область — cross_domain, чужой подтверждённый — foreign × доверие
  function prior(domain, technique, category = "all") {
    const b = book(), T = blank(), C = blank(), me = { domain, technique };
    const add = (e, w) => { if (w <= 0) return; T.n += w * e.treated.n; T.success += w * e.treated.success; C.n += w * e.control.n; C.success += w * e.control.success; };
    for (const e of Object.values(b.entries)) if (e.category === category && sameTech(me, e)) add(weighted(e, b), e.domain === domain ? 1 : W.cross_domain);
    for (const p of Object.values(b.foreign)) { const tr = trustOf(p); for (const e of Object.values(p.entries || {})) if (e.status === "validated" && e.category === category && sameTech(me, e)) add(e, (e.domain === domain ? 1 : W.cross_domain) * W.foreign * tr); }
    const r = (x) => ({ n: Math.round(100 * x.n) / 100, success: Math.round(100 * x.success) / 100, gain: 0 });
    return { treated: r(T), control: r(C) };
  }
  const trustOf = (p) => { const t = p.trust || {}; return Math.max(0, Math.min(1, (1 + (t.validated || 0)) / (2 + (t.validated || 0) + (t.rejected || 0) + 2 * (t.bad_evidence || 0)))); };

  // приёмы, которые можно сразу дать новичку: в своей области (свой опыт или подтверждённый чужой), с содержимым приёма,
  // P(лучше контроля) по сложенным исходам ≥ min_prob и хотя бы один успех
  // 0.19: минимальная выборка (EXP_RECIPE_MIN_N в каждой группе). По умолчанию 0 — так работает песочница, где рецепты
  // из книги-затравки идут на 2 исхода против 0–1; на живых сферах используйте /v1/recipes (src/recipes.js), там минимум
  // обязателен, а группы назначает оркестратор
  function recipes(domain, { min_prob = W.recipe_prob, category = "all", min_n = W.recipe_min_n } = {}) {
    const b = book(), seen = new Map();
    for (const e of Object.values(b.entries)) if (e.domain === domain && e.category === category && e.payload) seen.set(e.technique, { e, origin: e.origin || "own" });
    for (const [did, p] of Object.entries(b.foreign)) for (const e of Object.values(p.entries || {})) if (e.status === "validated" && e.domain === domain && e.category === category && e.payload && !seen.has(e.technique)) seen.set(e.technique, { e, origin: `peer:${did}` });
    const out = [];
    for (const [tech, { e, origin }] of seen) {
      const agg = prior(domain, tech, category); if (agg.treated.success < 1) continue;
      if (min_n > 0 && (agg.treated.n < min_n || agg.control.n < min_n)) continue;
      const pb = probBetter(agg.treated, agg.control, tech); if (pb < min_prob) continue;
      out.push({ technique: tech, category, prob_better: pb, treated: agg.treated, control: agg.control, origin, runs: (e.runs || []).length, payload: e.payload });
    }
    return out.sort((a, b) => b.prob_better - a.prob_better);
  }

  // ---------- каталог, пакет опыта, послужной список ----------
  // 0.19: measured — есть исходы в обеих группах; без этого P(лучше контроля) получается из одного априорного распределения
  // (0 применений против 0 из 7 давало 0,9) и смысла не несёт
  function summarize(e) { const pb = probBetter(e.treated, e.control, e.technique), measured = e.treated.n > 0 && e.control.n > 0; return { measured, status: !measured ? "unmeasured" : (W.recipe_min_n > 0 && (e.treated.n < W.recipe_min_n || e.control.n < W.recipe_min_n)) ? "hypothesis" : "measured", domain: e.domain, category: e.category, technique: e.technique, treated: e.treated, control: e.control, mean_gain: e.treated.n ? Math.round(100 * e.treated.gain / e.treated.n) / 100 : null, prob_better: pb, evidence: e.evidence.length, runs: e.runs.length, origin: e.origin || "own", payload: e.payload || null, stale: e.stale ? { since: e.stale.since, history_prob: e.stale.history_prob, fresh_prob: e.stale.fresh_prob } : null }; }
  function catalog({ domain = null } = {}) {
    const b = book(), out = {};
    for (const e of Object.values(b.entries)) { if (domain && e.domain !== domain) continue; ((out[e.domain] ||= {})[e.category] ||= []).push(summarize(e)); }
    return { orchestrator: issuer.did, name, url: publicUrl, domains: out, track: trackSummary() };
  }
  function pack({ domain, categories = null } = {}) {
    if (!domain) throw err(400, "domain");
    const b = book(), entries = Object.values(b.entries).filter((e) => e.domain === domain && (!categories || categories.includes(e.category) || e.category === "all")).map((e) => ({ ...summarize(e), evidence_ids: e.evidence.slice(0, 12) }));
    return issuer.issue("ExperiencePack", { id: issuer.did, name, domain, categories: categories || "all", entries, track: trackSummary(), issued_for: "orchestrator or agent query" }, { validDays: 7 });
  }
  function trackSummary() {
    const t = book().track, adv = (t.advice || []).filter((a) => !a.confounded), y = (a) => (a.success ? 1 : 0);
    const treated = adv.filter((a) => a.arm !== "control"), control = adv.filter((a) => a.arm === "control");
    // 0.14.4: рецепт выдаётся без контроля, поэтому в сравнение «выполненные против контроля» не идёт (Брайер — как раньше, по всем выполненным).
    // Исходы до 0.14.4 рецептами не помечены — для них защита в trackScore: без контрольных случаев оценки нет
    // 0.17.2: исходы до 0.14.4 рецептами не помечались, и рецепт без контроля выглядел как совет против контроля. В run-series1-a2
    // это подняло оценку оркестратора 2 до 0.97 против 0.66, и агенты 7–9 остались у него. Теперь против контроля идут только
    // исходы с пометкой (tagged — с 0.17.2 у всех новых); старые неразмеченные видны отдельно и в сравнение не идут
    const vsControl = treated.filter((a) => a.tagged && !a.recipe), recipes = treated.filter((a) => a.recipe), untagged = treated.filter((a) => !a.tagged && !a.recipe);
    const rate = (l) => (l.length ? Math.round(100 * l.filter((a) => a.success).length / l.length) / 100 : null);
    const baseT = treated.length ? treated.reduce((s, a) => s + y(a), 0) / treated.length : 0;
    const drift = t.drift || { flags: [], verdicts: [] };
    const budget = Object.fromEntries(Object.entries(t.budget || {}).map(([d, x]) => [d, { periods: x.periods, within_share: x.periods ? Math.round(100 * x.within / x.periods) / 100 : null }]));
    const audits = t.audits || [];
    const imports = (t.imports || []).reduce((m, x) => { const k = x.peer; (m[k] ||= { validated: 0, rejected: 0, bad_evidence: 0 }); if (x.status === "validated") m[k].validated++; if (x.status === "rejected") m[k].rejected++; if (x.status === "bad_evidence") m[k].bad_evidence++; return m; }, {});
    return {
      agents_served: t.agents || {}, runs: book().runs.length,
      // 0.14.1: прогноз — это вероятность успеха выполненного совета, поэтому Брайер и база считаются только по выполненным.
      // В контроле совет не выполнялся, его «успех» почти всегда 0, и прогноз 0.6–0.7 там не про то (run-10r)
      advice: { measured: adv.length, treated_success: rate(vsControl), control_success: rate(control), treated_n: vsControl.length, control_n: control.length, recipes: recipes.length, untagged_before_0_17_2: untagged.length, brier: treated.length ? Math.round(10000 * treated.reduce((s, a) => s + (a.pred - y(a)) ** 2, 0) / treated.length) / 10000 : null, baseline_brier: treated.length ? Math.round(10000 * treated.reduce((s, a) => s + (baseT - y(a)) ** 2, 0) / treated.length) / 10000 : null, brier_n: treated.length },
      budget_adherence: budget,
      stale_experience: (t.stale || []).length,
      descendants: (() => { const d = t.descendants || { incidents: [], verdicts: [] }; return { incidents: d.incidents.length, caught: d.verdicts.filter((v) => v.verdict === "caught").length, false_alarms: d.verdicts.filter((v) => v.verdict === "false_alarm").length, missed: d.verdicts.filter((v) => v.verdict === "missed").length }; })(),
      drift_alarms: { flags: drift.flags.length, confirmed: drift.verdicts.filter((v) => v.verdict === "confirmed").length, false_alarms: drift.verdicts.filter((v) => v.verdict === "false_alarm").length, missed: drift.verdicts.filter((v) => v.verdict === "missed").length, descendant: drift.verdicts.filter((v) => v.verdict === "descendant").length },
      audit_accuracy: audits.length ? { checks: audits.length, truth_inside_ci: Math.round(100 * audits.filter((a) => a.inside).length / audits.length) / 100 } : null,
      peer_experience: imports, referrals: (t.referrals || []).length, archived_from: t.archived_from || [],
    };
  }
  // 0.16: пока книга не менялась (и не дольше 10 минут), отдаётся тот же аттестат — справочники и соседи забирают его при каждом обходе
  let trCache = null;
  const trackRecord = () => {
    if (trCache && trCache.ver === bookVer && Date.now() - trCache.at < 600_000) return trCache.vc;
    trCache = { ver: bookVer, at: Date.now(), vc: issuer.issue("OrchestratorTrackRecord", { id: issuer.did, name, ...trackSummary(), method: "own measurements; advice outcomes vs control; honest failures (false alarms, rejected imports) included" }, { validDays: 7 }) };
    return trCache.vc;
  };

  // ---------- засев опыта (из архивов прошлых прогонов) и доказательства ----------
  // архивные записи (исходы советов и подборов прошлых прогонов) оркестратор переподписывает своим ключом как ArchivedOutcome:
  // в аттестате — откуда запись, отпечаток исходного аттестата (если он сохранился) и сам исход; так доказательство проверяемо,
  // а его архивное происхождение не скрыто
  function seed({ entries = [], archive = [], track: tr = null, replace = false } = {}) {
    const ids = {};
    for (const a of archive) {
      const vc = issuer.issue("ArchivedOutcome", { id: issuer.did, source: a.source, original: a.original || null, technique: a.technique, category: a.category || "all", outcome: a.outcome, note: a.note || "архив прошлого прогона; исходный ключ подписи не сохранился — запись переподписана этим оркестратором" }, { validDays: 3650 });
      (ids[a.key] ||= []).push(vc.id);
      upd((b) => { b.evidence[vc.id] = { digest: sha256hex(jcs(vc)), issuer: issuer.did, live: true, archived: { source: a.source, original: a.original || null } }; });
    }
    upd((b) => {
      if (replace) b.entries = {};
      for (const e of entries) {
        const k = keyOf(e.domain, e.category, e.technique), ev = [...(e.evidence || []), ...(ids[e.key || k] || [])].slice(-40);
        for (const id of e.evidence || []) { const rec = store.get("credentials", {})[id]; if (rec && !b.evidence[id]) b.evidence[id] = { digest: rec.hash, issuer: issuer.did, live: true }; }
        b.entries[k] = { domain: e.domain, category: e.category, technique: e.technique, treated: e.treated || blank(), control: e.control || blank(), evidence: ev, runs: e.runs || [], origin: e.origin || "seed", payload: e.payload || null, note: e.note || null };
      }
    });
    // послужной список из архивов дописывается к своему (агенты, исходы советов, тревоги, аудит) — с пометкой источника
    if (tr) upd((b) => { const t = b.track;
      for (const [d, n] of Object.entries(tr.agents || {})) (t.agents ||= {})[d] = (t.agents[d] || 0) + n;
      (t.advice ||= []).push(...(tr.advice || []));
      t.drift ||= { flags: [], verdicts: [] }; t.drift.flags.push(...(tr.drift?.flags || [])); t.drift.verdicts.push(...(tr.drift?.verdicts || []));
      (t.audits ||= []).push(...(tr.audits || []));
      for (const [d, x] of Object.entries(tr.budget || {})) { const y = ((t.budget ||= {})[d] ||= { periods: 0, within: 0 }); y.periods += x.periods; y.within += x.within; }
      t.archived_from = [...new Set([...(t.archived_from || []), ...(tr.advice || []).map((a) => a.source).filter(Boolean)])];
    });
    return { entries: Object.keys(book().entries).length, archived_evidence: archive.length };
  }
  // самоподписанный аттестат по просьбе администратора (стенд: нечестный оркестратор «доказывает» выдуманный опыт сам себе)
  const selfIssue = ({ type = "AdviceOutcome", subject = {} } = {}) => issuer.issue(type, { id: issuer.did, ...subject }, { validDays: 365 });
  function evidence(id) {
    // отдаются только аттестаты, на которые ссылается книга опыта, — не все аттестаты оркестратора
    const rec = store.get("credentials", {})[id], e = book().evidence[id];
    if (!e) throw err(404, "доказательство не найдено");
    return { id, digest: e.digest, live: !!e.live, archived: e.archived || null, vc: rec?.vc || e.vc || null };
  }

  // ---------- обмен опытом между оркестраторами ----------
  async function fetchJson(url, body = null) { const r = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}); const j = await r.json().catch(() => ({})); if (!r.ok) throw err(502, `${url}: ${r.status} ${j.error || ""}`); return j; }
  const payloadSig = (p) => JSON.stringify(p || null);
  async function verifyVc(vc) { return verifyProof(vc, (vm) => resolver.keyFor(vm)); }
  // запросить пакет у другого оркестратора и проверить: подпись пакета, затем доказательства каждой записи
  async function learnFrom({ peer_url, domain, categories = null }) {
    const pk = await fetchJson(`${peer_url}/v1/experience/query`, { domain, categories });
    const sig = await verifyVc(pk);
    const peerDid = typeof pk.issuer === "string" ? pk.issuer : pk.issuer?.id;
    if (!sig.ok) { track("import", { peer: peerDid || peer_url, key: "*", status: "bad_evidence", reason: `подпись пакета: ${sig.reason}` }); upd((b) => { const p = (b.foreign[peerDid || peer_url] ||= { url: peer_url, trust: {}, entries: {} }); p.trust.bad_evidence = (p.trust.bad_evidence || 0) + 1; }); return { peer: peerDid, ok: false, reason: sig.reason, candidates: [] }; }
    const candidates = [];
    for (const e of pk.credentialSubject.entries || []) {
      const key = keyOf(e.domain, e.category, e.technique);
      let ok = (e.evidence_ids || []).length > 0, why = ok ? null : "нет доказательств";
      for (const id of (e.evidence_ids || []).slice(0, 3)) {
        try {
          const ev = await fetchJson(`${peer_url}/v1/experience/evidence/${encodeURIComponent(id)}`);
          if (ev.vc) { const v = await verifyVc(ev.vc); if (!v.ok) { ok = false; why = `доказательство ${id}: ${v.reason}`; break; } if (sha256hex(jcs(ev.vc)) !== ev.digest) { ok = false; why = `доказательство ${id}: отпечаток не совпадает`; break; } }
          else if (!ev.archived) { ok = false; why = `доказательство ${id}: нет ни аттестата, ни архивной записи`; break; }
        } catch (x) { ok = false; why = `доказательство ${id} не получено`; break; }
      }
      // уже проверенный у себя приём (в прошлом прогоне) не проверяется заново: статус и итог проверки сохраняются
      let status = ok ? "pending" : "bad_evidence";
      upd((b) => { const p = (b.foreign[peerDid] ||= { url: peer_url, trust: {}, entries: {} }); p.url = peer_url; const was = p.entries[key];
        if (ok && was && ["validated", "rejected"].includes(was.status) && payloadSig(was.payload) === payloadSig(e.payload)) status = was.status;
        else if (!ok && was?.status === "bad_evidence") status = "bad_evidence_known";
        p.entries[key] = { ...e, treated: e.treated, control: e.control, status: status === "bad_evidence_known" ? "bad_evidence" : status, reason: why, check: was?.check || null };
        if (status === "bad_evidence") p.trust.bad_evidence = (p.trust.bad_evidence || 0) + 1; });
      if (status === "bad_evidence") track("import", { peer: peerDid, key, status: "bad_evidence", reason: why });
      candidates.push({ key, technique: e.technique, category: e.category, claimed: { treated: e.treated, control: e.control, prob_better: e.prob_better, mean_gain: e.mean_gain }, payload: e.payload, evidence_ok: ok, reason: why, status });
    }
    return { peer: peerDid, peer_track: pk.credentialSubject.track, ok: true, candidates };
  }
  // итог собственной проверки чужого приёма: подтверждён или отклонён; доверие к источнику меняется
  // count — засчитать проверку в доверие к источнику (одна проверка приёма может закрыть несколько записей: по всем и по категориям)
  function settleForeign({ peer, key, validated, detail = null, count = true }) {
    upd((b) => { const p = b.foreign[peer]; if (!p?.entries?.[key]) return; p.entries[key].status = validated ? "validated" : "rejected"; p.entries[key].check = detail; if (count) p.trust[validated ? "validated" : "rejected"] = (p.trust[validated ? "validated" : "rejected"] || 0) + 1; });
    if (count) track("import", { peer, key, status: validated ? "validated" : "rejected", reason: detail ? JSON.stringify(detail).slice(0, 300) : null });
    return { peer, key, status: validated ? "validated" : "rejected", trust: trustOf(book().foreign[peer] || {}) };
  }
  function peers() { return Object.entries(book().foreign).map(([did, p]) => ({ did, url: p.url, trust: Math.round(100 * trustOf(p)) / 100, counts: p.trust, entries: Object.values(p.entries || {}).map((e) => ({ category: e.category, technique: e.technique, status: e.status, reason: e.reason || null })) })); }

  // направление: в категории у себя опыта мало, а у известного оркестратора он сильный и проверенный — честно сказать агенту
  async function referral({ domain, category, peer_urls = [] }) {
    // 0.14.3: свой опыт и чужой сравниваются только по приёмам, измеренным против контроля; рецепт без контроля — не доказательство
    const own = Object.values(book().entries).filter((e) => e.domain === domain && e.category === category);
    const ownBest = controlledBest(own.map((e) => ({ ...e, prob_better: probBetter(e.treated, e.control, e.technique) })));
    let best = null; const skipped = [];
    for (const url of peer_urls) {
      try {
        const cat = await fetchJson(`${url}/v1/experience/catalog?domain=${encodeURIComponent(domain)}`);
        // не направлять к тому, чьи доказательства уже не прошли проверку, и к тому, у кого нет подтверждённой работы с агентами
        const known = book().foreign[cat.orchestrator];
        if (known && trustOf(known) < 0.4) { skipped.push({ url, reason: `доверие к опыту ${Math.round(100 * trustOf(known)) / 100}: доказательства не прошли проверку или приёмы не подтвердились` }); continue; }
        const tr = await fetchJson(`${url}/v1/experience/track-record`); const sig = await verifyVc(tr);
        const served = Object.values(tr.credentialSubject?.agents_served || {}).reduce((a, b) => a + b, 0);
        if (!sig.ok || !served) { skipped.push({ url, reason: !sig.ok ? `подпись послужного списка: ${sig.reason}` : "не вёл ни одного агента" }); continue; }
        const es = (cat.domains?.[domain]?.[category] || []).filter((e) => e.evidence > 0 && measuredVsControl(e));
        const top = controlledBest(es);
        if (sig.ok && top > ownBest + 0.1 && (!best || top > best.prob_better)) best = { url, did: cat.orchestrator, name: cat.name, prob_better: top, techniques: es.map((e) => e.technique), track: tr.credentialSubject };
      } catch { /* недоступный оркестратор просто не рассматривается */ }
    }
    if (!best) return { refer: false, own_prob_better: ownBest, skipped };
    return { refer: true, to: best, own_prob_better: ownBest, skipped, instruction: `По категории «${category}» у оркестратора ${best.name} (${best.url}) проверенный опыт: ${best.techniques.join(", ")} (P(лучше контроля) ${best.prob_better}). Подключитесь к нему по этой категории (POST ${best.url}/v1/agents — регистрация, подтверждение домена, проверка MCP) или попросите меня запросить его опыт и обучиться (POST /v1/experience/learn).` };
  }

  // аудит-«правда» и вердикты о тревогах сообщает площадка (в стенде — оператор), когда правда становится известна
  // подделка доказательства для стенда: записать в книгу произвольное доказательство (аттестат и отпечаток как есть)
  const plantEvidence = ({ id, vc, digest }) => { upd((b) => { b.evidence[id] = { digest: digest || sha256hex(jcs(vc)), vc, live: false }; }); return { id }; };
  // 0.13.3: калибровка прогнозов советника по своим чистым исходам (прогноз до калибровки → успех): вес w ∈ [0, 1],
  // с которым прогноз смешивается со средней долей успехов, — тот, что дал наименьшую ошибку Брайера. Нужно не меньше
  // min_n исходов; иначе null (прогноз как есть)
  function calibration(domain = null, { min_n = 10 } = {}) {
    // 0.14.1: только выполненные советы — прогноз про них; с контрольными база была ~0.5 и тянула вниз прогнозы, хотя
    // выполненные советы удавались в 3 случаях из 4
    const l = (book().track.advice || []).filter((a) => !a.confounded && a.arm !== "control" && (!domain || !a.domain || a.domain === domain) && typeof (a.raw ?? a.pred) === "number");
    if (l.length < min_n) return null;
    const y = (a) => (a.success ? 1 : 0), base = l.reduce((s, a) => s + y(a), 0) / l.length;
    let best = { w: 1, brier: Infinity };
    for (let k = 0; k <= 10; k++) { const w = k / 10, b = l.reduce((s, a) => s + (w * (a.raw ?? a.pred) + (1 - w) * base - y(a)) ** 2, 0) / l.length; if (b < best.brier - 1e-9) best = { w, brier: b }; }
    return { w: best.w, base: Math.round(1000 * base) / 1000, n: l.length, brier: Math.round(10000 * best.brier) / 10000 };
  }
  return { record, track, prior, recipes, catalog, pack, trackRecord, trackSummary, seed, selfIssue, plantEvidence, evidence, learnFrom, settleForeign, peers, referral, book, calibration };
}

export function mountExperience(app, { exp, wrap, admin }) {
  app.get("/v1/experience/catalog", wrap((req) => exp.catalog({ domain: req.query?.domain || null })));
  app.post("/v1/experience/query", wrap((req) => exp.pack(req.body || {})));
  app.get("/v1/experience/track-record", wrap(() => exp.trackRecord()));
  app.get("/v1/experience/evidence/:id", wrap((req) => exp.evidence(decodeURIComponent(req.params.id))));
  app.get("/v1/experience/peers", wrap(() => exp.peers()));
  app.post("/v1/experience/seed", wrap((req) => { admin(req); return exp.seed(req.body || {}); }));
  app.post("/v1/experience/self-issue", wrap((req) => { admin(req); return exp.selfIssue(req.body || {}); }));
  app.post("/v1/experience/plant-evidence", wrap((req) => { admin(req); return exp.plantEvidence(req.body || {}); }));
  app.post("/v1/experience/track", wrap((req) => { admin(req); exp.track(req.body?.kind, req.body?.data || {}); return { ok: true }; }));
  app.post("/v1/experience/learn", wrap((req) => { admin(req); return exp.learnFrom(req.body || {}); }));
  app.post("/v1/experience/settle", wrap((req) => { admin(req); return exp.settleForeign(req.body || {}); }));
  app.post("/v1/experience/referral", wrap((req) => exp.referral(req.body || {})));
}
