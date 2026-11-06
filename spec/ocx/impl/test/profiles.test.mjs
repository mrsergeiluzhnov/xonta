// Conformance checks for the Experience, Referral and Appeal profiles.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../lib/orchestrator.js";
import { newKey, signDetached, verifyDetached, thumbprint } from "../lib/crypto.js";

const P = 6800;
const X = new Orchestrator({ name: "X", port: P + 1 });               // general orchestrator
const Y = new Orchestrator({ name: "Y", port: P + 2 });               // specialised in "support"
const Z = new Orchestrator({ name: "Z", port: P + 3 });               // a peer of X that receives experience
const wait = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await new Promise((r) => setTimeout(r, 5)); } return false; };
const base = { pairs: 141, better: 16, worse: 18, harm_scale: { miss: 6, false_alarm: 2 }, holdout: true, design: "paired" };

before(async () => {
  for (const o of [X, Y, Z]) await o.listen();
  await X.peerWith(Y.base); await X.peerWith(Z.base);
  Y.acceptReferrals.add("support");
  Y.competenceDecl = [{ category: "support", outcomes: { tasks: 900, harm_per_task: 0.8, baseline_harm_per_task: 1.4, period: "P30D" }, accepts_referrals: true }];
});
after(async () => { for (const o of [X, Y, Z]) await o.close(); });

// ---------- Experience
test("experience: a package without a baseline cannot be published", () => {
  assert.throws(() => X.publishExperience({ category: "support", rule: { kind: "words", words: ["refund"], then: "escalate" }, measurement: { ...base, harm_delta_per_task: -0.3 } }), /baseline/);
});

test("experience: better than the agent but not than the baseline is published as no_effect, not proven", () => {
  const p = X.publishExperience({ category: "support", rule: { kind: "words", words: ["urgent"], then: "escalate" }, measurement: { ...base, harm_delta_per_task: -0.4, baseline: { policy: "always escalate", harm_delta_vs_baseline_per_task: 0.1 } } });
  assert.equal(p.status, "no_effect");
});

test("experience: receiver verifies, re-measures on its own data and keeps its own verdict", async () => {
  const good = Y.publishExperience({ category: "support", rule: { kind: "words", words: ["chargeback"], then: "escalate" }, measurement: { ...base, harm_delta_per_task: -0.43, baseline: { policy: "always escalate", harm_delta_vs_baseline_per_task: -0.63 } } });
  assert.equal(good.status, "proven");
  X.remeasure = async (pkg) => (pkg.rule.words.includes("chargeback") ? { harm_delta_per_task: -0.2, baseline_delta_per_task: -0.1 } : { harm_delta_per_task: 0.05, baseline_delta_per_task: 0.2 });
  const r = await Y.rpc(X.url, "ocx/experience.offer", { packages: [good] });
  assert.deepEqual(r.received, [{ id: good.id, local: "confirmed" }]);
  const other = Y.publishExperience({ category: "support", rule: { kind: "words", words: ["hello"], then: "escalate" }, measurement: { ...base, harm_delta_per_task: -0.1, baseline: { policy: "always escalate", harm_delta_vs_baseline_per_task: -0.05 } } });
  const r2 = await Y.rpc(X.url, "ocx/experience.offer", { packages: [other] });
  assert.equal(r2.received[0].local, "no_effect", "proven at the sender, no effect on the receiver's data");
});

test("experience: a package claiming proven without beating the baseline is refused", async () => {
  const p = { ...Y.publishExperience({ category: "support", rule: { kind: "x" }, measurement: { ...base, harm_delta_per_task: -0.2, baseline: { policy: "always", harm_delta_vs_baseline_per_task: 0.3 } } }) };
  p.status = "proven"; p.signature = signDetached(Y.key, p);
  await assert.rejects(Y.rpc(X.url, "ocx/experience.offer", { packages: [p] }), (e) => e.rpc?.code === -32602);
});

test("experience: a tampered package is refused", async () => {
  const p = Y.publishExperience({ category: "support", rule: { kind: "words", words: ["a"], then: "b" }, measurement: { ...base, harm_delta_per_task: -0.5, baseline: { policy: "always", harm_delta_vs_baseline_per_task: -0.2 } } });
  await assert.rejects(Y.rpc(X.url, "ocx/experience.offer", { packages: [{ ...p, rule: { kind: "words", words: ["changed"], then: "b" } }] }), (e) => e.rpc?.code === -32021);
});

test("experience.get returns the issuer's packages for a category", async () => {
  const r = await X.fetchExperience(Y.base, "support");
  assert.ok(r.packages.length >= 3 && r.packages.every((p) => p.category === "support"));
});

// ---------- Referral
const agent = { kind: "agent", agent: "fp:sha256:" + "a".repeat(64), owner: "fp:sha256:" + "b".repeat(64) };

test("referral: the target declines a category it does not accept", async () => {
  await assert.rejects(X.refer({ to: Y.id, subject: agent, category: "payments", reason: "category_outside_competence" }), (e) => e.rpc?.code === -32040);
});

test("referral: token is signed, states reason and relationship, offers learn_here when the target has proven experience", async () => {
  const tok = await X.refer({ to: Y.id, subject: agent, category: "support", reason: "category_outside_competence" });
  assert.ok(verifyDetached((kid) => (kid === X.key.kid ? X.key.jwk : null), tok, tok.signature).ok);
  assert.equal(tok.reason, "category_outside_competence"); assert.equal(tok.relationship, "none");
  assert.equal(tok.alternatives.learn_here, true); assert.ok(tok.alternatives.experience.length >= 1);
  assert.equal(tok.evidence.competence_by_me, null, "X has not observed Y yet and says so");
  const adm = await Y.admitReferred(tok);
  assert.equal(adm.admitted, true);
  await assert.rejects(Y.admitReferred(tok), (e) => e.rpc?.code === -32041, "a token is used once");
});

test("referral: outcomes from the target build competence at the referrer; receipts count more than self-reports", async () => {
  for (let i = 0; i < 3; i++) {
    const tok = await X.refer({ to: Y.id, subject: { ...agent, agent: "fp:sha256:" + String(i).repeat(64) }, category: "support", reason: "category_outside_competence" });
    await Y.admitReferred(tok);
    await Y.reportOutcome(tok.target_referral_id, { tasks: 100, harm_per_task_before: 1.3, harm_per_task_after: 0.7, baseline_harm_per_task: 1.5, basis: i < 2 ? "receipts" : "agent_reported" });
  }
  const c = X.competence(Y.id, "support");
  assert.equal(c.referrals, 3); assert.equal(c.improved, 3);
  assert.equal(c.harm_delta_per_task, +((-0.6 - 0.6 - 0.3) / 3).toFixed(3));
});

test("referral: competence.query answers only from own observations, signed", async () => {
  const ans = await Z.rpc(X.url, "ocx/competence.query", { category: "support" });
  assert.ok(verifyDetached((kid) => (kid === X.key.kid ? X.key.jwk : null), ans, ans.signature).ok);
  assert.equal(ans.candidates[0].orchestrator, Y.id);
  assert.equal(ans.candidates[0].competence_by_me.referrals, 3);
  const none = await Z.rpc(X.url, "ocx/competence.query", { category: "payments" });
  assert.equal(none.candidates.length, 0);
});

test("referral: outcome about someone else's referral is refused", async () => {
  await assert.rejects(Z.rpc(X.url, "ocx/referral.outcome", { referral: "did:web:nowhere#ref-1", harm_per_task_before: 1, harm_per_task_after: 0, basis: "receipts" }), (e) => e.rpc?.code === -32602);
});

test("card declares competence and referral capability", async () => {
  const card = await (await fetch(`${Y.base}/.well-known/orchestrator-card.json`)).json();
  assert.equal(card.capabilities.referral.accept, true);
  assert.equal(card.competence[0].category, "support");
  assert.ok("baseline_harm_per_task" in card.competence[0].outcomes);
});

// ---------- Appeal
const ownerKey = newKey("owner"); const ownerId = thumbprint(ownerKey.jwk); ownerKey.kid = ownerId;
const subj = { kind: "agent", agent: "fp:sha256:" + "c".repeat(64), owner: ownerId, owner_verified: "signature" };
const appealBody = (signal, statement) => { const b = { signal, owner: ownerId, statement }; return { ...b, owner_jwk: ownerKey.jwk, owner_signature: signDetached(ownerKey, b) }; };

test("appeal: only the owner named in the signal can appeal", async () => {
  const s = await X.issue({ subject: subj, claim: "limit_exceeded", level: "suspected", evidence: [{ type: "behavioral_anomaly" }], category: "operations" });
  const stranger = newKey("s"); const sid = thumbprint(stranger.jwk); stranger.kid = sid;
  const b = { signal: s.id, owner: sid, statement: "not mine" };
  await assert.rejects(Z.rpc(X.url, "ocx/appeal.submit", { ...b, owner_jwk: stranger.jwk, owner_signature: signDetached(stranger, b) }), (e) => e.rpc?.code === -32031);
  const forged = appealBody(s.id, "x"); forged.statement = "changed after signing";
  await assert.rejects(Z.rpc(X.url, "ocx/appeal.submit", forged), (e) => e.rpc?.code === -32031);
});

test("appeal: upheld appeal retracts the signal and the retraction reaches peers", async () => {
  const s = await X.issue({ subject: subj, claim: "limit_exceeded", level: "suspected", evidence: [{ type: "behavioral_anomaly" }], category: "operations" });
  await wait(() => Y.signals.has(s.id));
  const a = await Z.rpc(X.url, "ocx/appeal.submit", appealBody(s.id, "the agent acted within its limits"));
  assert.equal(a.status, "received");
  assert.ok(new Date(a.respond_by) - Date.now() > 71 * 3600e3, "72 hours to respond");
  await X.decideAppeal(a.appeal_id, "retracted");
  assert.ok(await wait(() => Y.events.some((e) => e.type === "retraction_applied" && e.supersedes === s.id)));
  const st = await Z.rpc(X.url, "ocx/appeal.status", { signal: s.id });
  assert.equal(st.status, "retracted");
});

test("appeal: an overdue appeal is reported as overdue", async () => {
  X.appealHours = -1; // simulate an issuer that let the deadline pass
  const s = await X.issue({ subject: subj, claim: "limit_exceeded", level: "suspected", evidence: [{ type: "behavioral_anomaly" }], category: "operations" });
  await Z.rpc(X.url, "ocx/appeal.submit", appealBody(s.id, "no answer"));
  const st = await Z.rpc(X.url, "ocx/appeal.status", { signal: s.id });
  assert.equal(st.status, "overdue");
  X.appealHours = 72;
});

test("appeal: receivers downgrade applied signals whose appeal is overdue", async () => {
  X.appealHours = -1;
  const s = await X.issue({ subject: subj, claim: "limit_exceeded", level: "suspected", evidence: [{ type: "behavioral_anomaly" }], category: "operations" });
  await wait(() => Y.signals.has(s.id));
  const rec = Y.signals.get(s.id); Y.apply(rec); // as if Y had acted on it
  assert.equal(Y.agents.get(subj.agent).limits.human_confirmation, true);
  await Z.rpc(X.url, "ocx/appeal.submit", appealBody(s.id, "please review"));
  await Y.checkAppeals();
  assert.equal(rec.applied, false); assert.equal(rec.downgraded, true);
  assert.equal(Y.agents.get(subj.agent).limits.human_confirmation, false);
  X.appealHours = 72;
});
