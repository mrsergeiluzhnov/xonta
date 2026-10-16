// verify_agent: собрать аттестаты агента, проверить подписи, сроки и статусы, применить политику проверяющего, посчитать уровень.
import { verifyProof, checkValidity } from "./vc.js";
import { isSet } from "./status.js";
import { safeFetch } from "./net.js";

export const SHORT = {
  AgentDomainControl: "domain.control",
  AgentOwnerVerified: "owner.verified",
  AgentMcpScan: "mcp.scan",
  AgentEvaluation: "evaluation",
  AgentReputation: "reputation",
  AgentLineage: "lineage",
  AgentContribution: "contribution",
};
const shortOf = (vc) => SHORT[[].concat(vc?.type || []).find((t) => SHORT[t])] || String([].concat(vc?.type || []).at(-1) || "unknown");
const issuerOf = (vc) => (typeof vc?.issuer === "string" ? vc.issuer : vc?.issuer?.id);
const MAX_PRESENTED = 20;

export function defaultPolicy(issuerDid) {
  return {
    trusted_issuers: { "*": [issuerDid] }, // по умолчанию доверяем только этому оркестратору; проверяющий может добавить других
    require: { owner_country: null },
    // calls — внешние вызовы (всё, кроме синтетики нашего тестера)
    reputation: { min_age_days: 7, max_error_rate: 0.05, min_calls: 20 },
  };
}

export function createVerifier({ issuer, store, resolver, allowPrivate = false }) {
  const keyFor = async (vm) => (vm === issuer.vm ? issuer.publicKey : resolver.keyFor(vm));

  async function statusListFor(url, expected) {
    let list;
    if (url === issuer.listUrl("revocation") || url === issuer.listUrl("suspension")) list = issuer.statusListCredential(url.split("/").pop());
    else {
      const r = await safeFetch(url, { allowPrivate, maxBytes: 512 * 1024 });
      if (!r.ok) throw new Error("список статусов недоступен");
      list = r.json();
      const p = await verifyProof(list, keyFor);
      if (!p.ok) throw new Error("подпись списка статусов неверна");
    }
    if (issuerOf(list) !== expected.issuer) throw new Error("список статусов выдан не тем, кто выдал аттестат");
    if (list.credentialSubject?.statusPurpose !== expected.purpose) throw new Error("назначение списка статусов не совпадает");
    if (!checkValidity(list).ok) throw new Error("список статусов устарел");
    return list;
  }

  async function checkOne(vc, policy) {
    const out = { id: vc?.id, type: shortOf(vc), issuer: issuerOf(vc), valid: false };
    const list = policy.trusted_issuers[out.type] || policy.trusted_issuers["*"] || [];
    // недоверенные выдающие не проверяются вовсе: так чужие аттестаты не заставляют оркестратор ходить по произвольным адресам
    if (!list.includes(out.issuer)) return { ...out, counted: false, reason: "выдающий не входит в доверенные по политике" };
    const proof = await verifyProof(vc, keyFor);
    if (!proof.ok) return { ...out, reason: proof.reason };
    const v = checkValidity(vc);
    if (!v.ok) return { ...out, reason: v.reason };
    for (const st of [].concat(vc.credentialStatus || [])) {
      try {
        if (isSet(await statusListFor(st.statusListCredential, { issuer: out.issuer, purpose: st.statusPurpose }), st.statusListIndex))
          return { ...out, reason: st.statusPurpose === "revocation" ? "отозван" : "приостановлен", status: st.statusPurpose };
      } catch (e) { return { ...out, reason: `статус не проверен: ${e.message}` }; }
    }
    return { ...out, valid: true, counted: true, validFrom: vc.validFrom, subject: vc.credentialSubject };
  }

  function agentRecord(ref) {
    const agents = store.get("agents", {});
    if (typeof ref !== "string") return null;
    return (Object.hasOwn(agents, ref) ? agents[ref] : null) || Object.values(agents).filter((a) => a.did === ref || a.mcp_url === ref).sort((a, b) => (a.status === "retired") - (b.status === "retired"))[0] || null;
  }

  async function verifyAgent({ agent, policy: userPolicy, credentials = [], request_signed_by_agent = null } = {}) {
    if (typeof agent !== "string" || !agent) throw Object.assign(new Error("нужен agent: DID, id или адрес MCP-сервера"), { status: 400 });
    if (!Array.isArray(credentials) || credentials.length > MAX_PRESENTED) throw Object.assign(new Error(`credentials: массив не больше ${MAX_PRESENTED}`), { status: 400 });
    const rec = agentRecord(agent);
    const did = rec?.did || agent;
    const base = defaultPolicy(issuer.did);
    const policy = { ...base, ...(userPolicy || {}), require: { ...base.require, ...(userPolicy?.require || {}) }, reputation: { ...base.reputation, ...(userPolicy?.reputation || {}) } };
    if (typeof policy.trusted_issuers !== "object" || !policy.trusted_issuers) policy.trusted_issuers = base.trusted_issuers;

    const own = Object.values(store.get("credentials", {})).filter((c) => c.subject === did).map((c) => c.vc);
    const seen = new Set();
    const all = [...own, ...credentials.filter((c) => c?.credentialSubject?.id === did)].filter((c) => c?.id && !seen.has(c.id) && seen.add(c.id));
    const checked = await Promise.all(all.map((vc) => checkOne(vc, policy)));

    // для каждого типа засчитывается самый свежий действующий аттестат (по validFrom), а не тот, что агент предъявил последним
    // вклады (contribution) накапливаются — каждый за своё слияние, их не схлопываем
    const best = {};
    const MULTI = ["contribution"];
    for (const c of checked) if (c.valid && !MULTI.includes(c.type) && (!best[c.type] || c.validFrom > best[c.type].validFrom)) best[c.type] = c;
    for (const c of checked) if (c.valid && !MULTI.includes(c.type) && best[c.type] !== c) { c.counted = false; c.reason = "есть более новый аттестат этого типа"; }

    // наследование проверки владельца: потомок с действующей родословной получает owner.verified корня,
    // если родословная называет того же владельца и вся цепочка предков действует
    let ownerInheritedFrom = null;
    if (rec?.parent && !best["owner.verified"] && best.lineage) {
      const agents = store.get("agents", {});
      const chain = [];
      for (let r = rec; r?.parent; r = agents[r.parent]) chain.push(agents[r.parent]);
      const root = chain.at(-1);
      const lin = best.lineage.subject;
      const chainOk = chain.every((a) => a && ["active", "deprecated"].includes(a.status));
      if (root && chainOk && lin.root === root.did && lin.owner === root.owner_did && lin.parent === agents[rec.parent]?.did) {
        const rootOwner = Object.values(store.get("credentials", {})).filter((c) => c.subject === root.did && c.type === "AgentOwnerVerified").map((c) => c.vc);
        const ok = (await Promise.all(rootOwner.map((vc) => checkOne(vc, policy)))).filter((c) => c.valid).sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
        if (ok) { best["owner.verified"] = ok; ownerInheritedFrom = root.did; }
      }
    }
    const contributions = {};
    for (const c of checked) if (c.valid && c.type === "contribution") {
      const x = (contributions[c.subject.category] ||= { merges: 0, gain_pp: 0, to: new Set() });
      x.merges++; x.gain_pp = Math.round((x.gain_pp + (c.subject.gain_pp || 0)) * 10) / 10; x.to.add(c.subject.to);
    }

    const blocked = rec && ["suspended", "revoked"].includes(rec.status);
    const has = (t) => !!best[t];
    const ownerOk = has("owner.verified") && (!policy.require.owner_country || policy.require.owner_country.includes(best["owner.verified"].subject?.owner?.country));
    const scanOk = has("mcp.scan") && best["mcp.scan"].subject?.result === "no_findings";
    const rep = best.reputation?.subject;
    const repOk = !!rep && rep.age_days >= policy.reputation.min_age_days && rep.error_rate <= policy.reputation.max_error_rate && (rep.traffic?.external ?? 0) >= policy.reputation.min_calls;

    let level = 0;
    const missing = [];
    if (blocked) missing.push(`агент ${rec.status === "revoked" ? "отозван" : "приостановлен"}`);
    else {
      if (has("domain.control")) level = 1; else missing.push("domain.control");
      if (level === 1) { if (ownerOk) level = 2; else missing.push(has("owner.verified") ? "owner.verified (страна не подходит политике)" : "owner.verified"); }
      if (level === 2) {
        if (scanOk && repOk) level = 3;
        if (!scanOk) missing.push(has("mcp.scan") ? "mcp.scan (найдены признаки)" : "mcp.scan");
        if (!repOk) missing.push(rep ? "reputation (не выполнены требования политики)" : "reputation");
      }
    }
    return {
      agent: did,
      registered: !!rec,
      name: rec?.name,
      status: rec?.status,
      level,
      request_signed_by_agent,
      attestations: checked.map(({ subject, validFrom, ...c }) => ({ ...c, ...(c.valid ? { summary: summarize(c.type, subject) } : {}) })),
      profile: best.evaluation ? profileFrom(best.evaluation.subject) : null,
      lineage: best.lineage ? { parent: best.lineage.subject.parent, root: best.lineage.subject.root, depth: best.lineage.subject.depth, owner: best.lineage.subject.owner, scope: best.lineage.subject.scope } : null,
      owner_inherited_from: ownerInheritedFrom,
      contributions: Object.keys(contributions).length ? Object.fromEntries(Object.entries(contributions).map(([k, v]) => [k, { ...v, to: [...v.to] }])) : null,
      missing_for_next_level: level < 3 ? missing : [],
      note: "Паспорт подтверждает проверки на их дату, а не безопасность агента.",
    };
  }

  return { verifyAgent, checkOne, agentRecord };
}

function summarize(type, s = {}) {
  if (type === "domain.control") return { domain: s.domain };
  if (type === "owner.verified") return { country: s.owner?.country, kind: s.owner?.kind, method: s.owner?.method };
  if (type === "mcp.scan") return { result: s.result, tools: s.tools_count, fingerprint: s.tools_fingerprint?.slice(0, 16) };
  if (type === "evaluation") return { data: s.evaluation?.data, suite: s.evaluation?.suite, score: s.overall };
  if (type === "lineage") return { parent: s.parent, depth: s.depth, scope: s.scope?.category };
  if (type === "contribution") return { to: s.to, category: s.category, gain_pp: s.gain_pp, share: s.share };
  if (type === "reputation") return { calls_external: s.traffic?.external, synthetic: s.traffic?.synthetic, error_rate: s.error_rate, age_days: s.age_days };
  return {};
}

// Профиль по категориям: сильные стороны (≥80) и зона роста (<60)
export function profileFrom(evalSubject) {
  const cats = evalSubject?.categories || [];
  return {
    expert: cats.filter((c) => c.score >= 80).map((c) => ({ category: c.category, score: c.score })),
    growth: cats.filter((c) => c.score < 60).map((c) => ({ category: c.category, score: c.score })),
    data: evalSubject?.evaluation?.data,
  };
}
