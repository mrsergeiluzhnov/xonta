// OCX conformance runner: checks any OCX implementation from the outside, as a peer would see it.
// It starts a small tester orchestrator, peers with the target and runs the Core checks.
//
//   node conformance.mjs https://orch.example.com
//   TESTER_PUBLIC_URL=https://tester.example.com TESTER_PORT=7900 node conformance.mjs https://orch.example.com
//
// The target must be able to reach the tester's card, so for a remote target run the tester behind a public URL.
// Output: a table in the terminal and conformance-<host>.json next to this file.
import { writeFileSync, readFileSync } from "node:fs";
import { Orchestrator, VERSION, experienceStatus } from "./lib/orchestrator.js";
import { signRequest } from "./lib/httpsig.js";
import { verifyDetached, signDetached } from "./lib/crypto.js";

const target = (process.argv[2] || "").replace(/\/$/, "");
if (!target) { console.error("usage: node conformance.mjs <target base url>"); process.exit(2); }
const port = Number(process.env.TESTER_PORT || 7900);
const T = new Orchestrator({ name: "ocx-conformance", port, publicBase: process.env.TESTER_PUBLIC_URL || null, roles: ["auditor"] });
await T.listen();

const results = [];
const check = async (profile, name, fn) => {
  try { const r = await fn(); results.push({ profile, name, ok: r !== false, detail: typeof r === "string" ? r : "" }); }
  catch (e) { results.push({ profile, name, ok: false, detail: e.rpc ? `${e.rpc.code} ${e.rpc.message}` : e.message }); }
};
const expectCode = (p, code) => p.then(() => { throw new Error(`expected ${code}, got success`); }, (e) => { if (e.rpc?.code !== code) throw new Error(`expected ${code}, got ${e.rpc?.code ?? e.message}`); return `${code}`; });
const raw = async (url, headers, body) => (await fetch(url, { method: "POST", headers, body })).json();

let card = null, ocxUrl = null;
await check("Core", "card at /.well-known/orchestrator-card.json", async () => {
  const r = await fetch(`${target}/.well-known/orchestrator-card.json`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!/application\/json/.test(r.headers.get("content-type") || "")) throw new Error("content-type is not application/json");
  card = await r.json();
  const schema = JSON.parse(readFileSync(new URL("../schema/orchestrator-card.schema.json", import.meta.url)));
  const missing = schema.required.filter((k) => !(k in card)); if (missing.length) throw new Error("missing " + missing.join(", "));
  const i = (card.interfaces || []).find((x) => x.protocol === "ocx"); if (!i) throw new Error("no ocx interface");
  ocxUrl = i.url; return card.id;
});
if (!card) { report(); process.exit(1); }

await check("Core", "supports protocol version " + VERSION, () => card.interfaces.find((x) => x.protocol === "ocx").protocolVersions.includes(VERSION) || false);
await check("Core", "policies.probing is consent_required or none", () => ["consent_required", "none"].includes(card.policies?.probing) || false);
await check("Core", "keys are published", () => !!(card.keys?.jwks?.keys?.length || card.keys?.jwks_uri) || false);

await check("Core", "unsigned request refused with -32011", async () => {
  const j = await raw(ocxUrl, { "content-type": "application/json", "ocx-sender": T.id }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ocx/ping" }));
  return j.error?.code === -32011 || `got ${JSON.stringify(j.error || j.result)}`;
});
await check("Core", "unknown version refused with -32012 and supported list", () =>
  expectCode(T.rpc(ocxUrl, "ocx/peer.hello", { orchestrator: T.id, protocolVersions: ["2000-01-01"], subscription: {} }), -32012));
await check("Core", "peer.hello succeeds", async () => {
  const r = await T.peerWith(target); return r.protocolVersion === VERSION || `version ${r.protocolVersion}`;
});
await check("Core", "ping", async () => !!(await T.rpc(ocxUrl, "ocx/ping", {})));
await check("Core", "replayed request refused with -32011", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ocx/ping" });
  const h = { ...signRequest(T.key, { method: "POST", url: ocxUrl, body, version: VERSION }), "ocx-sender": T.id };
  const a = await raw(ocxUrl, h, body), b = await raw(ocxUrl, h, body);
  return (a.result && b.error?.code === -32011) || `first ${JSON.stringify(a.error || "ok")}, second ${JSON.stringify(b.error || b.result)}`;
});
const subj = { kind: "agent", agent: "fp:sha256:" + "e".repeat(64) };
const mk = (o = {}) => T.makeSignal({ subject: subj, category: "operations", claim: "limit_exceeded", level: "suspected", evidence: [{ type: "behavioral_anomaly" }], ...o });
await check("Core", "valid signal accepted", async () => { const s = mk(); const r = await T.rpc(ocxUrl, "ocx/signals.push", { signals: [s] }); return r.accepted?.includes(s.id) || JSON.stringify(r); });
await check("Core", "altered signal rejected with -32021", async () => { const s = mk(); const r = await T.rpc(ocxUrl, "ocx/signals.push", { signals: [{ ...s, claim: "other" }] }); return r.rejected?.[0]?.code === -32021 || JSON.stringify(r); });
await check("Core", "expired signal rejected with -32020", async () => { const s = mk({ ttlH: -1 }); const r = await T.rpc(ocxUrl, "ocx/signals.push", { signals: [s] }); return r.rejected?.[0]?.code === -32020 || JSON.stringify(r); });
await check("Core", "relay loop rejected with -32022", async () => { const s = mk(); const r = await T.rpc(ocxUrl, "ocx/signals.push", { signals: [{ ...s, relay: { hops: 1, max_hops: 2, path: [card.id] } }] }); return r.rejected?.[0]?.code === -32022 || JSON.stringify(r); });
await check("Core", "duplicate ignored", async () => { const s = mk(); await T.rpc(ocxUrl, "ocx/signals.push", { signals: [s] }); const r = await T.rpc(ocxUrl, "ocx/signals.push", { signals: [s] }); return (r.accepted.length === 0 && r.rejected.length === 0) || JSON.stringify(r); });
await check("Core", "status answer is signed by the target", async () => {
  const a = await T.rpc(ocxUrl, "ocx/status.query", { subject: { agent: subj.agent }, category: "operations" });
  const ok = verifyDetached((kid) => (card.keys.jwks?.keys || []).find((k) => k.kid === kid), a, a.signature).ok;
  return (ok && a.issuer === card.id) || "signature or issuer mismatch";
});
await check("Core", "retraction accepted", async () => {
  const s = mk(); await T.rpc(ocxUrl, "ocx/signals.push", { signals: [s] }); T.issued.set(s.id, { signal: s });
  const r = T.makeSignal({ type: "conduct.retraction", subject: subj, category: "operations", claim: "limit_exceeded", level: "suspected", evidence: [{ type: "peer_report", cites: s.id }], supersedes: s.id, reason: "conformance" });
  const res = await T.rpc(ocxUrl, "ocx/signals.push", { signals: [r] }); return res.accepted?.includes(r.id) || JSON.stringify(res);
});
if (card.capabilities?.evidence) await check("Evidence", "unknown signal evidence refused with -32023", () => expectCode(T.rpc(ocxUrl, "ocx/evidence.get", { signal: `${card.id}#does-not-exist` }), -32023));
if (card.capabilities?.experience) {
  await check("Experience", "experience.get answers", async () => Array.isArray((await T.rpc(ocxUrl, "ocx/experience.get", {})).packages) || false);
  // §10.7: harmful experience is never served, and a receiver refuses it however it is labelled
  await check("Experience", "experience.get serves nothing harmful", async () => {
    const bad = (await T.rpc(ocxUrl, "ocx/experience.get", {})).packages.filter((p) => p.status === "harmful" || (p.status !== "revoked" && experienceStatus(p.measurement?.harm_delta_per_task, p.measurement?.baseline?.harm_delta_vs_baseline_per_task) === "harmful"));
    return !bad.length || `served ${bad.map((p) => p.id).join(", ")}`;
  });
  const m = { design: "paired", pairs: 120, better: 10, worse: 30, holdout: true };
  const pkg = (measurement, status) => { const p = { ...T.publishExperience({ category: "operations", rule: { kind: "conformance" }, measurement: { ...m, ...measurement } }) }; delete p.signature; p.status = status; p.signature = signDetached(T.key, p); return p; };
  const worse = { harm_delta_per_task: 0.5, baseline: { policy: "always escalate", harm_delta_vs_baseline_per_task: 0.7 } };
  await check("Experience", "package marked harmful refused with -32602", () => expectCode(T.rpc(ocxUrl, "ocx/experience.offer", { packages: [pkg(worse, "harmful")] }), -32602));
  await check("Experience", "package worse than agent and baseline but marked no_effect refused with -32602", () => expectCode(T.rpc(ocxUrl, "ocx/experience.offer", { packages: [pkg(worse, "no_effect")] }), -32602));
  await check("Experience", "package marked proven without beating the baseline refused with -32602", () => expectCode(T.rpc(ocxUrl, "ocx/experience.offer", { packages: [pkg({ harm_delta_per_task: -0.2, baseline: { policy: "always escalate", harm_delta_vs_baseline_per_task: 0.3 } }, "proven")] }), -32602));
}
if (card.capabilities?.referral) await check("Referral", "competence.query answer is signed", async () => {
  const a = await T.rpc(ocxUrl, "ocx/competence.query", { category: "operations" });
  return verifyDetached((kid) => (card.keys.jwks?.keys || []).find((k) => k.kid === kid), a, a.signature).ok || "bad signature";
});
if (card.capabilities?.appeal) await check("Appeal", "appeal.status answers for an unknown signal", async () => (await T.rpc(ocxUrl, "ocx/appeal.status", { signal: `${card.id}#none` })).status === "none" || false);

report();
await T.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);

function report() {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  [${r.profile}] ${r.name}${r.detail && !r.ok ? "  — " + r.detail : ""}`);
  const host = new URL(target).host.replace(/[^a-z0-9.-]/gi, "_");
  const out = { ocx: VERSION, target, card_id: card?.id || null, at: new Date().toISOString(), passed: results.filter((r) => r.ok).length, total: results.length, results };
  writeFileSync(new URL(`./conformance-${host}.json`, import.meta.url), JSON.stringify(out, null, 1));
  console.log(`\n${out.passed}/${out.total} passed`);
}
