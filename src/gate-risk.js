// Xonta Gate, risk limits (0.30). Expected harm says how much autonomy an agent has earned; it says nothing about
// how bad one call can be. So the gate checks three things independently:
//   1. expected harm  -> the action budget (actions_per_period, from the exam and live work, as before);
//   2. exposure       -> the worst one call can cost, read from its arguments, capped per tool regardless of who asks;
//   3. the owner pool -> all agents and gates of one owner reserve their exposure in one shared pool, atomically,
//                        so parallel children can't together spend more than the owner allowed.
// A call is reserved at its worst case before it goes out and settled after: an error releases it, success books it.
// Harm found later (a chargeback, a leak noticed next week) is booked against the period it happened in.
//
// policy.risk = {
//   pool_file: "/var/lib/xonta/acme.pool.json",   // shared by every gate of this owner
//   budget: 20000, period_seconds: 86400, currency: "RUB",
//   reserve_ttl_seconds: 900,                     // a reservation never settled (crash) is booked as spent, not dropped
//   unknown_action_exposure: null,                // exposure of action tools not listed below; null = not limited
//   tools: {
//     refund_order:        { amount_arg: "amount", max_per_action: 3000 },
//     export_customers:    { count_arg: "limit", per_item: 50, default_count: 1000, max_per_action: 5000 },
//     change_bank_details: { exposure: 250000, max_per_action: 0 },    // always a human
//     send_email:          { rules: [{ arg: "body", count: "[\\w.+-]+@[\\w-]+\\.[\\w.]+", min: 3, exposure: 50, per_match: true }], max_per_action: 500 },  // a mail full of addresses is a data export
//   } }
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const num = (x) => (typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x.replace(/[\s,]/g, "")) : NaN);
const at = (obj, path) => String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

// worst case of one call, from its arguments. A missing or unreadable amount counts as the tool's ceiling, never as 0.
export function exposureOf(cfg, args = {}) {
  if (!cfg) return 0;
  // rules: the first that matches sets the exposure, e.g. mail to outside the company is worth more than mail inside
  for (const r of cfg.rules || []) {
    const v = String(at(args, r.arg) ?? "");
    if (r.count != null) { const k = (v.match(new RegExp(r.count, "gi")) || []).length; if (k >= (r.min ?? 1)) return Number(r.exposure) * (r.per_match ? k : 1); continue; }
    if ((r.match != null && new RegExp(r.match, "i").test(v)) || (r.not_match != null && !new RegExp(r.not_match, "i").test(v))) return Number(r.exposure);
  }
  if (cfg.exposure != null) return Number(cfg.exposure);
  const ceiling = cfg.ceiling ?? cfg.max_exposure ?? Infinity;
  if (cfg.amount_arg) { const v = num(at(args, cfg.amount_arg)); return Number.isFinite(v) && v >= 0 ? v * (cfg.factor ?? 1) : ceiling; }
  if (cfg.count_arg) {
    const raw = at(args, cfg.count_arg), v = raw == null ? cfg.default_count ?? NaN : num(raw);
    return Number.isFinite(v) && v >= 0 ? v * (cfg.per_item ?? 1) : ceiling;
  }
  return 0;
}

// One pool per owner, in a file every gate of that owner opens. A lock directory makes each change atomic across processes.
export function openPool({ file, budget, period_seconds = 86400, reserve_ttl_seconds = 900 }) {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const withLock = (fn) => {
    for (let i = 0; ; i++) {
      try { mkdirSync(lock); break; } catch (e) {
        if (e.code !== "EEXIST") throw e;
        try { if (Date.now() - statSync(lock).mtimeMs > 10_000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch {}
        if (i > 400) throw new Error("risk pool is locked for too long");
        sleepSync(5 + (i % 7));
      }
    }
    try {
      const now = Date.now();
      let s = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
      if (!s || !s.period_start) s = { period_start: now, spent: 0, reserved: {}, late: [], log: [] };
      if (now - s.period_start >= period_seconds * 1000) s = { period_start: now - ((now - s.period_start) % (period_seconds * 1000)), spent: 0, reserved: s.reserved, late: [], log: [] };
      for (const [id, r] of Object.entries(s.reserved)) if (now - r.at > reserve_ttl_seconds * 1000) { s.spent += r.amount; delete s.reserved[id]; s.log.push({ t: now, ev: "expired_as_spent", id, amount: r.amount }); }
      const out = fn(s, now);
      s.log = s.log.slice(-500);
      writeFileSync(`${file}.tmp`, JSON.stringify(s)); renameSync(`${file}.tmp`, file);
      return out;
    } finally { rmSync(lock, { recursive: true, force: true }); }
  };
  const reservedOf = (s) => Object.values(s.reserved).reduce((a, r) => a + r.amount, 0);
  return {
    file, budget,
    // all or nothing: either the whole worst case fits next to what is spent and already reserved by others, or nothing is taken
    reserve(id, amount, meta = {}) {
      return withLock((s, now) => {
        const used = s.spent + reservedOf(s), free = budget - used;
        if (amount > free) { s.log.push({ t: now, ev: "refused", id, amount, free, ...meta }); return { ok: false, free, used, amount }; }
        s.reserved[id] = { amount, at: now, ...meta }; s.log.push({ t: now, ev: "reserved", id, amount, ...meta });
        return { ok: true, free: free - amount, used: used + amount, amount };
      });
    },
    settle(id, actual) {
      return withLock((s, now) => {
        const r = s.reserved[id]; if (!r) return { ok: false, why: "no such reservation" };
        delete s.reserved[id]; const amount = Math.max(0, Math.min(actual ?? r.amount, r.amount)); s.spent += amount;
        s.log.push({ t: now, ev: "settled", id, amount, reserved: r.amount });
        return { ok: true, amount };
      });
    },
    release(id) { return this.settle(id, 0); },
    // harm noticed later goes to the current period: it lowers what is left for everyone
    late(amount, note = "") { return withLock((s, now) => { s.spent += amount; s.late.push({ t: now, amount, note }); s.log.push({ t: now, ev: "late", amount, note }); return { ok: true, spent: s.spent }; }); },
    status() { return withLock((s) => ({ budget, spent: s.spent, reserved: reservedOf(s), free: budget - s.spent - reservedOf(s), reservations: Object.keys(s.reserved).length, period_start: new Date(s.period_start).toISOString(), late: s.late.length })); },
  };
}

// The gate's side: exposure and per-call cap first (no pool needed), then the pool reservation.
export function createRisk(risk, { agent = "gate" } = {}) {
  if (!risk) return null;
  const tools = risk.tools || {}, pool = risk.pool_file ? openPool({ file: risk.pool_file, budget: risk.budget ?? Infinity, period_seconds: risk.period_seconds, reserve_ttl_seconds: risk.reserve_ttl_seconds }) : null;
  const cur = risk.currency || "";
  let seq = 0;
  return {
    pool, tools,
    check(tool, args, { action = false } = {}) {
      const cfg = tools[tool] || (action && risk.unknown_action_exposure != null ? { exposure: risk.unknown_action_exposure } : null);
      if (!cfg) return { allow: true, exposure: 0 };
      const exposure = exposureOf(cfg, args);
      if (cfg.max_per_action != null && exposure > cfg.max_per_action) return { allow: false, kind: "exposure", exposure, reason: cfg.max_per_action === 0 ? `${tool} always needs a human` : exposure === Infinity ? `can't tell how much ${tool} may cost from its arguments. Needs a human` : `one call may cost up to ${exposure} ${cur}, the limit for one ${tool} is ${cfg.max_per_action} ${cur}. Needs a human` };
      if (!pool || exposure <= 0) return { allow: true, exposure };
      const id = `${agent}-${process.pid}-${Date.now().toString(36)}-${++seq}`, r = pool.reserve(id, exposure, { agent, tool });
      if (!r.ok) return { allow: false, kind: "pool", exposure, reason: `the owner's shared risk budget has ${Math.max(0, r.free)} ${cur} left for this period, this call may cost ${exposure} ${cur}. Needs a human` };
      return { allow: true, exposure, reservation: id };
    },
    done(chk, { error = false } = {}) { if (chk?.reservation) pool.settle(chk.reservation, error ? 0 : chk.exposure); },
  };
}
