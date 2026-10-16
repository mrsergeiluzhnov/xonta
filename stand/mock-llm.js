// Заглушка языковой модели для проверки стенда без сети и без затрат (LLM_PROVIDER=mock, STAND_MODE=fixture).
// Судья знает все «ловушки» учебных страниц. Агент узнаёт ловушку, только если пример с ней есть в его запросе —
// так в заглушке моделируется обучение на примерах и ограниченная ёмкость запроса. Это проверка механики, не результат.
import { TRAPS } from "./fixture-site.js";

const ALL_TRAPS = Object.values(TRAPS).flat();
const TEMPLATE = /Отличный товар! Всем рекомендую|Очень доволен покупкой, всё супер/;

function parseItems(user) {
  return user.split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function rate(item, knownTraps) {
  const t = item.text || "";
  const trap = knownTraps.find((x) => t.includes(x));
  const words = t.split(/\s+/).length;
  const templ = TEMPLATE.test(t) || (item.signals?.near_duplicate ?? 0) > 0.6 || (item.signals?.same_day_reviews ?? 0) >= 4;
  return {
    id: item.id,
    relevance: trap ? 0.1 : 0.9,
    informativeness: trap ? 0.1 : templ ? 0.1 : Math.min(1, +(words / 20).toFixed(2)),
    authenticity: templ ? 0.2 : 0.9,
    flags: [...(trap ? ["off_model"] : []), ...(templ ? ["template"] : [])],
  };
}

export function mockJudge(system, user) {
  return JSON.stringify(parseItems(user).filter((x) => x.id).map((x) => rate(x, ALL_TRAPS)));
}

export function mockAgent(system, user) {
  if (user.startsWith("TASK: extract")) return mockExtract(user);
  // ловушки, которые агент «видел» в примерах своего запроса
  const known = ALL_TRAPS.filter((t) => system.includes(t));
  return JSON.stringify(parseItems(user).filter((x) => x.id).map((x) => rate(x, known)));
}

function mockExtract(user) {
  const out = [];
  for (const m of user.matchAll(/ОТЗЫВ ★(\d) (\d{4}-\d{2}-\d{2}): ([^\n]+)/g)) out.push({ rating: Number(m[1]), date: m[2], text: m[3].trim(), variant: null });
  return JSON.stringify(out);
}
// для режима, когда судья и агент работают через одну заглушку (извлечение у агентов)
export const mockAny = (system, user) => (user.startsWith("TASK: judge") ? mockJudge(system, user) : mockAgent(system, user));
