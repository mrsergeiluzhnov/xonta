// Подпись запросов агента. Упрощённая схема до перехода на HTTP Message Signatures (RFC 9421):
// x-agent-did, x-agent-date, x-agent-signature = multibase(Ed25519(did \n date \n METHOD \n host \n path \n sha256(тело))).
// Подписывается каждый запрос, тело входит в подпись. Окно 5 минут; повтор того же запроса внутри окна этой схемой не исключается.
import { signBytes, verifyBytes, multibase58, fromMultibase58, sha256hex } from "./crypto.js";

const payload = (did, date, method, host, path, body) =>
  Buffer.from(`${did}\n${date}\n${method.toUpperCase()}\n${host}\n${path}\n${sha256hex(body || "")}`);

export function signRequest({ did, privateKey, method = "POST", url, body = "" }) {
  const u = new URL(url);
  const date = new Date().toISOString();
  return { "x-agent-did": did, "x-agent-date": date, "x-agent-signature": multibase58(signBytes(privateKey, payload(did, date, method, u.host, u.pathname, body))) };
}

// fetch для MCP-клиента, который подписывает каждый запрос
export function signingFetch({ did, privateKey, extraHeaders = {} }) {
  return async (url, init = {}) => {
    const body = typeof init.body === "string" ? init.body : "";
    const headers = new Headers(init.headers);
    for (const [k, v] of Object.entries({ ...extraHeaders, ...signRequest({ did, privateKey, method: init.method || "GET", url: String(url), body }) })) headers.set(k, v);
    return fetch(url, { ...init, headers });
  };
}

export async function verifyCaller(req, resolver, { maxSkewMs = 300_000 } = {}) {
  const did = req.get("x-agent-did"), date = req.get("x-agent-date"), sig = req.get("x-agent-signature");
  if (!did) return { did: null, verified: false, reason: "вызывающий не представился" };
  if (!date || !sig) return { did, verified: false, reason: "нет подписи" };
  const t = Date.parse(date);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > maxSkewMs) return { did, verified: false, reason: "подпись устарела или дата некорректна" };
  try {
    const doc = await resolver.resolve(did);
    const vmId = [].concat(doc.authentication || []).map((x) => (typeof x === "string" ? x : x.id))[0];
    const key = await resolver.keyFor(vmId, "authentication");
    const host = req.get("host");
    const ok = verifyBytes(key, payload(did, date, req.method, host, req.originalUrl.split("?")[0], req.rawBody || ""), fromMultibase58(sig));
    return ok ? { did, verified: true } : { did, verified: false, reason: "подпись неверна" };
  } catch {
    return { did, verified: false, reason: "DID вызывающего не разрешается или ключ не найден" };
  }
}
