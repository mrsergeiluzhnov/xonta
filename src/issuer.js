// Выдающий аттестаты: ключ, DID, выдача, отзыв и приостановка, суточная контрольная сумма.
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadOrCreateKey, jcs, sha256hex } from "./crypto.js";
import { didDocument, urlToDidWeb } from "./did.js";
import { signCredential, credential, credentialHash, VC_CONTEXT } from "./vc.js";
import { newBitstring, encodeList, setBit, getBit, statusEntry, SIZE } from "./status.js";
import { buildTree, proofFor } from "./merkle.js";

export const PURPOSES = ["revocation", "suspension"];

export function createIssuer({ store, publicUrl, dataDir, contextUrl = `${publicUrl}/ns/v0` }) {
  const context = ["https://www.w3.org/ns/credentials/v2", contextUrl];
  const did = urlToDidWeb(publicUrl);
  const vm = `${did}#key-1`;
  const { privateKey, publicKey } = loadOrCreateKey(join(dataDir, "keys", "issuer.jwk"));
  const doc = didDocument(did, publicKey, { service: [{ id: `${did}#orchestrator`, type: "AgentOrchestrator", serviceEndpoint: publicUrl }] });
  const listUrl = (p) => `${publicUrl}/status/${p}`;

  function bits(purpose) {
    const st = store.get("status", { next: 0, lists: {} });
    return st.lists[purpose] ? Buffer.from(st.lists[purpose], "base64") : newBitstring();
  }

  function event(kind, data) {
    const row = { kind, ...data, at: new Date().toISOString() };
    row.hash = sha256hex(jcs(row));
    store.log("events", row);
    return row;
  }

  function issue(type, subject, { validDays, agentId } = {}) {
    // ёмкость списка статусов: 131 072 аттестата; дальше нужен следующий список (в 0.1 — отказ, а не тихая потеря отзыва)
    if (store.get("status", { next: 0, lists: {} }).next >= SIZE) throw Object.assign(new Error("список статусов заполнен — нужна ротация списка"), { status: 507 });
    const index = store.update("status", { next: 0, lists: {} }, (s) => { s.next += 1; }).next - 1;
    const vc = signCredential(
      { ...credential({ id: `urn:uuid:${randomUUID()}`, type, issuer: did, subject, validDays, status: PURPOSES.map((p) => statusEntry(listUrl(p), index, p)) }), "@context": context },
      { privateKey, verificationMethod: vm },
    );
    const hash = credentialHash(vc);
    store.update("credentials", {}, (c) => { c[vc.id] = { vc, hash, type, agentId, subject: subject.id, index, issuedAt: vc.validFrom }; });
    event("issued", { credential: vc.id, type, subject: subject.id, credential_hash: hash });
    return vc;
  }

  // purpose: revocation | suspension; value=false снимает приостановку (отзыв необратим)
  function setStatus(credentialId, purpose, value, reason) {
    const all = store.get("credentials", {});
    const rec = Object.hasOwn(all, credentialId) ? all[credentialId] : null;
    if (!rec) throw Object.assign(new Error("аттестат не найден"), { status: 404 });
    if (!PURPOSES.includes(purpose)) throw Object.assign(new Error("purpose: revocation или suspension"), { status: 400 });
    if (purpose === "revocation" && !value) throw Object.assign(new Error("отзыв необратим"), { status: 400 });
    const b = bits(purpose);
    setBit(b, rec.index, value ? 1 : 0);
    store.update("status", { next: 0, lists: {} }, (s) => { s.lists[purpose] = b.toString("base64"); });
    event(value ? purpose : "unsuspended", { credential: credentialId, reason: reason || null, credential_hash: rec.hash });
    return { credential: credentialId, purpose, value: !!value };
  }

  const statusOf = (rec) => Object.fromEntries(PURPOSES.map((p) => [p, getBit(bits(p), rec.index) === 1]));

  function statusListCredential(purpose) {
    if (!PURPOSES.includes(purpose)) return null;
    const now = new Date();
    return signCredential({
      "@context": context,
      id: listUrl(purpose),
      type: ["VerifiableCredential", "BitstringStatusListCredential"],
      issuer: did,
      validFrom: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      validUntil: new Date(now.getTime() + 86400000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      credentialSubject: { id: `${listUrl(purpose)}#list`, type: "BitstringStatusList", statusPurpose: purpose, encodedList: encodeList(bits(purpose)) },
    }, { privateKey, verificationMethod: vm });
  }

  // Суточная контрольная сумма: дерево Меркла из всех событий с прошлой фиксации
  function anchor({ ots = true } = {}) {
    const anchors = store.get("anchors", []);
    const prev = anchors.at(-1);
    const offset = prev?.events_to ?? 0; // позиция в журнале, а не время: события в ту же миллисекунду не теряются
    const log = store.readLog("events");
    const events = log.slice(offset);
    if (!events.length) return { skipped: true, reason: "нет новых событий" };
    // первый лист — корень предыдущей фиксации: фиксации образуют цепочку
    const leaves = [...(prev ? [prev.root] : []), ...events.map((e) => e.hash)];
    const tree = buildTree(leaves);
    const record = { root: tree.root, prev_root: prev?.root || null, events_from: offset, events_to: log.length, from: events[0].at, until: events.at(-1).at, count: events.length, at: new Date().toISOString(), method: [] };
    const dir = join(dataDir, "anchors");
    mkdirSync(dir, { recursive: true });
    const base = join(dir, `${record.at.replace(/[:.]/g, "-")}`);
    writeFileSync(`${base}.json`, JSON.stringify({ ...record, leaves, proofs: leaves.map((_, i) => proofFor(tree, i)) }));
    writeFileSync(`${base}.root`, Buffer.from(tree.root, "hex"));
    if (ots) {
      // OpenTimestamps: бесплатная фиксация даты в Bitcoin. Нужен установленный клиент `ots` и доступ к серверам календарей.
      const r = spawnSync("ots", ["stamp", `${base}.root`], { encoding: "utf8", timeout: 30000 });
      if (r.status === 0 && existsSync(`${base}.root.ots`)) record.method.push({ type: "opentimestamps", proof: readFileSync(`${base}.root.ots`).toString("base64") });
      else record.method.push({ type: "opentimestamps", error: (r.error?.code === "ENOENT" ? "клиент ots не установлен" : ((r.stderr || "ошибка").trim().split("\n").filter((l) => !/^Submitting/.test(l)).pop() || "серверы календарей недоступны").slice(0, 200)) });
    }
    record.file = `${base}.json`;
    store.put("anchors", [...anchors, record]);
    return record;
  }

  // Доказательство вхождения события выдачи аттестата в зафиксированный корень
  function inclusion(credentialId) {
    const rec = store.get("credentials", {})[credentialId];
    if (!rec) return null;
    const ev = store.readLog("events").find((e) => e.kind === "issued" && e.credential === credentialId);
    if (!ev) return null;
    for (const a of store.get("anchors", [])) {
      if (!existsSync(a.file)) continue;
      const full = JSON.parse(readFileSync(a.file, "utf8"));
      const i = full.leaves.indexOf(ev.hash);
      if (i >= 0) return { event: ev, root: a.root, anchored_at: a.at, proof: full.proofs[i], method: a.method.map((m) => ({ type: m.type, ok: !!m.proof })) };
    }
    return { event: ev, root: null, note: "ещё не зафиксировано — фиксация раз в сутки" };
  }

  return { did, vm, doc, publicKey, privateKey, issue, setStatus, statusOf, statusListCredential, anchor, inclusion, event, listUrl };
}
