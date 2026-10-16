// Проверяемые аттестаты W3C VC 2.0 с доказательством Data Integrity, набор eddsa-jcs-2022
// по Рекомендации W3C (vc-di-eddsa): @context документа входит в доказательство и в хэшируемую конфигурацию.
import { jcs, sha256, signBytes, verifyBytes, multibase58, fromMultibase58, sha256hex } from "./crypto.js";

export const VC_CONTEXT = ["https://www.w3.org/ns/credentials/v2", "https://xonta.ru/ns/passport/v0"];
const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");

// hashData = SHA-256(JCS(конфигурация доказательства)) || SHA-256(JCS(документ без доказательства))
function hashData(unsecured, proofConfig) {
  return Buffer.concat([sha256(jcs(proofConfig)), sha256(jcs(unsecured))]);
}

export function signCredential(credential, { privateKey, verificationMethod, created = new Date() }) {
  const { proof: _ignored, ...unsecured } = credential;
  const proofConfig = {
    type: "DataIntegrityProof",
    cryptosuite: "eddsa-jcs-2022",
    created: iso(created),
    verificationMethod,
    proofPurpose: "assertionMethod",
    "@context": unsecured["@context"],
  };
  const signature = signBytes(privateKey, hashData(unsecured, proofConfig));
  return { ...unsecured, proof: { ...proofConfig, proofValue: multibase58(signature) } };
}

// Проверка подписи. keyFor(verificationMethod) → KeyObject открытого ключа.
// bindIssuer: ключ подписи должен принадлежать DID выдавшего (для наших аттестатов — всегда).
export async function verifyProof(vc, keyFor, { bindIssuer = true } = {}) {
  const proofs = [].concat(vc.proof || []);
  if (!proofs.length) return { ok: false, reason: "нет подписи" };
  const issuer = typeof vc.issuer === "string" ? vc.issuer : vc.issuer?.id;
  const reasons = [];
  for (const p of proofs) {
    if (p?.type !== "DataIntegrityProof" || p.cryptosuite !== "eddsa-jcs-2022") { reasons.push(`набор ${p?.cryptosuite} не поддерживается этой реализацией`); continue; }
    if (p.proofPurpose !== "assertionMethod") { reasons.push("назначение подписи не assertionMethod"); continue; }
    if (bindIssuer && p.verificationMethod?.split("#")[0] !== issuer) { reasons.push("ключ подписи не принадлежит выдавшему"); continue; }
    try {
      const { proofValue, ...config } = p;
      const { proof: _p, ...unsecured } = vc;
      if (config["@context"] !== undefined) {
        // @context документа должен начинаться с @context доказательства, в том же порядке
        const dc = [].concat(vc["@context"] || []), pc = [].concat(config["@context"]);
        if (pc.some((c, i) => JSON.stringify(c) !== JSON.stringify(dc[i]))) { reasons.push("@context доказательства не совпадает с документом"); continue; }
        unsecured["@context"] = config["@context"];
      }
      const key = await keyFor(p.verificationMethod);
      if (verifyBytes(key, hashData(unsecured, config), fromMultibase58(proofValue))) return { ok: true, suite: p.cryptosuite };
      reasons.push("подпись неверна");
    } catch {
      reasons.push("ключ подписи не получен или подпись повреждена");
    }
  }
  return { ok: false, reason: reasons.join("; ") };
}

export function checkValidity(vc, now = new Date()) {
  if (vc.validFrom && !(new Date(vc.validFrom) <= now)) return { ok: false, reason: "ещё не действует" };
  if (vc.validUntil && !(new Date(vc.validUntil) >= now)) return { ok: false, reason: "срок истёк" };
  return { ok: true };
}

// Отпечаток аттестата для журнала событий
export const credentialHash = (vc) => sha256hex(jcs(vc));

export function credential({ id, type, issuer, subject, validDays, status, extraContext }) {
  const from = new Date();
  const vc = {
    "@context": extraContext ? [...VC_CONTEXT, ...extraContext] : VC_CONTEXT,
    id,
    type: ["VerifiableCredential", type],
    issuer,
    validFrom: iso(from),
    credentialSubject: subject,
  };
  if (validDays) vc.validUntil = iso(from.getTime() + validDays * 86400000);
  if (status) vc.credentialStatus = status;
  return vc;
}
