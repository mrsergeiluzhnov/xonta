// Квитанции о тратах (0.17.2). Мандат говорит, сколько агенту можно. Сколько уже потрачено, раньше знал только оркестратор, и
// проверяющей стороне оставалось верить на слово (комментарий ANP2 Network на dev.to). Оркестратор не бухгалтерия: агент может
// войти через него, а тратить где угодно. Поэтому:
//  - квитанцию подписывает тот, кто списал деньги (исполнитель): кто платил, по какому мандату или пределу, номер списания в периоде,
//    сумма, остаток до и после, отпечаток предыдущей квитанции. Получается цепочка, как выписка с печатью;
//  - оркестратор принимает квитанции от кого угодно и проверяет: подпись по did:web исполнителя, что плательщик — агент или его
//    зарегистрированный потомок, что мандат наш и не отозван, что цепочка не разорвана и остаток живой (каждое списание его
//    уменьшает ровно на сумму). Нарушения записываются как замечания к исполнителю и к агенту;
//  - наша работа — оценка агента: что агент сам заявляет о тратах, сверяется с квитанциями. Скрыл траты — сигнал, сильнее любого
//    экзамена. Где квитанций нет, так и пишется: подтверждено независимо столько-то, остальное со слов агента;
//  - потомки: траты потомка входят в траты семьи и в оценку родителя; лимит потомка выделяется из лимита родителя, а не сверх.
// Оркестратор сам подписывает квитанции только за то, что прошло через его собственный шлюз (массовые задачи).
import { randomUUID } from "node:crypto";
import { signCredential, credential, verifyProof } from "./vc.js";
import { jcs, sha256hex } from "./crypto.js";

const err = (status, msg) => Object.assign(new Error(msg), { status });
const r2 = (x) => Math.round(100 * x) / 100;
export const receiptHash = (vc) => sha256hex(jcs(vc));

// подписать квитанцию ключом исполнителя: signer = { did, vm, privateKey, context? }
export function signReceipt(signer, subject) {
  const vc = credential({ id: `urn:uuid:${randomUUID()}`, type: "SpendReceipt", issuer: signer.did, subject, validDays: 3650 });
  if (signer.context) vc["@context"] = signer.context;
  return signCredential(vc, { privateKey: signer.privateKey, verificationMethod: signer.vm });
}

// исполнитель ведёт свою цепочку на каждый счёт (плательщик + мандат/предел + период) и выдаёт квитанции
// chains — простой объект состояния цепочек; исполнитель хранит его у себя, чтобы цепочка переживала перезапуск
export function createReceiptWriter(signer, chains = {}) {
  return function write({ payer, allowance, period, amount, currency = "RUB", action = null, ref = null, mandate = null }) {
    const key = `${payer}|${allowance.ref}|${period}`, c = chains[key] || { seq: 0, prev: null, balance: allowance.per_period };
    const before = c.balance, after = r2(before - amount);
    const vc = signReceipt(signer, { id: payer, mandate, allowance: { ref: allowance.ref, per_period: allowance.per_period }, period, seq: c.seq + 1, amount: r2(amount), currency, balance_before: r2(before), balance_after: after, prev: c.prev, action, ref });
    chains[key] = { seq: c.seq + 1, prev: receiptHash(vc), balance: after };
    return vc;
  };
}

export function createReceipts({ store, issuer, orch, resolver, notify = async () => {}, publicUrl }) {
  const st = () => store.get("receipts", { accounts: {}, rows: [], claims: {}, anomalies: [] });
  const upd = (fn) => store.update("receipts", { accounts: {}, rows: [], claims: {}, anomalies: [] }, fn);
  const agentByDid = (did) => Object.values(store.get("agents", {})).find((a) => a.did === did && !["retired"].includes(a.status)) || null;
  const rootOf = (rec) => { let r = rec; const ag = store.get("agents", {}); while (r?.parent && ag[r.parent]) r = ag[r.parent]; return r; };
  const familyOf = (rec) => { const ag = Object.values(store.get("agents", {})), out = [rec]; const walk = (p) => { for (const c of ag.filter((a) => a.parent === p.id)) { out.push(c); walk(c); } }; walk(rec); return out; };

  async function verifyOne(vc) {
    const problems = [];
    if (!(vc?.type || []).includes("SpendReceipt")) return { ok: false, problems: ["not a SpendReceipt"] };
    const exec = typeof vc.issuer === "string" ? vc.issuer : vc.issuer?.id, s = vc.credentialSubject || {};
    const sig = await verifyProof(vc, (vm) => resolver.keyFor(vm)).catch((e) => ({ ok: false, reason: e.message }));
    if (!sig.ok) return { ok: false, problems: [`signature: ${sig.reason}`] };
    const payer = agentByDid(s.id);
    if (!payer) return { ok: false, problems: [`payer ${s.id} is not an agent registered here`] };
    // мандат: если указан, должен быть нашим, выданным плательщику или его предку, и не отозванным
    if (s.mandate) {
      const m = store.get("credentials", {})[s.mandate];
      if (!m) problems.push("mandate is not one issued here");
      else {
        const holder = m.vc.credentialSubject?.id, fam = new Set(familyOf(rootOf(payer)).map((a) => a.did));
        let ok = holder === s.id; if (!ok) { for (let r = payer; r?.parent; r = store.get("agents", {})[r.parent]) if (store.get("agents", {})[r.parent]?.did === holder) ok = true; }
        if (!ok) problems.push(fam.has(holder) ? "mandate belongs to a relative that is not an ancestor" : "mandate was issued to someone else");
        const stat = issuer.statusOf(m); if (stat.revocation) problems.push("mandate is revoked");
      }
    }
    if (!(Number(s.amount) > 0)) problems.push("amount must be positive");
    if (r2(Number(s.balance_before) - Number(s.amount)) !== r2(Number(s.balance_after))) problems.push(`balance after ${s.balance_after} is not balance before ${s.balance_before} minus ${s.amount}`);
    return { ok: !problems.length, problems, exec, payer, s };
  }

  // приём пачки квитанций; проверка цепочки по счёту (исполнитель + плательщик + предел + период)
  async function submit({ receipts = [] } = {}) {
    if (!Array.isArray(receipts) || !receipts.length || receipts.length > 1000) throw err(400, "receipts: от 1 до 1000 квитанций");
    const out = [];
    for (const vc of receipts) {
      const v = await verifyOne(vc);
      if (!v.ok && (!v.exec || !v.payer)) { out.push({ id: vc?.id || null, accepted: false, problems: v.problems }); continue; }
      const s = v.s, key = `${v.exec}|${s.id}|${s.allowance?.ref || s.mandate || "-"}|${s.period}`, h = receiptHash(vc);
      const acc = st().accounts[key] || { seq: 0, last: null, balance: null, n: 0, total: 0, balances: [] };
      if (acc.hashes?.includes(h)) { out.push({ id: vc.id, accepted: false, duplicate: true }); continue; }
      const chain = [];
      if (Number(s.seq) !== acc.seq + 1) chain.push(`sequence ${s.seq} after ${acc.seq}`);
      if ((s.prev || null) !== acc.last) chain.push("previous receipt hash does not match (a receipt was skipped, reordered or rewritten)");
      if (acc.balance != null && r2(Number(s.balance_before)) !== acc.balance) chain.push(`balance before ${s.balance_before} does not continue the last balance ${acc.balance}`);
      if (acc.balance == null && s.allowance?.per_period != null && r2(Number(s.balance_before)) !== r2(Number(s.allowance.per_period))) chain.push(`first balance ${s.balance_before} is not the allowance ${s.allowance.per_period}`);
      const problems = [...v.problems, ...chain];
      upd((d) => {
        const a = (d.accounts[key] ||= { exec: v.exec, payer: s.id, agent: v.payer.id, ref: s.allowance?.ref || s.mandate || null, per_period: s.allowance?.per_period ?? null, period: s.period, currency: s.currency, seq: 0, last: null, balance: null, n: 0, total: 0, balances: [], hashes: [] });
        a.seq = Number(s.seq); a.last = h; a.balance = r2(Number(s.balance_after)); a.n++; a.total = r2(a.total + Number(s.amount)); a.balances.push(a.balance); a.balances = a.balances.slice(-500); a.hashes.push(h); a.hashes = a.hashes.slice(-500);
        d.rows.push({ id: vc.id, hash: h, exec: v.exec, payer: s.id, agent: v.payer.id, period: s.period, seq: Number(s.seq), amount: Number(s.amount), balance_after: a.balance, ok: !problems.length, problems, at: new Date().toISOString() }); d.rows = d.rows.slice(-50000);
        if (problems.length) { d.anomalies.push({ exec: v.exec, agent: v.payer.id, receipt: vc.id, problems, at: new Date().toISOString() }); d.anomalies = d.anomalies.slice(-5000); }
      });
      out.push({ id: vc.id, accepted: true, problems });
    }
    return { received: receipts.length, accepted: out.filter((x) => x.accepted).length, with_problems: out.filter((x) => x.problems?.length).length, results: out };
  }

  // проверка из комментария: в счёте без сброса N положительных списаний должны дать N разных, строго убывающих остатков,
  // последний — предел минус сумма
  function liveness(acc, perPeriod = acc.per_period ?? null) {
    const b = acc.balances || [], distinct = new Set(b).size, falling = b.every((x, i) => i === 0 || x < b[i - 1]);
    const expectLast = perPeriod != null ? r2(perPeriod - acc.total) : null;
    return { debits: acc.n, distinct_balances: distinct, strictly_falling: falling, last_balance: acc.balance, expected_last: expectLast, ok: distinct === acc.n && falling && (expectLast == null || expectLast === acc.balance) };
  }

  // что агент заявляет о своих тратах за период — сверка с квитанциями всей семьи (агент и его потомки)
  function claim(agentId, { period, total, count = null, currency = null } = {}) {
    const rec = orch.get(agentId);
    if (period == null || !(Number(total) >= 0)) throw err(400, "period и total: за какой период и сколько агент потратил по своим словам");
    const r = reconcile(rec, period, { claimed: Number(total), count, currency: currency ? String(currency).toUpperCase() : rec.allowance?.currency || null });
    upd((d) => { (d.claims[rec.id] ||= {})[String(period)] = { total: Number(total), count, at: new Date().toISOString(), result: r.verdict }; });
    if (r.verdict === "hidden_spending") notify(rec, { title: `Агент «${rec.name}»: траты больше заявленных`, text: `${r.why_ru}` }).catch?.(() => {});
    return r;
  }
  // деньги сверяются в одной валюте; квитанции на число действий (ACTIONS) в денежную сверку не идут
  function reconcile(rec, period, { claimed = null, count = null, currency = null } = {}) {
    const fam = familyOf(rec), dids = new Set(fam.map((a) => a.did));
    const accs = Object.values(st().accounts).filter((a) => dids.has(a.payer) && String(a.period) === String(period) && a.currency !== "ACTIONS" && (!currency || a.currency === currency));
    const confirmed = r2(accs.reduce((s, a) => s + a.total, 0)), n = accs.reduce((s, a) => s + a.n, 0);
    const byMember = fam.map((a) => ({ agent: a.id, did: a.did, child: a.id !== rec.id, confirmed: r2(accs.filter((x) => x.payer === a.did).reduce((s, x) => s + x.total, 0)) })).filter((x) => x.confirmed > 0);
    const anomalies = st().anomalies.filter((x) => fam.some((a) => a.id === x.agent)).length;
    let verdict = "no_claim", why = null, why_ru = null;
    if (claimed != null) {
      if (confirmed > claimed + 0.01) { verdict = "hidden_spending"; why = `receipts signed by executors show ${confirmed} spent in period ${period}${byMember.some((x) => x.child) ? " (including descendants)" : ""}, the agent claims ${claimed}`; why_ru = `по квитанциям исполнителей за период ${period} потрачено ${confirmed}${byMember.some((x) => x.child) ? " (вместе с потомками)" : ""}, а агент заявляет ${claimed}`; }
      else if (claimed > confirmed + 0.01) { verdict = "partly_unconfirmed"; why = `${confirmed} of the ${claimed} the agent claims is confirmed by receipts, the rest is the agent's word`; why_ru = `из заявленных ${claimed} квитанциями подтверждено ${confirmed}, остальное со слов агента`; }
      else { verdict = "matches"; why = `the claim matches the receipts (${confirmed})`; why_ru = `заявленное совпадает с квитанциями (${confirmed})`; }
    }
    const over = rec.allowance && confirmed > rec.allowance.per_period ? { allowance: rec.allowance.per_period, spent: confirmed } : null;
    return { agent: rec.id, period, claimed, claimed_count: count, confirmed_by_receipts: confirmed, family_over_allowance: over, debits: n, family: byMember, executors: [...new Set(accs.map((a) => a.exec))], receipt_anomalies: anomalies, verdict, why, why_ru, accounts: accs.map((a) => ({ exec: a.exec, payer: a.payer, ref: a.ref, debits: a.n, total: a.total, liveness: liveness(a) })) };
  }

  // сводка для оценки агента: что подтверждено независимо, что со слов агента, найденные скрытые траты, замечания к квитанциям
  function summary(agentId) {
    const rec = orch.get(agentId), cl = st().claims[rec.id] || {}, periods = new Set([...Object.keys(cl), ...Object.values(st().accounts).filter((a) => familyOf(rec).some((m) => m.did === a.payer)).map((a) => String(a.period))]);
    const rows = [...periods].sort().map((p) => reconcile(rec, p, { claimed: cl[p]?.total ?? null }));
    return {
      agent: rec.id, periods: rows.map(({ accounts, ...r }) => r),
      confirmed_total: r2(rows.reduce((s, r) => s + r.confirmed_by_receipts, 0)), claimed_total: r2(rows.reduce((s, r) => s + (r.claimed || 0), 0)),
      hidden_spending_periods: rows.filter((r) => r.verdict === "hidden_spending").length, unconfirmed_periods: rows.filter((r) => r.verdict === "partly_unconfirmed").length,
      receipt_anomalies: st().anomalies.filter((x) => familyOf(rec).some((a) => a.id === x.agent)).length,
      note: "Only spending with receipts signed by the executor is confirmed. Spending nobody signed is the agent's own word.",
      note_ru: "Подтверждены только траты с квитанциями, подписанными исполнителем. Остальное — со слов агента.",
    };
  }
  const accountsOf = (agentId) => { const rec = orch.get(agentId), dids = new Set(familyOf(rec).map((a) => a.did)); return Object.values(st().accounts).filter((a) => dids.has(a.payer)).map(({ hashes, ...a }) => ({ ...a, liveness: liveness(a) })); };

  // свои квитанции оркестратора — за то, что прошло через его шлюз
  const ownSigner = { did: issuer.did, vm: issuer.vm, privateKey: issuer.privateKey, context: ["https://www.w3.org/ns/credentials/v2", `${publicUrl}/ns/v0`] };
  async function issueOwn(args) {
    const chains = store.get("receipt_chains_own", {}), vc = createReceiptWriter(ownSigner, chains)(args);
    store.put("receipt_chains_own", chains); await submit({ receipts: [vc] }); return vc;
  }
  // лимит семьи: у потомков лимиты выделяются из лимита родителя, вместе не больше
  function setAllowance(agentId, { per_period, currency = "RUB" } = {}) {
    const rec = orch.get(agentId), v = Number(per_period);
    if (!(v >= 0)) throw err(400, "per_period: сколько агенту можно тратить за период");
    if (rec.parent) { const p = store.get("agents", {})[rec.parent], sib = familyOf(p).filter((a) => a.parent === p.id && a.id !== rec.id).reduce((s, a) => s + (a.allowance?.per_period || 0), 0);
      if (!p.allowance) throw err(409, "сначала задайте лимит родителю: лимит потомка выделяется из него");
      if (sib + v > p.allowance.per_period) throw err(409, `лимит потомков не может быть больше лимита родителя: родителю ${p.allowance.per_period}, другим потомкам уже ${sib}`); }
    store.update("agents", {}, (a) => { a[rec.id].allowance = { per_period: v, currency: String(currency).toUpperCase().slice(0, 3), set_at: new Date().toISOString() }; });
    return { agent: rec.id, allowance: store.get("agents", {})[rec.id].allowance };
  }

  return { submit, claim, reconcile, summary, accountsOf, liveness, issueOwn, verifyOne, setAllowance };
}

export function mountReceipts(app, { receipts, wrap, ownerAuth, limit }) {
  app.post("/v1/receipts", wrap((req) => { limit(req, 600, 3600_000, "receipts"); return receipts.submit(req.body || {}); }));
  app.post("/v1/agents/:id/spend-claims", wrap(async (req) => { await ownerAuth(req, req.params.id); return receipts.claim(req.params.id, req.body || {}); }));
  app.get("/v1/agents/:id/spend", wrap((req) => receipts.summary(req.params.id)));
  app.post("/v1/agents/:id/allowance", wrap(async (req) => { await ownerAuth(req, req.params.id); return receipts.setAllowance(req.params.id, req.body || {}); }));
  app.get("/v1/agents/:id/receipt-accounts", wrap(async (req) => { await ownerAuth(req, req.params.id); return receipts.accountsOf(req.params.id); }));
}
