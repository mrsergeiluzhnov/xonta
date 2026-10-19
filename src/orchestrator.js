// Оркестратор (уровень 1 «Наблюдатель»): регистрация агентов, подтверждение домена, проверка MCP-сервера,
// тест через шлюз A2O2A, репутация по трафику, статусы и паспорт. Код подключённых агентов не меняется.
import { join } from "node:path";
import { randomId, sha256hex, loadOrCreateKey, hmacHex } from "./crypto.js";
import { didDocument } from "./did.js";
import { scanMcpServer } from "./scan.js";
import { assertPublicUrl, safeFetch } from "./net.js";
import { runSuite } from "./tester.js";
import { metrics } from "./analyzer.js";
import { publicKeyFromMultibase } from "./crypto.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const STATUSES = ["active", "deprecated", "suspended", "revoked"];

export function createOrchestrator({ store, issuer, notify, signals, publicUrl, dataDir, allowPrivate, suites, env = process.env }) {
  const hostedDid = (id) => `${issuer.did}:agents:${id}`;

  // Тестер — отдельный участник со своим ключом и DID
  const testerKey = loadOrCreateKey(join(dataDir, "keys", "tester.jwk"));
  const tester = { id: "tester", did: hostedDid("tester"), ...testerKey };

  const agents = () => store.get("agents", {});
  function get(id) { const a = agents(); if (typeof id !== "string" || !Object.hasOwn(a, id)) throw err(404, "агент не найден"); return a[id]; }
  // новые аттестаты выдаются только действующему агенту; приостановленный или отозванный их не получает
  function assertIssuable(rec) { if (!["active", "deprecated"].includes(rec.status)) throw err(409, `агент ${rec.status}: новые аттестаты не выдаются`); }
  function assertDomain(rec) { if (!rec.domain_verified_at) throw err(409, "сначала подтвердите управление доменом агента (domain-check)"); }
  const save = (rec) => store.update("agents", {}, (a) => { a[rec.id] = rec; });
  function checkOwner(rec, token) {
    if (!token || sha256hex(token) !== rec.owner_token_hash) throw err(403, "нужен ключ владельца (Authorization: Bearer …)");
  }
  const credsOf = (rec, type) => Object.values(store.get("credentials", {})).filter((c) => c.agentId === rec.id && (!type || c.type === type));

  // did — собственный did:web агента (тот же хост, что у mcp_url; контроль хоста подтверждается domain-check).
  // owner_did — DID владельца; запрос регистрации тогда должен быть подписан этим DID. Без did агенту выдаётся DID у оркестратора.
  async function register(body, { caller = null } = {}) {
    const { name, mcp_url, owner = {}, level = 1, sla_ms, require_signed_callers = false, owner_public_key, did, owner_did } = body || {};
    if (!name || !mcp_url) throw err(400, "нужны name и mcp_url");
    await assertPublicUrl(mcp_url, { allowPrivate });
    if (owner_did !== undefined && owner_did !== null) {
      if (typeof owner_did !== "string" || !owner_did.startsWith("did:web:")) throw err(400, "owner_did: ожидается did:web");
      if (!caller?.verified || caller.did !== owner_did) throw err(403, "запрос регистрации должен быть подписан owner_did");
    }
    if (did !== undefined && did !== null) {
      if (typeof did !== "string" || !did.startsWith("did:web:")) throw err(400, "did: ожидается did:web");
      const host = decodeURIComponent(did.slice(8).split(":")[0]);
      if (host !== new URL(mcp_url).host) throw err(400, "did:web агента должен быть на том же хосте, что и mcp_url");
      if (Object.values(agents()).some((a) => a.did === did && !["revoked", "retired"].includes(a.status))) throw err(409, "этот DID уже зарегистрирован");
    }
    if (owner_public_key) try { publicKeyFromMultibase(owner_public_key); } catch { throw err(400, "owner_public_key: ожидается Ed25519 Multikey (z6Mk…)"); }
    if (![1, 2, 3].includes(Number(level))) throw err(400, "level: 1, 2 или 3");
    if (Object.values(agents()).some((a) => a.mcp_url === mcp_url && !["revoked", "retired"].includes(a.status))) throw err(409, "этот адрес уже зарегистрирован");
    const id = `ag_${randomId(5)}`;
    const ownerToken = `own_${randomId(16)}`;
    const rec = {
      id, name: String(name).slice(0, 100), mcp_url, did: did || hostedDid(id), own_did: !!did, owner_did: owner_did || null, level: Number(level), status: "active",
      owner: { name: owner.name ? String(owner.name).slice(0, 100) : null, contact: owner.contact || null, telegram_chat_id: owner.telegram_chat_id || null, webhook: owner.webhook || null },
      owner_public_key: owner_public_key || null, owner_token_hash: sha256hex(ownerToken),
      challenge: `xonta-${randomId(12)}`, sla_ms: Number(sla_ms) || 2000, require_signed_callers: !!require_signed_callers,
      created: new Date().toISOString(),
    };
    save(rec);
    issuer.event("agent_registered", { agent: id, did: rec.did, level: rec.level });
    return {
      id, did: rec.did, owner_token: ownerToken,
      gateway: `${publicUrl}/gw/${id}/mcp`,
      domain_challenge: { url: `${new URL(mcp_url).origin}/.well-known/xonta-challenge.txt`, content: rec.challenge },
      note: "Сохраните owner_token: он показывается один раз. Подключение по уровню " + rec.level + " — условия по договору этого уровня.",
    };
  }

  function didDoc(id) {
    const rec = agents()[id];
    if (id === "tester") return didDocument(tester.did, tester.publicKey, { controller: issuer.did, service: [{ id: `${tester.did}#role`, type: "AgentTester", serviceEndpoint: publicUrl }] });
    if (!rec || rec.own_did) return null; // собственный did:web агент публикует сам
    const base = { "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"], id: rec.did, controller: issuer.did };
    const service = [
      { id: `${rec.did}#mcp`, type: "MCPServer", serviceEndpoint: rec.mcp_url },
      { id: `${rec.did}#gateway`, type: "A2O2AGateway", serviceEndpoint: `${publicUrl}/gw/${rec.id}/mcp` },
      { id: `${rec.did}#passport`, type: "AgentPassport", serviceEndpoint: `${publicUrl}/v1/agents/${rec.id}/passport` },
    ];
    if (!rec.owner_public_key) return { ...base, service };
    const vm = `${rec.did}#owner-key`;
    return { ...base, verificationMethod: [{ id: vm, type: "Multikey", controller: rec.did, publicKeyMultibase: rec.owner_public_key }], authentication: [vm], service };
  }

  async function domainCheck(id) {
    const rec = get(id);
    assertIssuable(rec);
    const url = `${new URL(rec.mcp_url).origin}/.well-known/xonta-challenge.txt`;
    const r = await safeFetch(url, { allowPrivate, maxBytes: 1024 }).catch(() => ({ ok: false, status: "недоступен" }));
    const text = r.ok ? r.text().trim() : null;
    if (text !== rec.challenge) throw err(422, `код подтверждения не найден по адресу ${url} (${r.status}). Положите туда: ${rec.challenge}`);
    rec.domain_verified_at = new Date().toISOString();
    save(rec);
    const vc = issuer.issue("AgentDomainControl", { id: rec.did, domain: new URL(rec.mcp_url).host, endpoint: rec.mcp_url, method: "well-known-token", checked_at: new Date().toISOString() }, { validDays: 90, agentId: rec.id });
    return { ok: true, credential: vc };
  }

  async function scan(id) {
    const rec = get(id);
    assertIssuable(rec); assertDomain(rec);
    const result = await scanMcpServer(rec.mcp_url, { allowPrivate });
    const changed = rec.tools_fingerprint && rec.tools_fingerprint !== result.tools_fingerprint;
    // каждая новая проверка заменяет прежние: старый «признаков не найдено» нельзя предъявить после новой проверки
    for (const c of credsOf(rec, "AgentMcpScan")) if (!issuer.statusOf(c).revocation)
      issuer.setStatus(c.vc.id, "revocation", true, changed ? "описания инструментов изменились после проверки" : "заменён новой проверкой");
    if (changed) {
      issuer.event("tools_changed", { agent: rec.id, from: rec.tools_fingerprint, to: result.tools_fingerprint });
      notify(rec, { title: "Описания инструментов изменились", text: `Отпечаток списка инструментов сменился. Прежняя проверка отозвана, выполнена новая: ${result.result === "no_findings" ? "признаков не найдено" : "найдены признаки, см. паспорт"}.` });
    }
    rec.tools = result._tools;
    rec.tools_fingerprint = result.tools_fingerprint;
    rec.last_scan = result.checked_at;
    save(rec);
    const serious = result.findings.filter((f) => f.severity !== "low");
    const vc = issuer.issue("AgentMcpScan", {
      id: rec.did, endpoint: rec.mcp_url, tools_count: result.tools_count, tools_fingerprint: result.tools_fingerprint, result: result.result,
      findings: serious.map(({ tool, rule, severity, what }) => ({ tool, rule, severity, what })), checked_at: result.checked_at, method: "xonta-mcp-scan/0.1",
    }, { validDays: 30, agentId: rec.id });
    if (serious.length) notify(rec, { title: "Проверка MCP-сервера: найдены признаки", text: serious.slice(0, 5).map((f) => `${f.tool}: ${f.what}`).join("\n") });
    const { _tools, ...report } = result;
    return { report: { ...report, changed_since_last_scan: !!changed }, credential: vc };
  }

  async function test(id, { suite = "xonta-docs", tasks = 30, seed } = {}) {
    const rec = get(id);
    assertIssuable(rec); assertDomain(rec);
    if (!rec.tools) await scan(id);
    const s = Object.hasOwn(suites, suite) ? suites[suite] : null;
    if (!s) throw err(400, `набор не найден: ${suite}. Доступны: ${Object.keys(suites).join(", ")}`);
    const res = await runSuite({ gatewayUrl: `${publicUrl}/gw/${rec.id}/mcp`, tester, suite: s.SUITE, generate: s.generate, tasks: Math.min(Number(tasks) || 30, 200), seed });
    const vc = issuer.issue("AgentEvaluation", {
      id: rec.did, categories: res.categories, overall: res.overall, latency_ms: res.latency_ms, evaluation: res.evaluation, tester: tester.did,
    }, { validDays: 30, agentId: rec.id });
    rec.last_evaluation = { categories: res.categories, evaluation: res.evaluation, at: new Date().toISOString() };
    save(rec);
    const sig = signals.analyze(rec, rec.last_evaluation);
    return { result: res, credential: vc, signals: sig.emitted };
  }

  function reputation(id, { window_days = 30 } = {}) {
    const rec = get(id);
    assertIssuable(rec); assertDomain(rec);
    window_days = Number(window_days);
    if (!Number.isInteger(window_days) || window_days < 1 || window_days > 90) throw err(400, "window_days: от 1 до 90");
    const traces = store.readLog("traces", new Date(Date.now() - window_days * 86400000).toISOString()).filter((t) => t.agent === rec.id);
    if (!traces.length) throw err(422, "нет трафика через шлюз за период — репутацию не из чего считать");
    const m = metrics(traces);
    const external = traces.filter((t) => !t.synthetic).length; // всё, кроме подписанной синтетики нашего тестера
    const verifiedExternal = traces.filter((t) => !t.synthetic && t.caller_verified).length;
    const vc = issuer.issue("AgentReputation", {
      id: rec.did, calls: m.calls, error_rate: m.error_rate, p95_ms: m.p95_ms, age_days: Math.floor((Date.now() - Date.parse(rec.created)) / 86400000),
      complaints_open: 0, window_days, traffic: { synthetic: m.calls - external, external, external_verified: verifiedExternal }, method: "a2o2a-gateway",
    }, { validDays: 30, agentId: rec.id });
    return { metrics: m, credential: vc };
  }

  // Проверка владельца вручную (администратор оркестратора по договору). Региональные способы проверки — в профилях юрисдикций.
  // Идентификатор владельца не хранится: только HMAC-отпечаток с секретом сервера.
  function ownerVerified(id, { country = null, kind, owner_ref, note } = {}) {
    const rec = get(id);
    assertIssuable(rec);
    if (!["self_employed", "individual_entrepreneur", "company", "person"].includes(kind)) throw err(400, "kind: self_employed | individual_entrepreneur | company | person");
    if (owner_ref && !env.OWNER_HMAC_SECRET && !allowPrivate) throw err(500, "не задан OWNER_HMAC_SECRET — отпечаток владельца без секрета можно подобрать");
    const subject = { id: rec.did, owner: { country, kind, method: "manual-contract", checked_at: new Date().toISOString() } };
    if (owner_ref) subject.owner.ref_hmac = hmacHex(env.OWNER_HMAC_SECRET || "dev-only-secret", String(owner_ref)).slice(0, 32);
    if (note) subject.owner.note = String(note).slice(0, 200);
    return { credential: issuer.issue("AgentOwnerVerified", subject, { validDays: 365, agentId: rec.id }) };
  }

  // Переходы статусов. Владелец: active → deprecated, active|deprecated → revoked (отзыв необратим).
  // Администратор: любые, кроме выхода из revoked. Приостановку снимает только администратор.
  async function setAgentStatus(id, { status, reason, sunset, successor } = {}, { admin = false } = {}) {
    const rec = get(id);
    if (!STATUSES.includes(status)) throw err(400, `status: ${STATUSES.join(", ")}`);
    if (rec.status === "revoked") throw err(409, "отзыв агента необратим");
    const ownerAllowed = (rec.status === "active" && ["deprecated", "revoked"].includes(status)) || (rec.status === "deprecated" && status === "revoked");
    if (!admin && !ownerAllowed) throw err(403, `переход ${rec.status} → ${status} доступен только администратору`);
    let sunsetIso = null, successorUrl = null;
    if (status === "deprecated") {
      const d = sunset ? new Date(sunset) : new Date(Date.now() + 30 * 86400000);
      if (isNaN(d)) throw err(400, "sunset: некорректная дата");
      sunsetIso = d.toISOString();
      if (successor) successorUrl = (await assertPublicUrl(String(successor), { allowPrivate })).href;
    }
    const prev = rec.status;
    rec.status = status; rec.sunset = sunsetIso; rec.successor = successorUrl;
    if (status === "revoked") for (const c of credsOf(rec)) if (!issuer.statusOf(c).revocation) issuer.setStatus(c.vc.id, "revocation", true, reason || "агент отозван");
    if (status === "suspended") {
      // запоминаем, какие аттестаты приостановлены именно из-за статуса агента — снимаем потом только их
      rec.suspended_by_status = credsOf(rec).filter((c) => !issuer.statusOf(c).suspension && !issuer.statusOf(c).revocation).map((c) => c.vc.id);
      for (const cid of rec.suspended_by_status) issuer.setStatus(cid, "suspension", true, reason || "агент приостановлен");
    }
    if (status === "active" && prev === "suspended") {
      for (const cid of rec.suspended_by_status || []) issuer.setStatus(cid, "suspension", false, reason || "проверка завершена");
      rec.suspended_by_status = [];
    }
    save(rec);
    issuer.event("agent_status", { agent: rec.id, from: prev, status, reason: reason || null, sunset: rec.sunset, successor: rec.successor });
    notify(rec, { title: `Статус агента: ${status}`, text: reason || "" });
    return { id: rec.id, status, sunset: rec.sunset, successor: rec.successor };
  }

  function passport(id) {
    const rec = get(id);
    const creds = credsOf(rec).map((c) => ({ ...c.vc, _status: issuer.statusOf(c), _inclusion: issuer.inclusion(c.vc.id) }));
    return {
      name: rec.name,
      url: rec.mcp_url,
      passport: {
        spec: "xonta-agent-passport/0.2",
        id: rec.did,
        status: rec.status,
        sunset: rec.sunset || undefined,
        successor: rec.successor || undefined,
        level_of_access: rec.level,
        gateway: `${publicUrl}/gw/${rec.id}/mcp`,
        issuer: issuer.did,
        // 0.15: при открытой регистрации владельца никто не проверял — так и пишем, а не молчим
        owner_verified: credsOf(rec, "AgentOwnerVerified").some((c) => !issuer.statusOf(c).revocation),
      },
      profile: rec.last_evaluation ? {
        expert: rec.last_evaluation.categories.filter((c) => c.score >= 80).map((c) => c.category),
        growth: rec.last_evaluation.categories.filter((c) => c.score < 60).map((c) => c.category),
        data: rec.last_evaluation.evaluation.data,
      } : null,
      credentials: creds,
    };
  }

  function listSignals(id) { const rec = get(id); return Object.values(store.get("signals", {})).filter((s) => s.agent === rec.id).sort((a, b) => b.created.localeCompare(a.created)); }
  function actOnSignal(sid, action, token) {
    const all = store.get("signals", {});
    const s = typeof sid === "string" && Object.hasOwn(all, sid) ? all[sid] : null;
    if (!s) throw err(404, "сигнал не найден");
    const rec = get(s.agent);
    checkOwner(rec, token);
    if (!["accept", "reject", "mute30"].includes(action)) throw err(400, "action: accept | reject | mute30");
    store.update("signals", {}, (x) => { x[sid].status = action === "mute30" ? "muted" : action === "accept" ? "accepted" : "rejected"; x[sid].decided = new Date().toISOString(); });
    if (action === "mute30") { rec.muted = { ...(rec.muted || {}), [s.type]: new Date(Date.now() + 30 * 86400000).toISOString() }; save(rec); }
    issuer.event("signal_decision", { agent: rec.id, signal: sid, type: s.type, action });
    return { signal: sid, action, note: action === "accept" ? "Оркестратор ничего не применяет сам: план передан владельцу." : undefined };
  }

  return { register, didDoc, domainCheck, scan, test, reputation, ownerVerified, setAgentStatus, passport, listSignals, actOnSignal, checkOwner, get, tester };
}
