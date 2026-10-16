// Советник оркестратора, версия 2 (язык навыков xonta-geo/1). Оркестратор даёт владельцу конкретные советы, сам проверяет
// их исход на своём эталоне и копит опыт: какие советы помогают, а какие нет.
//
// Что изменилось по сравнению с версией 1 (см. документ «Оркестратор-советник: что взять из науки и практики»):
// 1) Решение «давать совет или нет» — сэмплирование Томпсона (бандиты): у каждого типа совета две апостериорные бета-оценки
//    вероятности успеха — «совет выполнен» и «совет не выполнен». Совет выдаётся, если выборка первой больше выборки второй.
//    Априорное распределение — общая доля успехов по всем типам (опыт переносится на новые типы), его вес ограничен.
//    Жёсткого подавления больше нет: плохой тип выдаётся всё реже, но шанс у него остаётся.
//    Первые ADVICE_WARMUP советов типа (кроме контрольных) выполняются всегда — разогрев, иначе опыт копится слишком медленно.
// 2) Контроль по каждому типу: каждый четвёртый совет типа (позиция в блоке из четырёх — случайная, детерминированная)
//    не выполняется. Удержанные политикой советы тоже измеряются: решение Томпсона не зависит от содержания случая,
//    поэтому они такие же честные контрольные. Польза типа = доля успехов выполненных − доля успехов контрольных
//    (так отделяется регрессия к среднему: отстающий агент часто восстанавливается и без совета).
// 3) Горизонт по типу: рождению специалиста нужно 6 раундов, откату — 2 (правило готовности из PBT).
// 4) Совет выдаётся, только если агент-цель объявил такое действие (supported_actions в get_skills).
// 5) Выбор и подтверждение — на разных половинах эталона: доказательства для совета ищутся на половине «select»,
//    исход меряется на половине «confirm» (иначе советник подгоняется под собственную выборку — закон Гудхарта).
// 6) Страж для узлов с потомками: доля отзывов, отправленных не тому потомку. Если она выросла — совет откатиться.
// 7) Прогноз каждого совета записывается заранее (вероятность успеха); по исходам считается оценка Брайера и таблица
//    надёжности — так видно, учится ли сам советник.
import * as geo from "../skills/xonta-geo.js";
import { randomId, sha256hex } from "./crypto.js";

const err = (status, message) => Object.assign(new Error(message), { status });

export const ADVICE_TYPES = {
  spawn_specialist: "Родить потомка-специалиста для отстающей подгруппы",
  rollback: "Откатить навыки агента к лучшей проверенной версии и ужесточить его самопроверку",
  train_routing: "Учить узел распределению: он теряет отзывы, которые потомок оценил бы лучше",
  clarify_objective: "Сформулировать узлу цель: отличать свою оценку от соседних",
};
const ACTION_OF = { spawn_specialist: "spawn", rollback: "restore", train_routing: "routing_focus", clarify_objective: "set_objective" };
const DEFAULT_HORIZON = { spawn_specialist: 6, rollback: 2, train_routing: 3, clarify_objective: 3 };

// детерминированный генератор (воспроизводимость прогона) и бета-распределение через два гамма-распределения
function rng(seed) { let s = parseInt(sha256hex(String(seed)).slice(0, 8), 16) || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967297; }
function gamma(a, r) {
  if (a < 1) return gamma(a + 1, r) * Math.pow(r(), 1 / a);
  const d = a - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r()); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = r();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export const betaSample = (a, b, r) => { const x = gamma(a, r), y = gamma(b, r); return x / (x + y); };
export const halfOf = (id) => (parseInt(String(id).slice(-1), 16) % 2 === 0 ? "select" : "confirm");

export function createAdvisor({ store, issuer, orch, env = process.env }) {
  const num = (k, d) => (env[k] != null && env[k] !== "" ? Number(env[k]) : d);
  const CFG = {
    policy: env.ADVICE_POLICY || "thompson", // thompson | always (как в версии 1, без подавления)
    // горизонт по типу; ADVICE_HORIZON задаёт один горизонт для всех (как в версии 1), ADVICE_HORIZON_<ТИП> — для одного типа
    horizon: Object.fromEntries(Object.entries(DEFAULT_HORIZON).map(([t, h]) => [t, num(`ADVICE_HORIZON_${t.toUpperCase()}`, num("ADVICE_HORIZON", h))])),
    control_share: num("ADVICE_CONTROL", 0.25),
    success_margin: num("ADVICE_SUCCESS_MARGIN", 2), // исход успешен, если исправленных ответов больше испорченных хотя бы на столько
    prior_weight: num("ADVICE_PRIOR_WEIGHT", 4), // сколько наблюдений «стоит» общий опыт всех типов
    warmup: num("ADVICE_WARMUP", 3), // первые советы типа (кроме контрольных) выполняются всегда: без них не из чего учиться
    split: env.ADVICE_SPLIT !== "0", // выбор на select, подтверждение на confirm
    rollback_margin: num("ADVICE_ROLLBACK_MARGIN", 3),
    routing_gap_pp: num("ADVICE_ROUTING_GAP_PP", 5),
    guardrail_pp: num("ADVICE_GUARDRAIL_PP", 5),
    min_items: num("ADVICE_MIN_ITEMS", 10),
    stagnation_rounds: num("ADVICE_STAGNATION_ROUNDS", 4),
  };
  const block = Math.max(2, Math.round(1 / Math.max(0.01, CFG.control_share)));
  const heldout = () => store.get("heldout_geo", {});
  const evals = () => store.get("geo_evals", {});
  const adviceAll = () => store.get("advice", {});
  const statsAll = () => store.get("advice_stats", {});
  const caps = () => store.get("agent_caps", {});
  const pathOfId = (id) => { const h = heldout()[id]; return h ? geo.pathOf(h.text, h.rating) : []; };
  const evalAt = (agentId, round) => (evals()[agentId] || []).find((e) => e.round === round) || null;
  const scopeIds = (e, scope, half = null) => Object.keys(e.preds).filter((id) => geo.inScope(scope, pathOfId(id)) && (!half || !CFG.split || halfOf(id) === half));
  const supports = (rec, kind) => { const c = caps()[rec.id]; return !c || c.includes(kind); };

  function compare(predsA, predsB, ids) {
    const H = heldout();
    let b = 0, c = 0, okA = 0, okB = 0;
    for (const id of ids) {
      const t = H[id]?.rating, a = predsA[id] === t, n = predsB[id] === t;
      if (a) okA++; if (n) okB++;
      if (!a && n) b++; if (a && !n) c++;
    }
    const n = ids.length;
    return { n, improved: b, worsened: c, before_pp: n ? Math.round(1000 * okA / n) / 10 : 0, after_pp: n ? Math.round(1000 * okB / n) / 10 : 0,
      gain_pp: n ? Math.round(1000 * (b - c) / n) / 10 : 0, p_value: Number(geo.mcnemar(b, c).toPrecision(3)) };
  }

  const blank = () => ({ accepted: { n: 0, success: 0, gain: 0 }, control: { n: 0, success: 0, gain: 0 } });
  // общий опыт всех типов — априорное распределение для каждого типа (вес не больше prior_weight наблюдений)
  function prior() {
    let s = 0, n = 0;
    for (const x of Object.values(statsAll())) for (const g of ["accepted", "control"]) { s += x[g].success; n += x[g].n; }
    const rate = (s + 1) / (n + 2), w = Math.min(n, CFG.prior_weight);
    return { a: 1 + w * rate, b: 1 + w * (1 - rate), rate, n };
  }
  function posterior(type) {
    const s = statsAll()[type] || blank(), p = prior();
    const post = (g) => ({ a: p.a + s[g].success, b: p.b + s[g].n - s[g].success });
    return { treat: post("accepted"), ctrl: post("control"), s, prior: p };
  }
  const mean = (x) => x.a / (x.a + x.b);
  // вероятность, что выполненный совет этого типа успешнее невыполненного (Монте-Карло, воспроизводимо)
  function probBetter(type) {
    const { treat, ctrl } = posterior(type), r = rng(`pb-${type}-${JSON.stringify(statsAll()[type] || {})}`);
    let k = 0; for (let i = 0; i < 400; i++) if (betaSample(treat.a, treat.b, r) > betaSample(ctrl.a, ctrl.b, r)) k++;
    return Math.round(k / 4) / 100;
  }
  function experience(type) {
    const { treat, ctrl, s } = posterior(type);
    const conf = mean(treat), cr = mean(ctrl);
    return { confidence: Math.round(conf * 100) / 100, control_rate: Math.round(cr * 100) / 100, uplift: Math.round((conf - cr) * 100) / 100,
      prob_better: probBetter(type), accepted: s.accepted, control: s.control,
      mean_gain_pp: s.accepted.n ? Math.round(10 * s.accepted.gain / s.accepted.n) / 10 : null,
      control_gain_pp: s.control.n ? Math.round(10 * s.control.gain / s.control.n) / 10 : null,
      diff_gain_pp: s.accepted.n && s.control.n ? Math.round(10 * (s.accepted.gain / s.accepted.n - s.control.gain / s.control.n)) / 10 : null };
  }

  // группа совета: блочная рандомизация по типу (в каждом блоке из четырёх один контрольный), затем решение Томпсона
  function assignArm(type, id) {
    const given = Object.values(adviceAll()).filter((a) => a.type === type && a.status !== "void").length;
    const b = Math.floor(given / block), pos = given % block;
    const ctrlPos = parseInt(sha256hex(`block-${type}-${b}`).slice(0, 8), 16) % block;
    if (pos === ctrlPos) return { arm: "control", why: "block_control" };
    if (CFG.policy !== "thompson") return { arm: "treatment", why: "always" };
    if (Object.values(adviceAll()).filter((a) => a.type === type && a.arm === "treatment").length < CFG.warmup) return { arm: "treatment", why: "warmup" };
    const { treat, ctrl } = posterior(type), r = rng(`ts-${id}`);
    const t = betaSample(treat.a, treat.b, r), c = betaSample(ctrl.a, ctrl.b, r);
    return t > c ? { arm: "treatment", why: "thompson", sample: { treat: Math.round(t * 100) / 100, control: Math.round(c * 100) / 100 } }
      : { arm: "control", why: "policy_withheld", sample: { treat: Math.round(t * 100) / 100, control: Math.round(c * 100) / 100 } };
  }

  function recordEval(rec, round, preds, skills, routing) {
    store.update("geo_evals", {}, (all) => {
      const list = (all[rec.id] ||= []).filter((e) => e.round !== round);
      list.push({ round, hash: skills?.hash || null, version: skills?.version ?? null, preds, routing: routing || null });
      all[rec.id] = list.slice(-40);
    });
    if (Array.isArray(skills?.supported_actions)) store.update("agent_caps", {}, (all) => { all[rec.id] = skills.supported_actions; });
  }

  function create(type, rec, { target, scope, evidence, action, signal = null }, round) {
    if (!supports(target, action.kind)) return null;
    // один открытый совет одного типа на пару «цель + область»
    if (Object.values(adviceAll()).some((a) => a.type === type && a.target === target.id && a.scope === scope && !a.outcome && a.status !== "void")) return null;
    const id = `adv_${randomId(6)}`;
    const exp = experience(type), arm = assignArm(type, id);
    const { treat, ctrl } = posterior(type);
    // прогноз записывается до исхода: вероятность успеха в той группе, в которую попал совет
    const predicted = Math.round(100 * (arm.arm === "treatment" ? mean(treat) : mean(ctrl))) / 100;
    // исходный замер цели на половине confirm хранится в самом совете: повтор раунда не может подменить точку «до»
    const e0 = evalAt(target.id, round);
    const baseline = e0 ? Object.fromEntries(scopeIds(e0, scope, "confirm").map((x) => [x, e0.preds[x]])) : null;
    const a = { id, type, title: ADVICE_TYPES[type], agent: rec.id, target: target.id, target_did: target.did, scope, round, due_round: round + CFG.horizon[type], baseline,
      evidence, action, signal, confidence: exp.confidence, predicted, arm: arm.arm, arm_reason: arm.why, thompson: arm.sample || null, prob_better: exp.prob_better,
      track_record: { accepted: exp.accepted.n, success: exp.accepted.success, control: exp.control.n, control_success: exp.control.success, mean_gain_pp: exp.mean_gain_pp },
      status: "new", created: new Date().toISOString() };
    store.update("advice", {}, (all) => { all[a.id] = a; });
    issuer.event("advice_created", { advice: a.id, type, target: target.id, scope, confidence: a.confidence, predicted, arm: a.arm });
    return a;
  }

  function decide(id, action) {
    const a = adviceAll()[id];
    if (!a) throw err(404, "совет не найден");
    if (a.status !== "new") throw err(409, `по совету уже принято решение: ${a.status}`);
    // void — совет невозможно исполнить (например, у дерева исчерпан лимит потомков): не измеряется и не входит в опыт
    if (!["accept", "decline", "void"].includes(action)) throw err(400, "action: accept | decline | void");
    store.update("advice", {}, (all) => { Object.assign(all[id], { status: action === "accept" ? "accepted" : action === "void" ? "void" : "declined", decided: new Date().toISOString() }); });
    return adviceAll()[id];
  }

  // исход совета: замер цели в раунде совета против замера через горизонт, на половине «confirm» области
  function resolveDue(rec, round) {
    const out = [];
    for (const a of Object.values(adviceAll()).filter((x) => x.target === rec.id && !x.outcome && ["accepted", "declined"].includes(x.status) && round >= x.due_round)) {
      const e1 = evalAt(rec.id, round);
      const base = a.baseline || evalAt(rec.id, a.round)?.preds;
      if (!base || !e1) continue;
      const ids = Object.keys(base).filter((id) => id in e1.preds && geo.inScope(a.scope, pathOfId(id)) && (!CFG.split || halfOf(id) === "confirm"));
      const t = compare(base, e1.preds, ids);
      const success = t.improved - t.worsened >= CFG.success_margin;
      const group = a.status === "accepted" ? "accepted" : "control";
      const brier = Math.round(10000 * (a.predicted - (success ? 1 : 0)) ** 2) / 10000;
      const vc = issuer.issue("AdviceOutcome", { id: a.target_did, advice: { id: a.id, type: a.type, scope: a.scope, round: a.round, confidence: a.confidence, predicted: a.predicted, arm: a.arm, arm_reason: a.arm_reason },
        decision: a.status, outcome: { success, measured_round: round, ...t, brier, half: CFG.split ? "confirm" : "all", method: "paired, author labels, McNemar exact" } }, { validDays: 365, agentId: a.target });
      store.update("advice", {}, (all) => { Object.assign(all[a.id], { outcome: { success, measured_round: round, ...t, brier, credential: vc.id } }); });
      store.update("advice_stats", {}, (all) => {
        const s = (all[a.type] ||= blank());
        s[group].n++; if (success) s[group].success++; s[group].gain += t.gain_pp;
      });
      issuer.event("advice_resolved", { advice: a.id, type: a.type, decision: a.status, success, gain_pp: t.gain_pp, brier });
      out.push({ ...adviceAll()[a.id] });
    }
    return out;
  }

  const wrongShare = (e) => (e?.routing && e.routing.n ? e.routing.wrong / e.routing.n : null);

  function generate(rec, round, emittedSignals = []) {
    const created = [];
    const mine = evals()[rec.id] || [];
    const cur = mine.find((e) => e.round === round);
    if (!cur) return created;
    const scope = rec.specialization || null;
    const sel = scopeIds(cur, scope, "select");
    const okOn = (e, ids) => ids.filter((id) => e.preds[id] === heldout()[id]?.rating).length;

    // 1) откат: лучшая из прошлых версий (с другим хэшем) значимо лучше текущей на половине «select»,
    //    или у узла с потомками выросла доля отзывов, отправленных не тому потомку (страж)
    let best = null, bestOk = -1;
    for (const e of mine) {
      if (e.round === round || !e.hash || e.hash === cur.hash) continue;
      const k = okOn(e, sel.filter((id) => id in e.preds));
      if (k > bestOk) { bestOk = k; best = e; }
    }
    if (best) {
      const t = compare(best.preds, cur.preds, sel.filter((id) => id in best.preds));
      const w0 = wrongShare(best), w1 = wrongShare(cur);
      const guard = w0 != null && w1 != null && (w1 - w0) * 100 >= CFG.guardrail_pp && t.worsened >= t.improved;
      if ((t.worsened - t.improved >= CFG.rollback_margin && t.p_value < 0.2) || guard)
        push(create("rollback", rec, { target: rec, scope, evidence: { reason: guard ? "guardrail_routing" : "accuracy", best_round: best.round, best_hash: best.hash, current_hash: cur.hash, ...t,
          ...(guard ? { routing_wrong_pp: { best: Math.round(1000 * w0) / 10, current: Math.round(1000 * w1) / 10 } } : {}) },
          action: { kind: "restore", hash: best.hash, min_margin: 3 } }, round));
    }

    // 2) цель узла: специалист за несколько раундов не вырос
    if (scope) {
      const first = mine[0];
      const askedBefore = Object.values(adviceAll()).some((a) => a.type === "clarify_objective" && a.target === rec.id);
      if (first && round - first.round >= CFG.stagnation_rounds && !askedBefore) {
        const t = compare(first.preds, cur.preds, sel.filter((id) => id in first.preds));
        if (t.improved - t.worsened < CFG.success_margin)
          push(create("clarify_objective", rec, { target: rec, scope, evidence: { since_round: first.round, ...t }, action: { kind: "set_objective", text: geo.objectiveFor(scope) } }, round));
      }
    }

    // 3) распределение у родителя: потомок на своих отзывах точнее, чем родитель на тех же отзывах (вместе с передачей)
    if (rec.parent && scope) {
      const parent = orch.get(rec.parent);
      const pe = evalAt(parent.id, round);
      if (pe) {
        const common = sel.filter((id) => id in pe.preds);
        if (common.length >= CFG.min_items) {
          const t = compare(pe.preds, cur.preds, common);
          if (t.after_pp - t.before_pp >= CFG.routing_gap_pp)
            push(create("train_routing", rec, { target: parent, scope: parent.specialization || null, evidence: { child: rec.id, child_scope: scope, parent_pp: t.before_pp, child_pp: t.after_pp, n: t.n },
              action: { kind: "routing_focus", category: scope } }, round));
        }
      }
    }

    // 4) рождение специалиста — из сигнала «В»
    for (const s of emittedSignals.filter((x) => x.type === "spawn_specialist")) {
      const a = create("spawn_specialist", rec, { target: rec, scope: s.evidence.category, evidence: s.evidence, action: { kind: "spawn", category: s.evidence.category }, signal: s.id }, round);
      if (a) store.update("signals", {}, (all) => { if (all[s.id]) all[s.id].advice = a.id; });
      push(a);
    }
    return created;
    function push(a) { if (a) created.push(a); }
  }

  function onEval(rec, round, preds, skills, emittedSignals, routing = null) {
    recordEval(rec, round, preds, skills, routing);
    const resolved = resolveDue(rec, round);
    const created = generate(rec, round, emittedSignals);
    return { created, resolved };
  }

  // калибровка: оценка Брайера, базовая оценка (всегда предсказывать общую долю успехов), таблица надёжности, по половинам прогона
  function calibration(list, splitRound) {
    if (!list.length) return null;
    const y = (a) => (a.outcome.success ? 1 : 0);
    const brier = (l) => (l.length ? Math.round(10000 * l.reduce((s, a) => s + (a.predicted - y(a)) ** 2, 0) / l.length) / 10000 : null);
    const base = list.reduce((s, a) => s + y(a), 0) / list.length;
    const baseline = Math.round(10000 * list.reduce((s, a) => s + (base - y(a)) ** 2, 0) / list.length) / 10000;
    const b = brier(list);
    const bins = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]].map(([lo, hi]) => {
      const l = list.filter((a) => a.predicted >= lo && a.predicted < hi);
      return { bin: `${lo.toFixed(1)}–${Math.min(1, hi).toFixed(1)}`, n: l.length, mean_predicted: l.length ? Math.round(100 * l.reduce((s, a) => s + a.predicted, 0) / l.length) / 100 : null, actual: l.length ? Math.round(100 * l.reduce((s, a) => s + y(a), 0) / l.length) / 100 : null };
    }).filter((x) => x.n);
    const first = list.filter((a) => a.round <= splitRound), second = list.filter((a) => a.round > splitRound);
    return { n: list.length, brier: b, baseline_brier: baseline, skill: baseline ? Math.round(1000 * (1 - b / baseline)) / 1000 : null, split_round: splitRound,
      brier_first_half: brier(first), brier_second_half: brier(second), n_first: first.length, n_second: second.length, reliability: bins };
  }

  function stats({ split_round = null } = {}) {
    const all = Object.values(adviceAll()).filter((a) => a.status !== "void");
    const byType = Object.fromEntries(Object.keys(ADVICE_TYPES).map((t) => {
      const l = all.filter((a) => a.type === t);
      return [t, { title: ADVICE_TYPES[t], horizon_rounds: CFG.horizon[t], ...experience(t), given: l.length, treatment: l.filter((a) => a.arm === "treatment").length,
        control_block: l.filter((a) => a.arm_reason === "block_control").length, withheld: l.filter((a) => a.arm_reason === "policy_withheld").length }];
    }));
    const resolved = all.filter((a) => a.outcome && a.predicted != null);
    const acc = resolved.filter((a) => a.status === "accepted"), ctl = resolved.filter((a) => a.status === "declined");
    const rate = (l) => (l.length ? Math.round(100 * l.filter((a) => a.outcome.success).length / l.length) / 100 : null);
    const rounds = resolved.map((a) => a.round).sort((a, b) => a - b);
    const sr = split_round ?? (rounds.length ? rounds[Math.floor((rounds.length - 1) / 2)] : 0);
    return { version: 2, issuer: issuer.did, void: Object.values(adviceAll()).filter((a) => a.status === "void").length, policy: CFG.policy, control_share: CFG.control_share, horizon_rounds: CFG.horizon, select_confirm_split: CFG.split,
      success_rule: `на половине confirm исправленных ответов больше испорченных хотя бы на ${CFG.success_margin}`, prior: prior(),
      given: all.length, resolved: resolved.length, accepted_success_rate: rate(acc), control_success_rate: rate(ctl),
      calibration: calibration(resolved, sr), by_type: byType };
  }

  const list = (agentId) => Object.values(adviceAll()).filter((a) => !agentId || a.agent === agentId || a.target === agentId);
  return { onEval, decide, stats, list, compare, experience, CFG };
}
