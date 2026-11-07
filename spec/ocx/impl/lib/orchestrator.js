// OCX reference orchestrator (profiles Core + Evidence + Relay of SPEC.md 2026-11-06).
// One process = one orchestrator: Orchestrator Card, JSON-RPC endpoint /ocx, receipt ledger, local limits for agents.
// A tiny agent-facing API (/agent/*) stands in for the real Xonta gateway so the demo can drive agents through it.
import http from "node:http";
import { newKey, thumbprint, signDetached, verifyDetached, jcs, sha256hex } from "./crypto.js";
import { signRequest, verifyRequest } from "./httpsig.js";
import { Ledger, verifyWindow } from "./ledger.js";

export const VERSION = "2026-11-06";
const E = (code, message, data) => Object.assign(new Error(message), { rpc: { code, message, data } });
let ulidSeq = 0;
const ulid = () => Date.now().toString(36).toUpperCase().padStart(9, "0") + (ulidSeq++).toString(36).toUpperCase().padStart(5, "0");
const didFor = (port) => `did:web:127.0.0.1%3A${port}`;
export const didToBase = (did) => { const host = decodeURIComponent(did.replace(/^did:web:/, "").split("#")[0]); return (/^(127\.0\.0\.1|localhost)(:|$)/.test(host) ? "http://" : "https://") + host; };
const didFromBase = (base) => "did:web:" + encodeURIComponent(new URL(base).host);

// §10.7: proven — better than the agent and the baseline; harmful — worse than both; otherwise no_effect
export function experienceStatus(vsAgent, vsBaseline) {
  if (vsAgent < 0 && vsBaseline < 0) return "proven";
  if (vsAgent > 0 && vsBaseline > 0) return "harmful";
  return "no_effect";
}

export class Orchestrator {
  constructor({ name, port, publicBase = null, roles = ["governing"], trust = {}, actOnLevels = ["proven"], maxHops = 2, log = () => {},
    openLimits = { max_payment: { amount: "100", currency: "USD" }, human_confirmation: false }, closedLimits = { max_payment: { amount: "0", currency: "USD" }, human_confirmation: true } }) {
    // openLimits / closedLimits: local limits without and with an active reason (own mismatch or an applied signal)
    Object.assign(this, { name, port, roles, actOnLevels, maxHops, log, openLimits, closedLimits });
    // publicBase: the address other orchestrators use to reach this one (behind a proxy); default is localhost
    this.base = (publicBase || `http://127.0.0.1:${port}`).replace(/\/$/, ""); this.id = publicBase ? didFromBase(this.base) : didFor(port); this.url = `${this.base}/ocx`;
    this.key = newKey(`${name}-2026-11`);
    this.ledger = new Ledger({ issuer: this.id, key: this.key, ulid });
    this.peers = new Map();           // id -> { card, jwks, push_url }
    this.cards = new Map();           // id -> card (cache, includes non-peers)
    this.agents = new Map();          // agent id -> { jwk, owner, limits, reasons: [] }
    this.signals = new Map();         // signal id -> { signal, verified, applied, from }
    this.issued = new Map();          // own signals -> { signal, evidenceSource }
    this.weights = new Map();         // issuer -> { v, f, base }
    for (const [iss, w] of Object.entries(trust)) this.weights.set(iss, { v: 0, f: 0, base: w });
    this.events = [];
    // Experience (§10.7): own packages, received packages with local re-measurement status
    this.experience = new Map();      // id -> package (own, signed)
    this.received = new Map();        // id -> { pkg, from, local: "hypothesis" | "confirmed" | "no_effect" | "harmful" }
    this.remeasure = null;            // async (pkg) => { harm_delta_per_task, baseline_delta_per_task } on own data
    // Referral (§10.10–10.12, §12.2)
    this.competenceDecl = [];         // what this orchestrator declares in its card (§5.5)
    this.acceptReferrals = new Set(); // categories this orchestrator accepts referrals for
    this.referralsIn = new Map();     // referral_id -> { category, subject, expires_at, used }
    this.observed = new Map();        // orchestrator -> category -> { n, referrals, experience_confirmed, experience_harmful, improved, worse, harm_delta_sum }
    this.referralsOut = new Map();    // target_referral_id -> token we issued
    // Appeal (§10.9)
    this.owners = new Map();          // owner id -> jwk (owners known to this orchestrator)
    this.appeals = new Map();         // appeal_id -> { signal, owner, statement, status, respond_by }
    this.appealHours = 72;
  }

  card() {
    return { id: this.id, name: this.name, description: `OCX reference orchestrator ${this.name}`, roles: this.roles,
      interfaces: [{ protocol: "ocx", url: this.url, protocolVersions: [VERSION] }], keys: { jwks: { keys: [this.key.jwk] } },
      capabilities: { signals: { push: true, list: true, relay: true }, status: { query: true }, evidence: { types: ["ledger_mismatch"], receipts: true }, experience: { offer: true, categories: [...new Set([...this.experience.values()].map((p) => p.category))] }, referral: { offer: true, accept: this.acceptReferrals.size > 0 }, appeal: true },
      competence: this.competenceDecl,
      policies: { accepts_peering: "open", acts_on_levels: this.actOnLevels, relays_levels: ["proven"], max_hops: this.maxHops, probing: "consent_required", appeal_url: `${this.base}/ocx/appeal`, retention: "P90D" },
      ledger: { checkpoint_url: `${this.base}/ocx/checkpoint` }, updated_at: new Date().toISOString() };
  }

  note(type, data) { const e = { t: Date.now(), at: new Date().toISOString(), orch: this.name, type, ...data }; this.events.push(e); this.log(e); return e; }

  // ---------- keys and cards
  async cardOf(id) {
    if (this.cards.has(id)) return this.cards.get(id);
    const r = await fetch(`${didToBase(id)}/.well-known/orchestrator-card.json`);
    if (!r.ok) throw new Error(`card of ${id}: HTTP ${r.status}`);
    const c = await r.json(); if (c.id !== id) throw new Error("card id mismatch");
    this.cards.set(id, c); return c;
  }
  jwkOf(card, kid) { return (card?.keys?.jwks?.keys || []).find((k) => k.kid === kid) || null; }
  async issuerLookup(id) { const c = await this.cardOf(id); return (kid) => this.jwkOf(c, kid); }

  // ---------- outgoing JSON-RPC
  async rpc(url, method, params) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ulid(), method, params });
    const headers = signRequest(this.key, { method: "POST", url, body, version: VERSION });
    headers["ocx-sender"] = this.id;
    const r = await fetch(url, { method: "POST", headers, body });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { rpc: j.error });
    return j.result;
  }

  async peerWith(otherBase, subscription = { feeds: ["signals"], categories: ["*"], min_level: "proven" }) {
    const card = await (await fetch(`${otherBase}/.well-known/orchestrator-card.json`)).json();
    this.cards.set(card.id, card);
    const res = await this.rpc(card.interfaces[0].url, "ocx/peer.hello", { orchestrator: this.id, protocolVersions: [VERSION], capabilities: this.card().capabilities, policies: this.card().policies, subscription: { ...subscription, push_url: this.url } });
    this.peers.set(card.id, { card, push_url: card.interfaces[0].url, subscription: res.subscription });
    if (!this.weights.has(card.id)) this.weights.set(card.id, { v: 0, f: 0, base: 0.5 });
    this.note("peered", { with: card.name, version: res.protocolVersion });
    return res;
  }

  // Beta prior with the operator's starting trust as prior mean (SPEC §12.1): w = (v + 2·base) / (v + f + 2)
  weight(id) { const w = this.weights.get(id) || { v: 0, f: 0, base: 0.3 }; return (w.v + 2 * w.base) / (w.v + w.f + 2); }

  // ---------- agents (local API standing in for the gateway)
  registerAgent({ jwk, owner }) {
    const id = thumbprint(jwk);
    if (!this.agents.has(id)) this.agents.set(id, { jwk, owner, limits: { ...this.openLimits }, reasons: [] });
    else if (!this.agents.get(id).jwk) Object.assign(this.agents.get(id), { jwk, owner }); // known from a signal before it came here
    return id;
  }
  act({ agent, task, tool, input, output }) {
    if (!this.agents.has(agent)) throw new Error("unknown agent");
    return this.ledger.append({ agent, task, action: "tool_call", tool, input, output });
  }

  // agent hands in a signed report; we compare its claims with receipts for the task window
  async report({ report, jws }) {
    const a = this.agents.get(report.agent); if (!a) throw new Error("unknown agent");
    const sig = verifyDetached((kid) => (kid === report.agent ? a.jwk : null), report, jws);
    if (!sig.ok) throw new Error("report signature: " + sig.reason);
    const t0 = Date.now();
    const cp = this.ledger.checkpoint();
    const proof = this.ledger.windowProof(report.agent, report.window.from, report.window.to, cp);
    const done = new Set(proof.receipts.map((x) => x.receipt).filter((r) => r.task === report.task && r.at >= report.window.from && r.at <= report.window.to).map((r) => r.tool));
    const missing = (report.checks || []).filter((c) => !done.has(c));
    this.note("report", { agent: report.agent.slice(0, 22), claimed: report.checks, receipts: [...done], missing });
    if (!missing.length) return { ok: true, mismatch: [] };
    // set own limits first, then tell peers
    a.reasons.push("own:ledger_mismatch"); this.recompute(report.agent);
    const signal = this.makeSignal({ subject: { kind: "agent", agent: report.agent, owner: a.owner, owner_verified: "signature" }, category: "payments", claim: "report_misstated_actions", level: "proven",
      evidence: [{ type: "ledger_mismatch", report: { hash: sha256hex(jcs(report)), jws, agent_jwk: a.jwk, body: report }, claims: missing.map((c) => ({ path: "/checks", claimed: c, finding: "no_receipt" })), window: report.window, task: report.task, checkpoint: cp }] });
    this.issued.set(signal.id, { signal });
    this.note("signal_issued", { id: signal.id, level: "proven", build_ms: Date.now() - t0 });
    await this.pushToPeers(signal);
    return { ok: false, mismatch: missing, signal: signal.id };
  }

  // issue an arbitrary signal (used for suspected signals and for testing defences against false ones)
  async issue({ subject, claim, level, evidence, category = "payments" }) {
    const signal = this.makeSignal({ subject, category, claim, level, evidence });
    this.issued.set(signal.id, { signal }); this.note("signal_issued", { id: signal.id, level });
    await this.pushToPeers(signal); return signal;
  }

  makeSignal({ subject, category, claim, level, evidence, type = "conduct.violation", supersedes = null, reason, ttlH = 24 }) {
    const now = new Date();
    const s = { ocx: VERSION, type, id: `${this.id}#${ulid()}`, issuer: this.id, issued_at: now.toISOString(), expires_at: new Date(+now + ttlH * 3600e3).toISOString(),
      subject, category, claim, evidence_level: level, evidence, issuer_limits: { ...this.closedLimits },
      supersedes, ...(reason ? { reason } : {}), relay: { hops: 0, max_hops: this.maxHops, path: [] }, appeal: `${this.base}/ocx/appeal` };
    s.signature = signDetached(this.key, s, ["signature", "relay"]);
    return s;
  }

  async pushToPeers(signal, except = []) {
    await Promise.all([...this.peers.values()].filter((p) => !except.includes(p.card.id)).map(async (p) => {
      try { const r = await this.rpc(p.push_url, "ocx/signals.push", { signals: [signal] }); this.note("pushed", { to: p.card.name, accepted: r.accepted.length, rejected: r.rejected.map((x) => x.code) }); }
      catch (e) { this.note("push_failed", { to: p.card.name, error: e.message }); }
    }));
  }

  async retract(id, reason) {
    const orig = this.issued.get(id)?.signal; if (!orig) throw new Error("not my signal");
    const r = this.makeSignal({ type: "conduct.retraction", subject: orig.subject, category: orig.category, claim: orig.claim, level: orig.evidence_level, evidence: [{ type: "peer_report", cites: id }], supersedes: id, reason });
    this.issued.get(id).retracted = true;
    // the agent's own limits open again only when no other own signal about it is still active
    const a = this.agents.get(orig.subject.agent), still = [...this.issued.values()].some((x) => !x.retracted && x.signal.type === "conduct.violation" && x.signal.subject.agent === orig.subject.agent);
    if (a && !still) { a.reasons = a.reasons.filter((x) => x !== "own:ledger_mismatch"); this.recompute(orig.subject.agent); }
    this.note("retracted", { id, signal_issued_at: orig.issued_at });
    await this.pushToPeers(r);
    return r.id;
  }

  // ---------- receiving
  async onSignal(signal, from) {
    const lookup = await this.issuerLookup(signal.issuer);
    const sig = verifyDetached(lookup, signal, signal.signature, ["signature", "relay"]);
    if (!sig.ok) throw E(-32021, "signal_signature_invalid", { reason: sig.reason });
    if (new Date(signal.expires_at) < new Date()) throw E(-32020, "signal_expired");
    if (this.signals.has(signal.id)) return "duplicate";
    if (signal.relay.hops > signal.relay.max_hops || signal.relay.path.includes(this.id)) throw E(-32022, "relay_limit_exceeded");
    const rec = { signal, from, received: Date.now(), verified: null, applied: false };
    this.signals.set(signal.id, rec);
    this.note("signal_received", { id: signal.id, type: signal.type, level: signal.evidence_level, from: this.cards.get(from)?.name || from, hops: signal.relay.hops });
    setImmediate(() => this.process(rec).catch((e) => this.note("process_error", { error: e.message })));
    return "accepted";
  }

  async process(rec) {
    const s = rec.signal;
    if (s.type === "conduct.retraction") {
      for (const [, r] of this.signals) if (r.signal.id === s.supersedes) { r.retracted = true; if (r.applied) { this.unapply(r); } }
      this.note("retraction_applied", { supersedes: s.supersedes });
      await this.relay(s, rec);
      return;
    }
    if (s.evidence_level !== "proven") { this.note("monitoring_only", { id: s.id, level: s.evidence_level }); return; } // suspected/strong: no limit change, no relay
    const t0 = Date.now();
    const v = await this.verifyEvidence(s);
    rec.verified = v.ok; rec.verify_ms = Date.now() - t0;
    const w = this.weights.get(s.issuer) || { v: 0, f: 0, base: 0.3 }; this.weights.set(s.issuer, w);
    if (!v.ok) { w.f++; this.note("evidence_failed", { id: s.id, reason: v.reason, issuer_weight: +this.weight(s.issuer).toFixed(2) }); return; }
    w.v++;
    const weight = this.weight(s.issuer);
    this.note("evidence_verified", { id: s.id, ms: rec.verify_ms, issuer_weight: +weight.toFixed(2) });
    if (weight >= 0.6 && this.actOnLevels.includes("proven")) this.apply(rec);
    else this.note("extra_checks_only", { id: s.id, issuer_weight: +weight.toFixed(2) });
    await this.relay(s, rec);
  }

  async relay(s, rec) {
    if (s.relay.hops + 1 > s.relay.max_hops) return;
    const out = { ...s, relay: { hops: s.relay.hops + 1, max_hops: s.relay.max_hops, path: [...s.relay.path, this.id] } };
    const except = [rec.from, s.issuer, ...s.relay.path];
    if ([...this.peers.keys()].some((p) => !except.includes(p))) { this.note("relaying", { id: s.id, hops: out.relay.hops }); await this.pushToPeers(out, except); }
  }

  apply(rec) {
    const s = rec.signal, id = s.subject.agent;
    if (!this.agents.has(id)) this.agents.set(id, { jwk: null, owner: s.subject.owner, limits: { ...this.openLimits }, reasons: [] });
    this.agents.get(id).reasons.push(`signal:${s.id}`); rec.applied = true; this.recompute(id);
    this.note("limits_lowered", { agent: id.slice(0, 22), by: s.id, since_issued_ms: Date.now() - Date.parse(s.issued_at) });
  }
  unapply(rec) { const id = rec.signal.subject.agent, a = this.agents.get(id); if (!a) return; a.reasons = a.reasons.filter((x) => x !== `signal:${rec.signal.id}`); rec.applied = false; this.recompute(id); this.note("limits_restored", { agent: id.slice(0, 22) }); }
  recompute(id) { const a = this.agents.get(id); a.limits = a.reasons.length ? { ...this.closedLimits } : { ...this.openLimits }; }

  async verifyEvidence(s) {
    try {
      const ev = await this.rpc(`${didToBase(s.issuer)}/ocx`, "ocx/evidence.get", { signal: s.id, items: [0], proofs: true });
      const lookup = await this.issuerLookup(s.issuer);
      if (!verifyDetached(lookup, ev, ev.signature).ok) return { ok: false, reason: "evidence package signature" };
      const item = s.evidence[0];
      if (item.type !== "ledger_mismatch") return { ok: false, reason: "unsupported evidence type" };
      const rep = item.report;
      if (thumbprint(rep.agent_jwk) !== s.subject.agent) return { ok: false, reason: "agent key does not match subject" };
      if (sha256hex(jcs(rep.body)) !== rep.hash) return { ok: false, reason: "report hash" };
      if (!verifyDetached((kid) => (kid === s.subject.agent ? rep.agent_jwk : null), rep.body, rep.jws).ok) return { ok: false, reason: "report not signed by the agent" };
      if (jcs(ev.window_proof.checkpoint) !== jcs(item.checkpoint)) return { ok: false, reason: "checkpoint differs from the one in the signal" };
      const w = verifyWindow(ev.window_proof, item.window.from, item.window.to, lookup);
      if (!w.ok) return { ok: false, reason: "window: " + w.reason };
      const done = new Set(w.receipts.filter((r) => r.task === item.task).map((r) => r.tool));
      const claimedMissing = item.claims.map((c) => c.claimed);
      const reallyMissing = (rep.body.checks || []).filter((c) => !done.has(c));
      if (!claimedMissing.length || claimedMissing.some((c) => !reallyMissing.includes(c))) return { ok: false, reason: `issuer claims no receipt for ${claimedMissing.join(",")}, but receipts show it` };
      return { ok: true };
    } catch (e) { return { ok: false, reason: "evidence unavailable: " + e.message }; }
  }

  // relying side: a payment request from an agent
  async pay({ agent, amount }) {
    const t0 = Date.now();
    const a = this.agents.get(agent);
    const limits = a?.limits || this.openLimits;
    const ok = !limits.human_confirmation && Number(amount) <= Number(limits.max_payment.amount);
    const reasons = (a?.reasons || []).map((r) => r.replace(/^signal:/, ""));
    this.note("payment_decision", { agent: agent.slice(0, 22), amount, decision: ok ? "auto_approved" : "needs_human", reasons, ms: Date.now() - t0 });
    return { approved: ok, needs_human: !ok, reasons };
  }

  // ---------- JSON-RPC server
  async handleRpc(req, body) {
    const msg = JSON.parse(body);
    const sender = req.headers["ocx-sender"];
    const call = async () => {
      if (!sender) throw E(-32011, "bad_request_signature", { reason: "no sender" });
      if (msg.method === "ocx/peer.hello" && msg.params?.orchestrator !== sender) throw E(-32011, "bad_request_signature", { reason: "sender differs from orchestrator" });
      let card; try { card = await this.cardOf(sender); } catch (e) { throw E(-32011, "bad_request_signature", { reason: e.message }); }
      const v = verifyRequest({ method: req.method, url: `${this.base}${req.url}`, headers: req.headers, body }, (kid) => this.jwkOf(card, kid));
      if (!v.ok) throw E(-32011, "bad_request_signature", { reason: v.reason });
      const p = msg.params || {};
      switch (msg.method) {
        case "ocx/peer.hello": {
          if (!p.protocolVersions?.includes(VERSION)) throw E(-32012, "unsupported_version", { supported: [VERSION] });
          this.peers.set(card.id, { card, push_url: p.subscription?.push_url || card.interfaces[0].url, subscription: p.subscription });
          if (!this.weights.has(card.id)) this.weights.set(card.id, { v: 0, f: 0, base: 0.5 });
          return { orchestrator: this.id, protocolVersion: VERSION, capabilities: this.card().capabilities, policies: this.card().policies, subscription: { feeds: ["signals"], min_level: "proven", push_url: this.url } };
        }
        case "ocx/peer.close": this.peers.delete(card.id); return { closed: true };
        case "ocx/ping": return { pong: new Date().toISOString() };
        case "ocx/signals.push": {
          if (!this.peers.has(card.id)) throw E(-32010, "not_peered");
          const accepted = [], rejected = [];
          for (const s of p.signals || []) { try { const r = await this.onSignal(s, card.id); if (r !== "duplicate") accepted.push(s.id); } catch (e) { rejected.push({ id: s.id, code: e.rpc?.code || -32603, reason: e.rpc?.data?.reason || e.message }); } }
          return { accepted, rejected };
        }
        case "ocx/signals.list": return { signals: [...this.issued.values()].map((x) => x.signal), next: null };
        case "ocx/status.query": {
          const a = this.agents.get(p.subject?.agent);
          const ans = { ocx: VERSION, issuer: this.id, subject: { agent: p.subject?.agent }, as_of: new Date().toISOString(), known: !!a,
            own_limits: a?.limits, active_signals: [
              // own signals first (the answer is about what this orchestrator knows, including what it found itself), then received ones
              ...[...this.issued.values()].filter((x) => x.signal.subject.agent === p.subject?.agent && !x.retracted && x.signal.type === "conduct.violation").map((x) => ({ id: x.signal.id, evidence_level: x.signal.evidence_level, claim: x.signal.claim, issuer: x.signal.issuer, verified_by_me: true })),
              ...[...this.signals.values()].filter((r) => r.signal.subject.agent === p.subject?.agent && !r.retracted && r.signal.type === "conduct.violation").map((r) => ({ id: r.signal.id, evidence_level: r.signal.evidence_level, claim: r.signal.claim, issuer: r.signal.issuer, verified_by_me: !!r.verified }))] };
          ans.signature = signDetached(this.key, ans); return ans;
        }
        case "ocx/evidence.get": {
          // served to any orchestrator with a resolvable card and a valid signed request (SPEC §9.5)
          const own = this.issued.get(p.signal); if (!own) throw E(-32023, "evidence_unavailable");
          const it = own.signal.evidence[0];
          const out = { signal: p.signal, window_proof: this.ledger.windowProof(own.signal.subject.agent, it.window.from, it.window.to, it.checkpoint) };
          out.signature = signDetached(this.key, out); return out;
        }
        case "ocx/experience.offer": {
          if (!this.peers.has(card.id)) throw E(-32010, "not_peered");
          const out = [];
          for (const pkg of p.packages || []) out.push({ id: pkg.id, local: await this.acceptPackage(pkg, card.id) });
          return { received: out };
        }
        case "ocx/experience.get": return { packages: [...this.experience.values()].filter((x) => x.status !== "harmful" && (!p.category || x.category === p.category)) };
        case "ocx/competence.query": {
          const cands = [];
          for (const [orch, cats] of this.observed) { const c = this.competence(orch, p.category); if (c && cats.has(p.category)) cands.push({ orchestrator: orch, card: `${didToBase(orch)}/.well-known/orchestrator-card.json`, competence_by_me: c,
            verified_experience: [...this.received.values()].filter((r) => r.pkg.issuer === orch && r.local === "confirmed" && r.pkg.category === p.category).map((r) => r.pkg.id) }); }
          cands.sort((a, b) => a.competence_by_me.harm_delta_per_task - b.competence_by_me.harm_delta_per_task);
          const ans = { category: p.category, candidates: cands.slice(0, p.limit || 5) }; ans.signature = signDetached(this.key, ans); return ans;
        }
        case "ocx/referral.offer": {
          if (!this.acceptReferrals.has(p.category)) throw E(-32040, "referral_declined", { reason: "category not accepted" });
          const id = `${this.id}#ref-${ulid()}`, expires_at = new Date(Date.now() + 7 * 864e5).toISOString();
          this.referralsIn.set(id, { category: p.category, subject: p.subject, expires_at, used: false, from: card.id });
          return { accepted: true, referral_id: id, expires_at, admission: `${this.base}/agent/register?referral=${encodeURIComponent(id)}` };
        }
        case "ocx/referral.outcome": {
          // sent by the target of a referral this orchestrator made: we learn the target's competence from it (§12.2)
          const tok = this.referralsOut.get(p.referral);
          if (!tok || tok.to !== card.id) throw E(-32602, "Invalid params", { reason: "not a referral of ours to the sender" });
          const o = this.observe(tok.to, tok.category);
          const d = (p.harm_per_task_after - p.harm_per_task_before) * (p.basis === "receipts" ? 1 : 0.5);
          o.n++; o.referrals++; o.harm_delta_sum += d; if (d < 0) o.improved++; else if (d > 0) o.worse++;
          this.note("referral_outcome", { from: card.name, category: tok.category, delta: +d.toFixed(3) });
          return { recorded: true };
        }
        case "ocx/appeal.submit": {
          const own = this.issued.get(p.signal)?.signal; if (!own) throw E(-32023, "evidence_unavailable");
          const ownerJwk = p.owner_jwk; const ownerId = ownerJwk ? thumbprint(ownerJwk) : null;
          if (!ownerId || ownerId !== own.subject.owner || ownerId !== p.owner) throw E(-32031, "appeal_not_accepted", { reason: "owner key does not match the signal subject" });
          const body = { signal: p.signal, owner: p.owner, statement: p.statement };
          if (!verifyDetached((kid) => (kid === ownerId ? ownerJwk : null), body, p.owner_signature).ok) throw E(-32031, "appeal_not_accepted", { reason: "owner signature" });
          const id = `${this.id}#appeal-${ulid()}`, respond_by = new Date(Date.now() + this.appealHours * 3600e3).toISOString();
          this.appeals.set(id, { signal: p.signal, owner: p.owner, statement: p.statement, status: "received", respond_by });
          this.note("appeal_received", { signal: p.signal, respond_by });
          return { appeal_id: id, status: "received", respond_by };
        }
        case "ocx/appeal.status": {
          const a = [...this.appeals.entries()].find(([, x]) => x.signal === p.signal);
          if (!a) return { signal: p.signal, status: "none" };
          const [id, x] = a; const status = x.status === "received" && new Date(x.respond_by) < new Date() ? "overdue" : x.status;
          return { appeal_id: id, signal: p.signal, status, respond_by: x.respond_by };
        }
        default: throw E(-32601, "Method not found");
      }
    };
    try { return { jsonrpc: "2.0", id: msg.id, result: await call() }; }
    catch (e) { return { jsonrpc: "2.0", id: msg.id, error: e.rpc || { code: -32603, message: e.message } }; }
  }

  // ---------- Experience (§10.7)
  publishExperience({ category, rule, measurement }) {
    if (!measurement?.baseline || typeof measurement.baseline.harm_delta_vs_baseline_per_task !== "number") throw new Error("measurement.baseline is required");
    const pkg = { id: `${this.id}#exp-${ulid()}`, category, rule, measurement, status: experienceStatus(measurement.harm_delta_per_task, measurement.baseline.harm_delta_vs_baseline_per_task), issuer: this.id };
    pkg.signature = signDetached(this.key, pkg);
    this.experience.set(pkg.id, pkg); return pkg;
  }
  async offerExperience(peerId, pkgId) {
    const pkg = this.experience.get(pkgId);
    if (pkg?.status === "harmful") throw new Error("harmful experience is not offered (§10.7)");
    const p = this.peers.get(peerId); return this.rpc(p.push_url, "ocx/experience.offer", { packages: [pkg] });
  }
  async fetchExperience(base, category) { return this.rpc(`${base}/ocx`, "ocx/experience.get", { category }); }
  async acceptPackage(pkg, from) {
    const lookup = await this.issuerLookup(pkg.issuer);
    if (!verifyDetached(lookup, pkg, pkg.signature).ok) throw E(-32021, "signal_signature_invalid", { reason: "experience signature" });
    const m = pkg.measurement || {};
    if (!m.baseline || typeof m.baseline.harm_delta_vs_baseline_per_task !== "number") throw E(-32602, "Invalid params", { reason: "measurement.baseline is required" });
    if (pkg.status === "proven" && !(m.harm_delta_per_task < 0 && m.baseline.harm_delta_vs_baseline_per_task < 0)) throw E(-32602, "Invalid params", { reason: "proven but not better than the agent and the baseline" });
    if (pkg.status === "harmful") throw E(-32602, "Invalid params", { reason: "harmful experience is not shared" });
    if (experienceStatus(m.harm_delta_per_task, m.baseline.harm_delta_vs_baseline_per_task) === "harmful" && pkg.status !== "revoked") throw E(-32602, "Invalid params", { reason: "worse than the agent and the baseline but not marked harmful" });
    const rec = { pkg, from, local: "hypothesis" }, seen = this.received.has(pkg.id);
    if (this.remeasure) {
      const r = await this.remeasure(pkg); rec.local_measurement = r; const v = experienceStatus(r.harm_delta_per_task, r.baseline_delta_per_task); rec.local = v === "proven" ? "confirmed" : v;
      // §12.2: experience re-measured here feeds the issuer's competence in that category. Confirmed raises it, harmful lowers it,
      // no_effect counts for nothing. The same package offered twice is counted once.
      if (!seen && (rec.local === "confirmed" || rec.local === "harmful")) {
        const o = this.observe(pkg.issuer, pkg.category); o.n++; o.harm_delta_sum += r.harm_delta_per_task;
        if (rec.local === "confirmed") { o.experience_confirmed++; o.improved++; } else { o.experience_harmful++; o.worse++; }
      }
    }
    this.received.set(pkg.id, rec); this.note("experience_received", { id: pkg.id, from: this.cards.get(from)?.name || from, offered_as: pkg.status, local: rec.local });
    return rec.local;
  }

  // ---------- Referral (§10.10–10.12, §12.2)
  observe(orch, category) { if (!this.observed.has(orch)) this.observed.set(orch, new Map()); const m = this.observed.get(orch); if (!m.has(category)) m.set(category, { n: 0, referrals: 0, experience_confirmed: 0, experience_harmful: 0, improved: 0, worse: 0, harm_delta_sum: 0 }); return m.get(category); }
  competence(orch, category) { const o = this.observed.get(orch)?.get(category); if (!o || !o.n) return null; return { ...o, harm_delta_per_task: +(o.harm_delta_sum / o.n).toFixed(3) }; }
  async refer({ to, subject, category, reason, relationship = "none" }) {
    const card = await this.cardOf(to);
    const off = await this.rpc(card.interfaces[0].url, "ocx/referral.offer", { category, subject, reason, share_status: false });
    const exp = [...(await this.fetchExperience(didToBase(to), category).catch(() => ({ packages: [] }))).packages].filter((p) => p.status === "proven").map((p) => p.id);
    const token = { ocx: VERSION, type: "referral", id: `${this.id}#ref-${ulid()}`, from: this.id, to, target_referral_id: off.referral_id, subject, category, reason,
      evidence: { competence_by_me: this.competence(to, category) }, alternatives: { learn_here: exp.length > 0, experience: exp }, relationship,
      issued_at: new Date().toISOString(), expires_at: off.expires_at };
    token.signature = signDetached(this.key, token);
    this.referralsOut.set(off.referral_id, token);
    this.note("referral_issued", { to: card.name, category, reason, learn_here: token.alternatives.learn_here, relationship });
    return token;
  }
  async admitReferred(token) { // target side: the agent shows up with a token
    const lookup = await this.issuerLookup(token.from);
    if (!verifyDetached(lookup, token, token.signature).ok) throw new Error("referral token signature");
    const r = this.referralsIn.get(token.target_referral_id);
    if (!r || r.used || new Date(r.expires_at) < new Date()) throw E(-32041, "referral_expired");
    if (token.subject.agent !== r.subject.agent || token.to !== this.id) throw new Error("token does not match the offer");
    r.used = true; this.note("referral_admitted", { from: this.cards.get(token.from)?.name || token.from, category: token.category });
    return { admitted: true, note: "limits are set by this orchestrator; status of the agent is checked as for anyone else" };
  }
  // target side: tell the referrer how the referred agent did (§10.12)
  async reportOutcome(referralId, outcome) {
    const r = this.referralsIn.get(referralId); if (!r) throw new Error("unknown referral");
    const card = await this.cardOf(r.from);
    return this.rpc(card.interfaces[0].url, "ocx/referral.outcome", { referral: referralId, category: r.category, ...outcome });
  }

  // ---------- Appeal (§10.9)
  async decideAppeal(appealId, decision) {
    const a = this.appeals.get(appealId); if (!a) throw new Error("no such appeal");
    a.status = decision; this.note("appeal_decided", { signal: a.signal, decision });
    if (decision === "retracted") await this.retract(a.signal, "appeal upheld by the owner");
    return a.status;
  }
  async checkAppeals() { // receiver side: signals whose appeal is overdue drop to suspected
    for (const [, rec] of this.signals) {
      if (!rec.applied || rec.retracted) continue;
      try {
        const st = await this.rpc(`${didToBase(rec.signal.issuer)}/ocx`, "ocx/appeal.status", { signal: rec.signal.id });
        if (st.status === "overdue") { rec.downgraded = true; this.unapply(rec); this.note("downgraded_overdue_appeal", { id: rec.signal.id }); }
      } catch {}
    }
  }

  listen() {
    this.server = http.createServer(async (req, res) => {
      let body = ""; for await (const c of req) body += c;
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      try {
        if (req.method === "GET" && req.url === "/.well-known/orchestrator-card.json") return send(200, this.card());
        if (req.method === "GET" && req.url === "/ocx/checkpoint") return send(200, this.ledger.checkpoints.at(-1) || null);
        if (req.method === "POST" && req.url === "/ocx") return send(200, await this.handleRpc(req, body));
        if (req.method === "POST" && req.url.startsWith("/agent/")) {
          const p = JSON.parse(body || "{}"), op = req.url.slice(7);
          if (op === "register") return send(200, { id: this.registerAgent(p) });
          if (op === "act") return send(200, this.act(p));
          if (op === "report") return send(200, await this.report(p));
          if (op === "pay") return send(200, await this.pay(p));
        }
        send(404, { error: "not found" });
      } catch (e) { send(400, { error: e.message }); }
    });
    return new Promise((r) => this.server.listen(this.port, "127.0.0.1", r));
  }
  close() { return new Promise((r) => this.server.close(r)); }
}
