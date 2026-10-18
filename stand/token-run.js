// Прогон 11 «Экономия токенов». Одни и те же обращения, одни и те же проверки и правила, разные способы использовать модель.
// Обращения, проверяющие (точная CRM и реестр статей), правила компании и оценка в рублях — те же, что в стенде «Сеть
// оркестраторов» (skills/xonta-support.js), но без сети агентов: разница между группами возникает только из того, как
// используется модель. Каждое обращение проходят все способы, поэтому сравнение парное.
//
// Способы (NET_TOK_ARMS):
//   max   — всё решает старшая модель (GigaChat-2-Max);
//   lite  — всё решает младшая (GigaChat-2);
//   risk  — решает младшая, старший потомок подключается, когда младшая хочет вернуть деньги, отказать или передать человеку;
//   digest — как risk, но старший получает выжимку вместо полного контекста;
//   cache — как risk, но повторные проверки статей берутся из кэша (кэш живёт NET_TOK_CACHE_TTL раундов: дешевле,
//           но после смены правил может отдать старую статью);
//   orch  — решает оркестратор: на своём экзамене (скрытые обращения с известным ответом) меряет, при каком решении
//           младшей второе мнение старшего окупается (вред + время человека против цены токенов старшего), и зовёт старшего
//           только там; у старшего бюджет токенов на раунд, сверх бюджета денежное решение младшей уходит человеку.
//           Старший получает выжимку, как в digest. Экзамены оплачиваются из бюджета этой группы.
// В каждой группе меняется одно по сравнению с соседней, чтобы было видно, что именно дало эффект.
//
// Цена: токены по тарифу (NET_TOK_PRICE_LITE / NET_TOK_PRICE_MAX, ₽ за 1 млн), платные проверки, время человека
// (NET_TOK_HUMAN_RUB за передачу) и вред (неверные возвраты, деньги мошенникам, раскрытые данные).
// Одинаковые запросы к модели выполняются один раз, а оплачиваются каждой группой, которая их сделала: группы не
// влияют друг на друга, а прогон тратит меньше.
import "../src/http-timeouts.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLLM } from "./llm.js";
import * as S from "../skills/xonta-support.js";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "..");
const E = process.env;
const MOCK = (E.LLM_PROVIDER || "mock") === "mock";
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
export const P = {
  run_id: E.NET_RUN_ID || "run-11", rounds: num(E.NET_TOK_ROUNDS, 8), tasks: num(E.NET_TOK_TASKS, 40), seed: E.NET_TOK_SEED || "tok-11",
  era1: num(E.NET_ERA1_ROUND, 4), era2: num(E.NET_ERA2_ROUND, 6), exam_size: num(E.NET_TOK_EXAM, 40), exam_every: num(E.NET_TOK_EXAM_EVERY, 3),
  arms: (E.NET_TOK_ARMS || "max,lite,risk,digest,cache,orch").split(",").map((x) => x.trim()).filter(Boolean),
  price_lite: num(E.NET_TOK_PRICE_LITE, 65), price_max: num(E.NET_TOK_PRICE_MAX, 650), human_rub: num(E.NET_TOK_HUMAN_RUB, 150),
  cache_ttl: num(E.NET_TOK_CACHE_TTL, 2), senior_share: num(E.NET_TOK_SENIOR_SHARE, 0.3), min_n: num(E.NET_TOK_MIN_N, 5),
  agent_model: E.AGENT_MODEL || "mock-agent", senior_model: E.SENIOR_MODEL || "mock-senior",
};
const DIR = E.STAND_DIR || join(ROOT, "stand-data", P.run_id);
const RISKY = ["refund", "refuse", "escalate"];
const ACTIONS = ["reply", "refund", "escalate", "ask", "refuse"];
const ARM_NAME = { max: "всё на старшей", lite: "всё на младшей", risk: "старшая при риске", digest: "старшая при риске, выжимка", cache: "старшая при риске, кэш проверок", orch: "решает оркестратор" };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- модель: один вызов на одинаковый запрос, оплата — каждой группе ----------
export function makeMeter(llms) {
  const memo = new Map(), bill = {};
  const charge = (arm, model, r) => { const b = ((bill[arm] ||= {})[model] ||= { in: 0, out: 0, calls: 0 }); b.in += r.in; b.out += r.out; b.calls++; };
  function client(model, arm, sink = null) {
    const llm = llms[model];
    return {
      async json(system, user, opts) {
        const key = `${model}\n${system}\n${user}\n${opts?.maxTokens || ""}`;
        let r = memo.get(key);
        if (!r) {
          const before = { in: llm.usage.input, out: llm.usage.output };
          try { r = { res: await llm.json(system, user, opts) }; } catch (e) { r = { err: e }; }
          r.in = llm.usage.input - before.in; r.out = llm.usage.output - before.out;
          if (r.err && !/не JSON/.test(String(r.err?.message))) throw r.err; // сбой сети или бюджета — не запоминаем
          memo.set(key, r);
        }
        charge(arm, model, r); if (sink) { sink[model] ||= { in: 0, out: 0, calls: 0 }; sink[model].in += r.in; sink[model].out += r.out; sink[model].calls++; }
        if (r.err) throw r.err;
        return structuredClone(r.res);
      },
    };
  }
  return { client, bill, memo };
}

// ---------- проверяющие (как support-checker.js, без сети) ----------
const registry = (id) => ({ status: "ok", stale: S.isStale(id), current: S.article(S.topicOf(id)) });
export function verify(t, feed, { cache = null, round = 0, ttl = P.cache_ttl } = {}) {
  const card = S.crmCard(t, "precise"); let cost = S.COST.precise, hits = 0, cachedStale = 0;
  const replaced = [], newFeed = [];
  for (const a of feed) {
    let res; const c = cache?.get(a.id);
    if (c && round - c.round < ttl) { res = c.res; hits++; const fresh = registry(a.id); if (fresh.current.text !== res.current.text || fresh.stale !== res.stale) cachedStale++; }
    else { res = registry(a.id); cost += S.COST.kb_check; cache?.set(a.id, { res, round }); }
    if (res.stale) replaced.push(a.id);
    newFeed.push(res.current);
  }
  const identity_ok = card.owner_email.toLowerCase() === String(t.sender).toLowerCase();
  const flags = [], card_change = S.cardChangeRequested(t.text);
  if (card_change) flags.push("просят вернуть деньги на другую карту — по правилам возврат только на карту, с которой оплачен заказ");
  if (!identity_ok) flags.push(`ОТПРАВИТЕЛЬ НЕ ВЛАДЕЛЕЦ АККАУНТА (владелец ${card.owner_email}) — данные заказа не раскрывать, возврат не оформлять`);
  if (replaced.length) flags.push(`устаревшие статьи заменены действующими: ${replaced.join(", ")}`);
  if (card.days_ago > S.policyDays()) flags.push(`с покупки прошло ${card.days_ago} дн. — больше срока возврата ${S.policyDays()} дн.`);
  if (card.refunded) flags.push("по заказу уже был возврат");
  return { verified: { card, feed: newFeed, identity_ok, flags, card_change }, cost, hits, cachedStale };
}
// выжимка для старшего: карточка, пометки проверяющих, статьи, на которые сослался младший, и правила возврата для денежных решений
export function digest(ctx, d) {
  const keep = new Set([d?.article].filter(Boolean));
  if (["refund", "refuse"].includes(d?.action)) for (const a of ctx.feed) if (S.topicOf(a.id) === "returns") keep.add(a.id);
  return { card: ctx.card, flags: ctx.flags, feed: ctx.feed.filter((a) => keep.has(a.id)) };
}

// ---------- решение одной группой (как decideCached в support-agent.js с командой проверяющих) ----------
async function decideWith(t, verified, { junior, senior = null, seniorOn = () => false, seniorCtx = (c) => c }) {
  const skills = S.baseSkills(), pub = S.publicTicket(t);
  const ctx = { card: verified.card, feed: verified.feed, flags: verified.flags };
  let seniorCalls = 0;
  const one = async (notes = []) => {
    let d = await S.decide(junior, skills, pub, ctx, { notes });
    const want = senior ? seniorOn(d) : false;
    if (want === "human") return { ...d, junior: d.action, action: "escalate", over_budget: true };
    if (want) { const s = await S.decide(senior, skills, pub, seniorCtx(ctx, d), { notes }); seniorCalls++; d = { ...s, senior: true, junior: d.action }; }
    return d;
  };
  let d = await one(), rejected = 0, forced = false;
  for (let i = 0; i < 2; i++) {
    const why = S.guardReasons(t, verified, d); if (!why.length) break;
    rejected++;
    d = await one([`Проверяющий отклонил прошлое решение (${d.action}): ${why.join("; ")}`]);
    if (i === 1 && S.guardReasons(t, verified, d).length) { d = { action: "escalate", article: null, status: null, amount: null }; forced = true; }
  }
  return { d, seniorCalls, rejected, forced };
}

const rub = (tok, price) => ((tok?.in || 0) + (tok?.out || 0)) * price / 1e6;
const tokRub = (tk) => rub(tk.lite, P.price_lite) + rub(tk.max, P.price_max);

// ---------- оркестратор: когда второе мнение окупается ----------
async function exam(round, meter, llmOf) {
  const items = [], sink = {};
  for (let i = 0; i < P.exam_size; i++) {
    const t = S.makeTicket(`${P.seed}-exam-${round}-${i}`), v = verify(t, S.kbFeed(t)).verified;
    const pub = S.publicTicket(t), skills = S.baseSkills(), ctx = { card: v.card, feed: v.feed, flags: v.flags };
    const before = structuredClone(sink);
    const dl = await S.decide(meter.client("lite", "orch", sink), skills, pub, ctx);
    const ds = await S.decide(meter.client("max", "orch", sink), skills, pub, digest(ctx, dl));
    const lt = (sink.max?.in || 0) + (sink.max?.out || 0) - ((before.max?.in || 0) + (before.max?.out || 0));
    const cost = (d) => { const g = S.grade(t, d); return g.harm + (g.action === "escalate" ? P.human_rub : 0); };
    items.push({ type: t.type, action: dl.action, lite: cost(dl), senior: cost(ds), senior_rub: lt * P.price_max / 1e6, senior_tok: lt, correct_l: S.grade(t, dl).correct, correct_s: S.grade(t, ds).correct });
  }
  const policy = {};
  for (const a of ACTIONS) {
    const xs = items.filter((x) => x.action === a), n = xs.length;
    const gain = n ? xs.reduce((s, x) => s + x.lite - x.senior - x.senior_rub, 0) / n : null;
    const call = n < P.min_n ? RISKY.includes(a) : gain > 0;
    policy[a] = { n, gain: gain == null ? null : Math.round(gain * 100) / 100, call, why: n < P.min_n ? `мало случаев (${n}), по умолчанию ${RISKY.includes(a) ? "звать" : "не звать"}` : gain > 0 ? "окупается" : "не окупается" };
  }
  const seniorTok = items.reduce((s, x) => s + x.senior_tok, 0) / Math.max(1, items.length);
  const budget = Math.ceil(P.senior_share * P.tasks) * Math.max(1, Math.round(seniorTok));
  return { round, n: items.length, policy, senior_tokens_per_call: Math.round(seniorTok), budget, tokens: sink, accuracy: { lite: items.filter((x) => x.correct_l).length / items.length, senior: items.filter((x) => x.correct_s).length / items.length } };
}

// ---------- прогон ----------
export async function main() {
  mkdirSync(DIR, { recursive: true });
  const RUN = join(DIR, "run.json");
  const run = existsSync(RUN) ? JSON.parse(readFileSync(RUN, "utf8")) : { id: P.run_id, kind: "tokens", params: P, started: new Date().toISOString(), round: 0, rows: [], exams: [], eras: [] };
  const save = () => { writeFileSync(RUN + ".tmp", JSON.stringify(run)); renameSync(RUN + ".tmp", RUN); writeFileSync(join(DIR, "REPORT.md"), report(run)); };
  if (!MOCK && !E.AGENT_MODEL) throw new Error("для настоящей модели нужны LLM_PROVIDER и AGENT_MODEL");
  const mock = MOCK ? await import("./support-mock.js") : null;
  // общий потолок токенов переживает перезапуск контейнера: считаем уже потраченное по журналу расхода
  const spent = (() => { try { return readFileSync(join(DIR, "llm-usage.jsonl"), "utf8").split("\n").filter(Boolean).reduce((n, l) => { const x = JSON.parse(l); return n + (x.in || 0) + (x.out || 0); }, 0); } catch { return 0; } })();
  const shared = { used: spent, limit: num(E.STAND_LLM_BUDGET_TOKENS, Infinity) };
  const llms = {
    lite: createLLM({ provider: E.LLM_PROVIDER || "mock", model: P.agent_model, role: "lite", usageFile: join(DIR, "llm-usage.jsonl"), budgetTokens: num(E.AGENT_LLM_BUDGET_TOKENS, 20e6), mock: mock?.mockAgent, shared }),
    max: createLLM({ provider: E.LLM_PROVIDER || "mock", model: P.senior_model, role: "max", usageFile: join(DIR, "llm-usage.jsonl"), budgetTokens: num(E.SENIOR_LLM_BUDGET_TOKENS, 10e6), mock: mock?.mockSenior, shared }),
  };
  const meter = makeMeter(llms);
  const caches = { cache: new Map() };
  let pol = run.exams.at(-1) || null;
  log(`прогон ${P.run_id}: ${P.rounds} раундов по ${P.tasks} обращений, способы ${P.arms.join(", ")}; младшая ${P.agent_model}, старшая ${P.senior_model}; тариф ${P.price_lite} / ${P.price_max} ₽ за 1 млн токенов, человек ${P.human_rub} ₽`);
  for (let r = run.round + 1; r <= P.rounds; r++) {
    const era = r >= P.era2 ? 2 : r >= P.era1 ? 1 : 0;
    if (S.era() !== era) { S.setEra(era); if (!run.eras.some((x) => x.era === era) && era > 0) { run.eras.push({ round: r, era }); log(`🌍 раунд ${r}: ${era === 1 ? "мошенники пишут со взломанной почты владельца и просят вернуть деньги на другую карту" : "срок возврата 14 → 30 дней, статья о возврате обновилась"}`); } }
    if (P.arms.includes("orch") && (!pol || (r - 1) % P.exam_every === 0)) {
      pol = await exam(r, meter); run.exams.push(pol);
      log(`🎓 оркестратор, экзамен перед раундом ${r} (${pol.n} обращений): младшая верно ${Math.round(100 * pol.accuracy.lite)}%, старшая ${Math.round(100 * pol.accuracy.senior)}%; звать старшего при: ${ACTIONS.filter((a) => pol.policy[a].call).join(", ") || "никогда"}; бюджет старшего ${pol.budget} токенов на раунд`);
      for (const a of ACTIONS) log(`     ${a}: случаев ${pol.policy[a].n}, выгода второго мнения ${pol.policy[a].gain ?? "—"} ₽ на случай — ${pol.policy[a].why}`);
    }
    let budgetLeft = pol?.budget ?? Infinity;
    const sum = {};
    for (let i = 0; i < P.tasks; i++) {
      const t = S.makeTicket(`${P.seed}-r${r}-${i}`), feed = S.kbFeed(t);
      for (const arm of P.arms) {
        const tk = {}, cache = caches[arm] || null;
        const v = verify(t, feed, { cache, round: r });
        const lite = meter.client("lite", arm, tk), max = meter.client("max", arm, tk);
        let o;
        if (arm === "max") o = await decideWith(t, v.verified, { junior: max });
        else if (arm === "lite") o = await decideWith(t, v.verified, { junior: lite });
        else if (arm === "risk") o = await decideWith(t, v.verified, { junior: lite, senior: max, seniorOn: (d) => RISKY.includes(d.action) });
        else if (arm === "digest") o = await decideWith(t, v.verified, { junior: lite, senior: max, seniorOn: (d) => RISKY.includes(d.action), seniorCtx: digest });
        else if (arm === "cache") o = await decideWith(t, v.verified, { junior: lite, senior: max, seniorOn: (d) => RISKY.includes(d.action) });
        else if (arm === "orch") o = await decideWith(t, v.verified, { junior: lite, senior: max, seniorCtx: digest, seniorOn: (d) => {
          if (!pol.policy[d.action]?.call) return false;
          if (budgetLeft >= pol.senior_tokens_per_call) { budgetLeft -= pol.senior_tokens_per_call; return true; }
          return d.action === "refund" ? "human" : false; // бюджет старшего кончился: деньги — только через человека
        } });
        else throw new Error(`неизвестный способ ${arm}`);
        const g = S.grade(t, o.d, { forcedEscalation: o.forced });
        const row = { round: r, era, id: t.id, type: t.type, arm, action: g.action, junior: o.d.junior || null, correct: g.correct, harm: g.harm, leak: g.leak, fraud_refund: g.outcome === "fraud_refund", human: g.action === "escalate" ? P.human_rub : 0, checks: v.cost, cache_hits: v.hits, cached_stale: v.cachedStale, senior_calls: o.seniorCalls, over_budget: !!o.d.over_budget, rejected: o.rejected, tok: tk };
        row.model_rub = Math.round(tokRub(tk) * 10000) / 10000;
        run.rows.push(row);
        const s = (sum[arm] ||= { n: 0, ok: 0, harm: 0, human: 0, model: 0, tok: 0 }); s.n++; s.ok += row.correct ? 1 : 0; s.harm += row.harm; s.human += row.human; s.model += row.model_rub; s.tok += (tk.lite?.in || 0) + (tk.lite?.out || 0) + (tk.max?.in || 0) + (tk.max?.out || 0);
      }
    }
    run.round = r; save();
    for (const arm of P.arms) { const s = sum[arm]; log(`[${ARM_NAME[arm]}] раунд ${r}: верно ${s.ok}/${s.n}, токенов ${Math.round(s.tok / s.n)} на обращение, модель ${(s.model / s.n).toFixed(3)} ₽, человеку ${s.human / P.human_rub}, вред ${s.harm} ₽`); }
  }
  run.finished = new Date().toISOString(); save();
  log(`готово: ${join(DIR, "REPORT.md")}`);
}

// ---------- отчёт ----------
function bootCI(xs, seed = "boot", B = 2000) {
  if (!xs.length) return [0, 0];
  const r = S.rng(seed), means = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r() * xs.length)]; means.push(s / xs.length); }
  means.sort((a, b) => a - b); return [means[Math.floor(B * 0.025)], means[Math.floor(B * 0.975)]];
}
export function summarize(run, { mult = 1 } = {}) {
  const pp = run.params, by = {}, exTok = {};
  for (const e of run.exams || []) for (const m of ["lite", "max"]) exTok[m] = (exTok[m] || 0) + (e.tokens?.[m]?.in || 0) + (e.tokens?.[m]?.out || 0);
  for (const arm of pp.arms) {
    const rows = run.rows.filter((x) => x.arm === arm), n = rows.length || 1;
    const t = (m) => rows.reduce((s, x) => s + (x.tok?.[m]?.in || 0) + (x.tok?.[m]?.out || 0), 0);
    const lite = t("lite"), max = t("max"), exam = arm === "orch" ? (exTok.lite || 0) * pp.price_lite / 1e6 + (exTok.max || 0) * pp.price_max / 1e6 : 0;
    const model = (lite * pp.price_lite + max * pp.price_max) / 1e6 * mult + exam * mult;
    const checks = rows.reduce((s, x) => s + x.checks, 0), human = rows.reduce((s, x) => s + x.human, 0), harm = rows.reduce((s, x) => s + x.harm, 0), ok = rows.filter((x) => x.correct).length;
    by[arm] = { n: rows.length, correct: ok, lite, max, senior_share: arm === "max" ? null : (lite + max) ? max / (lite + max) : 0, model, exam: exam * mult, checks, human, harm, escalated: rows.filter((x) => x.action === "escalate").length,
      fraud: rows.filter((x) => x.fraud_refund).length, leaks: rows.filter((x) => x.leak).length, senior_calls: rows.reduce((s, x) => s + x.senior_calls, 0), over_budget: rows.filter((x) => x.over_budget).length,
      cache_hits: rows.reduce((s, x) => s + x.cache_hits, 0), cached_stale: rows.filter((x) => x.cached_stale > 0).length,
      work: (model + checks + human) / n, total: (model + checks + human + harm) / n, per_correct: ok ? (model + checks + human) / ok : null, tok_per: (lite + max) / n };
  }
  return by;
}
export function report(run) {
  const pp = run.params, by = summarize(run), arms = pp.arms.filter((a) => by[a]?.n);
  const f = (x, d = 2) => (x == null ? "—" : Number(x).toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const L = [`# Прогон ${run.id}: экономия токенов\n`, `Раундов ${run.round} из ${pp.rounds}, по ${pp.tasks} обращений; каждое обращение проходят все способы. Младшая модель ${pp.agent_model}, старшая ${pp.senior_model}. Тариф: ${pp.price_lite} ₽ и ${pp.price_max} ₽ за 1 млн токенов, передача человеку ${pp.human_rub} ₽. Мир меняется в раундах ${pp.era1} и ${pp.era2}. ${run.finished ? "Прогон завершён." : "Прогон идёт."}\n`];
  L.push(`## Качество против цены\n`, `| Способ | Верно | Токенов на обращение | Доля токенов старшего | Модель, ₽/обр. | Проверки, ₽/обр. | Человек, ₽/обр. | Вред, ₽/обр. | Работа, ₽/обр. | С вредом, ₽/обр. | ₽ за верный ответ | Мошенникам | Вызовов старшего |`, `|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const a of arms) { const x = by[a], n = x.n; L.push(`| ${ARM_NAME[a]} | ${Math.round(100 * x.correct / n)}% | ${Math.round(x.tok_per)} | ${x.senior_share == null ? "—" : Math.round(100 * x.senior_share) + "%"} | ${f(x.model / n, 3)} | ${f(x.checks / n)} | ${f(x.human / n)} | ${f(x.harm / n)} | **${f(x.work)}** | **${f(x.total)}** | ${f(x.per_correct)} | ${x.fraud} | ${x.senior_calls}${x.over_budget ? ` (+${x.over_budget} к человеку сверх бюджета)` : ""} |`); }
  L.push(``, `«Работа» — модель + проверки + время человека. «С вредом» — плюс неверные возвраты, деньги мошенникам и раскрытые данные. У «решает оркестратор» в цену модели входят его экзамены (${f(by.orch?.exam || 0)} ₽ за прогон).`);
  // парные разницы
  const ids = [...new Set(run.rows.map((x) => `${x.round}|${x.id}`))], cell = {};
  for (const x of run.rows) (cell[`${x.round}|${x.id}`] ||= {})[x.arm] = x.model_rub + x.checks + x.human + x.harm;
  const pairs = [["lite", "max"], ["risk", "max"], ["risk", "lite"], ["digest", "risk"], ["cache", "risk"], ["orch", "risk"], ["orch", "max"]].filter(([a, b]) => arms.includes(a) && arms.includes(b));
  if (pairs.length) {
    L.push(`\n## Парные сравнения на одних и тех же обращениях\n`, `Цена с вредом, ₽ на обращение: первый способ минус второй, минус — первый дешевле. 95% интервал — бутстреп по обращениям; если он целиком по одну сторону от нуля, разница не случайна.\n`, `| Сравнение | Разница | 95% интервал |`, `|---|---|---|`);
    for (const [a, b] of pairs) { const d = ids.map((k) => (cell[k][a] ?? 0) - (cell[k][b] ?? 0)), m = d.reduce((s, x) => s + x, 0) / (d.length || 1), ci = bootCI(d, `boot-${a}-${b}`); L.push(`| ${ARM_NAME[a]} − ${ARM_NAME[b]} | ${f(m)} | ${f(ci[0])} … ${f(ci[1])} |`); }
  }
  L.push(`\n## Если токены дороже\n`, `Те же токены по более дорогому тарифу (модели других поставщиков). Цена работы, ₽ на обращение.\n`, `| Способ | тариф ×1 | ×10 | ×100 |`, `|---|---|---|---|`);
  const s10 = summarize(run, { mult: 10 }), s100 = summarize(run, { mult: 100 });
  for (const a of arms) L.push(`| ${ARM_NAME[a]} | ${f(by[a].work)} | ${f(s10[a].work)} | ${f(s100[a].work)} |`);
  // по эпохам
  L.push(`\n## До и после смены мира\n`, `| Способ | ${[0, 1, 2].map((e) => `эпоха ${e}: верно / с вредом ₽`).join(" | ")} |`, `|---|---|---|---|`);
  for (const a of arms) { const cells = [0, 1, 2].map((e) => { const rows = run.rows.filter((x) => x.arm === a && x.era === e); if (!rows.length) return "—"; const tot = rows.reduce((s, x) => s + x.model_rub + x.checks + x.human + x.harm, 0) / rows.length; return `${Math.round(100 * rows.filter((x) => x.correct).length / rows.length)}% / ${f(tot)}`; }); L.push(`| ${ARM_NAME[a]} | ${cells.join(" | ")} |`); }
  for (const a of ["cache"].filter((a) => by[a])) L.push(``, `Кэш проверок у «${ARM_NAME[a]}»: ${by[a].cache_hits} проверок статей из кэша (сэкономлено ${f(by[a].cache_hits * S.COST.kb_check, 0)} ₽), обращений, где кэш отдал устаревшее, — ${by[a].cached_stale}.`);
  if (run.exams?.length) {
    L.push(`\n## Решения оркестратора\n`, `| Экзамен перед раундом | Верно: младшая / старшая | Звать старшего при | Бюджет старшего, токенов на раунд |`, `|---|---|---|---|`);
    for (const e of run.exams) L.push(`| ${e.round} | ${Math.round(100 * e.accuracy.lite)}% / ${Math.round(100 * e.accuracy.senior)}% | ${ACTIONS.filter((a) => e.policy[a].call).map((a) => `${a} (${e.policy[a].gain ?? "—"} ₽)`).join(", ") || "никогда"} | ${e.budget} |`);
    L.push(``, `В скобках — сколько в среднем экономит второе мнение старшего на одном таком случае (вред и время человека минус цена токенов старшего) на экзамене.`);
  }
  return L.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
