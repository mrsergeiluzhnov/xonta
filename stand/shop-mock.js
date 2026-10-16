// Заглушка модели для стенда покупок (STAND_MODE=fixture, LLM_PROVIDER=mock): проверка механики без сети и без затрат.
// «Умение» заглушки растёт с числом выученных правил категории и с целью от владельца: чем их больше, тем чаще она
// проверяет итог с доставкой, признаки товара, продавца и спрашивает, когда в задании чего-то не хватает. Это не результат.
const h = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 1000 / 1000;

function rules(system, user) {
  const nErr = user.split("\n").filter((l) => l.startsWith("•")).length;
  const k = Math.max(1, Math.min(6, Math.floor(nErr / 4)));
  const set = (m) => Array.from({ length: Math.min(6, m) }, (_, i) => `учебное правило закупок ${i + 1}`);
  const many = system.match(/Предложи (\d) разн/);
  return JSON.stringify(many ? { candidates: Array.from({ length: Number(many[1]) }, (_, j) => set(k + j)) } : { rules: set(k) });
}

export function mockShop(system, user, boost = 0) {
  if (system.includes("Ты улучшаешь свои правила закупок")) return rules(system, user);
  const lines = user.split("\n");
  const text = lines.filter((l) => !l.startsWith("{")).join(" ");
  const offers = lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const cap = Number((text.match(/не больше (\d+(?:\.\d+)?) ₽/) || [])[1] || Infinity);
  const minR = Number((text.match(/рейтингом не ниже ([\d.]+)/) || [])[1] || 0);
  const dl = Number((text.match(/не дольше (\d+) дн/) || [])[1] || 99);
  const qtyM = text.match(/, (\d+) шт\.|: (\d+) (?:стр|провер)/);
  const qty = qtyM ? Number(qtyM[1] || qtyM[2]) : 1;
  const q = Number((text.match(/точность не ниже (\d+)%/) || [])[1] || 0);
  const k = (system.match(/^- \[/gm) || []).length + (system.includes("Цель от владельца") ? 3 : 0) + boost;
  const seed = h(user);
  const p = (base, step) => Math.min(0.95, base + step * k);
  const checkScam = seed < p(0.2, 0.1), checkTotal = h(user + "t") < p(0.4, 0.1), checkAttr = h(user + "a") < p(0.5, 0.08), checkMandate = h(user + "m") < p(0.6, 0.07), canAsk = h(user + "q") < p(0.3, 0.1);
  const item = offers.length ? offers.map((o) => o.item).sort((a, b) => offers.filter((x) => x.item === b).length - offers.filter((x) => x.item === a).length)[0] : null;
  const attrOk = (o) => o.item === item && Object.entries(o.attrs || {}).every(([key, v]) => (key === "quality" ? !q || v >= q : text.includes(String(v)) || key === "color"));
  // неоднозначность: признак, значения которого у вариантов различаются и ни одно не названо в задании
  const ambiguous = !text.includes("Владелец уточнил") && Object.keys(offers[0]?.attrs || {}).some((key) => key !== "color" && key !== "quality" && !offers.some((o) => o.item === item && text.includes(String(o.attrs[key]))));
  if (ambiguous && canAsk) return JSON.stringify({ action: "ask", offer: null, qty, question: "Уточните недостающий признак товара", confidence: 0.6 });
  const total = (o) => (checkTotal ? o.price * qty + (o.delivery_fee || 0) : o.price * qty);
  const ok = offers.filter((o) => (!checkAttr || attrOk(o)) && (!checkScam || (o.seller_days >= 30 && !o.note)) && (!checkMandate || (o.rating >= minR && o.delivery_days <= dl)) && total(o) <= cap);
  const best = ok.sort((a, b) => total(a) - total(b))[0];
  if (!best) return JSON.stringify({ action: "refuse", offer: null, qty, question: null, confidence: 0.7 });
  return JSON.stringify({ action: "buy", offer: best.id, qty, question: null, confidence: 0.8 });
}
export const mockAgent = (s, u) => mockShop(s, u, 0);
export const mockSenior = (s, u) => mockShop(s, u, 6);
export const mockJudge = mockAgent;
