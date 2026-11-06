// Receipt ledger (OCX §9.2, §9.3, §9.5). Receipts are made by the orchestrator, never by the agent.
// Every receipt is a leaf of a Merkle tree (RFC 9162). Each checkpoint also commits a per-agent index:
// for every agent, the ordered list of tree positions of its receipts. The index tree has one leaf per agent,
// leaf data = JCS({agent, positions}), sorted by agent id. This is what makes "there was no such action" provable.
import { jcs, sha256hex, signDetached, verifyDetached, fromB64u } from "./crypto.js";
import { leafHash, root, inclusionProof, verifyInclusion } from "./merkle.js";

const hex = (b) => "sha256:" + Buffer.from(b).toString("hex");
const unhex = (h) => Buffer.from(String(h).replace(/^sha256:/, ""), "hex");

export class Ledger {
  constructor({ issuer, key, ulid }) { this.issuer = issuer; this.key = key; this.ulid = ulid; this.receipts = []; this.leaves = []; this.byAgent = new Map(); this.checkpoints = []; }

  append({ agent, task, action, tool, input, output }) {
    const prev = this.receipts.length ? sha256hex(jcs(this.receipts.at(-1))) : "sha256:" + "0".repeat(64);
    const r = { id: `${this.issuer}#${this.ulid()}`, agent, task, action, tool, input_hash: sha256hex(jcs(input ?? null)), output_hash: sha256hex(jcs(output ?? null)), at: new Date().toISOString(), prev, tool_attestation: null };
    r.signature = signDetached(this.key, r);
    const pos = this.receipts.length;
    this.receipts.push(r); this.leaves.push(leafHash(jcs(r)));
    if (!this.byAgent.has(agent)) this.byAgent.set(agent, []);
    this.byAgent.get(agent).push(pos);
    return r;
  }

  agentIndexLeaves(size) {
    const agents = [...this.byAgent.keys()].sort();
    return agents.map((a) => ({ agent: a, positions: this.byAgent.get(a).filter((p) => p < size) })).filter((e) => e.positions.length);
  }

  checkpoint() {
    const size = this.receipts.length;
    const idx = this.agentIndexLeaves(size);
    const cp = { issuer: this.issuer, tree_size: size, root_hash: hex(root(this.leaves.slice(0, size))), agent_index_root: hex(root(idx.map((e) => leafHash(jcs(e))))), agents: idx.length, at: new Date().toISOString() };
    cp.signature = signDetached(this.key, cp);
    this.checkpoints.push(cp);
    return cp;
  }

  // Everything a receiver needs to check that, within [from, to], the agent's receipts are exactly these.
  windowProof(agent, from, to, cp) {
    const size = cp.tree_size, idx = this.agentIndexLeaves(size);
    const pos = idx.findIndex((e) => e.agent === agent);
    if (pos < 0) return { agent, index_entry: { agent, positions: [] }, absent: true, checkpoint: cp };
    const entry = idx[pos];
    const leaves = this.leaves.slice(0, size);
    const inWindow = entry.positions.map((p) => ({ p, r: this.receipts[p] })).filter(({ r }) => r.at >= from && r.at <= to);
    return {
      agent, checkpoint: cp,
      index_entry: entry, index_position: pos, index_size: idx.length,
      index_proof: inclusionProof(pos, idx.map((e) => leafHash(jcs(e)))).map(hex),
      // receipts adjacent to the window prove its edges: the last one before and the first one after
      receipts: entry.positions.map((p, i) => ({ p, i, r: this.receipts[p] }))
        .filter(({ r }, i, arr) => (r.at >= from && r.at <= to) || (arr[i + 1] && arr[i + 1].r.at >= from && r.at < from) || (arr[i - 1] && arr[i - 1].r.at <= to && r.at > to))
        .map(({ p, r }) => ({ position: p, receipt: r, proof: inclusionProof(p, leaves).map(hex) })),
      in_window: inWindow.length,
    };
  }
}

// Receiver side: verify a window proof against the issuer's keys. Returns the receipts in the window or a reason.
export function verifyWindow(proof, from, to, jwkLookup) {
  const cp = proof.checkpoint;
  if (!verifyDetached(jwkLookup, cp, cp.signature).ok) return { ok: false, reason: "checkpoint signature" };
  if (proof.absent) return { ok: false, reason: "agent absent from index: cannot prove a window for it" };
  const e = proof.index_entry;
  if (!verifyInclusion(proof.index_position, proof.index_size, leafHash(jcs(e)), proof.index_proof.map(unhex), unhex(cp.agent_index_root))) return { ok: false, reason: "agent index proof" };
  const given = new Map();
  for (const x of proof.receipts) {
    if (x.receipt.agent !== proof.agent) return { ok: false, reason: "receipt of another agent" };
    if (!e.positions.includes(x.position)) return { ok: false, reason: "receipt not in agent index" };
    if (!verifyDetached(jwkLookup, x.receipt, x.receipt.signature).ok) return { ok: false, reason: "receipt signature" };
    if (!verifyInclusion(x.position, cp.tree_size, leafHash(jcs(x.receipt)), x.proof.map(unhex), unhex(cp.root_hash))) return { ok: false, reason: "receipt inclusion" };
    given.set(x.position, x.receipt);
  }
  // completeness: every indexed position whose receipt falls in the window must be present. Positions are in time order,
  // so the window is a contiguous run; its neighbours (if any) must be given and lie outside the window.
  const pos = e.positions;
  const shown = pos.filter((p) => given.has(p));
  const inWin = shown.filter((p) => given.get(p).at >= from && given.get(p).at <= to);
  if (inWin.length) {
    const a = pos.indexOf(inWin[0]), b = pos.indexOf(inWin.at(-1));
    for (let i = a; i <= b; i++) if (!given.has(pos[i])) return { ok: false, reason: "gap inside window" };
    if (a > 0 && !(given.has(pos[a - 1]) && given.get(pos[a - 1]).at < from)) return { ok: false, reason: "left edge not proven" };
    if (b < pos.length - 1 && !(given.has(pos[b + 1]) && given.get(pos[b + 1]).at > to)) return { ok: false, reason: "right edge not proven" };
  } else {
    // empty window: need the two neighbours around it (or the list edge)
    const before = shown.filter((p) => given.get(p).at < from), after = shown.filter((p) => given.get(p).at > to);
    const lastBefore = before.at(-1), firstAfter = after[0];
    const iB = lastBefore === undefined ? -1 : pos.indexOf(lastBefore), iA = firstAfter === undefined ? pos.length : pos.indexOf(firstAfter);
    if (iA - iB !== 1) return { ok: false, reason: "empty window not proven" };
  }
  return { ok: true, receipts: inWin.map((p) => given.get(p)) };
}
