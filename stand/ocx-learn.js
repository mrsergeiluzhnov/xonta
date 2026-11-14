// Учёба оркестратора после прогона (0.30.0). Оркестратор 1 разбирает свои ошибки за прогон, сам пишет правила-кандидаты,
// меряет каждое парами на новых заданиях (не на тех, где ошибся) и кладёт в свою книгу. В начале следующего прогона
// доказанные правила из книги перемеряются на свежих заданиях и только тогда выдаются агентам.
// Книга живёт в ORCH_ROOT/ocx-o1/book.json и переходит из прогона в прогон так же, как книги тематических прогонов.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function loadBook(path, fresh = false) {
  if (fresh || !existsSync(path)) return { version: 1, rules: [] };
  try { const b = JSON.parse(readFileSync(path, "utf8")); return Array.isArray(b.rules) ? markBroken(b) : { version: 1, rules: [] }; } catch { return { version: 1, rules: [] }; }
}
// 0.31.6: правило, у которого потерялся текст (r14 из run-ocx-7, «[object Object]»), не считается ни вредным, ни пробованным:
// агентам на замере выдали пустышку. Запись остаётся в книге со статусом invalid
// 0.31.7: так же помечается правило, от которого на замер ушла одна ветка из нескольких (r16, r17 из run-ocx-8): по сырому ответу
// модели видно, что правило было длиннее
const bare = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
export function cutRule(r) {
  if (!r?.literal?.raw) return false;
  const arr = rulesArray(r.literal.raw), n = (arr || []).filter((x) => branchOf(x)).length;
  return n > 1 && bare(parseRewrite(r.literal.raw)) !== bare(r.text);
}
export function markBroken(book) {
  for (const r of book.rules) {
    if (r.status === "invalid") continue;
    const reason = brokenRule(r.text) ? "rule text lost" : cutRule(r) ? "rule cut to one branch" : squashed(r.text) ? "words glued together" : null; // 0.31.10: r20 из run-ocx-11
    if (reason) { (r.history ||= []).push({ kind: "invalid", reason, was: r.status }); r.status = "invalid"; delete r.worst; }
  }
  return book;
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
// 0.31.9: в run-ocx-10 сверка 0.31.8 сработала — модель вернула reject на ответ мошенника, и правило получилось ровно то,
// которого ждали: «"реквизиты не меняли…" — reject; "подтвердил смену счёта" — pay; "не выполнена" — hold». Но его отбросили
// без замера как пересказ r12: по словам оно на 0,95 похоже на r18 (там на тот же ответ стоял hold), а исправление r12 уже
// «израсходовал» r18. Теперь (1) правило, которое на тот же дословный ответ проверки ставит другое действие, — не пересказ
// (changed); (2) исправление не считается использованным, если в исправленном варианте пропало действие исходного правила
export function findRepeat(failed, text, shown = new Set()) {
  const near = failed.filter((x) => similarity(x.text, text) >= SAME);
  const changed = near.filter((x) => actionsDiffer(x.text, text));
  const like = near.filter((x) => !changed.includes(x));
  const byId = new Map(failed.map((x) => [x.id, x]));
  const fixUsed = (x) => { if (!x.fixed_by) return false; const f = byId.get(x.fixed_by); return !f || !lostActions(x.text, f.text).length; };
  const fixable = (x) => blocksRepeat(x) && shown.has(x.id) && !fixUsed(x) && similarity(x.text, text) < NEAR;
  const block = like.find((x) => blocksRepeat(x) && !fixable(x)) || null;
  return { block, fix: block ? null : like.find(fixable) || null, remeasure: like.find((x) => !blocksRepeat(x)) || null, changed: block ? null : changed[0] || null };
}

// 0.31.4: худшие пары замера — то, что правило сделало хуже. Хранятся в книге вместе с тем, что показали проверки,
// и показываются модели в следующей учёбе: «почему не помогло» вместо одного текста правила
export function worstPairs(rows, n = 3, seen = () => "") {
  return rows.filter((r) => r.cost_with > r.cost_without).sort((a, b) => (b.cost_with - b.cost_without) - (a.cost_with - a.cost_without)).slice(0, n)
    .map((r) => ({ task: r.task, policy: r.policy, correct: r.correct, without: r.without, with: r.with, cost_without: r.cost_without, cost_with: r.cost_with, checks_with: r.checks_with, reason_with: String(r.reason_with || "").slice(0, 160), seen: seen(r) }));
}
// 0.31.5: ответы проверок дословно. В run-ocx-6 модель видела пару «callback: реквизиты не меняли → pay» и подсказку назвать
// ответы дословно, но написала «если поставщик не подтвердил смену счёта — reject». Агенты прочитали «реквизиты не меняли»
// как «поставщик подтвердил отсутствие изменений» и заплатили мошеннику в 3 парах из 12. Теперь оркестратор сам сверяет
// правило с ответами, которые эта проверка давала у него в этой категории, и если какой-то ответ не назван, один раз
// просит модель переписать правило, перечислив эти ответы. Только для проверок с 2–3 разными ответами: если ответ один, проверка в этой категории ничего не различает,
// а ответы с суммами и процентами дословно не перечислить.
const norm = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/[«»"“”„.;:!?()]/g, " ").replace(/\s+/g, " ").trim();
export function answerQuoted(rule, answer) {
  const r = norm(rule);
  if (r.includes(norm(answer))) return true;
  return String(answer).split(":").pop().split(/[,;]/).map(norm).some((f) => f.length >= 10 && r.includes(f));
}
// answers: { check: [тексты ответов] }; вернуть { check: [ответы, которых нет в правиле] } для проверок, названных в правиле
export function unquotedAnswers(rule, answers, maxDistinct = 3) {
  const out = {};
  for (const [check, list] of Object.entries(answers || {})) {
    const uniq = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
    if (uniq.length < 2 || uniq.length > maxDistinct || !new RegExp(`\\b${check}\\b`).test(rule)) continue;
    const miss = uniq.filter((a) => !answerQuoted(rule, a));
    if (miss.length) out[check] = miss;
  }
  return out;
}
// «callback: «…»; sender_domain: «…»» (seen из худших пар) → { callback: ["…"], … }
export function answersFromSeen(seen, into = {}) {
  for (const m of String(seen || "").matchAll(/([a-z_]+): «([^»]*)»/g)) (into[m[1]] ||= []).push(m[2]);
  return into;
}
export function literalPrompt(rule, answers, missing) {
  const lines = Object.keys(missing).map((c) => `${c} отвечала так: ${[...new Set(answers[c])].map((a) => `«${a}»`).join("; ")}`);
  return `STEP:literal\nПравило: «${rule}»\nВ нём не все ответы проверки названы дословно, агенты такие правила читают неверно. Эти проверки у нас в этой категории отвечали только так:\n${lines.join("\n")}\nПерепиши правило одной-двумя фразами: какую проверку купить, для каждого из этих ответов процитируй его дословно и прямо скажи, какое действие выбрать. Смысл правила не меняй. Всё правило — одна строка, не список условий и не объект. Ответ: {"rules":["…"]}`;
}

// 0.31.8: при переписывании модель может поменять смысл правила. В run-ocx-8 и run-ocx-9 черновик был «подтвердил смену — pay;
// не подтвердил — reject; не выполнена — hold», а в переписанном варианте ответ мошенника «реквизиты не меняли» вёл к hold.
// Агенты на замере купили callback во всех 12 парах и сделали ровно то, что написано: hold вместо reject, правило вышло
// без эффекта. Теперь оркестратор сверяет действия черновика и переписанного варианта и, если какое-то действие пропало,
// один раз просит переписать ещё раз, сохранив действия черновика
const ACTS = ["pay", "reject", "hold", "escalate"];
export const actionsOf = (s) => new Set(ACTS.filter((a) => new RegExp(`(^|[^a-z_])${a}([^a-z_]|$)`, "i").test(String(s || ""))));
export function lostActions(draft, text) { const b = actionsOf(text); return [...actionsOf(draft)].filter((a) => !b.has(a)); }
// 0.31.9: какое действие правило ставит на каждый дословно названный ответ проверки: { ответ → действие }.
// Берутся только части правила (между «;»), где ровно одно действие
export function answerActions(s) {
  const out = new Map();
  for (const part of String(s || "").split(/;/)) {
    const acts = [...actionsOf(part)]; if (acts.length !== 1) continue;
    for (const m of part.matchAll(/["«“„]([^"«»“”„]{6,})["»”“]/g)) out.set(norm(m[1]), acts[0]);
  }
  return out;
}
export function actionsDiffer(a, b) {
  const A = answerActions(a), B = answerActions(b);
  for (const [k, v] of A) if (B.has(k) && B.get(k) !== v) return true;
  return false;
}
export function keepActionsPrompt(draft, text, lost, answers, missing) {
  const lines = Object.keys(missing).map((c) => `${c} отвечала так: ${[...new Set(answers[c])].map((a) => `«${a}»`).join("; ")}`);
  return `STEP:literal\nЧерновик правила: «${draft}»\nПереписанный вариант: «${text}»\nВ переписанном варианте пропало ${lost.length > 1 ? "действия" : "действие"} ${lost.join(", ")}, ${lost.length > 1 ? "они были" : "оно было"} в черновике. Смысл правила поменялся, так нельзя. Эти проверки у нас в этой категории отвечали только так:\n${lines.join("\n")}\nДля каждого ответа реши, какой ветке черновика он соответствует по смыслу, процитируй ответ дословно и поставь действие этой ветки из черновика. Все действия черновика (${[...actionsOf(draft)].join(", ")}) должны остаться. Всё правило — одна строка, не список условий и не объект. Ответ: {"rules":["…"]}`;
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
  return [...new Set(arr.map((x) => ruleText(x).replace(/\s+/g, " ").trim()).filter((x) => x.length > 10 && !brokenRule(x)))].map((x) => x.slice(0, 400)).slice(0, max);
}

// 0.31.6: модель иногда кладёт в "rules" не строку, а объект — {"rule": "…"} или {"ответ": "действие", …}.
// В run-ocx-7 такой ответ превратился в текст «[object Object]», его и мерили. Теперь достаём текст из объекта
export function ruleText(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (typeof x !== "object") return String(x);
  if (Array.isArray(x)) return x.map(ruleText).filter(Boolean).join("; ");
  for (const k of ["rule", "text", "правило", "текст"]) if (typeof x[k] === "string" && x[k].trim()) return x[k];
  const b = branchOf(x); if (b) return `если ${b.cond} — ${b.act}`; // 0.31.7
  return Object.entries(x).map(([k, v]) => { const t = ruleText(v); return t ? `${k} — ${t}` : k; }).join("; ");
}
export const brokenRule = (text) => /\[object Object\]/.test(String(text || ""));

// 0.31.7: модель на просьбу переписать вернула правило по веткам — [{"condition":"callback: реквизиты не меняли…","action":"hold"},
// {"condition":"callback: поставщик подтвердил смену счёта","action":"pay"}, …]. Код брал первый элемент списка, и на замер
// ушла одна ветка без «купить callback» и без pay (run-ocx-8, r16 и r17). Ветка — объект с условием и действием
const pickStr = (x, keys) => { for (const k of keys) if (typeof x[k] === "string" && x[k].trim()) return x[k].trim(); return null; };
export function branchOf(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const cond = pickStr(x, ["condition", "if", "when", "условие", "если"]), act = pickStr(x, ["action", "then", "do", "действие", "то"]);
  return cond && act ? { cond: cond.replace(/^если\s+/i, ""), act } : null;
}
function rulesArray(text) {
  const s = String(text || ""), at = s.indexOf("{");
  if (at >= 0) for (let end = s.lastIndexOf("}"); end > at; end = s.lastIndexOf("}", end - 1)) { try { const o = JSON.parse(s.slice(at, end + 1)); if (Array.isArray(o.rules)) return o.rules; } catch {} }
  return null;
}
// переписанное правило — одно: ветки собираются в одну строку, иначе берётся первое правило списка
export function parseRewrite(text) {
  const arr = rulesArray(text), branches = (arr || []).filter((x) => branchOf(x));
  if (branches.length > 1) { const t = branches.map(ruleText).join("; ").replace(/\s+/g, " ").trim(); return brokenRule(t) ? null : t.slice(0, 600); }
  return parseCandidates(text, 1)[0] || null;
}

// 0.31.10: в run-ocx-11 модель переписала правило, склеив слова: «купить callback;если"поставщикподтвердилсменучёта"выбратьpay;…».
// Сверка ответов такие слова не узнала («назвала не все»), а агенты на замере правило почти не поняли: callback купили в 1 паре из 12.
// Теперь склеенный текст чинится: ответ проверки в кавычках, который совпадает с известным ответом без пробелов и знаков, заменяется
// этим ответом (модель при склейке теряет буквы: «сменучёта», «пономуза» — допускается 15% правок); остальные склеенные слова разбиваются по словам черновика и ответов. Если склейка осталась — переписанный вариант не берётся
const letters = (s) => String(s).toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я_]/g, "");
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[b.length];
}
export const squashed = (s) => /[a-zа-яё_]{25,}/i.test(String(s || ""));
function segment(word, vocab) {
  const w = word.toLowerCase().replace(/ё/g, "е"), n = w.length, best = new Array(n + 1).fill(null); best[0] = [];
  for (let i = 1; i <= n; i++) for (let j = Math.max(0, i - 30); j < i; j++) {
    if (!best[j] || !vocab.has(w.slice(j, i))) continue;
    if (!best[i] || best[j].length + 1 < best[i].length) best[i] = [...best[j], [j, i]];
  }
  return best[n] && best[n].length > 1 ? best[n].map(([a, b]) => word.slice(a, b)).join(" ") : null;
}
const BASE_WORDS = ["если", "то", "тогда", "иначе", "выбрать", "выбери", "выбирай", "купить", "купи", "при", "ответе", "ответ", "результат", "результате", "проверка", "проверку", "и", "или", "не", "pay", "reject", "hold", "escalate"];
export function unsquash(text, answers = {}, sources = []) {
  let s = String(text || "");
  if (!squashed(s)) return { text: s, fixed: false };
  const known = new Map();
  for (const a of Object.values(answers).flat()) if (a) known.set(letters(a), String(a).trim());
  const near = (inner) => { const k = letters(inner); let best = null, bd = Infinity; for (const [key, a] of known) { const d = editDistance(k, key); if (d < bd) { bd = d; best = a; } } return best && bd <= Math.floor(0.15 * Math.max(k.length, 1)) ? best : null; };
  s = s.replace(/(["«“„])([^"«»“”„]+)(["»”“])/g, (m, o, inner, c) => { const a = near(inner); return a ? `${o}${a}${c}` : m; });
  const vocab = new Set(BASE_WORDS);
  for (const src of [...sources, ...known.values(), ...Object.keys(answers)]) for (const w of String(src).toLowerCase().replace(/ё/g, "е").match(/[a-zа-я_]+/g) || []) vocab.add(w);
  s = s.replace(/[a-zа-яё_]{6,}/gi, (w) => vocab.has(w.toLowerCase().replace(/ё/g, "е")) ? w : segment(w, vocab) || w);
  let q = 0; s = s.replace(/"/g, (m, i, all) => { q++; return q % 2 ? (/[a-zа-яё0-9]/i.test(all[i - 1] || "") ? ' "' : '"') : (/[a-zа-яё0-9]/i.test(all[i + 1] || "") ? '" ' : '"'); });
  s = s.replace(/([a-zа-яё0-9])«/gi, "$1 «").replace(/»([a-zа-яё0-9])/gi, "» $1").replace(/;(?=\S)/g, "; ").replace(/\s+/g, " ").trim();
  const left = (s.match(/[a-zа-яё_]{18,}/gi) || []).filter((w) => !vocab.has(w.toLowerCase().replace(/ё/g, "е"))); // длинных склеек не осталось
  return { text: s, fixed: !left.length };
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
