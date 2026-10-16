// Ключи Ed25519, подписи, кодировки multibase/multikey, отпечатки.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, createHash, randomBytes, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import canonicalize from "canonicalize";

export const sha256 = (data) => createHash("sha256").update(data).digest();
export const sha256hex = (data) => sha256(data).toString("hex");
export const jcs = (obj) => canonicalize(obj); // RFC 8785 (JSON Canonicalization Scheme)
export const randomId = (n = 12) => randomBytes(n).toString("hex");
export const hmacHex = (key, data) => createHmac("sha256", key).update(data).digest("hex");

// --- base58btc (алфавит Bitcoin) ---
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58encode(buf) {
  const bytes = [...buf];
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join("");
}
export function base58decode(str) {
  const bytes = [];
  for (const ch of str) {
    let carry = ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error("base58: недопустимый символ");
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  return Buffer.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}
export const multibase58 = (buf) => "z" + base58encode(buf);
export const fromMultibase58 = (s) => { if (!s?.startsWith("z")) throw new Error("ожидается multibase base58btc (z…)"); return base58decode(s.slice(1)); };

// Multikey для Ed25519: префикс multicodec 0xed01 + 32 байта открытого ключа
const ED_PREFIX = Buffer.from([0xed, 0x01]);
export const rawFromPublicKey = (pub) => Buffer.from(pub.export({ format: "jwk" }).x, "base64url");
export const publicKeyMultibase = (pub) => multibase58(Buffer.concat([ED_PREFIX, rawFromPublicKey(pub)]));
export function publicKeyFromMultibase(mb) {
  const b = fromMultibase58(mb);
  if (b[0] !== 0xed || b[1] !== 0x01 || b.length !== 34) throw new Error("ключ не Ed25519 Multikey");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b.subarray(2).toString("base64url") }, format: "jwk" });
}

export const signBytes = (privateKey, data) => edSign(null, data, privateKey);
export const verifyBytes = (publicKey, data, sig) => { try { return edVerify(null, data, publicKey, sig); } catch { return false; } };

// Загрузка или создание ключа (JWK в файле). Закрытый ключ не покидает DATA_DIR.
export function loadOrCreateKey(file) {
  if (existsSync(file)) {
    const jwk = JSON.parse(readFileSync(file, "utf8"));
    const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(privateKey.export({ format: "jwk" })), { mode: 0o600 });
  return { privateKey, publicKey };
}
