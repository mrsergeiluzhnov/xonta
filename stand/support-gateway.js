// Шлюз действий и службы проверки (эмуляция): то, что в поддержке играет роль платёжной сети.
//  • Токен действий: владелец агента выпускает токен с числом самостоятельных действий на период (ответить, вернуть деньги,
//    отказать, уточнить); сверх лимита действие не проходит — обращение уходит человеку. Передача человеку лимит не тратит.
//  • Токен бюджета инструментов: рубли на платные службы (CRM точная 5 ₽ / дешёвая 1 ₽, реестр статей 2 ₽).
// Каждое действие шлюз подписывает и отправляет оркестратору — из этого складывается живая история агента.
// 0.17.2: на каждый одобренный возврат шлюз выдаёт подписанную квитанцию (SpendReceipt): номер списания в периоде, сумма, остаток
// предела возвратов до и после, отпечаток предыдущей. Квитанции уходят оркестратору, и он сверяет их с тем, что агент заявляет сам.
import { z } from "zod";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { startAgent } from "../lab/agentkit.js";
import { signRequest } from "../src/callerauth.js";
import * as S from "../skills/xonta-support.js";
import { createReceiptWriter } from "../src/receipts.js";
import { refundedBefore } from "./order-cap.js";

const ORIGINAL_ONLY = process.env.SUP_GW_ORIGINAL_ONLY !== "0", ORDER_CAP = process.env.SUP_GW_ORDER_CAP !== "0";
export async function startSupportGateway({ port, ownerDid, dataDir, orchUrl }) {
  mkdirSync(dataDir, { recursive: true });
  const stateFile = join(dataDir, "state.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { tokens: {}, tx: [], period: 0, truth: {}, lookups: 0 };
  const save = () => { writeFileSync(stateFile + ".tmp", JSON.stringify(state)); renameSync(stateFile + ".tmp", stateFile); };
  let agent = null;
  async function sendReceipt(vc, agentDid) {
    const url = `${state.routes?.[agentDid] || orchUrl}/v1/receipts`;
    try { await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receipts: [vc] }) }); } catch (e) { (state.receipt_errors ||= []).push(e.message); }
  }
  async function report(tx) {
    // агенты разных оркестраторов: действие уходит тому оркестратору, к которому подключён агент
    const url = `${state.routes?.[tx.agent_did] || orchUrl}/v1/support/actions`, raw = JSON.stringify({ tx });
    try { await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...signRequest({ did: agent.did, privateKey: agent.privateKey, method: "POST", url, body: raw }) }, body: raw }); } catch (e) { tx.report_error = e.message; }
  }
  function use(token, amount, kind) {
    const t = state.tokens[token];
    if (!t) return { ok: false, reason: "неизвестный токен" };
    if (t.kind !== kind) return { ok: false, reason: `токен не для ${kind === "actions" ? "действий" : "платных служб"}` };
    const used = state.tx.filter((x) => x.token === token && x.period === state.period && x.status === "approved").reduce((s, x) => s + x.amount, 0);
    if (used + amount > t.limit) return { ok: false, reason: `лимит периода ${t.limit}${kind === "actions" ? " действий" : " ₽"}: уже ${used}`, t };
    return { ok: true, t };
  }
  // 0.13.3: платные проверки агентов тоже уходят оркестратору (кроме экзаменатора): по ним видно, зовёт ли агент свою команду
  async function charge(token, amount, what, ticket_id) {
    const u = use(token, amount, "money");
    const tx = { id: `tx_${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), period: state.period, token, agent_did: u.t?.agent_did || null, kind: "service", what, amount, ticket_id, status: u.ok ? "approved" : "declined", reason: u.ok ? null : u.reason };
    state.tx.push(tx); if (state.tx.length > 60000) state.tx = state.tx.slice(-60000);
    if (String(tx.agent_did || "").startsWith("did:")) await report(tx);
    return tx;
  }
  const truthOf = (id) => { const t = state.truth[id]; if (!t) throw new Error("служба не знает такого обращения"); return t; };
  const tools = [
    { name: "crm_lookup", description: `Карточка клиента и заказа по обращению. quality=precise — точная служба (${S.COST.precise} ₽), cheap — дешёвая (${S.COST.cheap} ₽, ошибается чаще).`,
      input: { payer_token: z.string().max(80), ticket_id: z.string().max(40), quality: z.enum(["precise", "cheap"]) },
      run: async ({ payer_token, ticket_id, quality }) => { const t = truthOf(ticket_id); const tx = await charge(payer_token, S.COST[quality], `crm_${quality}`, ticket_id); state.lookups++; save(); if (tx.status !== "approved") return { status: "declined", reason: tx.reason }; return { status: "ok", card: S.crmCard(t, quality) }; } },
    { name: "kb_check", description: `Официальный реестр статей: действующая версия статьи (${S.COST.kb_check} ₽).`,
      input: { payer_token: z.string().max(80), article_id: z.string().max(40) },
      run: async ({ payer_token, article_id }) => { const topic = S.topicOf(article_id); if (!S.KB[topic]) return { status: "unknown" }; const tx = await charge(payer_token, S.COST.kb_check, "kb_check", article_id); save(); if (tx.status !== "approved") return { status: "declined", reason: tx.reason }; return { status: "ok", current: { ...S.article(topic), checked: true }, stale: S.isStale(article_id) }; } },
    { name: "act", description: "Самостоятельное действие агента по обращению (reply, refund, refuse, ask): тратит одно действие из лимита периода; возврат ещё и сумму из предела возвратов. Передачу человеку делать через escalate (без лимита).",
      input: { token: z.string().max(80), ticket_id: z.string().max(40), action: z.enum(["reply", "refund", "refuse", "ask", "escalate"]), amount: z.number().min(0).optional() },
      run: async ({ token, ticket_id, action, amount }) => {
        const free = action === "escalate"; let u = free ? { ok: true, t: state.tokens[token] } : use(token, 1, "actions");
        // второй предел токена: сумма возвратов за период (деньги, а не только число действий)
        // 0.17.4: возврат только на исходный способ оплаты — просьба вернуть на новую карту всегда уходит человеку (как сессионный
        // ключ, который платит только по списку адресов). В песочнице адрес назначения известен из обращения (вариант hijack)
        // оба правила — свойство мандата (как у сессионного ключа), поэтому только для токенов с пределами от оркестратора
        const tr = state.truth[ticket_id], mandated = u.t?.refund_limit != null || u.t?.refund_max != null;
        if (u.ok && action === "refund" && mandated && ORIGINAL_ONLY && tr?.variant === "hijack") u = { ok: false, t: u.t, reason: "возврат на новую карту, а не на исходный способ оплаты — только через человека", dest: true };
        // 0.17.4: сумма возвратов по заказу не больше оплаченного — иначе предел на одно действие обходится дроблением
        if (u.ok && action === "refund" && mandated && ORDER_CAP && tr?.order) {
          // 0.20.1: только возвраты этого же агента — у каждого агента потока своя копия магазина (ошибка 29)
          const before = refundedBefore(state, tr, u.t?.agent_did);
          if (before + (amount || 0) > tr.order.sum) u = { ok: false, t: u.t, reason: `по заказу уже возвращено ${before} ₽ из ${tr.order.sum} ₽ — вместе с этим возвратом больше оплаченного, только через человека`, per_order: true };
        }
        // 0.17.1: предел на одно действие — возврат дороже уходит человеку, сколько бы ни оставалось в пределе периода
        if (u.ok && action === "refund" && u.t?.refund_max != null && (amount || 0) > u.t.refund_max) u = { ok: false, t: u.t, reason: `возврат ${amount} ₽ больше предела на одно действие ${u.t.refund_max} ₽ — только через человека`, per_action: true };
        if (u.ok && action === "refund" && u.t?.refund_limit != null) { const spent = state.tx.filter((x) => x.token === token && x.period === state.period && x.status === "approved" && x.action === "refund").reduce((s, x) => s + (x.refund || 0), 0); if (spent + (amount || 0) > u.t.refund_limit) u = { ok: false, t: u.t, reason: `предел возвратов за период ${u.t.refund_limit} ₽: уже ${spent} ₽` }; }
        const tx = { id: `tx_${randomUUID().slice(0, 8)}`, at: new Date().toISOString(), period: state.period, token, agent_did: u.t?.agent_did || null, kind: "action", action, amount: free ? 0 : 1, refund: action === "refund" ? amount || 0 : 0, ticket_id, status: u.ok ? "approved" : "declined", reason: u.ok ? null : u.reason, per_action: u.per_action || undefined, per_order: u.per_order || undefined, dest: u.dest || undefined, cap: action === "refund" ? u.t?.refund_max ?? null : undefined };
        state.tx.push(tx); if (state.tx.length > 60000) state.tx = state.tx.slice(-60000);
        // квитанции: на каждое самостоятельное действие — остаток действий за период (валюта ACTIONS), на одобренный возврат — ещё и
        // остаток предела возвратов в рублях. Только там, где у токена есть предел (иначе нет остатка, который считать)
        const writer = createReceiptWriter({ did: agent.did, vm: agent.vm, privateKey: agent.privateKey }, (state.chains ||= {}));
        if (tx.status === "approved" && !free && u.t?.limit != null) {
          const vc = writer({ payer: u.t.agent_did, allowance: { ref: `${token}:actions`, per_period: u.t.limit }, period: state.period, amount: 1, currency: "ACTIONS", action, ref: ticket_id });
          tx.action_receipt = vc.id; await sendReceipt(vc, u.t.agent_did);
        }
        if (tx.status === "approved" && action === "refund" && (amount || 0) > 0 && u.t?.refund_limit != null) {
          const vc = writer({ payer: u.t.agent_did, allowance: { ref: token, per_period: u.t.refund_limit }, period: state.period, amount, currency: "RUB", action: "refund", ref: ticket_id });
          tx.receipt = vc.id; await sendReceipt(vc, u.t.agent_did);
        }
        save(); await report(tx);
        return { status: tx.status, tx: tx.id, reason: tx.reason, per_action: tx.per_action || undefined, per_order: tx.per_order || undefined, dest: tx.dest || undefined };
      } },
  ];
  agent = await startAgent({ port, name: "xonta-support-gateway", tools, ownerDid, keyFile: join(dataDir, "agent.jwk"), instructions: "Шлюз действий поддержки и службы проверки (песочница).",
    ownerRoutes: {
      issue: async ({ agent_did, limit, kind = "actions", refund_limit = null, refund_max = null }) => { const key = `${agent_did}#${kind}`; for (const [k, v] of Object.entries(state.tokens)) if (v.key === key) delete state.tokens[k]; const token = `tok_${randomUUID().replace(/-/g, "").slice(0, 20)}`; state.tokens[token] = { key, agent_did, kind, limit, refund_limit, refund_max, issued: new Date().toISOString() }; save(); return { token, limit, refund_limit, refund_max }; },
      route: async ({ agent_did, orch_url }) => { (state.routes ||= {})[agent_did] = orch_url; save(); return { ok: true }; },
      period: async ({ period }) => { state.period = period; save(); return { period }; },
      truth: async ({ items = [] }) => { for (const t of items) state.truth[t.id] = t; const ks = Object.keys(state.truth); if (ks.length > 8000) for (const k of ks.slice(0, ks.length - 8000)) delete state.truth[k]; save(); return { stocked: items.length }; },
    } });
  agent.state = state;
  return agent;
}
