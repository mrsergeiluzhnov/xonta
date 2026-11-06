// HTTP Message Signatures (RFC 9421) subset used by OCX §6.2, with Content-Digest (RFC 9530).
// Covered: "@method" "@target-uri" "content-digest" "ocx-protocol-version" "date"; params created, keyid, nonce, alg="ed25519".
import { createHash } from "node:crypto";
import { rawSign, rawVerify, b64u, nonce as mkNonce } from "./crypto.js";

const COMPONENTS = ["@method", "@target-uri", "content-digest", "ocx-protocol-version", "date"];
export const contentDigest = (body) => `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;

function base(values, params) {
  const lines = COMPONENTS.map((c) => `"${c}": ${values[c]}`);
  return lines.join("\n") + `\n"@signature-params": ${params}`;
}
const paramString = ({ created, keyid, nonce }) => `(${COMPONENTS.map((c) => `"${c}"`).join(" ")});created=${created};keyid="${keyid}";nonce="${nonce}";alg="ed25519"`;

export function signRequest(key, { method, url, body, version }) {
  const date = new Date().toUTCString();
  const headers = { "content-type": "application/json", "content-digest": contentDigest(body), "ocx-protocol-version": version, date };
  const params = paramString({ created: Math.floor(Date.now() / 1000), keyid: key.kid, nonce: mkNonce() });
  const sig = rawSign(key, base({ "@method": method.toUpperCase(), "@target-uri": url, "content-digest": headers["content-digest"], "ocx-protocol-version": version, date }, params));
  headers["signature-input"] = `sig1=${params}`;
  headers.signature = `sig1=:${Buffer.from(sig).toString("base64")}:`;
  return headers;
}

const seen = new Map(); // nonce -> expiry
export function verifyRequest({ method, url, headers, body }, jwkLookup, { windowSec = 300 } = {}) {
  const input = headers["signature-input"], signature = headers.signature;
  if (!input || !signature) return { ok: false, reason: "unsigned" };
  const m = input.match(/^sig1=(\(.*\);created=(\d+);keyid="([^"]+)";nonce="([^"]+)";alg="ed25519")$/);
  const s = signature.match(/^sig1=:([A-Za-z0-9+/=]+):$/);
  if (!m || !s) return { ok: false, reason: "malformed signature headers" };
  const [, params, created, keyid, nonce] = m;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(created)) > windowSec) return { ok: false, reason: "stale" };
  for (const [n, exp] of seen) if (exp < now) seen.delete(n);
  if (seen.has(nonce)) return { ok: false, reason: "replay" };
  if (headers["content-digest"] !== contentDigest(body)) return { ok: false, reason: "digest mismatch" };
  const jwk = jwkLookup(keyid); if (!jwk) return { ok: false, reason: `unknown key ${keyid}`, keyid };
  const ok = rawVerify(jwk, base({ "@method": method.toUpperCase(), "@target-uri": url, "content-digest": headers["content-digest"], "ocx-protocol-version": headers["ocx-protocol-version"], date: headers.date }, params), Buffer.from(s[1], "base64"));
  if (!ok) return { ok: false, reason: "bad signature", keyid };
  seen.set(nonce, now + windowSec);
  return { ok: true, keyid };
}
