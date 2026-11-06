// Merkle tree hashing and inclusion proofs as in RFC 9162 §2.1 (Certificate Transparency v2):
// leaf = SHA-256(0x00 || data), node = SHA-256(0x01 || left || right), split at the largest power of two below n.
import { sha256 } from "./crypto.js";

export const leafHash = (data) => sha256(Buffer.concat([Buffer.from([0]), Buffer.from(data)]));
const nodeHash = (l, r) => sha256(Buffer.concat([Buffer.from([1]), l, r]));
const split = (n) => { let k = 1; while (k * 2 < n) k *= 2; return k; };

export function root(leaves) { // leaves: array of leaf hashes (Buffer)
  if (leaves.length === 0) return sha256(Buffer.alloc(0));
  if (leaves.length === 1) return leaves[0];
  const k = split(leaves.length);
  return nodeHash(root(leaves.slice(0, k)), root(leaves.slice(k)));
}

export function inclusionProof(index, leaves) {
  const n = leaves.length; if (index < 0 || index >= n) throw new Error("index out of range");
  if (n === 1) return [];
  const k = split(n);
  return index < k ? [...inclusionProof(index, leaves.slice(0, k)), root(leaves.slice(k))]
                   : [...inclusionProof(index - k, leaves.slice(k)), root(leaves.slice(0, k))];
}

// RFC 9162 §2.1.3.2 verification algorithm
export function verifyInclusion(index, size, leaf, proof, expectedRoot) {
  if (index >= size) return false;
  let fn = index, sn = size - 1, r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1) === 0) { while ((fn & 1) === 0 && fn !== 0) { fn >>= 1; sn >>= 1; } }
    } else r = nodeHash(r, p);
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && Buffer.compare(r, expectedRoot) === 0;
}
