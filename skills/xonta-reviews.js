// Язык навыков «xonta-reviews/1»: оценка отзывов о товаре — относится ли отзыв к этой модели, насколько он полезен
// и есть ли признаки накрутки. Навык — ДАННЫЕ (заметки и примеры по категориям), интерпретатор — открытый шаблон запроса
// к модели ниже. Поэтому оркестратор оценивает предложения потомков сам, тем же интерпретатором, не запуская чужой код.
//
// «Достоверность» здесь — признаки накрутки, а не вердикт «отзыв фальшивый». Судья — более сильная модель с доступом
// ко всем отзывам о товаре сразу; его разметка служит эталоном для обучения и оценки. Судья — не истина: это записано в аттестатах.
import { createHash } from "node:crypto";

export const LANGUAGE = "xonta-reviews/1";
export const KIND = "llm";
export const DIMENSIONS = ["relevance", "informativeness", "authenticity"];
export const BATCH = 10;

const h = (x) => createHash("sha256").update(String(x)).digest("hex");
export const reviewId = (r) => h(`${r.platform}|${r.product_key}|${r.text}`).slice(0, 16);
const clamp = (x) => Math.max(0, Math.min(1, Number(x) || 0));

// ---------- признаки без модели: дубликаты, всплески дат, шаблонность ----------
const norm = (t) => String(t).toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, " ").replace(/\s+/g, " ").trim();
const shingles = (t) => { const w = norm(t).split(" "); const s = new Set(); for (let i = 0; i + 2 < w.length; i++) s.add(w.slice(i, i + 3).join(" ")); return s; };
export function features(reviews) {
  const sh = reviews.map((r) => shingles(r.text));
  const byDay = {};
  for (const r of reviews) if (r.date) byDay[r.date] = (byDay[r.date] || 0) + 1;
  return reviews.map((r, i) => {
    let dup = 0;
    for (let j = 0; j < reviews.length; j++) if (j !== i && sh[i].size && sh[j].size) {
      let inter = 0; for (const x of sh[i]) if (sh[j].has(x)) inter++;
      dup = Math.max(dup, inter / Math.min(sh[i].size, sh[j].size));
    }
    const words = norm(r.text).split(" ").filter(Boolean).length;
    return { near_duplicate: +dup.toFixed(2), same_day_reviews: r.date ? byDay[r.date] : null, words, rating: r.rating ?? null };
  });
}

// ---------- шаблоны запросов (открытые — часть языка) ----------
const RUBRIC = `Ты оцениваешь отзывы покупателей о конкретном товаре. Для каждого отзыва верни три числа от 0 до 1 и флаги:
- relevance — отзыв о ЭТОЙ модели (а не о доставке, магазине, другой модели или комплектации); 0 — не о товаре, 1 — точно о модели;
- informativeness — полезность для покупателя: конкретика, опыт использования, плюсы и минусы; 0 — пусто («всё супер»), 1 — подробный опыт;
- authenticity — нет признаков накрутки; 1 — признаков нет, 0 — явные признаки (шаблонный текст, дубли, восторг без конкретики при пятёрке, всплеск отзывов в один день, реклама, несоответствие оценки и текста).
flags — коды из списка: off_model, delivery_only, empty, template, duplicate, burst, rating_mismatch, ad, other_language.
Не делай выводов о личности автора. Не пиши имён.`;

export function selectExamples(skills, category, limit) {
  const own = skills?.blocks?.[category]?.examples || [];
  const other = Object.entries(skills?.blocks || {}).filter(([c]) => c !== category).flatMap(([, b]) => b.examples || []);
  return [...own, ...other].slice(0, limit ?? skills?.limit ?? 8);
}

function assessPrompt(skills, { product, category, reviews, feats }) {
  const notes = [...(skills?.notes || []), ...(skills?.blocks?.[category]?.notes || [])];
  const ex = selectExamples(skills, category);
  const system = `${RUBRIC}${notes.length ? `\n\nЗаметки:\n- ${notes.join("\n- ")}` : ""}${ex.length ? `\n\nПримеры верной разметки:\n${ex.map((e) => JSON.stringify({ product: e.product, review: e.review, label: e.label })).join("\n")}` : ""}`;
  const user = `TASK: assess\nТовар: ${product.title} (${product.model || "модель не указана"}); категория: ${category}\nОтзывы (JSON, с подсчитанными признаками):\n` +
    reviews.map((r, i) => JSON.stringify({ id: r.id, rating: r.rating, date: r.date, text: r.text.slice(0, 1200), signals: feats[i] })).join("\n") +
    `\nВерни JSON-массив [{"id","relevance","informativeness","authenticity","flags":[]}] для каждого отзыва.`;
  return { system, user };
}

// Интерпретатор: оценка отзывов с данными навыками. Используют и агент, и оркестратор (при проверке предложений).
export async function assess(llm, skills, { product, category, reviews }) {
  const out = [];
  const feats = features(reviews);
  for (let i = 0; i < reviews.length; i += BATCH) {
    const part = reviews.slice(i, i + BATCH);
    const { system, user } = assessPrompt(skills, { product, category, reviews: part, feats: feats.slice(i, i + BATCH) });
    const res = await llm.json(system, user, { maxTokens: 1500 });
    const byId = new Map((Array.isArray(res) ? res : res.items || []).map((x) => [x.id, x]));
    for (const r of part) {
      const x = byId.get(r.id) || {};
      out.push({ id: r.id, relevance: clamp(x.relevance), informativeness: clamp(x.informativeness), authenticity: clamp(x.authenticity), flags: Array.isArray(x.flags) ? x.flags.slice(0, 6) : [] });
    }
  }
  return out;
}

// Судья: сильная модель, видит все отзывы о товаре сразу и более строгую инструкцию
export async function judge(llm, { product, category, reviews }) {
  const feats = features(reviews);
  const system = `${RUBRIC}\n\nТы — проверяющий. Будь строг и последователен. Ты видишь все отзывы о товаре сразу: сравнивай их между собой (одинаковые обороты, серии в один день, отзывы о другой модели из той же карточки).`;
  const out = [];
  for (let i = 0; i < reviews.length; i += 20) {
    const part = reviews.slice(i, i + 20);
    const user = `TASK: judge\nТовар: ${product.title} (${product.model || "—"}); категория: ${category}\nВсего отзывов о товаре: ${reviews.length}\n` +
      part.map((r, k) => JSON.stringify({ id: r.id, rating: r.rating, date: r.date, text: r.text.slice(0, 1500), signals: feats[i + k] })).join("\n") +
      `\nВерни JSON-массив [{"id","relevance","informativeness","authenticity","flags":[]}].`;
    const res = await llm.json(system, user, { maxTokens: 3000 });
    const byId = new Map((Array.isArray(res) ? res : res.items || []).map((x) => [x.id, x]));
    for (const r of part) { const x = byId.get(r.id); if (x) out.push({ id: r.id, relevance: clamp(x.relevance), informativeness: clamp(x.informativeness), authenticity: clamp(x.authenticity), flags: Array.isArray(x.flags) ? x.flags.slice(0, 6) : [] }); }
  }
  return out;
}

// Извлечение отзывов из текста страницы (разметка у площадок разная и меняется — поэтому моделью, а не селекторами)
export async function extract(llm, { product, platform, text, data }) {
  const system = `Из текста страницы площадки «${platform}» извлеки отзывы покупателей о товаре. Не выдумывай: только то, что есть в тексте. Имена и ники авторов НЕ включай.`;
  const user = `TASK: extract\nТовар: ${product.title} (${product.model || "—"})\n${data ? `Данные страницы (JSON):\n${data.slice(0, 15000)}\n` : ""}Текст страницы:\n${text}\n\nВерни JSON-массив [{"rating": число 1–5 или null, "date": "YYYY-MM-DD" или null, "text": "текст отзыва вместе с достоинствами и недостатками", "variant": "модель/комплектация, если указана, иначе null"}]. Если отзывов нет — [].`;
  const res = await llm.json(system, user, { maxTokens: 4000 });
  return (Array.isArray(res) ? res : res.reviews || []).filter((r) => r && typeof r.text === "string" && r.text.trim().length >= 3)
    .map((r) => ({ rating: Number.isFinite(Number(r.rating)) ? Number(r.rating) : null, date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || "") ? r.date : null, text: r.text.trim().slice(0, 4000), variant: r.variant || null }));
}

// ---------- метрика согласия с судьёй ----------
export function agrees(p, l) {
  return Math.abs(p.relevance - l.relevance) <= 0.25 && Math.abs(p.informativeness - l.informativeness) <= 0.25 && (p.authenticity >= 0.5) === (l.authenticity >= 0.5);
}
export function score(preds, labels) {
  const L = new Map(labels.map((l) => [l.id, l]));
  let ok = 0, n = 0, trustOk = 0, mae = 0;
  for (const p of preds) { const l = L.get(p.id); if (!l) continue; n++; if (agrees(p, l)) ok++; if ((p.authenticity >= 0.5) === (l.authenticity >= 0.5)) trustOk++; mae += DIMENSIONS.reduce((s, d) => s + Math.abs(p[d] - l[d]), 0) / 3; }
  return { n, agreement: n ? ok / n : 0, trust_accuracy: n ? trustOk / n : 0, mae: n ? mae / n : 0 };
}

// Оценка навыков на размеченной выборке (используется оркестратором). items: [{product, category, review, label}]
export async function evaluateSkills(llm, skills, items) {
  const groups = new Map();
  for (const it of items) { const k = `${it.category}|${it.product.key}`; (groups.get(k) || groups.set(k, { product: it.product, category: it.category, items: [] }).get(k)).items.push(it); }
  const per = {};
  const preds = [];
  for (const g of groups.values()) {
    const p = await assess(llm, skills, { product: g.product, category: g.category, reviews: g.items.map((x) => x.review) });
    preds.push(...p);
    const s = score(p, g.items.map((x) => x.label));
    const c = (per[g.category] ||= { ok: 0, n: 0 });
    c.ok += s.agreement * s.n; c.n += s.n;
  }
  const n = Object.values(per).reduce((s, c) => s + c.n, 0), ok = Object.values(per).reduce((s, c) => s + c.ok, 0);
  return { overall: n ? ok / n : 0, categories: Object.fromEntries(Object.entries(per).map(([k, c]) => [k, c.n ? c.ok / c.n : 0])), n, preds };
}

// ---------- обучение на расхождениях с судьёй ----------
// Ёмкость навыков ограничена (limit примеров на весь запрос): у одного агента на все категории, у специалиста — на свою.
export function learnFrom(skills, mistakes, { category, limit = skills.limit ?? 8 }) {
  const s = structuredClone(skills);
  s.limit = limit;
  const b = ((s.blocks ||= {})[category] ||= { examples: [], notes: [] });
  // сначала самые грубые расхождения
  const worst = [...mistakes].sort((a, b2) => b2.error - a.error);
  for (const m of worst) {
    if (b.examples.some((e) => e.id === m.review.id)) continue;
    b.examples.push({ id: m.review.id, product: m.product.title, review: { rating: m.review.rating, text: m.review.text.slice(0, 500) }, label: { relevance: m.label.relevance, informativeness: m.label.informativeness, authenticity: m.label.authenticity, flags: m.label.flags } });
  }
  // общий лимит: удаляем самые старые примеры из самой большой категории
  const total = () => Object.values(s.blocks).reduce((n, x) => n + x.examples.length, 0);
  while (total() > limit) {
    const big = Object.values(s.blocks).sort((a, b2) => b2.examples.length - a.examples.length)[0];
    big.examples.shift();
  }
  return s;
}
export const baseSkills = (limit = Number(process.env.SKILL_EXAMPLE_LIMIT || 8)) => ({ language: LANGUAGE, limit, notes: [], blocks: {} });

// Сводка для покупателя по одному товару
export function summarize(product, reviews, assessed) {
  const A = new Map(assessed.map((a) => [a.id, a]));
  const rows = reviews.map((r) => ({ ...r, ...A.get(r.id) })).filter((r) => r.relevance !== undefined);
  const relevant = rows.filter((r) => r.relevance >= 0.5);
  const trusted = relevant.filter((r) => r.authenticity >= 0.5);
  const flags = {};
  for (const r of rows) for (const f of r.flags || []) flags[f] = (flags[f] || 0) + 1;
  const avg = (xs) => (xs.length ? +(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(2) : null);
  return {
    product: product.title, model: product.model, reviews_total: rows.length,
    about_this_model: relevant.length, without_signs_of_manipulation: trusted.length,
    trust_share: relevant.length ? +(trusted.length / relevant.length).toFixed(2) : null,
    rating_all: avg(rows.map((r) => r.rating).filter((x) => x != null)), rating_trusted: avg(trusted.map((r) => r.rating).filter((x) => x != null)),
    flags, most_useful: [...trusted].sort((a, b) => b.informativeness - a.informativeness).slice(0, 3).map((r) => ({ platform: r.platform, rating: r.rating, date: r.date, text: r.text.slice(0, 300) })),
    note: "Оценка — признаки накрутки и полезности по мнению модели, а не вердикт о подлинности отзыва.",
  };
}
