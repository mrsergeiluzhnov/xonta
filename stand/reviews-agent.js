// Агент №2 «Отзывы»: находит отзывы о товаре на площадке, оценивает каждый (о той ли модели, полезен ли, есть ли признаки
// накрутки) и даёт сводку. Учится на расхождениях с судьёй, которые присылает клиент. Может делегировать категорию
// своему потомку — вызовом через шлюз оркестратора (A2O2A), подписанным своим ключом.
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as R from "../skills/xonta-reviews.js";
import { startAgent, sign } from "../lab/agentkit.js";
import { jcs, sha256hex } from "../src/crypto.js";
import { htmlToText, BlockedError, DisallowedError } from "./fetcher.js";
import { pageUrl } from "./platforms.js";
import { connectMcp } from "../src/scan.js";
import { signingFetch } from "../src/callerauth.js";

const hashSkills = (s) => sha256hex(jcs(s)).slice(0, 16);
const Product = z.object({ key: z.string().max(80), title: z.string().max(300), model: z.string().max(200).optional(), category: z.string().max(80), sources: z.record(z.string()).optional() });
const Review = z.object({ id: z.string().max(40), platform: z.string().max(40), product_key: z.string().max(80), rating: z.number().nullable().optional(), date: z.string().nullable().optional(), text: z.string().max(5000), variant: z.string().nullable().optional() });

export async function startReviewsAgent({ port, name, ownerDid, dataDir, llm, fetcher, platforms = ["market"], specialization = null, skills = null, parentDid = null, parentVersion = 0, maxPages = Number(process.env.MAX_PAGES || 2) }) {
  mkdirSync(dataDir, { recursive: true });
  const stateFile = join(dataDir, "state.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {
    skills: skills || R.baseSkills(), base: skills || R.baseSkills(), version: 0, baseVersion: parentVersion,
    corpus: {}, // product_key → { platform → reviews[] }
    mode: "goods", delegates: {}, feedbackItems: 0, examplesLearned: 0, history: [], sources: {},
  };
  const save = () => writeFileSync(stateFile, JSON.stringify(state));
  const inScope = (cat) => !specialization || cat === specialization;
  const categoryOf = (product, platform) => (state.mode === "platform" ? `platform:${platform}` : product.category);

  async function collect(product, platform) {
    const url = product.sources?.[platform];
    if (!url) return { platform, status: "нет адреса", reviews: [] };
    if (!fetcher) return { platform, status: "сбор отключён", reviews: [] };
    const all = [];
    let status = "ok";
    for (let page = 1; page <= maxPages; page++) {
      try {
        const html = await fetcher.get(pageUrl(platform, url, page));
        const { text, data } = htmlToText(html);
        const got = await R.extract(llm, { product, platform, text, data });
        if (!got.length) { if (page === 1) status = "на странице не найдено отзывов (возможно, они подгружаются скриптом)"; break; }
        all.push(...got);
      } catch (e) {
        status = e instanceof BlockedError ? `заблокировано: ${e.why}` : e instanceof DisallowedError ? "запрещено robots.txt" : `ошибка: ${e.message}`;
        break;
      }
    }
    const seen = new Set();
    const reviews = all.map((r) => ({ ...r, platform, product_key: product.key })).map((r) => ({ ...r, id: R.reviewId(r) })).filter((r) => !seen.has(r.id) && seen.add(r.id));
    if (reviews.length) ((state.corpus[product.key] ||= {})[platform] = reviews);
    state.sources[platform] = { last: new Date().toISOString(), status };
    save();
    return { platform, status, reviews };
  }

  // делегирование категории потомку через шлюз оркестратора
  async function delegate(gw, args) {
    const client = await connectMcp(gw.url, { name: `${name}-delegate`, fetch: signingFetch({ did: agent.did, privateKey: agent.privateKey, extraHeaders: { "x-task-category": encodeURIComponent(args.category), "x-task-id": `${args.product.key}-${Date.now()}` } }) });
    try {
      const out = await client.callTool({ name: "assess_reviews", arguments: args });
      const text = (out.content || []).map((c) => c.text || "").join("");
      if (out.isError) throw new Error(text.slice(0, 200));
      return JSON.parse(text).assessments;
    } finally { await client.close().catch(() => {}); }
  }

  async function assessGroup(product, category, reviews) {
    const gw = state.delegates[category];
    if (gw && !specialization) {
      try { return { assessed_by: gw.did, assessments: await delegate(gw, { product, category, reviews }) }; }
      catch (e) { state.history.push({ at: new Date().toISOString(), event: "delegate_failed", category, error: e.message }); }
    }
    return { assessed_by: agent.did, assessments: await R.assess(llm, state.skills, { product, category, reviews }) };
  }

  const tools = [
    { name: "analyze_product", description: "Находит отзывы о товаре на площадке и оценивает каждый: о той ли модели, полезен ли, есть ли признаки накрутки. Возвращает сводку по товару.",
      input: { product: Product, platform: z.string().max(40).optional() },
      run: async ({ product, platform }) => {
        const plats = platform ? [platform] : Object.keys({ ...(state.corpus[product.key] || {}), ...Object.fromEntries(platforms.map((p) => [p, 1])) });
        const groups = [], statuses = {};
        for (const p of plats) {
          let reviews = state.corpus[product.key]?.[p];
          if (!reviews && platforms.includes(p)) { const c = await collect(product, p); statuses[p] = c.status; reviews = c.reviews; }
          else statuses[p] = reviews ? "из накопленных данных" : "нет данных";
          if (!reviews?.length) continue;
          const category = categoryOf(product, p);
          const res = await assessGroup(product, category, reviews);
          groups.push({ platform: p, category, assessed_by: res.assessed_by, reviews, assessments: res.assessments });
        }
        const allReviews = groups.flatMap((g) => g.reviews), allAssess = groups.flatMap((g) => g.assessments);
        return { summary: R.summarize(product, allReviews, allAssess), sources: statuses,
          groups: groups.map((g) => ({ platform: g.platform, category: g.category, assessed_by: g.assessed_by, reviews: g.reviews, assessments: g.assessments })), version: state.version };
      } },
    { name: "collect_reviews", description: "Только собирает отзывы о товаре с площадки, без оценки.", input: { product: Product, platform: z.string().max(40).optional() },
      run: async ({ product, platform = platforms[0] }) => { const c = state.corpus[product.key]?.[platform]; return c ? { platform, status: "из накопленных данных", reviews: c } : collect(product, platform); } },
    { name: "assess_reviews", description: "Оценивает переданные отзывы о товаре (без сбора).", input: { product: Product, category: z.string().max(80), reviews: z.array(Review).max(200) }, annotations: { readOnlyHint: true },
      run: async ({ product, category, reviews }) => ({ assessments: (await assessGroup(product, category, reviews)).assessments, version: state.version }) },
    { name: "ingest", description: "Принимает отзывы с других площадок от поставщика данных и добавляет их в свою базу.",
      input: { product: Product, platform: z.string().max(40), reviews: z.array(Review).max(500), source: z.string().max(200).optional() },
      run: async ({ product, platform, reviews, source }) => {
        const clean = reviews.filter((r) => r.product_key === product.key).map((r) => ({ ...r, platform, id: R.reviewId({ ...r, platform }) }));
        (state.corpus[product.key] ||= {})[platform] = clean;
        state.history.push({ at: new Date().toISOString(), event: "ingest", product: product.key, platform, count: clean.length, source: source || null });
        save();
        return { accepted: clean.length, platforms: Object.keys(state.corpus[product.key]) };
      } },
    { name: "learn", description: "Обратная связь: эталонная разметка отзывов, в которых агент ошибся. Агент добавляет их в свои примеры (ёмкость ограничена).",
      input: { feedback: z.array(z.object({ product: Product, category: z.string().max(80), review: Review, label: z.object({ relevance: z.number(), informativeness: z.number(), authenticity: z.number(), flags: z.array(z.string()).optional() }), error: z.number().optional() })).max(50) },
      run: async ({ feedback }) => {
        const byCat = {};
        for (const f of feedback) if (inScope(f.category)) (byCat[f.category] ||= []).push(f);
        let added = 0;
        for (const [category, list] of Object.entries(byCat)) {
          const before = JSON.stringify(state.skills);
          state.skills = R.learnFrom(state.skills, list.map((f) => ({ ...f, error: f.error ?? 1 })), { category });
          if (JSON.stringify(state.skills) !== before) added += list.length;
          state.feedbackItems += list.length;
        }
        if (added) { state.version++; state.examplesLearned += added; }
        save();
        return { learned: added, version: state.version, examples: Object.fromEntries(Object.entries(state.skills.blocks).map(([c, b]) => [c, b.examples.length])) };
      } },
    { name: "get_skills", description: "Текущие навыки агента (заметки и примеры по категориям) и их версия.", input: {}, annotations: { readOnlyHint: true },
      run: () => ({ language: R.LANGUAGE, version: state.version, hash: hashSkills(state.skills), skills: state.skills, specialization, mode: state.mode }) },
    { name: "propose", description: "Готовит подписанное предложение улучшения для родителя: свой блок навыков сверх базовой версии.", input: {},
      run: () => {
        if (!parentDid) return { proposal: null, reason: "нет родителя" };
        const cat = specialization;
        const mine = state.skills.blocks?.[cat], base = state.base.blocks?.[cat];
        if (!mine || JSON.stringify(mine) === JSON.stringify(base)) return { proposal: null, reason: "нечего предложить" };
        return { proposal: sign(agent, "ImprovementProposal", { id: parentDid, from: agent.did, base_version: state.baseVersion, skill_language: R.LANGUAGE, category: cat,
          rules: { [cat]: { block: mine } }, evidence: { feedback_items: state.feedbackItems, examples: mine.examples.length } }, { validDays: 7 }) };
      } },
  ];

  const agent = await startAgent({
    port, name, tools, ownerDid, keyFile: join(dataDir, "agent.jwk"),
    instructions: "Агент оценки отзывов: относится ли отзыв к модели, полезен ли, есть ли признаки накрутки. Оценка — мнение модели, не вердикт.",
    ownerRoutes: {
      apply: async ({ skills, source }) => { state.skills = structuredClone(skills); state.base = structuredClone(skills); state.version++; state.history.push({ at: new Date().toISOString(), event: "apply", source, version: state.version, hash: hashSkills(state.skills) }); save(); return { version: state.version, hash: hashSkills(state.skills) }; },
      rebase: async ({ skills, parent_version }) => {
        const cat = specialization, mine = state.skills.blocks?.[cat];
        state.skills = structuredClone(skills);
        if (cat && mine) { state.skills.blocks ||= {}; state.skills.blocks[cat] = mine; state.skills.limit = state.skills.limit ?? mine.examples.length; }
        state.base = structuredClone(skills); state.baseVersion = parent_version; save();
        return { base_version: state.baseVersion };
      },
      "sign-lineage": async ({ child_did, mandate, scope, depth }) => {
        if (mandate?.credentialSubject?.id !== agent.did) throw new Error("мандат выдан не этому агенту");
        return { lineage: sign(agent, "AgentLineage", { id: child_did, parent: agent.did, mandate: mandate.id, depth, scope }, { validDays: 365 }) };
      },
      "set-mode": async ({ mode }) => { if (!["goods", "platform"].includes(mode)) throw new Error("mode: goods | platform"); state.mode = mode; save(); return { mode }; },
      "set-delegate": async ({ category, gateway_url, did }) => { if (gateway_url) state.delegates[category] = { url: gateway_url, did }; else delete state.delegates[category]; save(); return { delegates: state.delegates }; },
      "set-platforms": async ({ list }) => { platforms.splice(0, platforms.length, ...list); return { platforms }; },
    },
  });
  agent.state = state;
  agent.llm = llm;
  return agent;
}
