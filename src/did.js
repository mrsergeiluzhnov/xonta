// did:web — документы идентификаторов и их разрешение.
import { publicKeyMultibase, publicKeyFromMultibase } from "./crypto.js";
import { safeFetch } from "./net.js";

// did:web:host%3Aport:path:segments → https://host:port/path/segments/did.json (или /.well-known/did.json без пути)
export function didWebToUrl(did, { allowHttp = false } = {}) {
  if (typeof did !== "string" || !did.startsWith("did:web:")) throw new Error("поддерживается только did:web");
  const [host, ...path] = did.slice(8).split(":").map(decodeURIComponent);
  if (!host || /[/?#@\s]/.test(host) || path.some((p) => !p || /[/?#\s]|^\.\.?$/.test(p))) throw new Error("некорректный did:web");
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const scheme = allowHttp && local ? "http" : "https";
  return path.length ? `${scheme}://${host}/${path.join("/")}/did.json` : `${scheme}://${host}/.well-known/did.json`;
}

// PUBLIC_URL с путём тоже допустим: https://example.com/passport → did:web:example.com:passport
export function urlToDidWeb(base, path = []) {
  const u = new URL(base);
  const segs = u.pathname.split("/").filter(Boolean);
  return ["did:web", encodeURIComponent(u.host), ...segs, ...path].join(":");
}

export function didDocument(did, publicKey, extra = {}) {
  const vm = `${did}#key-1`;
  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
    id: did,
    verificationMethod: [{ id: vm, type: "Multikey", controller: did, publicKeyMultibase: publicKeyMultibase(publicKey) }],
    assertionMethod: [vm],
    authentication: [vm],
    ...extra,
  };
}

// Разрешение DID → документ; ключи для подписей аттестатов берутся только из assertionMethod.
export function makeResolver({ allowHttp = false, local = new Map(), maxCache = 1000 } = {}) {
  const cache = new Map();
  async function resolve(did) {
    if (local.has(did)) return local.get(did)();
    const hit = cache.get(did);
    if (hit && hit.exp > Date.now()) return hit.doc;
    const r = await safeFetch(didWebToUrl(did, { allowHttp }), { allowPrivate: allowHttp, maxBytes: 64 * 1024 });
    if (!r.ok) throw new Error(`DID-документ недоступен (${r.status})`);
    const doc = r.json();
    if (doc?.id !== did) throw new Error("DID-документ не соответствует идентификатору");
    if (cache.size >= maxCache) cache.delete(cache.keys().next().value);
    cache.set(did, { doc, exp: Date.now() + 600_000 });
    return doc;
  }
  async function keyFor(verificationMethod, relationship = "assertionMethod") {
    const did = String(verificationMethod).split("#")[0];
    const doc = await resolve(did);
    const allowed = [].concat(doc[relationship] || []).map((x) => (typeof x === "string" ? x : x.id));
    if (!allowed.includes(verificationMethod)) throw new Error(`ключ не указан в ${relationship}`);
    const vm = (doc.verificationMethod || []).find((m) => m.id === verificationMethod);
    if (!vm?.publicKeyMultibase || vm.controller !== did) throw new Error("ключ не найден в DID-документе");
    return publicKeyFromMultibase(vm.publicKeyMultibase);
  }
  return { resolve, keyFor };
}
