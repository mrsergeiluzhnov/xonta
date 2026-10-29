// Общие части тематических стендов (0.20): детерминированный генератор, сборка задания, набор для экзамена.
// Задание: что видит агент (brief), какие проверки можно купить и что они покажут (checks), правда (correct, harm по действиям,
// сумма, обратимость) и объяснение ошибки для обратной связи агенту (explain). Агент видит результат проверки, только если купил её.
import { createHash } from "node:crypto";

export const rng = (seed) => { let h = createHash("sha256").update(String(seed)).digest(); let i = 0; return () => { if (i > 28) { h = createHash("sha256").update(h).digest(); i = 0; } const v = h.readUInt32BE(i) / 2 ** 32; i += 4; return v; }; };
export const pick = (r, list) => list[Math.floor(r() * list.length) % list.length];
export const hid = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 10);
export const money = (n) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;

// набор для экзамена у оркестратора: агент получает brief и запечатанные результаты проверок, сам решает, какие открыть
export function fieldPack(D, { era = 0, n = 80, seed = "exam" } = {}) {
  const tasks = Array.from({ length: n }, (_, k) => D.makeTask(`${seed}-${era}-${k}`, era)).map((t) => ({ input: { brief: t.brief, category: t.category, sealed_checks: t.checks, actions: D.ACTIONS }, correct: t.truth.correct, harm: t.truth.harm, category: t.category }));
  return { name: `${D.TITLE} (стенд, эпоха ${era})`, description: D.DESCRIPTION, currency: "RUB", human_cost: D.HUMAN_COST, wrong_harm: 200, tool: "decide", arg: "task", actions: D.ACTIONS, human_action: D.HUMAN, tasks };
}

// оценка решения: верно, принято неверное, передал человеку; цена для итога (польза за верное самостоятельное, вред, человек, проверки)
export function grade(D, task, action, { checksCost = 0, gated = false } = {}) {
  const tr = task.truth, a = D.ACTIONS.includes(action) ? action : D.HUMAN;
  const human = gated || a === D.HUMAN, correct = a === tr.correct;
  const harm = human ? 0 : correct ? 0 : (tr.harm[a] ?? 200);
  const value = !human && correct ? D.VALUE : 0;
  return { action: a, gated, human, correct, wrong_accept: !human && !correct, harm, value, human_cost: human ? D.HUMAN_COST : 0, checks_cost: checksCost, utility: value - harm - (human ? D.HUMAN_COST : 0) - checksCost, irreversible: !human && !!tr.irreversible_action?.[a] };
}

// Разбор предложения агента (0.20.2). В run-ops-1 GigaChat ответил на все 15 просьб, но ни одно предложение не дошло до
// оркестратора: ответ отбрасывался молча, если не разбирался как JSON или категория была не дословно из списка.
// Теперь: JSON, если получится; иначе поля вытаскиваются из текста; категория — первая из списка, найденная в ответе
// (в поле category, потом в правиле), иначе самая частая среди ошибок раунда. Причина отказа возвращается для журнала.
export function parseProposal(text, categories, mistakeCategories = []) {
  const s = String(text || "");
  let o = null;
  const body = ((s.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1] || s).trim(), at = body.indexOf("{");
  if (at >= 0) for (let end = body.lastIndexOf("}"); end > at && !o; end = body.lastIndexOf("}", end - 1)) { try { o = JSON.parse(body.slice(at, end + 1)); } catch {} }
  const field = (k) => (o && o[k] != null ? String(o[k]) : (body.match(new RegExp(`["«]?${k}["»]?\\s*:\\s*["«]([\\s\\S]*?)["»]\\s*(?:,\\s*["«]?\\w+["»]?\\s*:|}|$)`)) || [])[1] || "");
  // 0.25.8: модель иногда переписывает в поле образец из подсказки — «до 120 символов», «когда применять»
  // (run-red-3, run-ops-4: два доказанных правила с таким хвостом). Хвост убираем, смысл правила не трогаем.
  // 0.25.9 (run-proc-4): ещё две формы того же образца — «(<200 символов)» и «независимо от количества символов»
  const clean = (x) => x.replace(/\s+/g, " ").replace(/[,;]?\s*\(?\s*(?:до|<|≤|не более|не длиннее)\s*\d+\s+символ[а-яё]*\s*\)?/gi, "").replace(/[,;]?\s*независимо от (?:количества|числа|длины) символов/gi, "").replace(/^когда применять[,.:]?\s*/i, "").replace(/\s+([.,;])/g, "$1").replace(/[\s,;]+$/, "").trim();
  const rule = clean(field("rule")), when = clean(field("when")), rawCat = field("category");
  if (!rule) return { ok: false, why: `нет правила в ответе: ${s.replace(/\s+/g, " ").slice(0, 160)}` };
  const find = (x) => { const low = String(x).toLowerCase(); return categories.find((c) => low.includes(c.toLowerCase())) || null; };
  let category = find(rawCat) || find(rule), guessed = false;
  if (!category && mistakeCategories.length) { const n = (c) => mistakeCategories.filter((x) => x === c).length; category = [...new Set(mistakeCategories)].sort((a, b) => n(b) - n(a))[0]; guessed = true; }
  if (!category) return { ok: false, why: `категория не из списка: ${rawCat.slice(0, 60)}` };
  return { ok: true, category, rule: rule.slice(0, 200), when: when.slice(0, 120), guessed, raw_category: rawCat.slice(0, 60) };
}

// через одно: a0, b0, a1, b1, …; хвост длинного списка — в конце
export const interleave = (a, b) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => [a[i], b[i]]).flat().filter((x) => x !== undefined);
