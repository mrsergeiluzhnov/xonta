// Чувствительность данных, аудитория, обратимость (0.18). Чистые функции без сети и без состояния — их использует Xonta Gate.
//
// Откуда это. ИИ-агент отправил личный финансовый отчёт пользователя в общий рабочий канал (новость на Хабре, октябрь 2026).
// Ошибка — смешение пользователей и аудиторий: данные одного человека ушли туда, где их видят больше людей, чем должно.
//
// Модель.
//  - Уровни данных: 0 публичное, 1 рабочее, 2 личное, 3 закрытое, 4 секрет.
//  - Аудитория получателя: A владелец/инициатор, B один человек, C небольшая группа, D широкая (вся компания), E внешний мир.
//  - Категория обращения (общее, рабочее, персональные данные клиентов, финансы, кадры и юридическое, здоровье, дети, секреты):
//    заявляется на каждое обращение и задаёт минимальный уровень и свои правила. Заявленная категория только ужесточает.
//  - Инициатор — цепочка: люди и агенты. Итоговый допуск — минимум по цепочке; неизвестное звено — посторонний (допуск 0).
//  - Уровень данных — наибольший из: заявленной категории, источников, прочитанных в этой задаче, и того, что видно в самом тексте.
//    Метка агента может только поднять уровень.
//  - Обратимость действия: 0 обратимо (черновик, метка), 1 исправимо с затратами (возврат), 2 необратимо (отправка наружу,
//    раскрытие, платёж, удаление). Хорошая история агента не расширяет права на необратимое.
// Решение: allow, human (нужен человек) или deny (никогда). Причину видит только владелец, агенту — общее «нужен человек».

export const LEVEL = { public: 0, work: 1, personal: 2, restricted: 3, secret: 4 };
export const LEVEL_NAME = ["public", "work", "personal", "restricted", "secret"];
export const AUD = { A: 0, B: 1, C: 2, D: 3, E: 4 };
export const AUD_NAME = ["A", "B", "C", "D", "E"];
// до какой аудитории данные уровня можно отправить без человека
export const MAX_AUDIENCE = [AUD.E, AUD.D, AUD.B, AUD.A, -1];
export const CATEGORIES = {
  general: { level: 0 }, work: { level: 1 }, customer_pd: { level: 2 }, finance: { level: 3 }, hr_legal: { level: 3 },
  health: { level: 3 }, children: { level: 3 }, secrets: { level: 4 },
};
// правила категорий по умолчанию: владелец может только ужесточить
export const CATEGORY_RULES = {
  general: { actions_per_period: null, max_audience: AUD.E, human_only: false, mismatch_to_freeze: 5 },
  work: { actions_per_period: null, max_audience: AUD.D, human_only: false, mismatch_to_freeze: 5 },
  customer_pd: { actions_per_period: 10, max_audience: AUD.B, human_only: false, mismatch_to_freeze: 3 },
  finance: { actions_per_period: 3, max_audience: AUD.A, human_only: false, mismatch_to_freeze: 2 },
  hr_legal: { actions_per_period: 3, max_audience: AUD.A, human_only: false, mismatch_to_freeze: 2 },
  health: { actions_per_period: 0, max_audience: AUD.A, human_only: true, mismatch_to_freeze: 1 },
  children: { actions_per_period: 0, max_audience: AUD.A, human_only: true, mismatch_to_freeze: 1 },
  secrets: { actions_per_period: 0, max_audience: -1, human_only: true, mismatch_to_freeze: 1 },
};
export const REV = { reversible: 0, fixable: 1, irreversible: 2 };
const REV_WORDS = [
  [/(^|[_\-.])(draft|label|tag|note|annotate|bookmark|star|pin|preview|stage|save_draft)([_\-.]|$)/i, REV.reversible],
  [/(^|[_\-.])(refund|update|edit|modify|reschedule|rename|move|assign|archive|close)([_\-.]|$)/i, REV.fixable],
  [/(^|[_\-.])(send|post|reply|publish|share|pay|payment|transfer|charge|purchase|buy|delete|destroy|drop|invite|email|message|comment|upload|merge|deploy|push)([_\-.]|$)/i, REV.irreversible],
];
// класс обратимости по имени инструмента; неизвестное — необратимо. Настройка владельца и обстоятельства могут только поднять
export function reversibilityOf(name, cfg = {}) {
  if (cfg.reversibility != null) return Math.max(REV[cfg.reversibility] ?? 2, 0);
  for (const [re, v] of [...REV_WORDS].reverse()) if (re.test(name)) return v; // сначала самые строгие слова
  return REV.irreversible;
}

// ---------- текст: нормализация и признаки ----------
const ZW = /[​-‍⁠﻿­]/g;
export function normalize(text) {
  let s = String(text ?? "").normalize("NFKC").replace(ZW, "");
  // раскодировать длинные base64-куски и приписать их к тексту: закодированный номер карты тоже проверяется
  const decoded = [];
  for (const m of s.match(/[A-Za-z0-9+/]{24,}={0,2}/g) || []) { try { const d = Buffer.from(m, "base64").toString("utf8"); if (/^[\x09\x0A\x0D\x20-\x7EЀ-ӿ]{8,}$/.test(d)) decoded.push(d); } catch {} }
  const all = [s, ...decoded].join("\n"), digits = all.replace(/(\d)[ \t\-.]+(?=\d)/g, "$1"); // 4111 1111-1111.1111 → 4111111111111111
  return { text: s, joined: [all, digits].join("\n"), base64_blobs: decoded.length, long_opaque: (s.match(/[A-Za-z0-9+/=_-]{120,}/g) || []).length };
}
const luhn = (d) => { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; } return s % 10 === 0; };
const FIN_WORDS = /(отч[её]т|баланс|выписк|зарплат|оклад|доход|расход|прибыл|убыт|налог|счёт|счет|invoice|salary|payroll|balance|statement|revenue|profit|loss|p&l|tax|budget|бюджет)/i;
const MONEY = /(\d[\d\s.,]{2,}\s?(₽|руб|rub|\$|usd|€|eur|£)|(\$|€|£)\s?\d[\d,]{2,})/i;
const HEALTH = /(диагноз|анализ|больнич|рецепт|лечени|заболеван|diagnos|prescription|medical|patient|treatment|blood test|hiv|вич)/i;
const CHILD = /(реб[её]н|дет(и|ей|ский)|школьник|несовершеннолет|child(ren)?|minor|kid\b|pupil)/i;
const HR = /(увольнени|приказ о|трудов(ой|ого) договор|дисциплинар|служебн(ая|ой) записк|termination|disciplinary|employment contract|severance|lawsuit|иск\b|претензи)/i;
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\b(sk|pk|rk)[-_](live|test|proj)?[-_]?[A-Za-z0-9]{20,}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, /\b(password|passwd|пароль|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/i,
];
// что видно в самом тексте: уровень и виды признаков (для владельца; агенту не показываются)
export function detect(raw) {
  const n = normalize(raw), t = n.joined, kinds = new Set();
  let level = 0;
  const up = (l, k) => { if (l > level) level = l; kinds.add(k); };
  if (SECRET.some((re) => re.test(t))) up(4, "secret");
  for (const m of t.match(/\b\d{13,19}\b/g) || []) if (luhn(m)) up(3, "card_number");
  if (/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/.test(t)) up(3, "iban");
  if (/\b\d{20}\b/.test(t) && /(сч[её]т|р\/с|account)/i.test(t)) up(3, "bank_account");
  if (/(паспорт|passport)/i.test(t) && /\b\d{4}\s?\d{6}\b/.test(t)) up(3, "passport");
  if (/\b\d{3}-\d{3}-\d{3}\s?\d{2}\b/.test(t)) up(3, "snils");
  if (MONEY.test(t) && FIN_WORDS.test(t)) up(3, "financial");
  if (HEALTH.test(t)) up(3, "health");
  if (HR.test(t)) up(3, "hr_legal");
  if (CHILD.test(t)) up(2, "child");
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(t) || /(\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/.test(t)) up(2, "contact");
  if (n.base64_blobs || n.long_opaque) kinds.add("encoded");
  return { level, kinds: [...kinds], encoded: n.base64_blobs + n.long_opaque > 0 };
}

// ---------- решение по отправке ----------
// chainClearance: допуск каждого звена цепочки инициаторов (неизвестное — 0); итог — минимум
export function effectiveClearance(chain = [], { users = {}, agents = {} } = {}) {
  if (!chain.length) return { clearance: 0, unknown: ["no initiator"] };
  let c = 4; const unknown = [];
  for (const x of chain) {
    let v = null;
    if (x.type === "human") { const u = users[x.id]; v = u && (!u.token_hash || u.token_hash === x.token_hash) ? u.clearance ?? 0 : null; }
    else if (x.type === "agent") { const a = agents[x.did || x.id]; v = a ? a.clearance ?? 0 : null; }
    if (v == null) { unknown.push(x.id || x.did || "?"); v = 0; }
    c = Math.min(c, v);
  }
  return { clearance: c, unknown };
}

// главное: можно ли эту отправку сделать без человека
// in: { name, cfg, content, recipient, recipientCfg, declared, sourceLevel, chain, dir, profile, categoryRules, subjectOf }
// что увидено в тексте → какой категории это соответствует (правила этой категории применяются, даже если заявлено «общее»)
export const KIND_CATEGORY = { secret: "secrets", card_number: "finance", iban: "finance", bank_account: "finance", financial: "finance", passport: "customer_pd", snils: "customer_pd", health: "health", hr_legal: "hr_legal", child: "children", contact: "customer_pd" };
export function decideSend(input) {
  const { content = "", sourceLevel = 0, recipient = null, recipientCfg = null, chain = [], dir = {}, categoryRules = CATEGORY_RULES } = input;
  const declared = input.declared in CATEGORIES ? input.declared : "general";
  const det = detect(content), declaredLevel = CATEGORIES[declared].level;
  // категория для правил — самая строгая из заявленной, категории источника и увиденного в тексте
  const cands = [declared, input.sourceCategory, ...det.kinds.map((k) => KIND_CATEGORY[k])].filter((c) => c && CATEGORIES[c]);
  const strictCat = cands.sort((a, b) => CATEGORIES[b].level - CATEGORIES[a].level || (CATEGORY_RULES[a].max_audience - CATEGORY_RULES[b].max_audience))[0] || declared;
  // уровень: наибольший; профиль организации/пользователя задаёт нижнюю границу
  const floor = Math.max(0, ...(input.floors || []));
  const level = Math.max(declaredLevel, sourceLevel, det.level, floor);
  const mismatch = declaredLevel < Math.max(sourceLevel, det.level) || (CATEGORIES[strictCat].level > declaredLevel);
  const audience = recipientCfg?.audience != null ? AUD[recipientCfg.audience] ?? AUD.E : AUD.E; // неизвестный получатель — внешний мир
  const recClear = recipientCfg?.clearance ?? (audience === AUD.E ? 0 : 1);
  const { clearance: chainClear, unknown } = effectiveClearance(chain, dir);
  const cat = strictCat, own = categoryRules[cat] || {}, base = CATEGORY_RULES[cat];
  // владелец может только ужесточить: меньше действий, уже аудитория, «только человек»
  const rules = { ...base, actions_per_period: own.actions_per_period != null ? (base.actions_per_period == null ? own.actions_per_period : Math.min(base.actions_per_period, own.actions_per_period)) : base.actions_per_period, max_audience: own.max_audience != null ? Math.min(base.max_audience, AUD[own.max_audience] ?? own.max_audience) : base.max_audience, human_only: base.human_only || !!own.human_only, mismatch_to_freeze: Math.min(base.mismatch_to_freeze, own.mismatch_to_freeze ?? Infinity) };
  const reasons = [];
  let verdict = "allow";
  const need = (why) => { reasons.push(why); if (verdict === "allow") verdict = "human"; };
  if (level >= LEVEL.secret) { verdict = "deny"; reasons.push("secret never leaves"); }
  if (verdict !== "deny") {
    if (level > chainClear) need(`data level ${LEVEL_NAME[level]} is above the initiator chain clearance ${chainClear}${unknown.length ? ` (unknown: ${unknown.join(", ")})` : ""}`);
    if (level > recClear) need(`data level ${LEVEL_NAME[level]} is above the recipient's clearance ${recClear}`);
    if (audience > MAX_AUDIENCE[level]) need(`audience ${AUD_NAME[audience]} is wider than allowed for ${LEVEL_NAME[level]} (up to ${AUD_NAME[Math.max(0, MAX_AUDIENCE[level])]})`);
    if (audience > rules.max_audience) need(`category ${cat} allows audience up to ${AUD_NAME[Math.max(0, rules.max_audience)]}`);
    if (rules.human_only) need(`category ${cat} is human only`);
    if (level === LEVEL.personal && audience >= AUD.B && !(recipientCfg?.spaces_of || []).some((u) => chain.some((x) => x.id === u))) need("personal data goes only to the person or the initiator's own space");
    if (det.encoded && audience >= AUD.C) need("encoded content to a wide audience");
    if (input.reversibility === REV.irreversible && level >= LEVEL.personal && audience > AUD.A) need("irreversible action with sensitive data");
  }
  return { verdict, level, level_name: LEVEL_NAME[level], audience: AUD_NAME[audience], chain_clearance: chainClear, unknown_initiators: unknown, mismatch, declared, detected: det.kinds, reasons, category: cat, rules };
}
