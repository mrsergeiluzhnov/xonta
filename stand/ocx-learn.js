// Учёба оркестратора после прогона (0.30.0). Оркестратор 1 разбирает свои ошибки за прогон, сам пишет правила-кандидаты,
// меряет каждое парами на новых заданиях (не на тех, где ошибся) и кладёт в свою книгу. В начале следующего прогона
// доказанные правила из книги перемеряются на свежих заданиях и только тогда выдаются агентам.
// Книга живёт в ORCH_ROOT/ocx-o1/book.json и переходит из прогона в прогон так же, как книги тематических прогонов.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function loadBook(path, fresh = false) {
  if (fresh || !existsSync(path)) return { version: 1, rules: [] };
  try { const b = JSON.parse(readFileSync(path, "utf8")); return Array.isArray(b.rules) ? b : { version: 1, rules: [] }; } catch { return { version: 1, rules: [] }; }
}
export function saveBook(path, book) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(book, null, 1)); }

// похожесть правил по словам (без окончаний): чтобы отброшенное правило не вернулось другими словами.
// Грубо, но в ops-5/ops-6 возвращались именно перестановки тех же слов
const STOP = new Set("и в во на по с со к ко о об от до для из за не ни что как если то это его её их или а но же ли бы при перед после только всегда".split(" "));
const stems = (s) => new Set(String(s).toLowerCase().replace(/ё/g, "е").match(/[a-zа-я_]+/g)?.filter((w) => w.length > 2 && !STOP.has(w)).map((w) => (/^[a-z_]+$/.test(w) ? w : w.slice(0, 5))) || []);
export function similarity(a, b) {
  const A = stems(a), B = stems(b); if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}
export const SAME = 0.6;

// 0.31.3: пересказ не прошедшего правила отбрасывается без замера, только если у того замера сохранились пары.
// Правила, отвергнутые до 0.31.1 (пар нет), можно перемерить один раз: иначе причину вреда уже не узнать
// (run-ocx-4: звонок поставщику, вредный в ocx-3b, вернулся другими словами и был отброшен).
export const blocksRepeat = (rule) => (rule?.history || []).some((h) => h.kind === "learn" && h.pairs_saved);
// 0.31.4: если модели показали худшие пары не прошедшего правила (shown), она может предложить исправленный вариант —
// он похож на старый по словам, но не почти дословно. Такой вариант меряется один раз (fix), дальше старое правило
// снова отбрасывает пересказы (run-ocx-5: звонок вреден, потому что агенты читают «реквизиты не меняли» как подтверждение)
export const NEAR = 0.85;
export function findRepeat(failed, text, shown = new Set()) {
  const like = failed.filter((x) => similarity(x.text, text) >= SAME);
  const fixable = (x) => blocksRepeat(x) && shown.has(x.id) && !x.fixed_by && similarity(x.text, text) < NEAR;
  const block = like.find((x) => blocksRepeat(x) && !fixable(x)) || null;
  return { block, fix: block ? null : like.find(fixable) || null, remeasure: like.find((x) => !blocksRepeat(x)) || null };
}

// 0.31.4: худшие пары замера — то, что правило сделало хуже. Хранятся в книге вместе с тем, что показали проверки,
// и показываются модели в следующей учёбе: «почему не помогло» вместо одного текста правила
export function worstPairs(rows, n = 3, seen = () => "") {
  return rows.filter((r) => r.cost_with > r.cost_without).sort((a, b) => (b.cost_with - b.cost_without) - (a.cost_with - a.cost_without)).slice(0, n)
    .map((r) => ({ task: r.task, policy: r.policy, correct: r.correct, without: r.without, with: r.with, cost_without: r.cost_without, cost_with: r.cost_with, checks_with: r.checks_with, reason_with: String(r.reason_with || "").slice(0, 160), seen: seen(r) }));
}
export function pairLesson(p) {
  const checks = p.seen || p.checks_with?.join(", ");
  return `  · С правилом агент ${checks ? `купил: ${checks}` : "проверок не покупал"}. Выбрал ${p.with}${p.reason_with ? ` («${p.reason_with}»)` : ""}, правильно было ${p.correct}, без правила выбрал ${p.without}. Цена с правилом ${Math.round(p.cost_with)} ₽, без ${Math.round(p.cost_without)} ₽.`;
}

// разбор ответа модели: {"rules":["…","…"]}; если JSON не разобрался — строки, похожие на правила
export function parseCandidates(text, max = 3) {
  const s = String(text || ""); let arr = null;
  const at = s.indexOf("{");
  if (at >= 0) for (let end = s.lastIndexOf("}"); end > at && !arr; end = s.lastIndexOf("}", end - 1)) { try { const o = JSON.parse(s.slice(at, end + 1)); if (Array.isArray(o.rules)) arr = o.rules; } catch {} }
  if (!arr) arr = s.split(/\n+/).map((x) => x.replace(/^[\s\-*\d.)"«]+|["»,\s]+$/g, "")).filter((x) => x.length > 25);
  return [...new Set(arr.map((x) => String(x).replace(/\s+/g, " ").trim()).filter((x) => x.length > 10))].map((x) => x.slice(0, 400)).slice(0, max);
}

// замер правил парами: одно и то же задание с правилами (base + rules) и с текущей практикой (base — правила, которые уже
// действуют, или пусто). Политики агентов чередуются: правило выдаётся всем, а быстрый без правила проверок не покупает вовсе.
// Цена — как в замере оркестратора 2: вред + человек + проверки − польза за верное самостоятельное решение
export async function measure({ tasks, rules, base = [], decide, cost, llm, policies, humanCost }) {
  const rows = [];
  for (let k = 0; k < tasks.length; k++) {
    const t = tasks[k], policy = policies[k % policies.length], noop = async () => {};
    const a = await decide(llm, policy, t, { rules: base, buy: noop }), b = await decide(llm, policy, t, { rules: [...base, ...rules], buy: noop });
    rows.push({ task: t.id, policy, correct: t.truth.correct, without: a.action, with: b.action, cost_without: cost(t, a), cost_with: cost(t, b), checks_without: a.checks, checks_with: b.checks, reason_with: b.reason });
  }
  const avg = (f) => rows.reduce((s, r) => s + f(r), 0) / Math.max(1, rows.length);
  return { rows, measurement: { pairs: rows.length, design: "paired", holdout: true, cost_with: +avg((r) => r.cost_with).toFixed(1), cost_without: +avg((r) => r.cost_without).toFixed(1),
    harm_delta_per_task: +avg((r) => r.cost_with - r.cost_without).toFixed(1), baseline: { policy: "always escalate", harm_delta_vs_baseline_per_task: +avg((r) => r.cost_with - humanCost).toFixed(1) },
    better: rows.filter((r) => r.cost_with < r.cost_without).length, worse: rows.filter((r) => r.cost_with > r.cost_without).length, against: base.length ? "current rule" : "no rule",
    unit: "RUB per task: harm + human + checks - value of a correct autonomous decision" } };
}

// что показать модели про ошибку: только то, что оркестратор знает после исхода — что видел агент, какие проверки купил
// и что они показали, что выбрал, как оказалось правильно и во что обошлось. Объяснение устройства темы не показываем
export function caseText(t, x) {
  const seen = x.checks.length ? x.checks.map((c) => `${c}: ${t.checks[c]}`).join("; ") : "проверок не покупал";
  return `- «${t.brief}» Проверки: ${seen}. Агент выбрал ${x.action}, правильно было ${x.correct}, вред ${x.harm} ₽.`;
}
