// Язык навыков «xonta-geo/1»: мониторинг репутации организации — по тексту отзыва определить оценку автора (1–5)
// и нужен ли срочный ответ (оценка 1–2). Эталон точный: оценка, которую поставил сам автор (набор Georeview, MIT).
// Навык — ДАННЫЕ (заметки и примеры по группам), интерпретатор — открытый шаблон запроса к модели ниже.
// Оркестратор оценивает предложения потомков тем же интерпретатором, не запуская чужой код.
import { createHash } from "node:crypto";

export const LANGUAGE = "xonta-geo/1";
export const KIND = "llm";
export const BATCH = 10;
export const GROUPS = ["rating:negative", "rating:middle", "rating:positive"];

export const groupOf = (rating) => (rating <= 2 ? "rating:negative" : rating <= 4 ? "rating:middle" : "rating:positive");

// Дерево специализаций: группа → оценка → длина отзыва. Ключ узла — путь: «rating:middle», «rating:middle/3», «rating:middle/3/long».
// У позитива одна оценка (5), поэтому уровень «оценка» пропускается: «rating:positive/short». Глубже признаков в данных нет.
export const LEN_SPLIT = Number(process.env.GEO_LEN_SPLIT || 320); // медиана длины отзыва на эталоне
export const lenOf = (text) => (String(text).length <= LEN_SPLIT ? "short" : "long");
export function pathOf(text, rating) {
  if (!(rating >= 1 && rating <= 5)) return [];
  const g = groupOf(rating);
  return g === "rating:positive" ? [g, `${g}/${lenOf(text)}`] : [g, `${g}/${rating}`, `${g}/${rating}/${lenOf(text)}`];
}
// следующий уровень пути после узла spec (null — корень); null, если отзыв вне области узла или глубже делить нечем
export function nextKey(spec, path) {
  if (!spec) return path[0] || null;
  const i = path.indexOf(spec);
  return i < 0 ? null : path[i + 1] || null;
}
export const inScope = (spec, path) => !spec || path.includes(spec);
export const underScope = (spec, key) => key === spec || String(key).startsWith(spec + "/");
const GROUP_NAME = { "rating:negative": "негатив (1–2)", "rating:middle": "середина (3–4)", "rating:positive": "позитив (5)" };
export function labelOf(key) {
  const [g, ...rest] = String(key).split("/");
  return [GROUP_NAME[g] || g, ...rest.map((x) => (x === "short" ? "короткие отзывы" : x === "long" ? "длинные отзывы" : `оценка ${x}`))].join(" / ");
}
export const reviewId = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
const clampRating = (x) => { const n = Math.round(Number(x)); return n >= 1 && n <= 5 ? n : null; };

const RUBRIC = `Ты читаешь отзывы клиентов об организациях (кафе, салоны, гостиницы, магазины, клиники и т. д.).
Для каждого отзыва определи, какую оценку от 1 до 5 поставил его автор. Учитывай, что люди часто ставят 3–4,
даже когда пишут вежливо, а 5 — когда пишут с явным восторгом; 1–2 — когда есть претензии без смягчения.`;

export function selectExamples(skills) {
  const all = Object.entries(skills?.blocks || {}).flatMap(([cat, b]) => (b.examples || []).map((e) => ({ ...e, cat })));
  return all.slice(-(skills?.limit ?? 8));
}

function prompt(skills, items) {
  const notes = [...(skills?.notes || []), ...Object.entries(skills?.blocks || {}).flatMap(([c, b]) => (b.notes || []).map((n) => `[${labelOf(c)}] ${n}`))];
  const ex = selectExamples(skills);
  const system = `${RUBRIC}${notes.length ? `\n\nПравила (выведены из прошлых ошибок):\n- ${notes.join("\n- ")}` : ""}${ex.length ? `\n\nПримеры (текст → оценка автора):\n${ex.map((e) => `«${e.text}» → ${e.rating}`).join("\n")}` : ""}`;
  const user = `TASK: rate\n` + items.map((r) => JSON.stringify({ id: r.id, text: String(r.text).slice(0, 1200) })).join("\n") + `\nВерни JSON-массив [{"id","rating"}] для каждого отзыва, rating — целое от 1 до 5.`;
  return { system, user };
}

// Интерпретатор: оценки отзывов с данными навыками (используют и агент, и оркестратор при проверке предложений)
// GEO_CONCURRENCY — сколько запросов к модели одновременно (по умолчанию 3)
// Ошибка формата ответа (не JSON) — это ответ модели: такие отзывы остаются без оценки. Остальные ошибки (бюджет исчерпан,
// сеть, лимит запросов после всех повторов) пробрасываются: раунд падает громко и повторяется, а не записывает пустые оценки.
const formatError = (e) => /не JSON/.test(String(e?.message));
const listOf = (res) => (Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : Object.values(res || {}).find(Array.isArray) || []).filter((x) => x && typeof x === "object");
export async function rate(llm, skills, items, { concurrency = Number(process.env.GEO_CONCURRENCY || 3) } = {}) {
  const parts = [];
  for (let i = 0; i < items.length; i += BATCH) parts.push(items.slice(i, i + BATCH));
  const results = new Array(parts.length);
  let next = 0;
  async function worker() {
    while (next < parts.length) {
      const k = next++, part = parts[k];
      const { system, user } = prompt(skills, part);
      let res = [];
      try { res = await llm.json(system, user, { maxTokens: 600 }); } catch (e) { if (!formatError(e)) throw e; res = []; }
      const byId = new Map(listOf(res).map((x) => [x.id, clampRating(x.rating)]));
      results[k] = part.map((r) => { const rating = byId.get(r.id) ?? null; return { id: r.id, rating, urgent: rating != null && rating <= 2 }; });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results.flat();
}

// Оценка навыков на размеченной выборке. items: [{id, text, rating, category}], category — по ИСТИННОЙ оценке
export async function evaluateSkills(llm, skills, items) {
  const preds = await rate(llm, skills, items);
  const P = new Map(preds.map((p) => [p.id, p.rating]));
  const per = {};
  let urgentOk = 0;
  for (const it of items) {
    const c = (per[it.category] ||= { ok: 0, n: 0 });
    c.n++; if (P.get(it.id) === it.rating) c.ok++;
    if ((P.get(it.id) != null && P.get(it.id) <= 2) === (it.rating <= 2)) urgentOk++;
  }
  const n = items.length, ok = Object.values(per).reduce((s, c) => s + c.ok, 0);
  return { overall: n ? ok / n : 0, categories: Object.fromEntries(Object.entries(per).map(([k, c]) => [k, c.n ? c.ok / c.n : 0])), urgent_accuracy: n ? urgentOk / n : 0, n, preds };
}

// Обучение на ошибках: ёмкость навыков ограничена (limit примеров на весь запрос)
export function learnFrom(skills, mistakes, { category, limit = skills.limit ?? 8 }) {
  const s = structuredClone(skills);
  s.limit = limit;
  const b = ((s.blocks ||= {})[category] ||= { examples: [], notes: [] });
  for (const m of [...mistakes].sort((a, b2) => (b2.error || 0) - (a.error || 0))) {
    if (b.examples.some((e) => e.id === m.id)) continue;
    b.examples.push({ id: m.id, text: String(m.text).slice(0, 300), rating: m.rating });
  }
  const total = () => Object.values(s.blocks).reduce((n, x) => n + x.examples.length, 0);
  while (total() > limit) { const big = Object.values(s.blocks).sort((a, b2) => b2.examples.length - a.examples.length)[0]; big.examples.shift(); }
  return s;
}
export const baseSkills = (limit = Number(process.env.SKILL_EXAMPLE_LIMIT || 8)) => ({ language: LANGUAGE, limit, notes: [], blocks: {} });

// ================= обучение правилами (GEO_LEARN=rules) =================
// Модель читает накопленные ошибки группы и переписывает короткие правила этой группы. Правила — данные навыка (block.notes),
// их видит тот же открытый интерпретатор; оркестратор проверяет их так же, как примеры.
export const RULES_LIMIT = Number(process.env.GEO_RULES_LIMIT || 6);
// Цель узла дерева: что именно он должен различать (оркестратор советует её, если узел не растёт)
export function objectiveFor(key) {
  const parts = String(key).split("/");
  const rating = parts.map(Number).find((x) => x >= 1 && x <= 5);
  if (rating) {
    const near = [rating - 1, rating + 1].filter((x) => x >= 1 && x <= 5);
    return `Ты специалист по отзывам с оценкой ${rating}. Каждое правило должно помогать отличить оценку ${rating} от ${near.join(" и ")}: укажи, по каким признакам это именно ${rating}, а когда автор поставил ${near.join(" или ")}. Не пиши правила «${Math.min(rating, near[0])}–${Math.max(rating, near.at(-1))}» — они не различают оценки.`;
  }
  const g = parts[0];
  return g === "rating:middle" ? "Ты специалист по оценкам 3–4. Каждое правило должно помогать отличить 3 от 4, а также середину от 2 и от 5."
    : g === "rating:negative" ? "Ты специалист по оценкам 1–2. Каждое правило должно помогать отличить 1 от 2, а также негатив от 3."
    : "Ты специалист по оценке 5. Каждое правило должно помогать отличить 5 от 4.";
}

// OPRO (Yang et al., 2023): модели показывают прошлые версии правил с их точностью на проверке (от худшей к лучшей)
// и просят несколько новых вариантов; агент проверяет каждый и оставляет лучший, если он значимо лучше текущего.
function historyText(history) {
  const h = (history || []).filter((x) => Array.isArray(x.rules) && x.rules.length).sort((a, b) => a.acc - b.acc);
  return h.length ? `Прошлые версии правил этой группы и их точность на проверке (от худшей к лучшей; пиши лучше лучшей, не повторяй худшие):\n` +
    h.map((x, i) => `Версия ${i + 1} — точность ${x.acc}%:\n${x.rules.map((r) => `  - ${r}`).join("\n")}`).join("\n") + "\n" : "";
}
const cleanRules = (list, limit) => (Array.isArray(list) ? list : []).filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim().slice(0, 200)).slice(0, limit);

export async function refineRulesCandidates(llm, skills, category, mistakes, { limit = RULES_LIMIT, objective = null, history = [], candidates = 1 } = {}) {
  const current = skills?.blocks?.[category]?.notes || [];
  const others = Object.entries(skills?.blocks || {}).filter(([c]) => c !== category).flatMap(([c, b]) => (b.notes || []).map((n) => `[${labelOf(c)}] ${n}`));
  const k = Math.max(1, Math.min(4, candidates));
  const system = `${RUBRIC}\n\nТы улучшаешь правила для группы «${labelOf(category)}». Ниже отзывы, где оценка агента разошлась с оценкой автора.
Найди общие закономерности и напиши до ${limit} коротких правил (до 200 символов каждое), которые помогут угадывать оценку автора.
Правила должны быть общими: про тон, формулировки, оговорки, жалобы, а не про конкретные организации. Не противоречь правилам других групп.${objective ? `\nЦель: ${objective}` : ""}
${k > 1 ? `Предложи ${k} разных варианта набора правил (разные гипотезы, а не перефразировки). Верни JSON {"candidates": [["…", "…"], ["…", "…"]]}.` : `Верни JSON {"rules": ["…", "…"]}.`}`;
  const user = `Текущие правила этой группы:\n${current.length ? current.map((r) => `- ${r}`).join("\n") : "(нет)"}\n` + historyText(history) +
    `${others.length ? `Правила других групп (для согласованности):\n${others.map((r) => `- ${r}`).join("\n")}\n` : ""}` +
    `Ошибки (текст → агент поставил / автор поставил):\n` + mistakes.map((m) => `«${String(m.text).slice(0, 300)}» → ${m.predicted ?? "?"} / ${m.rating}`).join("\n");
  let res;
  try { res = await llm.json(system, user, { maxTokens: 900 * k }); } catch { return []; }
  // варианты: [[…], […]] или [{rules: […]}]; плоский список строк — один вариант
  const cand = res?.candidates;
  const sets = Array.isArray(cand) && cand.length && cand.every((c) => typeof c === "string") ? [cleanRules(cand, limit)]
    : Array.isArray(cand) ? cand.map((c) => cleanRules(Array.isArray(c) ? c : c?.rules, limit)) : [cleanRules(Array.isArray(res) ? res : res?.rules, limit)];
  const seen = new Set();
  return sets.filter((r) => r.length && !seen.has(JSON.stringify(r)) && seen.add(JSON.stringify(r))).slice(0, k).map((rules) => {
    const s = structuredClone(skills);
    const b = ((s.blocks ||= {})[category] ||= { examples: [], notes: [] });
    b.notes = rules;
    return s;
  });
}
export async function refineRules(llm, skills, category, mistakes, opts = {}) {
  return (await refineRulesCandidates(llm, skills, category, mistakes, { ...opts, candidates: 1 }))[0] || null;
}

// ================= распределение как отдельный навык (GEO_ROUTER=1) =================
// Узел с потомками решает, кому передать отзыв, отдельным вопросом к модели со своими правилами распределения
// (skills.routing[ключ узла].notes). Передача — только если согласны два независимых ответа: собственная оценка узла
// и ответ маршрутизатора; при несогласии или «не уверен» узел оставляет отзыв себе (блокировка, Silla & Freitas, 2011).
// Варианты — следующий уровень дерева; если он определяется длиной текста, маршрутизатор не нужен (null).
export const routeKey = (spec) => spec || "root";
export function routeChoices(spec) {
  if (!spec) return [{ key: "rating:negative", label: "негатив: оценка 1 или 2" }, { key: "rating:middle", label: "середина: оценка 3 или 4" }, { key: "rating:positive", label: "позитив: оценка 5" }];
  if (spec === "rating:negative") return [{ key: "rating:negative/1", label: "оценка 1" }, { key: "rating:negative/2", label: "оценка 2" }];
  if (spec === "rating:middle") return [{ key: "rating:middle/3", label: "оценка 3" }, { key: "rating:middle/4", label: "оценка 4" }];
  return null;
}
function routePrompt(skills, spec, items, notesOverride = null) {
  const ch = routeChoices(spec);
  const notes = notesOverride ?? (skills?.routing?.[routeKey(spec)]?.notes || []);
  const system = `${RUBRIC}\n\nТвоя задача — распределение: для каждого отзыва выбери, к какой группе он относится${spec ? ` (все отзывы уже отнесены к группе «${labelOf(spec)}»)` : ""}.
Варианты:\n${ch.map((c, i) => `${i + 1} — ${c.label}`).join("\n")}\n0 — не уверен (отзыв на границе групп)
Выбирай 0, если признаки противоречат друг другу: такой отзыв оценит более общий агент.${notes.length ? `\n\nПравила распределения (выведены из прошлых ошибок):\n- ${notes.join("\n- ")}` : ""}`;
  const user = `TASK: route\n` + items.map((r) => JSON.stringify({ id: r.id, text: String(r.text).slice(0, 1200) })).join("\n") + `\nВерни JSON-массив [{"id","group"}], group — номер варианта (0–${ch.length}).`;
  return { system, user, ch };
}
export async function route(llm, skills, spec, items, { notes = null, concurrency = Number(process.env.GEO_CONCURRENCY || 3) } = {}) {
  if (!routeChoices(spec)) return items.map((r) => ({ id: r.id, key: null }));
  const parts = []; for (let i = 0; i < items.length; i += BATCH) parts.push(items.slice(i, i + BATCH));
  const results = new Array(parts.length); let next = 0;
  async function worker() {
    while (next < parts.length) {
      const k = next++, part = parts[k];
      const { system, user, ch } = routePrompt(skills, spec, part, notes);
      let res = [];
      try { res = await llm.json(system, user, { maxTokens: 400 }); } catch (e) { if (!formatError(e)) throw e; res = []; }
      const byId = new Map(listOf(res).map((x) => [x.id, Math.round(Number(x.group))]));
      results[k] = part.map((r) => { const g = byId.get(r.id); return { id: r.id, key: g >= 1 && g <= ch.length ? ch[g - 1].key : "unsure" }; });
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results.flat();
}
export async function refineRouting(llm, skills, spec, mistakes, { limit = RULES_LIMIT, history = [] } = {}) {
  const key = routeKey(spec), current = skills?.routing?.[key]?.notes || [];
  const ch = routeChoices(spec);
  const name = (k) => (k === "unsure" ? "не уверен" : ch.find((c) => c.key === k)?.label || k);
  const system = `${RUBRIC}\n\nТы улучшаешь правила распределения отзывов по группам: ${ch.map((c) => c.label).join("; ")}. Ниже отзывы, которые отправлены не в ту группу или оставлены как «не уверен».
Напиши до ${limit} коротких правил (до 200 символов каждое), по каким признакам отличать эти группы. Правила общие: тон, оговорки, сила претензий, восторг — не конкретные организации.
Верни JSON {"rules": ["…", "…"]}.`;
  const user = `Текущие правила распределения:\n${current.length ? current.map((r) => `- ${r}`).join("\n") : "(нет)"}\n` + historyText(history) +
    `Ошибки (текст → выбрано / верная группа):\n` + mistakes.map((m) => `«${String(m.text).slice(0, 300)}» → ${name(m.routed)} / ${name(m.truth)}`).join("\n");
  let res;
  try { res = await llm.json(system, user, { maxTokens: 900 }); } catch { return null; }
  const rules = cleanRules(Array.isArray(res) ? res : res?.rules, limit);
  if (!rules.length) return null;
  const s = structuredClone(skills);
  (s.routing ||= {})[key] = { notes: rules };
  return s;
}

// Точный двусторонний тест Макнемара для парного сравнения «до/после» на одних и тех же отзывах.
// b — было неверно, стало верно; c — было верно, стало неверно. p — вероятность получить такой перекос случайно.
export function mcnemar(b, c) {
  const n = b + c;
  if (!n) return 1;
  const k = Math.min(b, c);
  let logC = 0, sum = 0; // C(n,0)
  for (let i = 0; i <= k; i++) { if (i > 0) logC += Math.log(n - i + 1) - Math.log(i); sum += Math.exp(logC - n * Math.LN2); }
  return Math.min(1, 2 * sum);
}
export function pairedCompare(items, beforePreds, afterPreds) {
  const B = new Map(beforePreds.map((p) => [p.id, p.rating])), A = new Map(afterPreds.map((p) => [p.id, p.rating]));
  let b = 0, c = 0;
  for (const it of items) { const was = B.get(it.id) === it.rating, now = A.get(it.id) === it.rating; if (!was && now) b++; if (was && !now) c++; }
  return { b, c, n: items.length, gain_pp: Math.round((1000 * (b - c)) / items.length) / 10, p_value: Number(mcnemar(b, c).toPrecision(3)) };
}
