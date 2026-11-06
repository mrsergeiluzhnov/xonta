// Base crypto for the OCX reference implementation: JCS (RFC 8785), Ed25519 keys as JWK (RFC 8037),
// detached JWS (RFC 7515) over canonical JSON, SHA-256 helpers. No dependencies.
import { createHash, generateKeyPairSync, createPublicKey, createPrivateKey, sign as edSign, verify as edVerify, randomBytes } from "node:crypto";

export const b64u = (buf) => Buffer.from(buf).toString("base64url");
export const fromB64u = (s) => Buffer.from(s, "base64url");
export const sha256 = (data) => createHash("sha256").update(data).digest();
export const sha256hex = (data) => "sha256:" + sha256(data).toString("hex");
export const nonce = () => b64u(randomBytes(16));

// RFC 8785: keys sorted by UTF-16 code units, ECMAScript number formatting, no whitespace.
export function jcs(v) {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("JCS: non-finite number"); return JSON.stringify(v); }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(jcs).join(",") + "]";
  if (typeof v === "object") {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + jcs(v[k])).join(",") + "}";
  }
  throw new Error("JCS: unsupported type " + typeof v);
}

export function newKey(kid) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  return { kid, privateKey, publicKey, jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, kid, alg: "EdDSA", use: "sig" } };
}
export const publicFromJwk = (jwk) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
export const thumbprint = (jwk) => "fp:" + sha256hex(jcs({ crv: "Ed25519", kty: "OKP", x: jwk.x })).slice(0); // fp:sha256:<hex>

export const rawSign = (key, data) => edSign(null, Buffer.from(data), key.privateKey);
export const rawVerify = (jwk, data, sig) => { try { return edVerify(null, Buffer.from(data), publicFromJwk(jwk), sig); } catch { return false; } };

// Detached JWS: "<protected>..<signature>", payload = JCS(object without the excluded fields).
export function signDetached(key, obj, exclude = ["signature"]) {
  const body = { ...obj }; for (const k of exclude) delete body[k];
  const header = b64u(JSON.stringify({ alg: "EdDSA", kid: key.kid }));
  const payload = b64u(jcs(body));
  return `${header}..${b64u(rawSign(key, `${header}.${payload}`))}`;
}
export function verifyDetached(jwksLookup, obj, jws, exclude = ["signature"]) {
  if (typeof jws !== "string") return { ok: false, reason: "no signature" };
  const m = jws.match(/^([A-Za-z0-9_-]+)\.\.([A-Za-z0-9_-]+)$/); if (!m) return { ok: false, reason: "malformed JWS" };
  let header; try { header = JSON.parse(fromB64u(m[1]).toString()); } catch { return { ok: false, reason: "bad header" }; }
  if (header.alg !== "EdDSA") return { ok: false, reason: "alg" };
  const jwk = jwksLookup(header.kid); if (!jwk) return { ok: false, reason: `unknown kid ${header.kid}` };
  const body = { ...obj }; for (const k of exclude) delete body[k];
  const ok = rawVerify(jwk, `${m[1]}.${b64u(jcs(body))}`, fromB64u(m[2]));
  return ok ? { ok: true, kid: header.kid } : { ok: false, reason: "bad signature" };
}
