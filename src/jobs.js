// Массовые задачи (0.17): агент гоняет платный поиск, обогащение или любую обработку по длинному списку. Лимит бюджета тут
// не помогает: каждая строка может быть оплачена правильно, а весь список не подходит к задаче (разбор 103 прогонов на dev.to:
// номер найден у 1,28% строк при 14–26% у подходящих списков). Оркестратор следит за долей успехов на ходу.
//
// Как это устроено.
//  1. Задача. Агент заявляет объём, что считать успехом, порог доли успехов, цену (за найденную строку или за любую) и предельную
//     порцию. Владелец подтверждает это своим ключом, оркестратор выдаёт подписанный мандат задачи JobMandate.
//  2. Каждые 100 строк (окно) оркестратор считает долю успехов и прогноз на остаток вилкой: сколько будет успехов, сколько
//     это стоит, сколько займёт времени, какая доля ошибок. Прогноз приходит в каждом ответе.
//  3. Если доля в окне ниже порога, оркестратор советует уведомить пользователя и спросить, продолжать ли. Мандат
//     приостанавливается (статус аттестата suspension), шлюз не пропускает вызовы задачи до решения владельца.
//  4. Решение владельца — новый мандат с границами («продолжать, пока доля не ниже 3% и траты не выше 200»). Дальше
//     оркестратор спрашивает снова только при выходе за границы или если доля заметно ушла вниз от той, на которой
//     владелец согласился. Иначе на пограничном списке (6% при пороге 5%) вопрос был бы почти каждые 100 строк.
//  5. Кто считает успехи. Если вызовы идут через шлюз оркестратора, успехи считает сам шлюз по ответу инструмента — агенту верить
//     не нужно. Если агент отчитывается сам, оркестратор после каждого отчёта случайно выбирает строки для перепроверки, и
//     проверяющий (агент другого владельца или хотя бы свой потомок) их перепроверяет. Если он не подтверждает заметно больше
//     строк, чем объясняет обычное устаревание данных, — сигнал владельцу, мандат задачи замораживается. Насколько проверяющий
//     независим, пишется прямо в итоге.
// Оркестратор только советует и приостанавливает свой мандат; останавливает ли агент работу вне шлюза, решает его владелец.
import { randomBytes } from "node:crypto";
import { binomTail } from "./guardian.js";

const err = (status, msg) => Object.assign(new Error(msg), { status });
const rid = (n = 5) => randomBytes(n).toString("hex");
const r1 = (x) => Math.round(10 * x) / 10, r2 = (x) => Math.round(100 * x) / 100;
// alpha строгий, потому что проверок много (после каждой порции): при 0.01 честный агент с 5% устаревших строк на подходящем
// списке получал ложный сигнал в четверти прогонов (сценарий lookup, 0.17). Плюс проверка по сумме всех выборок задачи
export const JOB_DEFAULTS = { floor: 0.05, window: 100, max_batch: 1000, sample: 10, stale_allow: 0.1, alpha: 0.001, alpha_single: 0.0001, max_rows: 10_000_000 };

// интервал Уилсона для доли k из n (95%)
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

// прогноз на остаток: по доле в последнем окне (она про «сейчас»), с интервалом; цена, время и ошибки — по измеренному
export function forecast(job) {
  const t = job.totals, w = job.last_window || { n: 0, k: 0 }, rem = Math.max(0, job.total_rows - t.rows);
  const [lo, hi] = wilson(w.k, w.n), p = w.n ? w.k / w.n : null;
  const per = job.price?.per === "row" ? "row" : "found", price = Number(job.price?.amount || 0);
  const succ = p == null ? null : { low: Math.round(lo * rem), expected: Math.round(p * rem), high: Math.round(hi * rem) };
  const spendRem = per === "row" ? { low: r2(rem * price), expected: r2(rem * price), high: r2(rem * price) } : succ ? { low: r2(succ.low * price), expected: r2(succ.expected * price), high: r2(succ.high * price) } : null;
  const secPerRow = t.rows && t.elapsed_sec ? t.elapsed_sec / t.rows : null;
  return {
    rows_done: t.rows, rows_left: rem, window_rate: p == null ? null : r1(100 * p), window_rate_ci: p == null ? null : [r1(100 * lo), r1(100 * hi)], rate_so_far: t.rows ? r1(100 * t.successes / t.rows) : null,
    successes_left: succ, successes_total_expected: succ ? t.successes + succ.expected : null,
    currency: job.price?.currency || null, spent_so_far: r2(job.spent), spend_left: spendRem,
    hours_left: secPerRow ? r1(rem * secPerRow / 3600) : null,
    errors_share: t.rows ? r1(100 * (t.errors || 0) / t.rows) : null, stale_share: t.rows ? r1(100 * (t.stale || 0) / t.rows) : null,
    cost_per_success: t.successes ? r2(job.spent / t.successes) : null,
    rate_since_decision: job.approval && job.since?.n ? r1(100 * job.since.k / job.since.n) : undefined,
    claimed: job.verification === "agent" && !job.verified_rows ? true : undefined,
  };
}

// спрашивать ли пользователя по итогу окна
export function shouldAsk(job, win) {
  const p = win.k / win.n, a = job.approval;
  if (!a) return p < job.floor ? { ask: true, reason: "below_floor", why: `${r1(100 * p)}% successes in the last ${win.n} rows, the floor is ${r1(100 * job.floor)}%`, why_ru: `${r1(100 * p)}% успехов в последних ${win.n} строках при пороге ${r1(100 * job.floor)}%` } : { ask: false };
  // граница владельца проверяется по всем строкам после его решения: 100 строк слишком мало, чтобы уверенно сказать «ниже 3%»,
  // а самое низкое окно из многих — выбор худшего (на списке 6% при пороге 5% вопрос был бы зря в трети прогонов, сценарий lookup)
  const sn = job.since || win, [, hi] = wilson(sn.k, sn.n), ps = sn.n ? sn.k / sn.n : p;
  if (a.min_rate != null && sn.n >= win.n && hi < a.min_rate) return { ask: true, reason: "below_approved_min", why: `since your decision the rate is confidently below the ${r1(100 * a.min_rate)}% you approved (${sn.n} rows: ${r1(100 * ps)}%, at most ${r1(100 * hi)}%)`, why_ru: `после вашего решения доля уверенно ниже одобренных ${r1(100 * a.min_rate)}% (${sn.n} строк: ${r1(100 * ps)}%, не больше ${r1(100 * hi)}%)` };
  if (a.max_spend != null && job.spent > a.max_spend) return { ask: true, reason: "spend_bound", why: `spent ${r2(job.spent)} of the ${a.max_spend} you approved`, why_ru: `потрачено ${r2(job.spent)} из одобренных ${a.max_spend}` };
  const base = a.rate_at ?? job.floor, tol = 2 * Math.sqrt(Math.max(base, 0.01) * (1 - base) / win.n) + 0.02;
  if (p < base - tol) return { ask: true, reason: "dropped_since_approval", why: `the rate fell to ${r1(100 * p)}% from ${r1(100 * base)}% when you approved`, why_ru: `доля упала до ${r1(100 * p)}% с ${r1(100 * base)}%, на которых вы согласились` };
  return { ask: false };
}

// расхождение проверяющего с агентом: сколько заявленных успехов не подтвердилось сверх обычного устаревания
export function divergence({ claimed_ok, unconfirmed }, { stale_allow = JOB_DEFAULTS.stale_allow, alpha = JOB_DEFAULTS.alpha } = {}) {
  if (!claimed_ok) return { diverged: false, p: 1 };
  const p = binomTail(unconfirmed, claimed_ok, stale_allow);
  return { diverged: unconfirmed > 0 && p < alpha, p };
}

export function createJobs({ store, issuer, orch, notify = async () => {}, publicUrl, cfg = {}, receipts = null }) {
  const C = { ...JOB_DEFAULTS, ...cfg };
  const all = () => store.get("jobs", {});
  const save = (j) => store.update("jobs", {}, (x) => { x[j.id] = j; });
  function get(id) { const j = all()[id]; if (!j) throw err(404, "задача не найдена"); return j; }
  const agentOf = (j) => orch.get(j.agent);

  function mandate(j, bounds, reason) {
    return issuer.issue("JobMandate", { id: agentOf(j).did, job: j.id, name: j.name, total_rows: j.total_rows, success: j.success, floor: j.floor, max_batch: j.max_batch, price: j.price, verification: j.verification, bounds: bounds || null, reason, recommendation: true, applies: "the gateway refuses the job's calls while this mandate is suspended; outside the gateway it is advice to the owner" }, { validDays: 30, agentId: j.agent });
  }

  function create(agentId, body = {}) {
    const rec = orch.get(agentId);
    if (rec.status !== "active") throw err(409, `агент ${rec.status}: задачи не принимаются`);
    const total = Number(body.total_rows);
    if (!(total >= 1 && total <= C.max_rows)) throw err(400, `total_rows: от 1 до ${C.max_rows}`);
    const success = body.success || {};
    if (!success.description && !success.path) throw err(400, "success: что считать успехом (description, а для подсчёта шлюзом — path и equals)");
    const floor = body.floor == null ? C.floor : Number(body.floor);
    if (!(floor > 0 && floor < 1)) throw err(400, "floor: доля от 0 до 1, например 0.05");
    const price = body.price ? { per: body.price.per === "row" ? "row" : "found", amount: Number(body.price.amount) || 0, currency: String(body.price.currency || "USD").toUpperCase().slice(0, 3) } : null;
    const verification = body.verification === "gateway" ? "gateway" : "agent";
    const budget = body.budget == null ? null : Number(body.budget);
    if (budget != null && !(budget > 0)) throw err(400, "budget: сколько всего можно потратить на задачу");
    if (verification === "gateway") {
      if (!body.target || !body.tool || !success.path) throw err(400, "для подсчёта шлюзом нужны target (агент-источник у оркестратора), tool и success.path");
      orch.get(body.target);
    }
    const j = {
      id: `job_${rid()}`, agent: rec.id, name: String(body.name || "job").slice(0, 100), total_rows: total, success: { description: success.description ? String(success.description).slice(0, 200) : null, path: success.path ? String(success.path).slice(0, 100) : null, equals: success.equals ?? null },
      floor, window: Math.max(20, Math.min(1000, Number(body.window) || C.window)), max_batch: Math.max(1, Math.min(100_000, Number(body.max_batch) || C.max_batch)), price, budget, verification, target: body.target || null, tool: body.tool || null,
      status: "running", paused: null, approval: null, created: new Date().toISOString(),
      totals: { rows: 0, successes: 0, errors: 0, stale: 0, elapsed_sec: 0 }, spent: 0, buffer: { n: 0, k: 0 }, last_window: null, windows: [], asks: [], batches: 0, verified_rows: 0, pending_checks: {}, checks: [], flags: [],
    };
    const vc = mandate(j, null, "job started, the owner confirmed the success rule, floor, price and batch size");
    j.mandate = vc.id; save(j);
    issuer.event("job_created", { job: j.id, agent: rec.id, total_rows: total });
    return { job: view(j), mandate: vc, next: [`report every batch: POST ${publicUrl}/v1/jobs/${j.id}/progress`, verification === "gateway" ? `or just call the tool through the gateway, it counts successes itself` : `the orchestrator will pick rows for an independent check after each report`] };
  }

  function view(j) { return { id: j.id, agent: j.agent, name: j.name, status: j.status, paused: j.paused, approval: j.approval, floor: j.floor, window: j.window, max_batch: j.max_batch, verification: j.verification, price: j.price, success: j.success, forecast: forecast(j), asks: j.asks.length, last_ask: j.asks.at(-1) || null, checks: j.checks.slice(-5), flags: j.flags, mandate: j.mandate }; }

  // общий путь для отчёта агента и подсчёта шлюзом: добавить строки, закрыть окна, решить, спрашивать ли
  function ingest(j, { rows, successes, errors = 0, stale = 0, elapsed_sec = 0 }) {
    const spentBefore = j.spent;
    j.totals.rows += rows; j.totals.successes += successes; j.totals.errors += errors; j.totals.stale += stale; j.totals.elapsed_sec += elapsed_sec;
    if (j.price) j.spent += j.price.per === "row" ? rows * j.price.amount : successes * j.price.amount;
    j.buffer.n += rows; j.buffer.k += successes;
    j.since = { n: (j.since?.n || 0) + rows, k: (j.since?.k || 0) + successes }; // строки после последнего решения владельца (или с начала)
    let decision = null;
    // окно закрывается, когда набралось window строк; большой отчёт оценивается целиком как одно окно (доля та же)
    if (j.buffer.n >= j.window) {
      const win = { n: j.buffer.n, k: j.buffer.k, at_row: j.totals.rows };
      j.last_window = win; j.windows.push({ ...win, rate: r1(100 * win.k / win.n) }); j.windows = j.windows.slice(-200); j.buffer = { n: 0, k: 0 };
      if (!j.paused) { const d = shouldAsk(j, win); if (d.ask) decision = pause(j, d); }
    }
    if (j.totals.rows >= j.total_rows && j.status === "running") j.status = "done";
    // своя квитанция за траты задачи (0.17.2): оркестратор подписывает только то, что посчитал сам или что ему заявили по задаче,
    // с остатком бюджета задачи до и после
    const delta = Math.round(100 * (j.spent - spentBefore)) / 100;
    if (receipts && j.budget && delta > 0) receipts.issueOwn({ payer: agentOf(j).did, allowance: { ref: j.id, per_period: j.budget }, period: "job", amount: delta, currency: j.price?.currency || "USD", action: j.verification === "gateway" ? "counted_by_gateway" : "reported_by_agent", ref: j.id }).catch(() => {});
    return decision;
  }

  function pause(j, d) {
    j.paused = { reason: d.reason, why: d.why, why_ru: d.why_ru, at_row: j.totals.rows, at: new Date().toISOString() };
    const fc = forecast(j), ask = { at_row: j.totals.rows, reason: d.reason, why: d.why, forecast: fc, at: j.paused.at }; j.asks.push(ask);
    try { issuer.setStatus(j.mandate, "suspension", true, `job paused: ${d.reason}`); } catch {}
    const rec = agentOf(j), f = fc;
    const text = `${d.why_ru}. Прогноз на оставшиеся ${f.rows_left} строк: ${f.successes_left ? `${f.successes_left.low}–${f.successes_left.high} успехов` : "—"}${f.spend_left ? `, ${f.spend_left.low}–${f.spend_left.high} ${f.currency}` : ""}${f.hours_left != null ? `, около ${f.hours_left} ч` : ""}. Продолжать? POST ${publicUrl}/v1/jobs/${j.id}/decision`;
    notify(rec, { title: `Задача «${j.name}»: нужен ваш ответ`, text, job: j.id }).catch?.(() => {});
    return { recommendation: "notify_user", ...d, forecast: fc, decide: `POST ${publicUrl}/v1/jobs/${j.id}/decision {"continue":true,"min_rate":0.03,"max_spend":200} or {"continue":false}` };
  }

  // отчёт агента о порции: rows, successes, errors, stale, elapsed_sec; при самоотчёте — outcomes [{id, ok}] для выборочной проверки
  function progress(id, body = {}) {
    const j = get(id);
    if (j.status !== "running") throw err(409, `задача ${j.status}`);
    const rows = Number(body.rows), successes = Number(body.successes);
    if (!(rows >= 1 && rows <= 1e6) || !(successes >= 0 && successes <= rows)) throw err(400, "rows и successes: сколько строк в порции и сколько из них успешных");
    const out = { job: j.id };
    if (j.paused) out.warning = "the job's mandate is suspended, these rows ran without the owner's decision";
    if (rows > j.max_batch) { j.flags.push({ at_row: j.totals.rows, flag: "batch_over_mandate", rows, max_batch: j.max_batch }); out.warning = `batch of ${rows} rows is larger than the mandate allows (${j.max_batch}): a check every ${j.window} rows can't stop rows already launched`; }
    j.batches++;
    // выборка для проверки: оркестратор сам выбирает строки после отчёта, часть из заявленных успехов, часть из неуспехов
    if (j.verification === "agent" && Array.isArray(body.outcomes) && body.outcomes.length) {
      const oc = body.outcomes.slice(0, 100_000).filter((o) => o && o.id != null).map((o) => ({ id: String(o.id).slice(0, 200), ok: !!o.ok }));
      const ok = oc.filter((o) => o.ok), no = oc.filter((o) => !o.ok), pick = (l, n) => { const c = [...l], s = []; while (c.length && s.length < n) s.push(c.splice(Math.floor(Math.random() * c.length), 1)[0]); return s; };
      const nOk = Math.min(ok.length, Math.ceil(C.sample * 0.7)), sample = [...pick(ok, nOk), ...pick(no, C.sample - nOk)];
      if (sample.length) { const b = `b${j.batches}`; j.pending_checks[b] = { at: new Date().toISOString(), rows: sample }; out.verify = { batch: b, rows: sample.map((s) => s.id), how: `an independent checker re-runs these rows and posts POST ${publicUrl}/v1/jobs/${j.id}/verify {"batch":"${b}","results":[{"id":"…","ok":true}]}` }; }
    } else if (j.verification === "agent") out.note = "no per-row outcomes, so the rate can't be checked independently: the forecast is marked as claimed by the agent";
    const d = ingest(j, { rows, successes, errors: Number(body.errors) || 0, stale: Number(body.stale) || 0, elapsed_sec: Number(body.elapsed_sec) || 0 });
    save(j);
    return { ...out, recommendation: d ? "notify_user" : j.paused ? "wait_for_owner" : j.status === "done" ? "done" : "continue", ask: d || undefined, forecast: forecast(j), status: j.status, paused: j.paused };
  }

  // перепроверка выборки независимым проверяющим
  function verify(id, { batch, results = [] } = {}, { verifier = null } = {}) {
    const j = get(id), pc = j.pending_checks[batch];
    if (!pc) throw err(404, "выборки для проверки с таким batch нет");
    const res = new Map(results.filter((r) => r && r.id != null).map((r) => [String(r.id), !!r.ok]));
    const rows = pc.rows.filter((r) => res.has(r.id));
    if (!rows.length) throw err(400, "results: перепроверьте строки, которые выбрал оркестратор");
    const claimed_ok = rows.filter((r) => r.ok).length, unconfirmed = rows.filter((r) => r.ok && !res.get(r.id)).length, missed = rows.filter((r) => !r.ok && res.get(r.id)).length;
    // и по этой выборке, и по сумме всех выборок задачи: медленное приукрашивание видно только в сумме
    j.check_pool = { claimed_ok: (j.check_pool?.claimed_ok || 0) + claimed_ok, unconfirmed: (j.check_pool?.unconfirmed || 0) + unconfirmed };
    const one = divergence({ claimed_ok, unconfirmed }, { ...C, alpha: C.alpha_single }), pool = divergence(j.check_pool, C), dv = one.diverged || pool.diverged ? (one.p <= pool.p ? one : pool) : one;
    const check = { batch, at: new Date().toISOString(), checked: rows.length, claimed_ok, unconfirmed, missed, p: Number(dv.p.toPrecision(3)), pooled: { ...j.check_pool, p: Number(pool.p.toPrecision(3)) }, diverged: dv.diverged, verifier };
    delete j.pending_checks[batch]; j.checks.push(check); j.verified_rows += rows.length;
    let signal = null;
    if (dv.diverged) {
      j.flags.push({ at_row: j.totals.rows, flag: "claims_not_confirmed", unconfirmed, claimed_ok });
      signal = pause(j, { reason: "claims_not_confirmed", why: `the checker did not confirm ${unconfirmed} of ${claimed_ok} successes the agent reported, more than stale data explains (p = ${check.p}). Checker: ${verifier?.independence || "unknown"}`, why_ru: `проверяющий не подтвердил ${unconfirmed} из ${claimed_ok} заявленных агентом успехов, это больше, чем объясняет устаревание данных (p = ${check.p}). Проверяющий: ${verifier?.independence_ru || "неизвестно"}` });
    }
    save(j);
    return { check, signal, forecast: forecast(j) };
  }

  function decision(id, body = {}) {
    const j = get(id);
    if (body.continue === false) { j.status = "stopped"; j.paused = null; try { issuer.setStatus(j.mandate, "revocation", true, "owner stopped the job"); } catch {} save(j); return { job: view(j), stopped: true }; }
    if (body.continue !== true) throw err(400, "continue: true или false");
    const min_rate = body.min_rate == null ? null : Number(body.min_rate), max_spend = body.max_spend == null ? null : Number(body.max_spend);
    if (min_rate != null && !(min_rate >= 0 && min_rate < 1)) throw err(400, "min_rate: доля от 0 до 1");
    const rate_at = j.last_window ? j.last_window.k / j.last_window.n : null;
    j.approval = { at: new Date().toISOString(), at_row: j.totals.rows, rate_at, min_rate, max_spend, note: body.note ? String(body.note).slice(0, 300) : null };
    j.since = { n: 0, k: 0 };
    j.paused = null; if (j.status === "done") j.status = "done"; else j.status = "running";
    const vc = mandate(j, { min_rate, max_spend, approved_at_rate: rate_at == null ? null : r2(rate_at) }, "the owner saw the forecast and decided to continue");
    j.mandate = vc.id; save(j);
    return { job: view(j), mandate: vc };
  }

  // шлюз: вызов инструмента задачи. До вызова — не приостановлена ли задача, после — считать успех по ответу
  function gatewayBefore(target, caller, tool) {
    const j = Object.values(all()).find((x) => x.verification === "gateway" && x.status === "running" && x.target === target.id && x.tool === tool && caller?.verified && caller.did === orch.get(x.agent).did);
    if (!j) return { ok: true };
    if (j.paused) return { ok: false, reason: `задача «${j.name}» ждёт решения владельца: ${j.paused.why_ru}`, job: j.id };
    return { ok: true, job: j.id };
  }
  function gatewayAfter(jobId, text, isError) {
    if (!jobId) return;
    const j = all()[jobId]; if (!j || j.status !== "running") return;
    let ok = false;
    if (!isError) try { const v = String(j.success.path).split(".").reduce((o, k) => (o == null ? o : o[k]), JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] || text)); ok = j.success.equals == null ? !!v : v === j.success.equals || String(v) === String(j.success.equals); } catch {}
    ingest(j, { rows: 1, successes: ok ? 1 : 0, errors: isError ? 1 : 0 }); save(j);
  }

  const list = (agentId) => Object.values(all()).filter((j) => j.agent === agentId).map(view);
  return { create, progress, verify, decision, get: (id) => view(get(id)), raw: get, list, gatewayBefore, gatewayAfter };
}

export function mountJobs(app, { jobs, wrap, ownerAuth, store, resolver, verifyCaller }) {
  const owned = async (req) => { const j = jobs.raw(req.params.id); await ownerAuth(req, j.agent); return j; };
  app.post("/v1/agents/:id/jobs", wrap(async (req) => { await ownerAuth(req, req.params.id); return jobs.create(req.params.id, req.body || {}); }));
  app.get("/v1/agents/:id/jobs", wrap(async (req) => { await ownerAuth(req, req.params.id); return jobs.list(req.params.id); }));
  app.get("/v1/jobs/:id", wrap(async (req) => { await owned(req); return jobs.get(req.params.id); }));
  app.post("/v1/jobs/:id/progress", wrap(async (req) => { await owned(req); return jobs.progress(req.params.id, req.body || {}); }));
  app.post("/v1/jobs/:id/decision", wrap(async (req) => { await owned(req); return jobs.decision(req.params.id, req.body || {}); }));
  // проверяющий: подписанный запрос зарегистрированного агента (другой владелец — независимый, тот же — слабее) или ключ владельца
  app.post("/v1/jobs/:id/verify", wrap(async (req) => {
    const j = jobs.raw(req.params.id), agents = store.get("agents", {}), owner = agents[j.agent];
    const who = await verifyCaller(req, resolver);
    let verifier;
    if (who.verified) {
      const v = Object.values(agents).find((a) => a.did === who.did);
      if (!v) throw Object.assign(new Error("проверяющий должен быть зарегистрированным агентом"), { status: 403 });
      if (v.id === j.agent) throw Object.assign(new Error("агент не может проверять сам себя"), { status: 403 });
      const same = v.owner_token_hash === owner.owner_token_hash || (v.owner_did && v.owner_did === owner.owner_did) || v.root === j.agent || v.parent === j.agent;
      verifier = { did: who.did, agent: v.id, independence: same ? "same owner (weaker: same incentives)" : "another owner (independent)", independence_ru: same ? "тот же владелец (слабее: те же интересы)" : "другой владелец (независимый)" };
    } else { await ownerAuth(req, j.agent); verifier = { did: null, independence: "the owner's own check (weakest)", independence_ru: "проверка самого владельца (слабее всего)" }; }
    return jobs.verify(req.params.id, req.body || {}, { verifier });
  }));
}
