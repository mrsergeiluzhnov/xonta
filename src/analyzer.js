// Анализ трасс шлюза и сигналы владельцу. Оркестратор ничего не меняет сам — только рекомендует с доказательствами.
// А — добавить или убрать экземпляр; Б — выделить инструмент из повторяющейся детерминированной цепочки; В — родить специализированного потомка.
import { randomId } from "./crypto.js";

export const DEFAULTS = {
  a: { window_min: 15, min_calls: 20, sla_ms: 2000, scale_in_factor: 0.25 },
  b: { window_days: 7, min_tasks: 10, min_share: 0.3, min_len: 2 },
  c: { window_days: 7, min_share: 0.2, gap: 20 },
  cooldown_min: 30,
};

const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

export function metrics(traces) {
  const ms = traces.map((t) => t.ms).filter((x) => typeof x === "number");
  const errors = traces.filter((t) => !t.ok).length;
  return { calls: traces.length, errors, error_rate: traces.length ? +(errors / traces.length).toFixed(4) : 0, p50_ms: pct(ms, 50), p95_ms: pct(ms, 95), max_concurrent: traces.reduce((m, t) => Math.max(m, t.concurrent || 0), 0) };
}

// Детерминированность: одинаковые аргументы → одинаковый результат во всех наблюдениях
function deterministicTools(traces) {
  const seen = new Map(), bad = new Set(), repeated = new Set();
  for (const t of traces) {
    if (!t.ok || !t.out_hash) continue;
    const k = `${t.tool}|${t.args_hash}`;
    if (seen.has(k)) { repeated.add(t.tool); if (seen.get(k) !== t.out_hash) bad.add(t.tool); } else seen.set(k, t.out_hash);
  }
  return { deterministic: [...repeated].filter((x) => !bad.has(x)), nondeterministic: [...bad] };
}

export function signalA(traces, prev, cfg = DEFAULTS.a, sla = cfg.sla_ms) {
  const m = metrics(traces);
  if (m.calls < cfg.min_calls) return null;
  if (m.p95_ms > sla) return { type: "scale_out", title: "Добавить экземпляр агента", evidence: { ...m, sla_ms: sla, window_min: cfg.window_min }, recommendation: `95% ответов медленнее ${sla} мс (p95 = ${m.p95_ms} мс за ${cfg.window_min} мин). Рекомендуется добавить экземпляр.` };
  if (prev?.type === "scale_out" && m.p95_ms < sla * cfg.scale_in_factor) return { type: "scale_in", title: "Можно убрать экземпляр", evidence: { ...m, sla_ms: sla }, recommendation: `Нагрузка спала: p95 = ${m.p95_ms} мс. Дополнительный экземпляр можно убрать.` };
  return null;
}

export function signalB(traces, cfg = DEFAULTS.b) {
  const byTask = new Map();
  for (const t of traces) if (t.task) (byTask.get(t.task) || byTask.set(t.task, []).get(t.task)).push(t);
  const tasks = [...byTask.values()];
  if (tasks.length < cfg.min_tasks) return null;
  const counts = new Map();
  for (const steps of tasks) {
    const seq = steps.sort((a, b) => a.ts.localeCompare(b.ts)).map((s) => s.tool);
    if (seq.length < cfg.min_len) continue;
    const key = seq.join(" → ");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const [chain, n] = top, share = n / tasks.length;
  if (share < cfg.min_share) return null;
  const tools = chain.split(" → ");
  const { deterministic } = deterministicTools(traces);
  const det = tools.every((t) => deterministic.includes(t));
  const inChain = traces.filter((t) => tools.includes(t.tool));
  const chainMs = inChain.reduce((s, t) => s + (t.ms || 0), 0), allMs = traces.reduce((s, t) => s + (t.ms || 0), 0);
  const chainErr = inChain.filter((t) => !t.ok).length, allErr = traces.filter((t) => !t.ok).length;
  return {
    type: "extract_tool",
    title: "Выделить составной инструмент",
    evidence: { chain, tasks_with_chain: n, tasks_total: tasks.length, share: +share.toFixed(2), synthetic_share: +(traces.filter((t) => t.synthetic).length / traces.length).toFixed(2), deterministic: det, time_share: allMs ? +(chainMs / allMs).toFixed(2) : 0, errors_in_chain: chainErr, errors_total: allErr, window_days: cfg.window_days },
    recommendation: `Цепочка «${chain}» встречается в ${Math.round(share * 100)}% задач${det ? " и ведёт себя детерминированно" : ""}. ` +
      `Её можно заменить одним инструментом — меньше вызовов модели, быстрее и надёжнее.${det ? "" : " Детерминированность не подтверждена — сначала проверить."}`,
  };
}

// В: доля категории в трафике и её качество по последней оценке
// skip — категории, для которых уже есть действующий специализированный потомок
export function signalC(traces, evaluation, cfg = DEFAULTS.c, skip = []) {
  if (!evaluation?.categories?.length) return null;
  // только реальный трафик: синтетика нашего тестера сама задаёт долю категорий, и вывод был бы замкнутым
  // доля считается среди категорий, по которым есть оценка: трафик других измерений (например, прошлого режима) её не размывает
  // категория задачи может быть уточнена глубже, чем оценка («rating:middle/3/long» засчитывается в «rating:middle/3»)
  const evalCats = evaluation.categories.map((c) => c.category);
  const catOf = (tc) => evalCats.find((c) => tc === c || String(tc).startsWith(c + "/")) || null;
  const withCat = traces.filter((t) => t.category && !t.synthetic && catOf(t.category));
  if (!withCat.length) return null;
  const share = new Map();
  for (const t of withCat) { const c = catOf(t.category); share.set(c, (share.get(c) || 0) + 1); }
  const best = Math.max(...evaluation.categories.map((c) => c.score));
  // из подходящих категорий — самая отстающая (а не первая по порядку)
  for (const c of [...evaluation.categories].sort((a, b) => a.score - b.score)) {
    if (skip.includes(c.category)) continue;
    if (cfg.min_n && c.total != null && c.total < cfg.min_n) continue; // слишком мало отзывов — отставание неотличимо от шума
    const s = (share.get(c.category) || 0) / withCat.length;
    if (s >= cfg.min_share && c.score <= best - cfg.gap)
      return { type: "spawn_specialist", title: "Родить специализированного потомка", evidence: { category: c.category, traffic_share: +s.toFixed(2), score: c.score, best_score: best, data: evaluation.evaluation?.data },
        recommendation: `Категория «${c.category}» занимает ${Math.round(s * 100)}% задач, а качество в ней ${c.score} против ${best} в сильных категориях. Рекомендуется потомок, специализированный на ней (своя модель, промпт или права).` };
  }
  return null;
}

export function createSignals({ store, notify, cfg = DEFAULTS }) {
  function emit(rec, sig) {
    const all = store.get("signals", {});
    const mine = Object.values(all).filter((s) => s.agent === rec.id);
    const mutedUntil = rec.muted?.[sig.type];
    if (mutedUntil && mutedUntil > new Date().toISOString()) return null;
    const last = mine.filter((s) => s.type === sig.type).sort((a, b) => b.created.localeCompare(a.created))[0];
    if (last && Date.now() - Date.parse(last.created) < cfg.cooldown_min * 60000) return null;
    const s = { id: `sig_${randomId(6)}`, agent: rec.id, created: new Date().toISOString(), status: "new", ...sig };
    store.update("signals", {}, (x) => { x[s.id] = s; });
    notify(rec, { title: `Сигнал: ${sig.title}`, text: sig.recommendation, signal: s.id });
    return s;
  }

  function analyze(rec, latestEval, { skip = [] } = {}) {
    const now = Date.now();
    const recent = store.readLog("traces", new Date(now - cfg.a.window_min * 60000).toISOString()).filter((t) => t.agent === rec.id);
    const week = store.readLog("traces", new Date(now - cfg.b.window_days * 86400000).toISOString()).filter((t) => t.agent === rec.id);
    const prevA = Object.values(store.get("signals", {})).filter((s) => s.agent === rec.id && ["scale_out", "scale_in"].includes(s.type)).sort((a, b) => b.created.localeCompare(a.created))[0];
    const out = [];
    for (const sig of [signalA(recent, prevA, cfg.a, rec.sla_ms || cfg.a.sla_ms), signalB(week, cfg.b), signalC(week, latestEval, cfg.c, skip)]) {
      if (sig) { const s = emit(rec, sig); if (s) out.push(s); }
    }
    return { metrics: { recent: metrics(recent), week: metrics(week) }, emitted: out };
  }

  return { analyze, emit };
}
