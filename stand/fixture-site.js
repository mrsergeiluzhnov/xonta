// Учебные страницы отзывов — ТОЛЬКО для проверки стенда без сети (режим STAND_MODE=fixture).
// Отзывы выдуманы и помечены как учебные; результаты на них — проверка механики, а не данные о товарах.
// Одна площадка запрещает отзывы в robots.txt (mvideo), одна отвечает защитой 498 (wildberries) — чтобы проверить остановку сбора.
import express from "express";
import { seeded } from "../src/tester.js";

// «ловушки» — обороты, по которым видно, что отзыв не о модели; у каждой категории и площадки свои
export const TRAPS = {
  "goods:smartphones": ["брал жене на подарок, сам не пользовался", "перепутали цвет корпуса"],
  "goods:headphones": ["коробка пришла мятая", "заказывал другую версию с кейсом"],
  "goods:vacuums": ["курьер позвонил заранее", "у соседа такой же, но модель постарше"],
  "goods:kettles": ["упаковка целая, пупырка на месте", "это отзыв про чайник прошлого года"],
  "platform:market": ["пункт выдачи рядом с домом"], "platform:otzovik": ["пишу отзыв за баллы"],
  "platform:irecommend": ["в комментариях спрашивали про другую модель"], "platform:ozon": ["ozon fresh привёз быстро"],
  "platform:wildberries": ["примерочная на ПВЗ"], "platform:mvideo": ["консультант в магазине навязал страховку"],
};
const DETAILS = ["держит заряд два дня при активном использовании", "звук плотный, но басы проседают на максимуме", "через месяц появился люфт крышки", "шумит меньше старого, но фильтр забивается за неделю",
  "камера ночью мажет, днём отлично", "приложение глючит при обновлении", "кнопки нажимаются туго, привык за неделю", "нагревается при зарядке, в остальном доволен"];
const TEMPLATE = ["Отличный товар! Всем рекомендую! Супер!", "Очень доволен покупкой, всё супер, рекомендую!!!"];

export function reviewsFor(product, platform, n = 18) {
  const r = seeded(`${product.key}|${platform}`);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const traps = [...(TRAPS[product.category] || []), ...(TRAPS[`platform:${platform}`] || [])];
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = r();
    const d = `2026-0${1 + Math.floor(r() * 8)}-${String(1 + Math.floor(r() * 27)).padStart(2, "0")}`;
    if (x < 0.55) out.push({ rating: 3 + Math.floor(r() * 3), date: d, text: `[учебный] ${pick(DETAILS)}; ${pick(DETAILS)}. Пользуюсь ${2 + Math.floor(r() * 10)} недель.` });
    else if (x < 0.75) out.push({ rating: 5, date: "2026-09-14", text: `[учебный] ${pick(TEMPLATE)}` });
    else out.push({ rating: 1 + Math.floor(r() * 5), date: d, text: `[учебный] ${pick(traps)}. ${r() < 0.5 ? "Сам товар не открывал." : "Про сам товар сказать нечего."}` });
  }
  return out;
}

export async function startFixtureSite({ port, products }) {
  const app = express();
  const byKey = new Map(products.map((p) => [p.key, p]));
  app.get("/:platform/robots.txt", (req, res) => {
    if (req.params.platform === "wildberries") return res.status(498).send("blocked");
    res.type("text/plain").send(req.params.platform === "mvideo" ? "User-agent: *\nDisallow: /products/*/reviews/\n" : "User-agent: *\nDisallow: /search\n");
  });
  app.get("/:platform/products/:key/reviews/", (req, res) => page(req, res));
  app.get("/:platform/product--:key/reviews", (req, res) => page(req, res));
  const otz = (req, res) => page({ params: { platform: "otzovik", key: req.params.key }, query: { page: req.params.n || 1 } }, res);
  app.get("/otzovik/reviews/:key/", otz);
  app.get("/otzovik/reviews/:key/:n/", otz);
  app.get("/otzovik/review_:rid.html", (req, res) => {
    const n = Number(req.params.rid), p = products[Math.floor(n / 1000)], i = n % 1000; if (!p) return res.status(404).send("нет");
    const x = reviewsFor(p, "otzovik_full", 30)[Number(i)]; if (!x) return res.status(404).send("нет");
    res.type("html").send(`<html><body><article>ОТЗЫВ ★${x.rating} ${x.date}: ${x.text} Подробно: пользуюсь давно, есть что сказать.</article></body></html>`);
  });
  function page(req, res) {
    const { platform, key } = req.params;
    if (platform === "wildberries") return res.status(498).send("Подтвердите, что запросы отправляли вы");
    const p = byKey.get(key); if (!p) return res.status(404).send("нет");
    const all = reviewsFor(p, platform), pg = Number(req.query.page || 1), per = 9;
    const part = all.slice((pg - 1) * per, pg * per);
    const links = platform === "otzovik" ? Array.from({ length: 9 }, (_, i) => `<a href="/review_${products.indexOf(p) * 1000 + (pg - 1) * 9 + i}.html">полностью</a>`).join(" ") : "";
    res.type("html").send(`<html><body><h1>${p.title} — отзывы (учебная страница)</h1>${part.map((x) => `<article>ОТЗЫВ ★${x.rating} ${x.date}: ${x.text}</article>`).join("\n")}${links}</body></html>`);
  }
  return new Promise((ok) => { const s = app.listen(port, () => ok({ url: `http://localhost:${port}`, close: () => s.close() })); });
}

// адреса учебных страниц для товара: та же форма, что у настоящих площадок
export const fixtureSources = (key) => ({
  market: `https://market.yandex.ru/product--${key}/reviews`, otzovik: `https://otzovik.com/reviews/${key}/`, irecommend: `https://irecommend.ru/products/${key}/reviews/`,
  ozon: `https://www.ozon.ru/products/${key}/reviews/`, wildberries: `https://www.wildberries.ru/products/${key}/reviews/`, mvideo: `https://www.mvideo.ru/products/${key}/reviews/`,
});
export const fixtureOverrides = (base) => ({
  "market.yandex.ru": `${base}/market`, "otzovik.com": `${base}/otzovik`, "irecommend.ru": `${base}/irecommend`,
  "www.ozon.ru": `${base}/ozon`, "www.wildberries.ru": `${base}/wildberries`, "www.mvideo.ru": `${base}/mvideo`,
});
