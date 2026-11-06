// Conformance checks for the OCX Core and Evidence profiles, run against the reference orchestrator.
// node --test spec/ocx/impl/test/
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Orchestrator, VERSION } from "../lib/orchestrator.js";
import { signRequest } from "../lib/httpsig.js";
import { Ledger, verifyWindow } from "../lib/ledger.js";
import { newKey, signDetached, verifyDetached, thumbprint } from "../lib/crypto.js";

const P = 6700;
const A = new Orchestrator({ name: "A", port: P + 1 });
const B = new Orchestrator({ name: "B", port: P + 2 });
const C = new Orchestrator({ name: "C", port: P + 3 });
const wait = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await new Promise((r) => setTimeout(r, 5)); } return false; };

before(async () => { for (const o of [A, B, C]) await o.listen(); await A.peerWith(B.base); await B.peerWith(C.base); });
after(async () => { for (const o of [A, B, C]) await o.close(); });

test("card is served at the well-known path and has the required fields", async () => {
  const card = await (await fetch(`${A.base}/.well-known/orchestrator-card.json`)).json();
  for (const k of ["id", "name", "roles", "interfaces", "keys", "capabilities", "policies", "updated_at"]) assert.ok(k in card, k);
  assert.equal(card.interfaces[0].protocol, "ocx");
  assert.ok(card.interfaces[0].protocolVersions.includes(VERSION));
  assert.ok(["consent_required", "none"].includes(card.policies.probing));
  const schema = JSON.parse(readFileSync(new URL("../../schema/orchestrator-card.schema.json", import.meta.url)));
  for (const k of schema.required) assert.ok(k in card, `schema requires ${k}`);
});

test("peering is symmetric", () => {
  assert.ok(A.peers.has(B.id) && B.peers.has(A.id));
  assert.ok(B.peers.has(C.id) && C.peers.has(B.id));
});

test("unsupported version is refused with -32012 and the supported list", async () => {
  await assert.rejects(C.rpc(A.url, "ocx/peer.hello", { orchestrator: C.id, protocolVersions: ["2020-01-01"] }), (e) => e.rpc?.code === -32012 && e.rpc.data.supported.includes(VERSION));
});

test("unsigned request is refused with -32011", async () => {
  const r = await fetch(A.url, { method: "POST", headers: { "content-type": "application/json", "ocx-sender": B.id }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ocx/ping" }) });
  assert.equal((await r.json()).error.code, -32011);
});

test("replayed request is refused", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ocx/ping" });
  const headers = { ...signRequest(B.key, { method: "POST", url: A.url, body, version: VERSION }), "ocx-sender": B.id };
  const first = await (await fetch(A.url, { method: "POST", headers, body })).json();
  const second = await (await fetch(A.url, { method: "POST", headers, body })).json();
  assert.ok(first.result?.pong);
  assert.equal(second.error.code, -32011);
  assert.equal(second.error.data.reason, "replay");
});

test("request signed with a key not in the sender's card is refused", async () => {
  const stranger = newKey(B.key.kid); // same kid, different key
  const body = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ocx/ping" });
  const headers = { ...signRequest(stranger, { method: "POST", url: A.url, body, version: VERSION }), "ocx-sender": B.id };
  const r = await (await fetch(A.url, { method: "POST", headers, body })).json();
  assert.equal(r.error.code, -32011);
});

test("push from a non-peer is refused with -32010", async () => {
  const s = C.makeSignal({ subject: { kind: "agent", agent: "fp:sha256:" + "1".repeat(64) }, category: "operations", claim: "limit_exceeded", level: "suspected", evidence: [{ type: "behavioral_anomaly" }] });
  await assert.rejects(C.rpc(A.url, "ocx/signals.push", { signals: [s] }), (e) => e.rpc?.code === -32010);
});

test("a signal with an altered field is rejected with -32021", async () => {
  const s = A.makeSignal({ subject: { kind: "agent", agent: "fp:sha256:" + "2".repeat(64) }, category: "operations", claim: "limit_exceeded", level: "suspected", evidence: [{ type: "behavioral_anomaly" }] });
  const res = await A.rpc(B.url, "ocx/signals.push", { signals: [{ ...s, category: "payments" }] });
  assert.equal(res.accepted.length, 0);
  assert.equal(res.rejected[0].code, -32021);
});

test("an expired signal is rejected with -32020", async () => {
  const s = A.makeSignal({ subject: { kind: "agent", agent: "fp:sha256:" + "3".repeat(64) }, category: "operations", claim: "limit_exceeded", level: "suspected", evidence: [{ type: "behavioral_anomaly" }], ttlH: -1 });
  const res = await A.rpc(B.url, "ocx/signals.push", { signals: [s] });
  assert.equal(res.rejected[0].code, -32020);
});

test("relay fields are outside the signature; a loop or too many hops is rejected", async () => {
  const s = A.makeSignal({ subject: { kind: "agent", agent: "fp:sha256:" + "4".repeat(64) }, category: "operations", claim: "limit_exceeded", level: "suspected", evidence: [{ type: "behavioral_anomaly" }] });
  const lookup = (kid) => (kid === A.key.kid ? A.key.jwk : null);
  assert.ok(verifyDetached(lookup, { ...s, relay: { hops: 1, max_hops: 2, path: [B.id] } }, s.signature, ["signature", "relay"]).ok);
  const loop = await A.rpc(B.url, "ocx/signals.push", { signals: [{ ...s, relay: { hops: 1, max_hops: 2, path: [B.id] } }] });
  assert.equal(loop.rejected[0].code, -32022);
  const many = await A.rpc(B.url, "ocx/signals.push", { signals: [{ ...s, relay: { hops: 3, max_hops: 2, path: [] } }] });
  assert.equal(many.rejected[0].code, -32022);
});

test("a suspected signal is recorded but changes no limits and is not relayed", async () => {
  const agent = "fp:sha256:" + "5".repeat(64);
  const s = await A.issue({ subject: { kind: "agent", agent }, claim: "limit_exceeded", level: "suspected", evidence: [{ type: "behavioral_anomaly" }], category: "operations" });
  assert.ok(await wait(() => B.events.some((e) => e.type === "monitoring_only" && e.id === s.id)));
  assert.equal(B.agents.get(agent), undefined);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!C.signals.has(s.id));
});

test("duplicates are ignored", async () => {
  const s = A.makeSignal({ subject: { kind: "agent", agent: "fp:sha256:" + "6".repeat(64) }, category: "operations", claim: "limit_exceeded", level: "suspected", evidence: [{ type: "behavioral_anomaly" }] });
  const r1 = await A.rpc(B.url, "ocx/signals.push", { signals: [s] });
  const r2 = await A.rpc(B.url, "ocx/signals.push", { signals: [s] });
  assert.equal(r1.accepted.length, 1); assert.equal(r2.accepted.length, 0); assert.equal(r2.rejected.length, 0);
});

test("status answers are signed by the answering orchestrator", async () => {
  const ans = await A.rpc(B.url, "ocx/status.query", { subject: { agent: "fp:sha256:" + "5".repeat(64) }, category: "operations" });
  assert.equal(ans.issuer, B.id);
  assert.ok(verifyDetached((kid) => (kid === B.key.kid ? B.key.jwk : null), ans, ans.signature).ok);
  assert.equal(ans.active_signals.length, 1);
  assert.equal(ans.active_signals[0].verified_by_me, false);
});

test("evidence for an unknown signal is refused with -32023", async () => {
  await assert.rejects(B.rpc(A.url, "ocx/evidence.get", { signal: `${A.id}#nope` }), (e) => e.rpc?.code === -32023);
});

test("ledger: window proof shows exactly the receipts in the window and detects tampering", async () => {
  const k = newKey("L"); let n = 0;
  const L = new Ledger({ issuer: "did:web:l.example", key: k, ulid: () => String(++n) });
  const pause = () => new Promise((r) => setTimeout(r, 3));
  for (let i = 0; i < 4; i++) { L.append({ agent: "x", task: "t0", tool: "a" }); L.append({ agent: "y", task: "t0", tool: "b" }); }
  await pause(); const from = new Date().toISOString(); await pause();
  L.append({ agent: "x", task: "t1", tool: "c" }); L.append({ agent: "x", task: "t1", tool: "d" });
  await pause(); const to = new Date().toISOString(); await pause();
  L.append({ agent: "x", task: "t2", tool: "e" });
  const cp = L.checkpoint(), lookup = (kid) => (kid === "L" ? k.jwk : null);
  const proof = L.windowProof("x", from, to, cp);
  const ok = verifyWindow(proof, from, to, lookup);
  assert.ok(ok.ok); assert.deepEqual(ok.receipts.map((r) => r.tool), ["c", "d"]);
  const dropped = structuredClone(proof); dropped.receipts = dropped.receipts.filter((x) => x.receipt.tool !== "c");
  assert.equal(verifyWindow(dropped, from, to, lookup).ok, false);
  const edited = structuredClone(proof); edited.receipts.find((x) => x.receipt.tool === "d").receipt.tool = "z";
  assert.equal(verifyWindow(edited, from, to, lookup).ok, false);
  const index = structuredClone(proof); index.index_entry.positions.pop();
  assert.equal(verifyWindow(index, from, to, lookup).ok, false);
  const badCp = structuredClone(proof); badCp.checkpoint.tree_size += 1;
  assert.equal(verifyWindow(badCp, from, to, lookup).reason, "checkpoint signature");
});

test("agent identifiers are key thumbprints, so a report key can be bound to the subject", () => {
  const k = newKey("tmp");
  assert.match(thumbprint(k.jwk), /^fp:sha256:[0-9a-f]{64}$/);
  assert.equal(thumbprint(k.jwk), thumbprint({ ...k.jwk, kid: "other" }));
});

test("retraction is accepted and relayed even though the original was not", async () => {
  const s = await A.issue({ subject: { kind: "agent", agent: "fp:sha256:" + "7".repeat(64) }, claim: "limit_exceeded", level: "suspected", evidence: [{ type: "behavioral_anomaly" }], category: "operations" });
  await wait(() => B.signals.has(s.id));
  await A.retract(s.id, "test");
  assert.ok(await wait(() => B.events.some((e) => e.type === "retraction_applied" && e.supersedes === s.id)));
  assert.ok(await wait(() => C.events.some((e) => e.type === "retraction_applied" && e.supersedes === s.id)));
});

test("status lists the answerer's own signals and drops them once retracted; own limits reopen", async () => {
  const k = newKey("st-agent"); const id = A.registerAgent({ jwk: k.jwk, owner: "fp:sha256:" + "d".repeat(64) }); k.kid = id;
  const from = new Date(Date.now() - 1000).toISOString();
  A.act({ agent: id, task: "t-st", tool: "callback", input: {}, output: {} });
  const report = { agent: id, task: "t-st", checks: ["callback", "po_match"], window: { from, to: new Date(Date.now() + 1000).toISOString() } };
  const r = await A.report({ report, jws: signDetached(k, report) });
  assert.deepEqual(r.mismatch, ["po_match"]);
  const q = await C.rpc(A.url, "ocx/status.query", { subject: { kind: "agent", agent: id } });
  assert.ok(q.active_signals.some((s) => s.id === r.signal && s.verified_by_me), "own signal is in the answer");
  assert.equal(q.own_limits.human_confirmation, true);
  await A.retract(r.signal, "test");
  const q2 = await C.rpc(A.url, "ocx/status.query", { subject: { kind: "agent", agent: id } });
  assert.ok(!q2.active_signals.some((s) => s.id === r.signal), "retracted signal is gone");
  assert.equal(q2.own_limits.human_confirmation, false);
});
