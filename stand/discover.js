// Поиск товаров для стенда: проходит по разделам otzovik, берёт товары со страниц раздела,
// открывает каждый и считает отзывы на первой странице; оставляет товары с отзывами
// и пишет stand/products.json (оценочные и трафиковые товары не пересекаются).
// Те же правила сбора: robots.txt, пауза между запросами, при защите — остановка.
//   node stand/discover.js            — разделы по умолчанию (смартфоны, наушники, пылесосы, электрочайники)
//   PER_CATEGORY=10 EVAL_PER_CATEGORY=3 node stand/discover.js
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFetcher } from "./fetcher.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = process.env;
const CATS = JSON.parse(E.DISCOVER_CATEGORIES || JSON.stringify({
  "goods:smartphones": "/technology/communication/cellular_phones/",
  "goods:headphones": "/technology/audio/headphones/",
  "goods:vacuums": "/technology/appliances_room/vacuum/",
  "goods:kettles": "/technology/appliances/electric_kettles/",
}));
const PER = Number(E.PER_CATEGORY || 9), EVAL = Number(E.EVAL_PER_CATEGORY || 3), MIN_REVIEWS = Number(E.MIN_REVIEWS || 3), PAGES = Number(E.DISCOVER_PAGES || 8), CHECK = Number(E.CHECK_PER_CATEGORY || 30);
const OUT = E.PRODUCTS_OUT || join(HERE, "products.json");
const fetcher = createFetcher({ dir: join(E.STAND_DIR || join(HERE, "..", "stand-data"), "discover") });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const clean = (t) => t.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const result = { eval: [], traffic: [], _source: "otzovik.com", _generated: new Date().toISOString() };
for (const [category, path] of Object.entries(CATS)) {
  const links = new Map();
  for (let page = 1; page <= PAGES && links.size < CHECK; page++) {
    const url = `https://otzovik.com${path}${page > 1 ? `${page}/` : ""}`;
    let html;
    try { html = await fetcher.get(url); } catch (e) { log(`${category}: ${url} — ${e.message}`); break; }
    for (const m of html.matchAll(/<a[^>]+href="(?:https?:\/\/otzovik\.com)?(\/reviews\/[a-z0-9_-]+\/)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const t = clean(m[2]);
      if (t.length >= 4 && !links.has(m[1])) links.set(m[1], t);
    }
    log(`${category}: страница раздела ${page} — товаров найдено ${links.size}`);
  }
  const found = [];
  for (const [href, anchor] of [...links].slice(0, CHECK)) {
    const url = `https://otzovik.com${href}`;
    let html;
    try { html = await fetcher.get(url); } catch (e) { log(`  ${href} — ${e.message}`); if (/заблокировано/.test(e.message)) break; continue; }
    const reviews = (html.match(/Достоинства/g) || []).length;
    const h1 = clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || anchor).replace(/^Отзывы? (о|на)\s+/i, "").replace(/\s*-\s*отзывы.*$/i, "");
    if (reviews < MIN_REVIEWS) { log(`  ${h1}: отзывов на первой странице ${reviews} — мало, пропуск`); continue; }
    const key = `${category.slice(6, 10)}-${href.split("/")[2].slice(0, 50)}`;
    found.push({ key, title: h1.slice(0, 200), model: h1.slice(0, 200), category, sources: { otzovik: url }, reviews_on_first_page: reviews });
    log(`  ✓ ${h1} — отзывов на первой странице: ${reviews}`);
  }
  // больше всего отзывов — первыми; каждый третий по порядку — в оценку (не больше EVAL), остальные — в трафик
  const picked = found.sort((a, b) => b.reviews_on_first_page - a.reviews_on_first_page).slice(0, PER);
  let ev = 0;
  picked.forEach((p, i) => { if (i % 3 === 1 && ev < EVAL) { result.eval.push(p); ev++; } else result.traffic.push(p); });
  log(`${category}: в оценку ${result.eval.filter((x) => x.category === category).length}, в трафик ${result.traffic.filter((x) => x.category === category).length}`);
}
result._stats = fetcher.stats;
writeFileSync(OUT, JSON.stringify(result, null, 2));
log(`записано: ${OUT} — оценка ${result.eval.length}, трафик ${result.traffic.length}; запросов ${fetcher.stats.fetched}, из кэша ${fetcher.stats.cached}, заблокировано ${fetcher.stats.blocked}, запрещено robots ${fetcher.stats.disallowed}`);
process.exit(0);
