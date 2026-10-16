// Дерево Меркла из отпечатков аттестатов: корень пишется раз в сутки во внешнюю систему (OpenTimestamps, сеть Base),
// к каждому аттестату — доказательство вхождения. Выдающий не может задним числом выдать, изменить или тихо отозвать аттестат.
import { sha256 } from "./crypto.js";

const H = (a, b) => sha256(Buffer.concat([Buffer.from([1]), a, b])); // префиксы 0/1 — защита от подмены листа узлом
const leaf = (hex) => sha256(Buffer.concat([Buffer.from([0]), Buffer.from(hex, "hex")]));

export function buildTree(leavesHex) {
  if (!leavesHex.length) return { root: null, levels: [] };
  let level = leavesHex.map(leaf);
  const levels = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? H(level[i], level[i + 1]) : level[i]);
    levels.push((level = next));
  }
  return { root: level[0].toString("hex"), levels };
}

export function proofFor(tree, index) {
  const path = [];
  for (let d = 0; d < tree.levels.length - 1; d++) {
    const lvl = tree.levels[d];
    const sib = index ^ 1;
    if (sib < lvl.length) path.push({ side: index & 1 ? "left" : "right", hash: lvl[sib].toString("hex") });
    index >>= 1;
  }
  return path;
}

export function verifyProof(leafHex, path, rootHex) {
  let h = leaf(leafHex);
  for (const p of path) h = p.side === "left" ? H(Buffer.from(p.hash, "hex"), h) : H(h, Buffer.from(p.hash, "hex"));
  return h.toString("hex") === rootHex;
}
