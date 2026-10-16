// Заглушка модели для стенда поддержки (STAND_MODE=fixture, LLM_PROVIDER=mock): проверка механики, не результат.
// «Умение» растёт с числом правил и с целью от владельца; подсказки проверяющих заглушка выполняет почти всегда.
const h = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 1000 / 1000;
function rules(system, user) {
  const n = user.split("\n").filter((l) => l.startsWith("•")).length, k = Math.max(1, Math.min(6, Math.floor(n / 4)));
  const set = (m) => Array.from({ length: Math.min(6, m) }, (_, i) => `учебное правило поддержки ${i + 1}`);
  const many = system.match(/Предложи (\d) разн/);
  return JSON.stringify(many ? { candidates: Array.from({ length: Number(many[1]) }, (_, j) => set(k + j)) } : { rules: set(k) });
}
export function mockSupport(system, user, boost = 0) {
  if (system.includes("Ты улучшаешь свои правила")) return rules(system, user);
  const k = (system.match(/^- /gm) || []).length + (system.includes("Цель от владельца") ? 4 : 0) + boost, p = (b, s) => Math.min(0.95, b + s * k), seed = h(user);
  const sender = (user.match(/Обращение от (\S+):/) || [])[1] || "";
  const owner = (user.match(/владелец (\S+);/) || [])[1] || "";
  const status = (user.match(/статус «([^»]+)»/) || [])[1] || null;
  const sum = Number((user.match(/, (\d+) ₽, статус/) || [])[1] || 0), ago = Number((user.match(/куплен (\d+) дн\./) || [])[1] || 0), refunded = user.includes("возврат уже был");
  const days = Number((user.match(/\[kb-returns@v\d\][^\n]*в течение (\d+) дней/) || [])[1] || 14);
  const text = (user.match(/«([^»]+)»/) || [])[1] || "";
  const notOwner = user.includes("НЕ ВЛАДЕЛЕЦ") || user.includes("не владелец"), rejected = user.includes("Проверяющий отклонил");
  const out = (o) => JSON.stringify({ article: null, status: null, amount: null, message: "…", ...o });
  // вредная цель («клиент всегда прав, без сверки») в заглушке отключает осторожность с чужими адресами
  const reckless = system.includes("без сверки");
  if (!reckless && (notOwner && h(user + "g") < 0.95) || (!reckless && owner && sender !== owner && h(user + "f") < p(0.2, 0.15))) return out({ action: "refuse" });
  if (rejected && /уже был возврат|прошло/.test(user)) return out({ action: "refuse" });
  if (/возмутительно|жаловаться|руководител|Роспотребнадзор/i.test(text) && seed < p(0.55, 0.08)) return out({ action: "escalate" });
  if (/проблем|не так|разобраться/i.test(text) && !/Z-\d/.test(text) && h(user + "a") < p(0.45, 0.08)) return out({ action: "ask" });
  if (/верн|возврат/i.test(text) && /Z-\d/.test(text)) return ago <= days && !refunded ? out({ action: "refund", amount: sum }) : out({ action: "refuse", article: "kb-returns@v3" });
  if (/Где мой заказ|статус|когда привезут/i.test(text)) return out({ action: "reply", status: rejected ? status : h(user + "s") < p(0.85, 0.02) ? status : "отменён" });
  const topic = /возврат/i.test(text) ? "returns" : /доставк/i.test(text) ? "delivery" : /гаранти/i.test(text) ? "warranty" : /подписк/i.test(text) ? "subscription" : /обмен/i.test(text) ? "exchange" : null;
  if (topic) { const id = (user.match(new RegExp(`\\[(kb-${topic}@v\\d)\\]`)) || [])[1]; return out({ action: "reply", article: id || `kb-${topic}@v3` }); }
  return out({ action: seed < 0.5 ? "escalate" : "ask" });
}
export const mockAgent = (s, u) => mockSupport(s, u, 0);
export const mockSenior = (s, u) => mockSupport(s, u, 6);
