// Живые рецепты (0.19): проверяемое накопление, оценка и передача приёмов между агентами любой сферы.
// Откуда: эксперимент владельца с поиском телефонов головных офисов (22.10). Рецепт получил оценку 0,84 по одной паре,
// группы назначал сам экспериментатор, «применено» не отличалось от «помогло», а живой выдачи рецептов для внешней сферы
// не было вовсе. Здесь:
//   - агент A предлагает приём (domain, category, stage, payload, applicability, safeguards) — это гипотеза;
//   - любой агент той же сферы перед задачей просит рецепт, а ГРУППУ НАЗНАЧАЕТ ОРКЕСТРАТОР (рецепт или контроль, или парный
//     режим — обе группы на одной задаче) и пишет это в журнал;
//   - агент сообщает: принял или отклонил с причиной, применил ли, сработал ли на этой задаче, результат, и отдельно —
//     независимую проверку (эталон, второй проверяющий). Статус рецепта двигают ТОЛЬКО независимо проверенные исходы;
//   - доказан — не меньше min_n исходов в каждой группе и перевес значим (парный: точный биномиальный тест по
//     расхождениям; непарный: P(лучше контроля)); отозван — так же значимо хуже или нарушение ограничений;
//   - доказанный рецепт выдаётся, но control_share задач остаётся контролем, чтобы замер продолжался;
//   - каждое событие: запрошено → выдано → принято/отклонено → применено → проверено → записано → статус изменён.
// 0.19.1 (после первого прогона на телефонах): принятый неверный ответ считается хуже отказа, а пара, где одна из групп
// упала по инфраструктуре (ошибка модели, сеть), помечается invalid и в оценку не идёт. В первом прогоне две из трёх
// «побед» рецепта были ошибками модели в контроле, а два принятых чужих номера считались ничьей.
// Рецепт не может обходить ограничения: содержимое проверяется теми же правилами, что описания инструментов в Gate,
// а safeguards хранятся вместе с ним и выдаются агенту.
import { randomUUID, createHash } from "node:crypto";
import { analyzeTools } from "./scan.js";
import { probBetter } from "./experience.js";

const err = (status, m) => Object.assign(new Error(m), { status });
const S = (x, n = 120) => String(x ?? "").slice(0, n);
const num = (k, d) => (process.env[k] != null && process.env[k] !== "" ? Number(process.env[k]) : d);

// точный односторонний биномиальный тест: P(X >= k | n, 1/2)
export function binomTail(k, n) { let p = 0, c = 1; for (let i = 0; i <= n; i++) { if (i > 0) c = (c * (n - i + 1)) / i; if (i >= k) p += c; } return p / 2 ** n; }

// 0.22.1 (комментарий к статье: вердикт рецепта не хранил версию правил подсчёта). Версия правил пары ставится при записи
// в счётчики, в каждый исход журнала и в каждый вердикт. Пары по разным правилам не складываются: при смене правил старые
// счётчики уходят в архив рецепта вместе со статусом, по которому они были посчитаны, новые начинаются с нуля.
// 0.19.1 — верно 1, воздержался 0, принял неверное −1, пара со сбоем инфраструктуры не в счёт. Вред и расход (0.22) копятся
// отдельно и решают, только если есть почти во всех парах, поэтому версию пары не меняют.
export const SCORING = "0.19.1";
const SCORING_SINCE = { "0.19.1": Date.parse("2026-10-22T14:07:55Z") };
// у рецептов, записанных до штампа, версия восстанавливается по дате создания счётчиков
const scoringOf = (r) => r.counts?.scoring || (Date.parse(r.counts_since || r.created || 0) >= SCORING_SINCE["0.19.1"] ? "0.19.1" : "0.19");

// односторонний хвост нормального распределения P(Z >= z)
export function normTail(z) { if (z === Infinity) return 0; if (z === -Infinity) return 1; const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z >= 0 ? p : 1 - p; }

export function evaluateRecipe(r, cfg) {
  const T = r.counts.treated, C = r.counts.control, P = r.counts.pairs;
  const out = { measured_treated: T.indep_n, measured_control: C.indep_n, pairs: P.n, method: null, p_better: null, p_worse: null, prob_better: null };
  if (P.n > 0) { // парный режим: решают только расхождения
    const d = P.recipe_only + P.control_only;
    out.method = "paired_exact"; out.discordant = d; out.recipe_only = P.recipe_only; out.control_only = P.control_only;
    out.p_better = d ? +binomTail(P.recipe_only, d).toPrecision(3) : 1; out.p_worse = d ? +binomTail(P.control_only, d).toPrecision(3) : 1;
    out.enough = P.n >= cfg.min_n;
  } else if (T.indep_n && C.indep_n) {
    out.method = "unpaired_bayes"; out.prob_better = probBetter({ n: T.indep_n, success: T.indep_success }, { n: C.indep_n, success: C.indep_success }, `recipe-${r.id}`);
    out.enough = T.indep_n >= cfg.min_n && C.indep_n >= cfg.min_n;
  } else { out.method = "none"; out.enough = false; }
  // 0.22: парная разница вреда и расхода, нормальное приближение по среднему разности (пар обычно десятки и сотни)
  const diff = (x) => { if (!x || x.n < 2) return null; const m = x.sum / x.n, v = Math.max(0, (x.sum2 - x.n * m * m) / (x.n - 1)), se = Math.sqrt(v / x.n); const z = se > 0 ? m / se : m > 0 ? Infinity : m < 0 ? -Infinity : 0; return { n: x.n, mean: +m.toFixed(4), better: x.better, worse: x.worse, p_better: +normTail(z).toPrecision(3), p_worse: +normTail(-z).toPrecision(3) }; };
  if (P.harm) out.harm = diff(P.harm);
  if (P.cost) out.cost = diff(P.cost);
  // 0.26 (сеть оркестраторов, 30.10): шкала вреда 6:1 делает выгодной тревогу по любому поводу, и приём «почти всегда
  // осторожно» проходил как доказанный, хотя константа «всегда осторожно» была не хуже. Если агент сообщает вред простейшего
  // правила (baseline_harm: всегда одно и то же действие), доказанным считается только приём, который значимо лучше и его
  if (P.baseline) out.baseline = diff(P.baseline);
  let status = "hypothesis", why = `fewer than ${cfg.min_n} independently checked outcomes in each arm`;
  if (r.violations > 0) { status = "revoked"; why = "the recipe broke a safeguard"; }
  // по вреду: если цену ошибки сообщают во всех парах, решает она, а не «верно / неверно». Иначе приём, который ловит дорогие
  // ошибки ценой дешёвых, выходит «без эффекта» (glama team-1: 10 лучше, 13 хуже, а вред −16%)
  else if (out.enough && out.harm && out.harm.n >= cfg.min_n && out.harm.n >= 0.9 * P.n && (out.harm.p_better < cfg.alpha || out.harm.p_worse < cfg.alpha)) {
    out.basis = "harm";
    const vsBase = out.baseline && out.baseline.n >= 0.9 * out.harm.n ? out.baseline : null;
    if (out.harm.mean > 0 && out.harm.p_better < cfg.alpha && vsBase && !(vsBase.mean > 0 && vsBase.p_better < cfg.alpha)) { status = "no_effect"; why = `paired by harm, ${out.harm.mean} less harm per task than without the recipe, but not better than the simplest fixed policy (${-vsBase.mean} harm per task vs it, p = ${vsBase.p_better})`; }
    else if (out.harm.mean > 0 && out.harm.p_better < cfg.alpha) { status = "proven"; why = `paired by harm, ${out.harm.mean} less harm per task with the recipe (${out.harm.better} tasks better, ${out.harm.worse} worse of ${out.harm.n}), p = ${out.harm.p_better}`; }
    else { status = "revoked"; why = `paired by harm, ${-out.harm.mean} more harm per task with the recipe (${out.harm.worse} tasks worse, ${out.harm.better} better of ${out.harm.n}), p = ${out.harm.p_worse}`; }
  }
  // так же хорошо, но дешевле: ни одна пара не стала хуже ни по ответу, ни по вреду, а расход значимо ниже
  else if (out.enough && out.cost && out.cost.n >= cfg.min_n && P.control_only === 0 && !(out.harm && out.harm.worse > 0) && out.cost.mean > 0 && out.cost.p_better < cfg.alpha) {
    out.basis = "cost"; status = "proven"; why = `paired, same results in all ${P.n} tasks (none worse) and ${out.cost.mean} fewer tokens per task, p = ${out.cost.p_better}`;
  }
  else if (out.enough && out.method === "paired_exact") {
    out.basis = "quality";
    if (out.p_better < cfg.alpha && P.recipe_only > P.control_only) { status = "proven"; why = `paired, ${P.recipe_only} tasks better with the recipe vs ${P.control_only} better without, p = ${out.p_better}`; }
    else if (out.p_worse < cfg.alpha && P.control_only > P.recipe_only) { status = "revoked"; why = `paired, the recipe made ${P.control_only} tasks worse vs ${P.recipe_only} better, p = ${out.p_worse}`; }
    else { status = "no_effect"; why = `paired, ${P.recipe_only} better vs ${P.control_only} worse of ${P.n}, not significant`; }
  } else if (out.enough && out.method === "unpaired_bayes") {
    if (out.prob_better >= 1 - cfg.alpha) { status = "proven"; why = `P(better than control) = ${out.prob_better}`; }
    else if (out.prob_better <= cfg.alpha) { status = "revoked"; why = `P(better than control) = ${out.prob_better}`; }
    else { status = "no_effect"; why = `P(better than control) = ${out.prob_better}, not decisive`; }
  }
  return { status, why, test: out };
}

export function createRecipes({ store, issuer, orch, publicUrl = "", now = () => Date.now(), rand = Math.random }) {
  const cfg = { min_n: num("RECIPE_MIN_N", 10), alpha: num("RECIPE_ALPHA", 0.05), control_share: num("RECIPE_CONTROL_SHARE", 0.2), hypothesis_share: num("RECIPE_HYPOTHESIS_SHARE", 0.5) };
  const all = () => store.get("recipes", {});
  const reqs = () => store.get("recipe_requests", {});
  const iso = () => new Date(now()).toISOString();
  function event(e) { let cut = 0; store.update("recipe_events", [], (l) => { l.push({ at: iso(), ...e }); if (l.length > 50000) { cut = l.length - 50000; l.splice(0, cut); } }); pruned("events", cut); }
  const blankArm = () => ({ n: 0, success: 0, indep_n: 0, indep_success: 0 });
  const blankCounts = () => ({ scoring: SCORING, treated: blankArm(), control: blankArm(), pairs: { n: 0, both: 0, neither: 0, recipe_only: 0, control_only: 0 } });
  // пары по старым правилам — в архив вместе со статусом, счёт заново
  function rescore(r) {
    const was = scoringOf(r); if (was === SCORING) { if (!r.counts.scoring) r.counts.scoring = SCORING; return false; }
    (r.counts_archive ||= []).push({ scoring: was, version: r.version, counts: r.counts, status: r.status, status_why: r.status_why, archived: iso() });
    r.counts = blankCounts(); r.counts_since = iso();
    const ev = evaluateRecipe(r, cfg); r.status = ev.status; r.status_why = ev.why; r.test = ev.test;
    r.history.push({ version: r.version, scoring: SCORING, status: r.status, at: iso(), why: `scoring rules changed ${was} → ${SCORING}: pairs counted under ${was} archived with their verdict, counts start again` });
    event({ event: "recipe_rescored", recipe_id: r.id, recipe_version: r.version, from: was, to: SCORING });
    return true;
  }
  // журналы обрезаются (последние 20 000 запросов и 50 000 событий); сколько срезано — считается, чтобы сверка знала, что неполна
  const pruned = (k, n) => { if (n > 0) store.update("recipe_pruned", {}, (x) => { x[k] = (x[k] || 0) + n; }); };
  const pub = (r) => ({ id: r.id, version: r.version, domain: r.domain, category: r.category, stage: r.stage, technique: r.technique, payload: r.payload, applicability: r.applicability, safeguards: r.safeguards, source_agent: r.source_agent, status: r.status, status_why: r.status_why, scoring: scoringOf(r), counts: r.counts, archived_counts: (r.counts_archive || []).map((a) => ({ scoring: a.scoring, version: a.version, pairs: a.counts?.pairs?.n ?? 0, status: a.status, status_why: a.status_why, archived: a.archived })), test: r.test, issued: r.issued, created: r.created, history: r.history.slice(-10), evaluation_vc: r.evaluation_vc || null });

  function create(agentId, b = {}) {
    const rec = orch.get(agentId);
    for (const k of ["domain", "technique"]) if (!b[k] || typeof b[k] !== "string") throw err(400, `${k} is required`);
    if (!b.payload || typeof b.payload !== "object" || Array.isArray(b.payload)) throw err(400, "payload must be a JSON object: what the agent should do differently");
    const payload = JSON.parse(JSON.stringify(b.payload)), text = JSON.stringify(payload);
    if (text.length > 4000) throw err(400, "payload is over 4000 characters");
    const bad = analyzeTools([{ name: "recipe", description: text + " " + JSON.stringify(b.applicability || "") + " " + JSON.stringify(b.safeguards || "") }]).findings.filter((f) => f.severity === "high");
    if (bad.length) throw err(400, `the recipe looks like hidden instructions (${bad.map((f) => f.rule).join(", ")}), refused`);
    const key = [b.domain, b.category || "all", b.stage || "any", b.technique].map((x) => S(x, 80)).join("|");
    const id = "rcp_" + createHash("sha256").update(key).digest("hex").slice(0, 10), ex = all()[id];
    const r = ex ? { ...ex } : { id, version: 0, domain: S(b.domain, 80), category: S(b.category || "all", 80), stage: S(b.stage || "any", 80), technique: S(b.technique, 80), source_agent: rec.id, created: iso(), counts: blankCounts(), violations: 0, issued: 0, history: [] };
    // новая версия обнуляет счёт: оценка относится к конкретному содержимому
    const changed = !ex || JSON.stringify(ex.payload) !== text;
    if (changed) { r.version = (r.version || 0) + 1; r.counts = blankCounts(); r.counts_since = iso(); r.violations = 0; } else rescore(r);
    Object.assign(r, { payload, applicability: Array.isArray(b.applicability) ? b.applicability.map((x) => S(x, 200)).slice(0, 20) : b.applicability ? [S(b.applicability, 200)] : [], safeguards: Array.isArray(b.safeguards) ? b.safeguards.map((x) => S(x, 200)).slice(0, 20) : [] });
    const ev = evaluateRecipe(r, cfg); r.status = ev.status; r.status_why = ev.why; r.test = ev.test;
    if (changed) r.history.push({ version: r.version, scoring: SCORING, status: r.status, at: iso(), why: ex ? "new version, counts reset" : "proposed" });
    store.update("recipes", {}, (x) => { x[id] = r; });
    event({ event: ex ? "recipe_updated" : "recipe_proposed", recipe_id: id, recipe_version: r.version, agent: rec.id });
    return pub(r);
  }

  // агент просит рецепт перед задачей; группу назначает оркестратор
  function request(agentId, b = {}) {
    const rec = orch.get(agentId);
    if (!b.domain || !b.task_id) throw err(400, "domain and task_id are required");
    // перед выбором — привести счётчики рецептов сферы к текущим правилам (иначе статус по старым правилам решал бы выдачу)
    for (const x of Object.values(all())) if (x.domain === b.domain && scoringOf(x) !== SCORING) { const y = structuredClone(x); if (rescore(y)) store.update("recipes", {}, (z) => { z[y.id] = y; }); }
    const cands = Object.values(all()).filter((r) => r.domain === b.domain && (r.category === (b.category || "all") || r.category === "all") && (!b.stage || r.stage === b.stage || r.stage === "any") && ["hypothesis", "proven", "no_effect"].includes(r.status));
    // доказанные — по силе; иначе гипотеза, у которой меньше всего исходов (её надо замерить); «без эффекта» — в последнюю очередь
    const rank = (r) => (r.status === "proven" ? 0 : r.status === "hypothesis" ? 1 : 2);
    cands.sort((a, c) => rank(a) - rank(c) || (a.status === "proven" ? (c.test?.recipe_only || 0) - (a.test?.recipe_only || 0) : (a.counts.pairs.n + a.counts.treated.indep_n) - (c.counts.pairs.n + c.counts.treated.indep_n)));
    const r = cands[0] || null, id = "rq_" + randomUUID().replace(/-/g, "").slice(0, 16);
    let arm = "control", why = r ? null : "no recipe for this domain, category and stage";
    if (r) {
      if (b.paired) { arm = "both"; why = "paired: run the task with and without the recipe, report both"; }
      else { const share = r.status === "proven" ? 1 - cfg.control_share : cfg.hypothesis_share; arm = rand() < share ? "recipe" : "control"; why = arm === "recipe" ? (r.status === "proven" ? "proven recipe" : "recipe under test") : r.status === "proven" ? `control group (${Math.round(cfg.control_share * 100)}% keep measuring a proven recipe)` : "control group for a recipe under test"; }
    }
    const q = { id: id, agent: rec.id, domain: S(b.domain, 80), category: S(b.category || "all", 80), stage: b.stage ? S(b.stage, 80) : null, task_id: S(b.task_id, 200), arm, recipe_id: r?.id || null, recipe_version: r?.version || null, at: iso(), outcome: null };
    let cut = 0; store.update("recipe_requests", {}, (x) => { x[id] = q; const ks = Object.keys(x); if (ks.length > 20000) { cut = ks.length - 20000; for (const k of ks.slice(0, cut)) delete x[k]; } }); pruned("requests", cut);
    if (r && arm !== "control") store.update("recipes", {}, (x) => { if (x[r.id]) x[r.id].issued = (x[r.id].issued || 0) + 1; });
    event({ event: "recommendation_requested", request_id: id, task_id: q.task_id, agent: rec.id, recipe_id: q.recipe_id, recipe_version: q.recipe_version });
    event({ event: "recommendation_received", request_id: id, task_id: q.task_id, agent: rec.id, recipe_id: q.recipe_id, recipe_version: q.recipe_version, arm });
    return { request_id: id, arm, why, recipe: r && arm !== "control" ? { id: r.id, version: r.version, technique: r.technique, stage: r.stage, payload: r.payload, applicability: r.applicability, safeguards: r.safeguards, status: r.status, evidence: r.test } : null,
      report_to: `${publicUrl}/v1/recipes/requests/${id}/outcome`,
      report: arm === "both" ? { recipe: { accepted: true, applied: true, matched: true, success: true, invalid: false, independent: { verified: true, checker: "who" } }, control: { success: false, invalid: false, independent: { verified: false, checker: "who" } } } : { accepted: true, applied: true, matched: false, success: false, independent: { verified: false, checker: "who checked" } } };
  }

  const armOf = (o = {}) => ({ accepted: o.accepted !== false, reject_reason: o.accepted === false ? S(o.reject_reason || "not given", 200) : null, applied: !!o.applied, matched: !!o.matched, success: !!o.success, independent: o.independent && typeof o.independent === "object" ? { verified: !!o.independent.verified, checker: S(o.independent.checker, 80) } : null, violated_safeguard: !!o.violated_safeguard, invalid: !!o.invalid, tokens: Number.isFinite(+o.tokens) ? +o.tokens : null, harm: o.harm != null && Number.isFinite(+o.harm) && +o.harm >= 0 ? +o.harm : null, elapsed_ms: Number.isFinite(+o.elapsed_ms) ? +o.elapsed_ms : null, cost: Number.isFinite(+o.cost) ? +o.cost : null, note: o.note ? S(o.note, 300) : null });

  function outcome(requestId, b = {}, { authAgent } = {}) {
    const q = reqs()[requestId]; if (!q) throw err(404, "no such request");
    if (authAgent && authAgent !== q.agent) throw err(403, "this request belongs to another agent");
    if (q.outcome) throw err(409, "outcome already reported for this request");
    const base = { request_id: q.id, task_id: q.task_id, agent: q.agent, recipe_id: q.recipe_id, recipe_version: q.recipe_version };
    let res;
    if (q.arm === "both") { if (!b.recipe || !b.control) throw err(400, "paired request: send both recipe and control"); res = { recipe: armOf(b.recipe), control: armOf(b.control) }; }
    else res = { [q.arm]: armOf(b) };
    q.outcome = { at: iso(), scoring: SCORING, ...res };
    store.update("recipe_requests", {}, (x) => { x[q.id] = q; });
    const t = res.recipe;
    if (t) {
      event({ ...base, event: t.accepted ? "recommendation_accepted" : "recommendation_rejected", reason: t.reject_reason || undefined });
      if (t.applied) event({ ...base, event: "recommendation_applied", matched: t.matched });
    }
    event({ ...base, event: "task_completed", arm: q.arm, success: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.success])) });
    const ind = Object.fromEntries(Object.entries(res).filter(([, v]) => v.independent).map(([k, v]) => [k, v.independent.verified]));
    if (Object.keys(ind).length) event({ ...base, event: "result_evaluated", independent: ind, checker: Object.values(res).find((v) => v.independent)?.independent.checker });
    if (!q.recipe_id) return { ok: true, recorded: false, why: "no recipe was in play" };
    let r = all()[q.recipe_id];
    if (!r || r.version !== q.recipe_version) { event({ ...base, event: "experience_recorded", stale_version: true }); return { ok: true, recorded: false, why: "the recipe changed since this request, the outcome is kept in the log but doesn't count" }; }
    r = structuredClone(r); rescore(r);
    const add = (arm, v) => { const a = r.counts[arm === "recipe" ? "treated" : "control"]; a.n++; if (v.success) a.success++; if (v.independent) { a.indep_n++; if (v.independent.verified) a.indep_success++; else if (v.success) a.indep_wrong = (a.indep_wrong || 0) + 1; } };
    // отклонённый агентом рецепт не идёт в оценку: он не применялся. Причина отказа — в журнале и в счёте отказов
    if (Object.values(res).some((v) => v.invalid)) { r.counts.invalid = (r.counts.invalid || 0) + 1; event({ ...base, event: "experience_recorded", invalid: true }); store.update("recipes", {}, (x) => { x[r.id] = r; }); return { ok: true, recorded: false, why: "an arm failed for infrastructure reasons, the pair doesn't count", recipe: { id: r.id, version: r.version, status: r.status } }; }
    if (res.recipe && !res.recipe.accepted) { r.rejected = (r.rejected || 0) + 1; r.reject_reasons = { ...(r.reject_reasons || {}), [res.recipe.reject_reason]: ((r.reject_reasons || {})[res.recipe.reject_reason] || 0) + 1 }; }
    else {
      for (const [arm, v] of Object.entries(res)) add(arm, v);
      // 0.19.1: исход с учётом вреда. Верно = 1, воздержался = 0, принял неверное = -1: чужой номер хуже, чем никакого.
      // Лучше та группа, у которой выше. Пара, где одна из групп упала по инфраструктуре (invalid), в оценку не идёт
      if (res.recipe && res.control && res.recipe.independent && res.control.independent) {
        const P = r.counts.pairs, sc = (v) => (v.independent.verified ? 1 : v.success ? -1 : 0), a = sc(res.recipe), c = sc(res.control);
        if (a === 1 && c === 1) P.both++; else if (a === c) P.neither++; else if (a > c) P.recipe_only++; else P.control_only++;
        P.n++; if (a === -1) P.recipe_wrong = (P.recipe_wrong || 0) + 1; if (c === -1) P.control_wrong = (P.control_wrong || 0) + 1;
        // 0.22: когда агент сообщает цену ошибки (harm) и расход (tokens) по каждой группе, пара сравнивается и по ним.
        // d > 0 — с рецептом меньше вреда (дешевле)
        const acc = (key, d) => { const x = (P[key] ||= { n: 0, sum: 0, sum2: 0, better: 0, worse: 0 }); x.n++; x.sum += d; x.sum2 += d * d; if (d > 0) x.better++; else if (d < 0) x.worse++; };
        if (res.recipe.harm != null && res.control.harm != null) acc("harm", res.control.harm - res.recipe.harm);
        if (res.recipe.tokens != null && res.control.tokens != null) acc("cost", res.control.tokens - res.recipe.tokens);
        const bh = b.baseline_harm; if (res.recipe.harm != null && bh != null && Number.isFinite(+bh) && +bh >= 0) acc("baseline", +bh - res.recipe.harm);
      }
      if (res.recipe?.violated_safeguard) r.violations = (r.violations || 0) + 1;
    }
    const prev = r.status, ev = evaluateRecipe(r, cfg); r.status = ev.status; r.status_why = ev.why; r.test = ev.test;
    event({ ...base, event: "experience_recorded", scoring: SCORING });
    if (prev !== r.status) {
      r.history.push({ version: r.version, scoring: SCORING, basis: ev.test?.basis || null, status: r.status, at: iso(), why: ev.why });
      if (issuer && ["proven", "revoked", "no_effect"].includes(r.status)) { try { const vc = issuer.issue("RecipeEvaluation", { id: `${publicUrl}/v1/recipes/${r.id}`, recipe: { id: r.id, version: r.version, domain: r.domain, category: r.category, stage: r.stage, technique: r.technique, source_agent: r.source_agent }, status: r.status, why: ev.why, test: ev.test, scoring_version: SCORING, basis: ev.test?.basis || null, method: "xonta-recipes/0.22.1: arms assigned by the orchestrator; only independently checked outcomes count; paired by harm when every pair reports it, or same results at lower cost; otherwise paired exact binomial test on discordant tasks or Bayesian P(better than control)" }, { validDays: 90 }); r.evaluation_vc = vc.id; } catch {} }
      event({ ...base, event: r.status === "revoked" ? "recipe_revoked" : "recipe_updated", status: r.status, why: ev.why });
    }
    store.update("recipes", {}, (x) => { x[r.id] = r; });
    return { ok: true, recorded: true, recipe: { id: r.id, version: r.version, status: r.status, why: r.status_why, test: r.test } };
  }

  function revoke(id, why = "revoked by the owner") { const r = all()[id]; if (!r) throw err(404, "no such recipe"); store.update("recipes", {}, (x) => { x[id].status = "revoked"; x[id].status_why = S(why, 200); x[id].history.push({ version: x[id].version, status: "revoked", at: iso(), why: S(why, 200) }); }); event({ event: "recipe_revoked", recipe_id: id, recipe_version: r.version, why: S(why, 200) }); return pub(all()[id]); }
  const list = (q = {}) => Object.values(all()).filter((r) => (!q.domain || r.domain === q.domain) && (!q.category || r.category === q.category) && (!q.stage || r.stage === q.stage)).map(pub);
  const get = (id) => { const r = all()[id]; if (!r) throw err(404, "no such recipe"); return pub(r); };
  // выдача журнала говорит, полна ли она: сколько всего строк, какая страница, есть ли ещё и сколько срезано из журнала вообще.
  // Раньше отдавались последние 500 молча — счётчики могли сходиться, а строк в выдаче не хватать (комментарий к статье)
  const events = ({ agent = null, recipe = null, limit = 500, offset = 0 } = {}) => {
    const all = store.get("recipe_events", []).filter((e) => (!agent || e.agent === agent) && (!recipe || e.recipe_id === recipe));
    const lim = Math.max(1, Math.min(5000, Number(limit) || 500)), off = Math.max(0, Number(offset) || 0), rows = all.slice(off, off + lim), cut = store.get("recipe_pruned", {});
    return { total: all.length, offset: off, limit: lim, returned: rows.length, next_offset: off + rows.length < all.length ? off + rows.length : null, pruned_from_log: { events: cut.events || 0, requests: cut.requests || 0 }, complete: off === 0 && rows.length === all.length && !(cut.events > 0), rows };
  };
  // сверка счётчиков рецепта с журналом исходов: каждая пара и каждая группа, записанные в счётчики текущей версии и текущих
  // правил, должны найтись строкой в журнале запросов. Если журнал обрезан — сверка не может быть полной, и это сказано прямо
  function audit(id) {
    const r = all()[id]; if (!r) throw err(404, "no such recipe");
    const ledger = { treated: 0, control: 0, pairs: 0, invalid: 0, rejected: 0, other_scoring: 0 };
    for (const q of Object.values(reqs())) {
      if (q.recipe_id !== id || q.recipe_version !== r.version || !q.outcome) continue;
      const qs = q.outcome.scoring || (Date.parse(q.outcome.at) >= SCORING_SINCE["0.19.1"] ? "0.19.1" : "0.19");
      if (qs !== scoringOf(r) || (r.counts_since && q.outcome.at < r.counts_since)) { ledger.other_scoring++; continue; }
      const arms = ["recipe", "control"].filter((k) => q.outcome[k]);
      if (arms.some((k) => q.outcome[k].invalid)) { ledger.invalid++; continue; }
      if (q.outcome.recipe && q.outcome.recipe.accepted === false) { ledger.rejected++; continue; }
      for (const k of arms) ledger[k === "recipe" ? "treated" : "control"]++;
      if (q.outcome.recipe?.independent && q.outcome.control?.independent) ledger.pairs++;
    }
    const counters = { treated: r.counts.treated.n, control: r.counts.control.n, pairs: r.counts.pairs.n, invalid: r.counts.invalid || 0, rejected: r.rejected || 0 };
    const cut = store.get("recipe_pruned", {}), diff = { treated: counters.treated - ledger.treated, control: counters.control - ledger.control, pairs: counters.pairs - ledger.pairs };
    const match = !diff.treated && !diff.control && !diff.pairs;
    return { recipe: id, version: r.version, scoring: scoringOf(r), counters, ledger, missing_from_ledger: diff, pruned_from_log: { requests: cut.requests || 0, events: cut.events || 0 }, complete: match && !(cut.requests > 0),
      note: match ? (cut.requests > 0 ? "counters match the rows that are left, but the request log was pruned, so the check can't be complete" : "every counted outcome has its row in the log") : "counters and log disagree: some counted outcomes have no row" };
  }
  const sourceOf = (id) => all()[id]?.source_agent || null;
  const requestAgent = (rid) => reqs()[rid]?.agent || null;
  return { create, request, outcome, revoke, list, get, events, audit, sourceOf, requestAgent, cfg };
}

export function mountRecipes(app, { recipes, wrap, ownerAuth, isAdmin }) {
  app.post("/v1/agents/:id/recipes", wrap(async (req) => { await ownerAuth(req, req.params.id); return recipes.create(req.params.id, req.body || {}); }));
  app.post("/v1/agents/:id/recipes/request", wrap(async (req) => { await ownerAuth(req, req.params.id); return recipes.request(req.params.id, req.body || {}); }));
  app.post("/v1/recipes/requests/:rid/outcome", wrap(async (req) => { const a = recipes.requestAgent(req.params.rid); if (!a) throw Object.assign(new Error("no such request"), { status: 404 }); await ownerAuth(req, a); return recipes.outcome(req.params.rid, req.body || {}, { authAgent: a }); }));
  app.get("/v1/agents/:id/recipe-events", wrap(async (req) => { await ownerAuth(req, req.params.id); return recipes.events({ agent: req.params.id, limit: req.query?.limit, offset: req.query?.offset }); }));
  app.get("/v1/recipes", wrap((req) => recipes.list({ domain: req.query?.domain, category: req.query?.category, stage: req.query?.stage })));
  app.get("/v1/recipes/:id", wrap((req) => recipes.get(req.params.id)));
  app.get("/v1/recipes/:id/events", wrap(async (req) => { const src = recipes.sourceOf(req.params.id); if (!src) throw Object.assign(new Error("no such recipe"), { status: 404 }); if (!isAdmin(req)) await ownerAuth(req, src); return recipes.events({ recipe: req.params.id, limit: req.query?.limit, offset: req.query?.offset }); }));
  app.get("/v1/recipes/:id/audit", wrap(async (req) => { const src = recipes.sourceOf(req.params.id); if (!src) throw Object.assign(new Error("no such recipe"), { status: 404 }); if (!isAdmin(req)) await ownerAuth(req, src); return recipes.audit(req.params.id); }));
  app.post("/v1/recipes/:id/revoke", wrap(async (req) => { const src = recipes.sourceOf(req.params.id); if (!src) throw Object.assign(new Error("no such recipe"), { status: 404 }); if (!isAdmin(req)) await ownerAuth(req, src); return recipes.revoke(req.params.id, req.body?.why); }));
}
