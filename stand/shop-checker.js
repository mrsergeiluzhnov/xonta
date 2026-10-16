// Рой проверяющих (потомки покупателя, до двух уровней): главный проверяющий (уровень 1) и проверяющие (уровень 2).
// Главный проверяющий получает от покупателя ленту вариантов агента №3 и размер роя, выбирает, какие карточки проверить
// (сначала те, что по ленте выглядят подходящими и дешёвыми: их покупатель скорее всего и выберет), делит их между
// проверяющими (каждый — не больше PER_CHECKER карточек) и сводит находки. Проверяющий платит службе проверки токеном
// покупателя (делегированная трата) и сверяет ленту с правдой. Опровержение: перед оплатой выбранный вариант
// перепроверяет ДРУГОЙ проверяющий — не тот, что видел карточку раньше (если она вообще проверялась).
// У проверяющих нет модели: их работа — платный вызов и сверка полей, токены модели на неё не тратятся.
import { z } from "zod";
import { join } from "node:path";
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { startAgent, sign } from "../lab/agentkit.js";
import { connectMcp } from "../src/scan.js";
import { signingFetch } from "../src/callerauth.js";
import * as S from "../skills/xonta-shop.js";

export const PER_CHECKER = Number(process.env.SHOP_PER_CHECKER || 3);
const Card = z.object({ id: z.string().max(10) }).passthrough();
const Task = z.object({ id: z.string(), item: z.string(), qty: z.number(), mandate: z.object({ cap: z.number(), min_rating: z.number(), deadline_days: z.number() }), want: z.record(z.any()).optional() }).passthrough();

async function mcpCall(url, tool, args, signer) {
  const c = await connectMcp(url, { name: "xonta-shop-swarm", fetch: signer ? signingFetch({ did: signer.did, privateKey: signer.privateKey }) : undefined });
  try {
    const out = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: Number(process.env.MCP_TOOL_TIMEOUT_MS || 600000) });
    const text = (out.content || []).map((x) => x.text || "").join("");
    if (out.isError) throw new Error(`${tool}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally { await c.close().catch(() => {}); }
}

// порядок проверки: сначала карточки, которые по ленте подходят под поручение, от дешёвых к дорогим, потом остальные
export function priority(task, offers) {
  const m = task.mandate, total = (o) => o.price * task.qty + (o.delivery_fee || 0);
  const fits = (o) => o.item === task.item && total(o) <= m.cap && o.rating >= m.min_rating && o.delivery_days <= m.deadline_days;
  return [...offers].sort((a, b) => (fits(b) - fits(a)) || (total(a) - total(b)));
}

export async function startShopChecker({ port, name, ownerDid, dataDir, role = "checker", inspectorUrl, parentDid = null }) {
  mkdirSync(dataDir, { recursive: true });
  const stateFile = join(dataDir, "state.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { checkers: [], checked: 0, distorted: 0, refutes: 0 };
  const save = () => { writeFileSync(stateFile + ".tmp", JSON.stringify(state)); renameSync(stateFile + ".tmp", stateFile); };
  let agent = null;

  async function checkCards(task_id, cards, payer_token) {
    const out = [];
    for (const feed of cards) {
      const r = await mcpCall(inspectorUrl, "inspect", { payer_token, task_id, offer_id: feed.id }, agent);
      if (r.status !== "ok") { out.push({ id: feed.id, status: "declined", reason: r.reason }); continue; }
      const diff = S.discrepancy(feed, r.card);
      state.checked++; if (diff.length) state.distorted++;
      out.push({ id: feed.id, status: "ok", card: { ...r.card, ...(diff.length ? { discrepancy: diff } : {}) }, distorted: diff.length > 0 });
    }
    save();
    return out;
  }

  const tools = role === "checker" ? [
    { name: "check", description: "Проверить карточки вариантов у независимой службы (платно, токеном плательщика) и сверить с лентой поставщика.",
      input: { task_id: z.string().max(40), cards: z.array(Card).max(20), payer_token: z.string().max(80) },
      run: async ({ task_id, cards, payer_token }) => ({ results: await checkCards(task_id, cards, payer_token) }) },
  ] : [
    { name: "inspect_offers", description: "Рой проверяющих: проверить самые вероятные к покупке карточки силами size проверяющих и вернуть исправленную ленту.",
      input: { task: Task, offers: z.array(Card).max(40), size: z.number().int().min(0).max(16), payer_token: z.string().max(80) },
      run: async ({ task, offers, size, payer_token }) => {
        const team = state.checkers.slice(0, size);
        const order = priority(task, offers).slice(0, team.length * PER_CHECKER);
        const results = {};
        for (let k = 0; k < team.length; k++) {
          const part = order.slice(k * PER_CHECKER, (k + 1) * PER_CHECKER);
          if (!part.length) break;
          const r = await mcpCall(team[k].url, "check", { task_id: task.id, cards: part, payer_token }, agent);
          for (const x of r.results) results[x.id] = { ...x, by: k };
        }
        const corrected = offers.map((o) => (results[o.id]?.status === "ok" ? results[o.id].card : o));
        const checks = Object.values(results).filter((x) => x.status === "ok").length;
        // вердикт: какие варианты не покупать и почему. Проверенные — по правде службы (поручение и признаки мошенника),
        // непроверенные — по видимым признакам мошенника в ленте (бесплатно). Покупатель эти варианты модели не показывает.
        const exclude = {};
        for (const o of corrected) { const why = o.checked ? S.excludeReasons(task, o) : S.scamSigns(o); if (why.length) exclude[o.id] = why; }
        state.excluded = (state.excluded || 0) + Object.keys(exclude).length; save();
        return { offers: corrected, checked: Object.fromEntries(Object.entries(results).map(([id, x]) => [id, x.by])), checks, distorted: Object.values(results).filter((x) => x.distorted).length, exclude };
      } },
    { name: "refute", description: "Перед оплатой: другой проверяющий перепроверяет выбранный вариант.",
      input: { task_id: z.string().max(40), card: Card, payer_token: z.string().max(80), exclude: z.number().int().nullable().optional(), task: Task.optional() },
      run: async ({ task_id, card, payer_token, exclude = null, task = null }) => {
        const pool = state.checkers.map((c, i) => ({ ...c, i })).filter((c) => c.i !== exclude);
        if (!pool.length) return { status: "no_checker" };
        const c = pool[(parseInt(String(task_id).slice(-2), 16) || 0) % pool.length];
        const r = await mcpCall(c.url, "check", { task_id, cards: [card], payer_token }, agent);
        state.refutes++; save();
        const res = r.results[0] || null;
        // перед оплатой проверяется не только искажение карточки, но и сама сделка: поручение и репутация продавца
        const reject = res?.status === "ok" && task ? S.excludeReasons(task, res.card) : [];
        return { status: res?.status || "error", result: res, by: c.i, reject };
      } },
  ];

  agent = await startAgent({
    port, name, tools, ownerDid, keyFile: join(dataDir, "agent.jwk"),
    instructions: role === "checker" ? "Проверяющий: платная проверка карточек у независимой службы и сверка с лентой поставщика." : "Главный проверяющий: распределяет проверку карточек между проверяющими и сводит находки.",
    ownerRoutes: {
      "set-checkers": async ({ checkers = [] }) => { state.checkers = checkers; save(); return { checkers: state.checkers.length }; },
      "sign-lineage": async ({ child_did, mandate, scope, depth }) => {
        if (mandate?.credentialSubject?.id !== agent.did) throw new Error("мандат выдан не этому агенту");
        return { lineage: sign(agent, "AgentLineage", { id: child_did, parent: agent.did, mandate: mandate.id, depth, scope }, { validDays: 365 }) };
      },
    },
  });
  agent.state = state; agent.role = role; agent.parentDid = parentDid;
  return agent;
}
