// Агент №3 «Поставщик данных»: собирает отзывы о товаре с нескольких площадок (сайты отзывов и маркетплейсы)
// и передаёт их агенту отзывов через шлюз оркестратора, подписывая вызовы своим ключом.
// Правила сбора те же: robots.txt, редкие запросы, при защите площадки — остановка без обхода.
import { z } from "zod";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import * as R from "../skills/xonta-reviews.js";
import { startAgent } from "../lab/agentkit.js";
import { htmlToText, BlockedError, DisallowedError } from "./fetcher.js";
import { pageUrl, searchUrl, otzovikReviewLinks } from "./platforms.js";
import { connectMcp } from "../src/scan.js";
import { signingFetch } from "../src/callerauth.js";

export const SUPPLIER_PLATFORMS = (process.env.SUPPLIER_PLATFORMS || "otzovik_full,market,irecommend,ozon,wildberries,mvideo").split(",").map((x) => x.trim()).filter(Boolean);
const FULL_REVIEWS = Number(process.env.FULL_REVIEWS_PER_PRODUCT || 12);
const Product = z.object({ key: z.string().max(80), title: z.string().max(300), model: z.string().max(200).optional(), category: z.string().max(80), sources: z.record(z.string()).optional() });

export async function startSupplier({ port, ownerDid, dataDir, llm, fetcher, platforms = SUPPLIER_PLATFORMS, maxPages = Number(process.env.MAX_PAGES || 2) }) {
  mkdirSync(dataDir, { recursive: true });
  const stateFile = join(dataDir, "state.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { supplied: 0, by_platform: {}, statuses: {} };
  const save = () => writeFileSync(stateFile, JSON.stringify(state));

  const why = (e) => (e instanceof BlockedError ? `заблокировано: ${e.why}` : e instanceof DisallowedError ? "запрещено robots.txt" : `ошибка: ${e.message}`);

  // otzovik_full: полные тексты отдельных отзывов — больший объём, чем краткие отзывы на странице товара
  async function collectFull(product) {
    const base = product.sources?.otzovik;
    if (!base) return { platform: "otzovik_full", status: "нет адреса", reviews: [] };
    const links = [];
    try { for (let page = 1; page <= maxPages + 1 && links.length < FULL_REVIEWS; page++) links.push(...otzovikReviewLinks(await fetcher.get(pageUrl("otzovik", base, page)))); }
    catch (e) { if (!links.length) return { platform: "otzovik_full", status: why(e), reviews: [] }; }
    const all = []; let status = "ok";
    for (const link of [...new Set(links)].slice(0, FULL_REVIEWS)) {
      try {
        const { text } = htmlToText(await fetcher.get(link), 20000);
        const got = await R.extract(llm, { product, platform: "otzovik (полный отзыв)", text, data: "" });
        if (got[0]) all.push({ ...got[0], source_url: link });
      } catch (e) { status = why(e); break; }
    }
    const reviews = all.map((r) => ({ ...r, platform: "otzovik_full", product_key: product.key })).map((r) => ({ ...r, id: R.reviewId(r) }));
    state.statuses.otzovik_full = status;
    return { platform: "otzovik_full", status: `${status}; полных отзывов: ${reviews.length}`, reviews };
  }

  async function collect(product, platform) {
    if (platform === "otzovik_full") return collectFull(product);
    const url = product.sources?.[platform] || searchUrl(platform, product);
    if (!url) return { platform, status: "нет адреса", reviews: [] };
    const all = []; let status = "ok";
    for (let page = 1; page <= maxPages; page++) {
      try {
        const { text, data } = htmlToText(await fetcher.get(pageUrl(platform, url, page)));
        const got = await R.extract(llm, { product, platform, text, data });
        if (!got.length) { if (page === 1) status = "на странице не найдено отзывов"; break; }
        all.push(...got);
      } catch (e) { status = why(e); break; }
    }
    const seen = new Set();
    const reviews = all.map((r) => ({ ...r, platform, product_key: product.key })).map((r) => ({ ...r, id: R.reviewId(r) })).filter((r) => !seen.has(r.id) && seen.add(r.id));
    state.statuses[`${platform}`] = status;
    return { platform, status, reviews };
  }

  async function supply(product, list = platforms) {
    const out = [];
    for (const p of list) out.push(await collect(product, p));
    for (const o of out) { state.by_platform[o.platform] = (state.by_platform[o.platform] || 0) + o.reviews.length; state.supplied += o.reviews.length; }
    save();
    return out;
  }

  const tools = [
    { name: "supply", description: "Собирает отзывы о товаре с сайтов отзывов и маркетплейсов. Возвращает отзывы и статус каждой площадки.",
      input: { product: Product, platforms: z.array(z.string().max(40)).max(10).optional() }, annotations: { readOnlyHint: true },
      run: async ({ product, platforms: list }) => ({ results: await supply(product, list) }) },
    { name: "coverage", description: "Сколько отзывов передано по площадкам и статусы площадок.", input: {}, annotations: { readOnlyHint: true }, run: () => state },
  ];

  const agent = await startAgent({
    port, name: "xonta-reviews-supplier", tools, ownerDid, keyFile: join(dataDir, "agent.jwk"),
    instructions: "Поставщик отзывов с нескольких площадок. Собирает только то, что разрешено robots.txt, без обхода защиты.",
    ownerRoutes: {
      // по команде владельца: собрать и передать агенту отзывов через шлюз оркестратора
      deliver: async ({ gateway_url, product }) => {
        const results = await supply(product);
        const delivered = {};
        for (const r of results) {
          if (!r.reviews.length) { delivered[r.platform] = { accepted: 0, status: r.status }; continue; }
          const client = await connectMcp(gateway_url, { name: "supplier", fetch: signingFetch({ did: agent.did, privateKey: agent.privateKey, extraHeaders: { "x-task-category": encodeURIComponent(`platform:${r.platform}`), "x-task-id": `ingest-${product.key}-${r.platform}` } }) });
          try {
            const res = await client.callTool({ name: "ingest", arguments: { product, platform: r.platform, reviews: r.reviews, source: agent.did } });
            const text = (res.content || []).map((c) => c.text || "").join("");
            delivered[r.platform] = res.isError ? { accepted: 0, status: text.slice(0, 160) } : { ...JSON.parse(text), status: r.status };
          } finally { await client.close().catch(() => {}); }
        }
        return { product: product.key, delivered };
      },
    },
  });
  agent.state = state;
  return agent;
}
