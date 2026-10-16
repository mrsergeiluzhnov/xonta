// Тестовый эквайер: эмуляция платёжной сети для агентов (как токен с лимитом у Visa/Mastercard или Shared Payment Token у Stripe).
// Деньги ненастоящие. Владелец агента выпускает токен с лимитом на период (раунд) и списком категорий; агент платит токеном;
// эквайер отклоняет платёж сверх лимита или вне категорий. Каждый платёж (одобренный и отклонённый) эквайер подписывает
// и отправляет оркестратору — из этих записей складывается история трат агента в его паспорте.
import { z } from "zod";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { startAgent } from "../lab/agentkit.js";
import { signRequest } from "../src/callerauth.js";
import * as S from "../skills/xonta-shop.js";

export async function startShopRail({ port, ownerDid, dataDir, orchUrl }) {
  mkdirSync(dataDir, { recursive: true });
  const stateFile = join(dataDir, "state.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { tokens: {}, tx: [], period: 0 };
  state.truth ||= {}; state.inspections ||= 0;
  const save = () => { writeFileSync(stateFile + ".tmp", JSON.stringify(state)); renameSync(stateFile + ".tmp", stateFile); }; // атомарно: обрыв процесса не портит файл
  let agent = null;
  async function report(tx) {
    const url = `${orchUrl}/v1/shop/spending`, raw = JSON.stringify({ tx });
    try { await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...signRequest({ did: agent.did, privateKey: agent.privateKey, method: "POST", url, body: raw }) }, body: raw }); }
    catch (e) { tx.report_error = e.message; }
  }
  // списание по токену (общая логика для покупок и платных проверок)
  async function charge({ token, amount, merchant, category, order, offer = null }) {
    const t = state.tokens[token];
    const tx = { id: `tx_${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), period: state.period, agent_did: t?.agent_did || null, amount, merchant, category, order, offer };
    if (!t) Object.assign(tx, { status: "declined", reason: "неизвестный токен" });
    else {
      const spent = state.tx.filter((x) => x.token === token && x.period === state.period && x.status === "approved").reduce((s, x) => s + x.amount, 0);
      tx.token = token; tx.limit = t.limit; tx.spent_before = spent;
      if (t.categories?.length && !t.categories.includes(category)) Object.assign(tx, { status: "declined", reason: `категория ${category} не разрешена токеном` });
      else if (spent + amount > t.limit) Object.assign(tx, { status: "declined", reason: `лимит периода ${t.limit} ₽: уже ${spent} ₽, платёж ${amount} ₽` });
      else tx.status = "approved";
    }
    state.tx.push(tx); if (state.tx.length > 40000) state.tx = state.tx.slice(-40000);
    return tx;
  }
  const tools = [
    // независимая служба проверки карточек: правда о варианте за CHECK_COST тестовых ₽ (списывается с токена плательщика)
    { name: "inspect", description: `Платная проверка карточки варианта независимой службой: настоящие продавец, рейтинг, признаки товара, доставка. ${S.CHECK_COST} тестовых ₽ за вариант.`,
      input: { payer_token: z.string().max(80), task_id: z.string().max(40), offer_id: z.string().max(10) },
      run: async ({ payer_token, task_id, offer_id }) => {
        const o = (state.truth[task_id] || []).find((x) => x.id === offer_id);
        if (!o) throw new Error("служба не знает такой карточки");
        const tx = await charge({ token: payer_token, amount: S.CHECK_COST, merchant: "Служба проверки карточек", category: "tools", order: task_id, offer: offer_id });
        state.inspections++; save();
        if (tx.status !== "approved") return { status: "declined", reason: tx.reason };
        return { status: "ok", card: S.inspectCard(o), tx: tx.id };
      } },
    { name: "pay", description: "Оплата токеном: эквайер проверяет лимит периода и категорию и списывает тестовые деньги.",
      input: { token: z.string().max(80), amount: z.number().min(0), merchant: z.string().max(80), category: z.string().max(20), order: z.string().max(40), offer: z.string().max(10).optional() },
      run: async ({ token, amount, merchant, category, order, offer }) => {
        const t = state.tokens[token];
        const tx = { id: `tx_${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), period: state.period, agent_did: t?.agent_did || null, amount, merchant, category, order, offer: offer || null };
        if (!t) Object.assign(tx, { status: "declined", reason: "неизвестный токен" });
        else {
          const spent = state.tx.filter((x) => x.token === token && x.period === state.period && x.status === "approved").reduce((s, x) => s + x.amount, 0);
          tx.token = token; tx.limit = t.limit; tx.spent_before = spent;
          if (t.categories?.length && !t.categories.includes(category)) Object.assign(tx, { status: "declined", reason: `категория ${category} не разрешена токеном` });
          else if (spent + amount > t.limit) Object.assign(tx, { status: "declined", reason: `лимит периода ${t.limit} ₽: уже ${spent} ₽, платёж ${amount} ₽` });
          else tx.status = "approved";
        }
        state.tx.push(tx); if (state.tx.length > 20000) state.tx = state.tx.slice(-20000);
        save(); await report(tx);
        return { status: tx.status, tx: tx.id, reason: tx.reason || null };
      } },
  ];
  agent = await startAgent({ port, name: "xonta-test-acquirer", tools, ownerDid, keyFile: join(dataDir, "agent.jwk"), instructions: "Тестовый эквайер песочницы: деньги ненастоящие.",
    ownerRoutes: {
      // выпуск токена делает банк по заявке владельца агента; в стенде это команда оператора эквайера
      issue: async ({ agent_did, limit, categories = [] }) => { const token = `tok_${randomUUID().replace(/-/g, "").slice(0, 20)}`; for (const [k, v] of Object.entries(state.tokens)) if (v.agent_did === agent_did) v.revoked = true, delete state.tokens[k]; state.tokens[token] = { agent_did, limit, categories, issued: new Date().toISOString() }; save(); return { token, limit }; },
      period: async ({ period }) => { state.period = period; save(); return { period }; },
      "stock-truth": async ({ items = [] }) => { for (const x of items) state.truth[x.task_id] = x.offers; const ks = Object.keys(state.truth); if (ks.length > 6000) for (const k of ks.slice(0, ks.length - 6000)) delete state.truth[k]; save(); return { stocked: items.length }; },
      summary: async ({ period = null } = {}) => { const l = state.tx.filter((x) => period == null || x.period === period); return { tx: l.length, approved: l.filter((x) => x.status === "approved").length, declined: l.filter((x) => x.status === "declined").length, amount: l.filter((x) => x.status === "approved").reduce((s, x) => s + x.amount, 0) }; },
    } });
  agent.state = state;
  return agent;
}
