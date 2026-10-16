// Язык навыков «xonta-normalize/1»: нормализация данных в четырёх категориях — даты, единицы, телефоны, суммы.
// Навык — это ДАННЫЕ (декларативное правило), а не код: оркестратор оценивает предложения потомков сам,
// тем же открытым интерпретатором, не запуская чужой код.
//
// Правило привязано к «сигнатуре» входа — форме строки (цифры и слова заменены метками) плюс локаль/страна.
// Агент выводит правило из примеров: перебирает конечное множество гипотез и оставляет те, что объясняют примеры.

export const LANGUAGE = "xonta-normalize/1";
export const CATEGORIES = ["dates", "units", "phones", "money"];

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = new RegExp(`\\b(${MONTHS.join("|")}|${MONTHS.map((m) => m.slice(0, 3)).join("|")})\\b`, "i");
const pad = (n, w = 2) => String(n).padStart(w, "0");

// ---------- сигнатуры ----------
function dateTokens(text) {
  const out = [];
  const re = new RegExp(`\\d+|${MONTH_RE.source}`, "gi");
  for (const m of text.matchAll(re)) {
    if (/^\d+$/.test(m[0])) out.push(Number(m[0]));
    else out.push(MONTHS.findIndex((x) => x.startsWith(m[0].toLowerCase().slice(0, 3))) + 1);
  }
  return out;
}
function dateShape(text) {
  return text.replace(new RegExp(MONTH_RE.source, "gi"), "M").replace(/\d{4}/g, "Y").replace(/\d{1,2}/g, "N");
}
const moneyShape = (text) => text.replace(/\d+/g, "9");

export function signature(task) {
  const { category, input } = task;
  if (category === "dates") return `${dateShape(input.text)}|${input.locale}`;
  if (category === "units") return (input.text.match(/[a-zA-Z°]+\s*$/)?.[0] || "").trim().toLowerCase();
  if (category === "phones") return input.country;
  if (category === "money") return moneyShape(input.text);
  return "";
}
// запасная сигнатура с любой локалью (для однозначных форматов вроде ISO)
const wildcard = (task) => (task.category === "dates" ? `${dateShape(task.input.text)}|*` : null);

// ---------- интерпретатор ----------
function applyRule(category, rule, input) {
  if (category === "dates") {
    const t = dateTokens(input.text);
    if (t.length !== 3 || !rule.order) return null;
    const v = Object.fromEntries(rule.order.map((k, i) => [k, t[i]]));
    if (!(v.m >= 1 && v.m <= 12 && v.d >= 1 && v.d <= 31 && v.y >= 1000)) return null;
    return `${v.y}-${pad(v.m)}-${pad(v.d)}`;
  }
  if (category === "units") {
    const m = input.text.match(/^\s*([\d.]+)\s*/);
    if (!m) return null;
    const val = Number(m[1]) * rule.factor;
    return `${Number(val.toFixed(3))} ${rule.unit}`;
  }
  if (category === "phones") {
    let digits = input.text.replace(/\D/g, "");
    if (rule.strip && digits.startsWith(rule.strip)) digits = digits.slice(rule.strip.length);
    return `+${rule.cc}${digits}`;
  }
  if (category === "money") {
    let s = input.text.replace(/[^\d.,]/g, "");
    let num;
    if (rule.dec) {
      const i = s.lastIndexOf(rule.dec);
      const intPart = (i >= 0 ? s.slice(0, i) : s).replace(/\D/g, "");
      const frac = i >= 0 ? s.slice(i + 1).replace(/\D/g, "") : "";
      num = Number(`${intPart}.${frac || "0"}`);
    } else num = Number(s.replace(/\D/g, ""));
    if (!Number.isFinite(num)) return null;
    return `${num.toFixed(rule.decimals)} ${rule.currency}`;
  }
  return null;
}

// skills: { [category]: { [signature]: rule } }
export function solve(skills, task) {
  const cat = skills?.[task.category] || {};
  const sig = signature(task);
  const rule = cat[sig] || (wildcard(task) && cat[wildcard(task)]);
  if (!rule) return null;
  try { return applyRule(task.category, rule, task.input); } catch { return null; }
}

// ---------- гипотезы для вывода правил ----------
const PERMS = [["d", "m", "y"], ["m", "d", "y"], ["y", "m", "d"], ["y", "d", "m"], ["d", "y", "m"], ["m", "y", "d"]];
function candidates(category, input, expected) {
  if (category === "dates") return PERMS.map((order) => ({ order }));
  if (category === "units") {
    const m = input.text.match(/^\s*([\d.]+)/), e = String(expected).match(/^([\d.]+)\s+(\S+)$/);
    if (!m || !e || Number(m[1]) === 0) return [];
    return [{ factor: Number((Number(e[1]) / Number(m[1])).toPrecision(6)), unit: e[2] }];
  }
  if (category === "phones") {
    const digits = input.text.replace(/\D/g, ""), exp = String(expected).replace(/\D/g, "");
    const out = [];
    for (const strip of ["", "0"]) {
      const rest = strip && digits.startsWith(strip) ? digits.slice(strip.length) : strip ? null : digits;
      if (rest && exp.endsWith(rest) && exp.length > rest.length) out.push({ cc: exp.slice(0, exp.length - rest.length), strip });
    }
    return out;
  }
  if (category === "money") {
    const e = String(expected).match(/^(\d+)(?:\.(\d+))?\s+([A-Z]{3})$/);
    if (!e) return [];
    const decimals = e[2] ? e[2].length : 0;
    return [".", ",", null].map((dec) => ({ dec, currency: e[3], decimals }));
  }
  return [];
}
const sameRule = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Вывод правила для сигнатуры по накопленным примерам. Устойчив к редким ошибкам в данных:
// правило принимается, если объясняет не меньше 2 примеров и не меньше 70% из них.
export function induce(category, examples) {
  if (category === "units") return induceUnit(examples);
  const pool = [];
  for (const ex of examples) for (const c of candidates(category, ex.input, ex.expected)) if (!pool.some((p) => sameRule(p, c))) pool.push(c);
  let best = null;
  for (const c of pool) {
    const support = examples.filter((ex) => applyRule(category, c, ex.input) === ex.expected).length;
    if (!best || support > best.support) best = { rule: c, support };
  }
  if (!best || best.support < 2 || best.support / examples.length < 0.7) return null;
  return best.rule;
}

// Единицы: эталон округлён до 0,001, поэтому каждый пример задаёт не коэффициент, а интервал допустимых коэффициентов.
// Пересекаем интервалы (начиная с самых точных — больших значений), пропуская несовместимые (вероятный шум).
function induceUnit(examples) {
  const iv = [];
  for (const ex of examples) {
    const m = ex.input.text.match(/^\s*([\d.]+)/), e = String(ex.expected).match(/^([\d.]+)\s+(\S+)$/);
    if (!m || !e || Number(m[1]) === 0) continue;
    const v = Number(m[1]), out = Number(e[1]);
    iv.push({ lo: (out - 0.0005) / v, hi: (out + 0.0005) / v, unit: e[2], v });
  }
  if (iv.length < 2) return null;
  const byUnit = {};
  for (const x of iv) (byUnit[x.unit] ||= []).push(x);
  const [unit, list] = Object.entries(byUnit).sort((a, b) => b[1].length - a[1].length)[0];
  list.sort((a, b) => b.v - a.v);
  let lo = list[0].lo, hi = list[0].hi;
  for (const x of list.slice(1)) if (Math.max(lo, x.lo) <= Math.min(hi, x.hi)) { lo = Math.max(lo, x.lo); hi = Math.min(hi, x.hi); }
  // из всех коэффициентов в интервале берём самый короткий десятичный (0.3048, а не 0.30479871): так правило точнее на новых значениях
  const mid = (lo + hi) / 2;
  let factor = Number(mid.toPrecision(10));
  for (let p = 1; p <= 10; p++) { const c = Number(mid.toPrecision(p)); if (c >= lo && c <= hi) { factor = c; break; } }
  const rule = { factor, unit };
  const support = examples.filter((ex) => applyRule("units", rule, ex.input) === ex.expected).length;
  if (support < 2 || support / examples.length < 0.7) return null;
  return rule;
}

// ---------- генератор задач (агент-генератор) ----------
// Шаблоны появляются по раундам — так моделируется сдвиг распределения: агенту постоянно встречается новое.
const COUNTRIES = { US: ["1", ""], GB: ["44", "0"], DE: ["49", "0"], FR: ["33", "0"], JP: ["81", "0"] };
const UNITS = { m: [1, "m"], kg: [1, "kg"], l: [1, "l"], km: [1000, "m"], g: [0.001, "kg"], cm: [0.01, "m"], mm: [0.001, "m"], ml: [0.001, "l"],
  ft: [0.3048, "m"], in: [0.0254, "m"], lb: [0.45359237, "kg"], mi: [1609.344, "m"], oz: [0.028349523, "kg"], yd: [0.9144, "m"], gal: [3.785411784, "l"] };

export const PATTERNS = [
  // dates
  { id: "date-iso", category: "dates", from: 0 }, { id: "date-us-slash", category: "dates", from: 1 }, { id: "date-gb-slash", category: "dates", from: 1 },
  { id: "date-de-dot", category: "dates", from: 3 }, { id: "date-us-long", category: "dates", from: 3 }, { id: "date-gb-long", category: "dates", from: 5 }, { id: "date-jp", category: "dates", from: 7 },
  // units
  { id: "unit-base", category: "units", from: 0 }, { id: "unit-metric", category: "units", from: 1 }, { id: "unit-imperial", category: "units", from: 3 },
  { id: "unit-imperial2", category: "units", from: 5 }, { id: "unit-gal", category: "units", from: 7 },
  // phones
  { id: "phone-US", category: "phones", from: 0 }, { id: "phone-GB", category: "phones", from: 1 }, { id: "phone-DE", category: "phones", from: 3 },
  { id: "phone-FR", category: "phones", from: 5 }, { id: "phone-JP", category: "phones", from: 7 },
  // money
  { id: "money-usd", category: "money", from: 0 }, { id: "money-eur", category: "money", from: 1 }, { id: "money-gbp", category: "money", from: 3 },
  { id: "money-sek", category: "money", from: 5 }, { id: "money-jpy", category: "money", from: 7 },
];

const ri = (r, a, b) => a + Math.floor(r() * (b - a + 1));
function makeTask(pattern, r) {
  const id = pattern.id;
  if (pattern.category === "dates") {
    const y = ri(r, 2000, 2030), m = ri(r, 1, 12), d = ri(r, 1, 28), iso = `${y}-${pad(m)}-${pad(d)}`, M = MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1);
    const loc = ["en-US", "en-GB", "de-DE", "fr-FR"][ri(r, 0, 3)];
    const map = {
      "date-iso": [iso, loc], "date-us-slash": [`${pad(m)}/${pad(d)}/${y}`, "en-US"], "date-gb-slash": [`${pad(d)}/${pad(m)}/${y}`, "en-GB"],
      "date-de-dot": [`${pad(d)}.${pad(m)}.${y}`, "de-DE"], "date-us-long": [`${M} ${d}, ${y}`, "en-US"], "date-gb-long": [`${d} ${M} ${y}`, "en-GB"], "date-jp": [`${y}年${m}月${d}日`, "ja-JP"],
    };
    const [text, locale] = map[id];
    return { category: "dates", pattern: id, input: { text, locale }, expected: iso };
  }
  if (pattern.category === "units") {
    const sets = { "unit-base": ["m", "kg", "l", "km", "g"], "unit-metric": ["cm", "mm", "ml"], "unit-imperial": ["ft", "in", "lb"], "unit-imperial2": ["mi", "oz", "yd"], "unit-gal": ["gal"] };
    const u = sets[id][ri(r, 0, sets[id].length - 1)], v = ri(r, 1, 999);
    const [f, si] = UNITS[u];
    return { category: "units", pattern: id, input: { text: `${v} ${u}` }, expected: `${Number((v * f).toFixed(3))} ${si}` };
  }
  if (pattern.category === "phones") {
    const c = id.slice(6), [cc, trunk] = COUNTRIES[c];
    const n = Array.from({ length: c === "US" ? 10 : c === "FR" ? 9 : 10 }, (_, i) => (i === 0 ? ri(r, 2, 9) : ri(r, 0, 9))).join("");
    const fmt = { US: `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`, GB: `0${n.slice(0, 2)} ${n.slice(2, 6)} ${n.slice(6)}`, DE: `0${n.slice(0, 2)} ${n.slice(2)}`,
      FR: `0${n.slice(0, 1)} ${n.slice(1, 3)} ${n.slice(3, 5)} ${n.slice(5, 7)} ${n.slice(7)}`, JP: `0${n.slice(0, 1)}-${n.slice(1, 5)}-${n.slice(5)}` }[c];
    return { category: "phones", pattern: id, input: { text: fmt, country: c }, expected: `+${cc}${n}` };
  }
  const intv = ri(r, 1, 999999), cents = ri(r, 0, 99), grp = (x, sep) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const m = {
    "money-usd": [`$${grp(intv, ",")}.${pad(cents)}`, `${intv}.${pad(cents)} USD`], "money-eur": [`${grp(intv, ".")},${pad(cents)} €`, `${intv}.${pad(cents)} EUR`],
    "money-gbp": [`£${grp(intv, ",")}.${pad(cents)}`, `${intv}.${pad(cents)} GBP`], "money-sek": [`${grp(intv, " ")},${pad(cents)} kr`, `${intv}.${pad(cents)} SEK`],
    "money-jpy": [`¥${grp(intv, ",")}`, `${intv} JPY`],
  }[id];
  return { category: "money", pattern: id, input: { text: m[0] }, expected: m[1] };
}

// Неверная метка с вероятностью noise — данные никогда не бывают идеальными
function corrupt(task, r) {
  const t = structuredClone(task);
  if (t.category === "dates") { const [y, m, d] = t.expected.split("-"); t.expected = Number(d) <= 12 ? `${y}-${d}-${m}` : `${y}-${m}-${pad(Math.max(1, Number(d) - 1))}`; }
  else if (t.category === "units") t.expected = t.expected.replace(/^([\d.]+)/, (x) => String(Number((Number(x) * 1.1).toFixed(3))));
  else if (t.category === "phones") t.expected = t.expected.slice(0, -1) + ((Number(t.expected.at(-1)) + 1) % 10);
  else t.expected = t.expected.replace(/^(\d+)/, (x) => String(Number(x) + 1));
  t.noisy = true;
  return t;
}

// weights: { category: доля }; round — номер раунда (определяет доступные шаблоны)
export function generateTasks(r, { n, round, weights = null, noise = 0.02, onlyCategory = null }) {
  const avail = PATTERNS.filter((p) => p.from <= round && (!onlyCategory || p.category === onlyCategory));
  const cats = [...new Set(avail.map((p) => p.category))];
  const w = cats.map((c) => (weights?.[c] ?? 1));
  const sum = w.reduce((a, b) => a + b, 0);
  const tasks = [];
  for (let i = 0; i < n; i++) {
    let x = r() * sum, ci = 0;
    while (x > w[ci] && ci < cats.length - 1) { x -= w[ci]; ci++; }
    const pats = avail.filter((p) => p.category === cats[ci]);
    let t = makeTask(pats[ri(r, 0, pats.length - 1)], r);
    if (noise && r() < noise) t = corrupt(t, r);
    tasks.push({ id: `${round}-${i}`, ...t });
  }
  return tasks;
}

// Навыки «версии 0» — то, что агент умеет с рождения: базовые форматы
export function baseSkills() {
  return {
    dates: { "Y-N-N|*": { order: ["y", "m", "d"] } },
    units: { m: { factor: 1, unit: "m" }, kg: { factor: 1, unit: "kg" }, l: { factor: 1, unit: "l" }, km: { factor: 1000, unit: "m" }, g: { factor: 0.001, unit: "kg" } },
    phones: { US: { cc: "1", strip: "" } },
    money: { "$9,9.9": { dec: ".", currency: "USD", decimals: 2 }, "$9.9": { dec: ".", currency: "USD", decimals: 2 } },
  };
}

export function accuracy(skills, tasks) {
  const per = {};
  for (const t of tasks) {
    const c = (per[t.category] ||= { ok: 0, n: 0 });
    c.n++;
    if (solve(skills, t) === t.expected) c.ok++;
  }
  const ok = Object.values(per).reduce((s, c) => s + c.ok, 0), n = Object.values(per).reduce((s, c) => s + c.n, 0);
  return { overall: n ? ok / n : 0, categories: Object.fromEntries(Object.entries(per).map(([k, c]) => [k, c.n ? c.ok / c.n : 0])), n };
}
