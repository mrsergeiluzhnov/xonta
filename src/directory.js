// Справочник оркестраторов (0.16). Как одному оркестратору найти другие и понять, у кого какой опыт.
//
// Визитка. Каждый оркестратор отдаёт /.well-known/xonta-orchestrator.json: подписанный аттестат OrchestratorCard со своим DID,
// адресом, эндпоинтами, наборами заданий (сферами) с их статистикой и сводкой опыта по категориям. По визитке видно, что по адресу
// живёт оркестратор и чем он силён.
//
// Регистрация и проверка. Любой оркестратор может принимать записи других (DIRECTORY_ACCEPT). По умолчанию принимает только
// справочник Xonta. При записи и при каждом обходе проверяется: визитка подписана ключом из did:web этого же адреса, адрес в визитке
// совпадает с тем, откуда её взяли, послужной список подписан тем же DID, /health отвечает тем же DID. Не прошёл — не попадает в
// выдачу, причины видны.
//
// Обход. Раз в DIRECTORY_SCAN_HOURS справочник перепроверяет известные оркестраторы и забирает их /v1/experience/peers: так новые
// соседи находятся сами, граф раскрывается без ручной работы. Три неудачные проверки подряд — оркестратор помечается stale и
// пропадает из выдачи, пока снова не ответит.
//
// Честно. Цифры в визитке оркестратор считает сам. Подпись означает, что он за них отвечает, а не что они верны. Поэтому в выдаче
// отдельно видно, что проверено справочником (подписи, домен, доступность), а что заявлено самим оркестратором.
//
// Предложение записаться. Оркестратор, развёрнутый у себя из этого кода, при старте и раз в сутки сам предлагает владельцу записаться
// в справочник Xonta: в журнале, на главной странице и в /health. Без согласия владельца (DIRECTORY_JOIN=1 или вызов
// POST /v1/admin/directory/join) он никуда о себе не сообщает.
import { safeFetch, assertPublicUrl } from "./net.js";
import { verifyProof, checkValidity } from "./vc.js";
import { urlToDidWeb } from "./did.js";
import { trackScore, measuredVsControl } from "./experience.js";

const err = (status, msg) => Object.assign(new Error(msg), { status });
const norm = (u) => String(u || "").trim().replace(/\/+$/, "");
const lc = (s) => String(s || "").toLowerCase();
export const DIRECTORY_DEFAULTS = { hub_url: "https://passport.xonta.ru", scan_hours: 6, max_entries: 500, crawl_per_scan: 20, stale_after: 3 };

export function createDirectory({ store, issuer, resolver, exp, fields, publicUrl, version, allowPrivate = false, openRegistration = false, cfg = {} }) {
  const C = { ...DIRECTORY_DEFAULTS, ...Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined)) };
  const hub = C.hub_url && C.hub_url !== "off" ? norm(C.hub_url) : null;
  const self = norm(publicUrl);
  const isHub = !!hub && hub === self;
  const accept = cfg.accept ?? isHub;
  const st = () => store.get("directory", { entries: {}, joined: null });
  const upd = (fn) => store.update("directory", { entries: {}, joined: null }, fn);

  // ---------- своя визитка ----------
  function experienceSummary() {
    const out = {};
    for (const [domain, cats] of Object.entries(exp?.catalog().domains || {})) for (const [cat, list] of Object.entries(cats)) {
      const ctl = list.filter((e) => e.evidence > 0 && measuredVsControl(e));
      ((out[domain] ||= {})[cat] = { techniques: list.length, controlled: ctl.length, best_prob_better: ctl.length ? Math.max(...ctl.map((e) => e.prob_better)) : null });
    }
    return out;
  }
  function fieldsSummary() {
    return (fields?.list() || []).map((f) => ({ id: f.id, name: f.name, version: f.version, currency: f.currency, categories: f.categories, tasks: f.tasks, stats: { exams: f.stats.exams, agents: f.stats.agents, accuracy_mean: f.stats.accuracy_mean ?? null, harm_per_action_mean: f.stats.harm_per_action_mean ?? null, categories: f.stats.categories || null } }));
  }
  function cardSubject() {
    const track = exp?.trackSummary() || {};
    return {
      id: issuer.did, name: process.env.ORCH_NAME || "xonta", url: self, software: "xonta", version, open_registration: !!openRegistration,
      endpoints: { agents: `${self}/v1/agents`, fields: `${self}/v1/fields`, experience_catalog: `${self}/v1/experience/catalog`, track_record: `${self}/v1/experience/track-record`, peers: `${self}/v1/experience/peers`, directory: accept ? `${self}/v1/orchestrators` : null },
      fields: fieldsSummary(), experience: experienceSummary(),
      agents_served: Object.values(track.agents_served || {}).reduce((a, b) => a + b, 0),
      directory_hub: hub, listed_at: st().joined?.hub || (isHub ? self : null),
    };
  }
  let cached = null;
  // новая визитка выпускается, когда изменилось её содержимое (новый набор, новые экзамены, опыт), и не реже раза в сутки
  function card() {
    const sub = cardSubject(), fp = JSON.stringify(sub);
    if (cached && cached.fp === fp && Date.now() - cached.at < 86400_000) return cached.vc;
    cached = { at: Date.now(), fp, vc: issuer.issue("OrchestratorCard", sub, { validDays: 2 }) };
    return cached.vc;
  }
  const refreshCard = () => { cached = null; };

  // ---------- проверка чужого оркестратора ----------
  const getJson = async (url) => { const r = await safeFetch(url, { allowPrivate, maxBytes: 1024 * 1024, timeoutMs: 10000 }); if (!r.ok) throw err(502, `${url}: ${r.status}`); return r.json(); };
  async function verifyRemote(raw) {
    const base = norm(raw);
    await assertPublicUrl(base, { allowPrivate });
    const checks = [], add = (name, ok, detail = null) => { checks.push({ name, ok: !!ok, detail }); return ok; };
    let vc, sub, did, track = null;
    try { vc = await getJson(`${base}/.well-known/xonta-orchestrator.json`); } catch (e) { add("card", false, e.message); return { ok: false, base, checks }; }
    sub = vc?.credentialSubject || {};
    did = typeof vc?.issuer === "string" ? vc.issuer : vc?.issuer?.id;
    add("card_type", (vc?.type || []).includes("OrchestratorCard"), "OrchestratorCard");
    const sig = await verifyProof(vc, (vm) => resolver.keyFor(vm)).catch((e) => ({ ok: false, reason: e.message }));
    add("card_signature", sig.ok, sig.ok ? did : sig.reason);
    const val = checkValidity(vc); add("card_valid", val.ok, val.reason || null);
    add("card_subject_is_issuer", sub.id === did, sub.id);
    add("url_matches", norm(sub.url) === base, sub.url);
    let expected = null; try { expected = urlToDidWeb(base); } catch {}
    add("did_matches_domain", did === expected, `${did} vs ${expected}`);
    try {
      const tr = await getJson(`${base}/v1/experience/track-record`);
      const ts = await verifyProof(tr, (vm) => resolver.keyFor(vm)).catch((e) => ({ ok: false, reason: e.message }));
      const trIssuer = typeof tr.issuer === "string" ? tr.issuer : tr.issuer?.id;
      if (add("track_record_signature", ts.ok && trIssuer === did, ts.ok ? trIssuer : ts.reason)) track = tr.credentialSubject;
    } catch (e) { add("track_record_signature", false, e.message); }
    try { const h = await getJson(`${base}/health`); add("health", h.ok && h.issuer === did, h.issuer); } catch (e) { add("health", false, e.message); }
    return { ok: checks.every((c) => c.ok), base, did, card: sub, track, checks };
  }

  function upsert(v, { source }) {
    const now = new Date().toISOString();
    let row;
    upd((d) => {
      const key = v.ok ? v.did : `url:${v.base}`;
      if (v.ok) for (const [k, e] of Object.entries(d.entries)) if (k !== key && (e.url === v.base || e.did === v.did)) delete d.entries[k]; // тот же оркестратор под старым ключом
      const was = d.entries[key] || { added: now, source, scans: 0, ok_scans: 0, fails: 0 };
      row = d.entries[key] = { ...was, url: v.base, did: v.did || was.did || null, last_check: now, scans: was.scans + 1, ok_scans: was.ok_scans + (v.ok ? 1 : 0), fails: v.ok ? 0 : was.fails + 1, checks: v.checks,
        status: v.ok ? "listed" : was.status === "listed" || was.status === "stale" ? (was.fails + 1 >= C.stale_after ? "stale" : "listed") : "rejected",
        last_ok: v.ok ? now : was.last_ok || null, card: v.ok ? trimCard(v.card) : was.card || null, track: v.ok ? trimTrack(v.track) : was.track || null };
    });
    return row;
  }
  const trimCard = (c) => ({ name: String(c.name || "").slice(0, 80), version: String(c.version || "").slice(0, 20), software: String(c.software || "").slice(0, 40), open_registration: !!c.open_registration, agents_served: Number(c.agents_served) || 0, endpoints: c.endpoints || {}, fields: (Array.isArray(c.fields) ? c.fields : []).slice(0, 100).map((f) => ({ id: String(f.id || "").slice(0, 40), name: String(f.name || "").slice(0, 80), version: String(f.version || "").slice(0, 32), currency: String(f.currency || "").slice(0, 3), categories: (f.categories || []).slice(0, 40).map((x) => String(x).slice(0, 40)), tasks: Number(f.tasks) || 0, stats: { exams: Number(f.stats?.exams) || 0, agents: Number(f.stats?.agents) || 0, accuracy_mean: f.stats?.accuracy_mean ?? null, harm_per_action_mean: f.stats?.harm_per_action_mean ?? null, categories: f.stats?.categories || null } })), experience: c.experience || {} });
  const trimTrack = (t) => t ? { agents_served: t.agents_served || {}, advice: t.advice || null, drift_alarms: t.drift_alarms || null, descendants: t.descendants || null, audit_accuracy: t.audit_accuracy || null, peer_experience: t.peer_experience || null } : null;

  async function register({ url } = {}, { source = "registration" } = {}) {
    if (!url) throw err(400, "нужен url оркестратора");
    if (norm(url) === self) return { listed: true, self: true, entry: view(selfEntry()) };
    if (Object.keys(st().entries).length >= C.max_entries) throw err(503, "справочник заполнен, попробуйте позже");
    const v = await verifyRemote(url);
    // не прошедший проверку новый адрес не хранится: иначе справочник можно забить мусором
    const known = Object.values(st().entries).some((e) => e.url === v.base || (v.did && e.did === v.did));
    if (!v.ok && !known) return { listed: false, status: "rejected", url: v.base, checks: v.checks, note: "Not listed, see the failed checks.", note_ru: "Не записан, смотрите проваленные проверки." };
    const row = upsert(v, { source });
    if (row.status === "listed") issuer.event("orchestrator_listed", { did: row.did, url: row.url, source });
    return { listed: row.status === "listed", status: row.status, did: row.did, url: row.url, checks: v.checks, entry: row.status === "listed" ? view(row) : null,
      note: row.status === "listed" ? "Listed. The directory re-checks you every few hours, three failed checks in a row hide you until you answer again." : "Not listed, see the failed checks.",
      note_ru: row.status === "listed" ? "Записан. Справочник перепроверяет вас раз в несколько часов, после трёх неудачных проверок подряд вы скрыты, пока снова не ответите." : "Не записан, смотрите проваленные проверки." };
  }

  // ---------- выдача ----------
  function selfEntry() { const vc = card(); return { did: issuer.did, url: self, status: "listed", source: "self", added: null, last_ok: new Date().toISOString(), scans: 1, ok_scans: 1, card: trimCard(vc.credentialSubject), track: trimTrack(exp?.trackSummary()), checks: [] }; }
  function view(e) {
    const c = e.card || {}, t = e.track || {};
    return {
      did: e.did, name: c.name || null, url: e.url, status: e.status, source: e.source, self: e.url === self,
      verified: { signature_and_domain: e.status === "listed", last_ok: e.last_ok, uptime: e.scans ? Math.round(100 * e.ok_scans / e.scans) / 100 : null },
      claimed: {
        version: c.version, open_registration: c.open_registration, agents_served: c.agents_served,
        fields: (c.fields || []).map((f) => ({ id: f.id, name: f.name, version: f.version, currency: f.currency, categories: f.categories, exams: f.stats.exams, agents: f.stats.agents, accuracy_mean: f.stats.accuracy_mean })),
        experience: c.experience,
        advice_vs_control: t.advice ? { treated_success: t.advice.treated_success, control_success: t.advice.control_success, control_n: t.advice.control_n, score: trackScore(t) } : null,
        false_alarms: (t.drift_alarms?.false_alarms || 0) + (t.descendants?.false_alarms || 0), audit_accuracy: t.audit_accuracy,
      },
      endpoints: c.endpoints || {},
    };
  }
  // сколько опыта у оркестратора по категории (и набору): экзамены по наборам с этой категорией + приёмы, измеренные против контроля
  function evidenceFor(e, { category = null, field_version = null, domain = null } = {}) {
    const c = e.card || {}; let exams = 0, agents = 0, controlled = 0, match = !category && !field_version && !domain;
    for (const f of c.fields || []) {
      const vOk = !field_version || f.version === field_version, cOk = !category || (f.categories || []).some((x) => lc(x) === lc(category));
      if (vOk && cOk) { match = true; const cs = category && f.stats.categories?.[category]; exams += cs ? cs.exams || 0 : f.stats.exams; agents += cs ? cs.agents || 0 : f.stats.agents; }
    }
    for (const [d, cats] of Object.entries(c.experience || {})) {
      if (domain && d !== domain) continue;
      for (const [cat, x] of Object.entries(cats)) if (!category || lc(cat) === lc(category)) { if (x.controlled) match = true; controlled += x.controlled || 0; }
    }
    return { match, exams, agents, controlled };
  }
  function list({ category = null, field_version = null, domain = null, q = null, all = false } = {}) {
    const rows = [selfEntry(), ...Object.values(st().entries).filter((e) => e.url !== self && (all || e.status === "listed"))];
    return rows.map((e) => ({ e, ev: evidenceFor(e, { category, field_version, domain }) }))
      .filter(({ e, ev }) => ev.match && (!q || lc(e.card?.name).includes(lc(q)) || lc(e.url).includes(lc(q))))
      .sort((a, b) => b.ev.controlled - a.ev.controlled || b.ev.exams - a.ev.exams || (b.e.card?.agents_served || 0) - (a.e.card?.agents_served || 0))
      .map(({ e, ev }) => ({ ...view(e), evidence: (category || field_version || domain) ? ev : undefined }));
  }
  function get(key) {
    const k = decodeURIComponent(String(key));
    if (k === issuer.did || norm(k) === self) return view(selfEntry());
    const e = st().entries[k] || Object.values(st().entries).find((x) => x.url === norm(k) || x.did === k || (x.url && new URL(x.url).host === k));
    if (!e) throw err(404, "оркестратор не найден в справочнике");
    return { ...view(e), checks: e.checks };
  }

  // ---------- обход ----------
  let scanning = false;
  async function scan() {
    if (scanning) return { skipped: true }; scanning = true;
    const out = { checked: 0, listed: 0, found: 0 };
    try {
      for (const e of Object.values(st().entries)) {
        if (e.status === "rejected" && e.fails >= C.stale_after) continue; // отклонённых не долбим: перепроверка — по новой записи
        const v = await verifyRemote(e.url).catch((x) => ({ ok: false, base: e.url, checks: [{ name: "fetch", ok: false, detail: x.message }] }));
        const row = upsert(v, { source: e.source }); out.checked++; if (row.status === "listed") out.listed++;
      }
      // соседи из /v1/experience/peers тех, кто прошёл проверку, и общий список справочника Xonta (только если владелец согласился записаться)
      const known = new Set([self, ...Object.values(st().entries).map((e) => e.url)]), fresh = [];
      for (const e of Object.values(st().entries).filter((x) => x.status === "listed")) {
        try { for (const p of (await getJson(`${e.url}/v1/experience/peers`)) || []) if (p?.url && !known.has(norm(p.url))) { known.add(norm(p.url)); fresh.push({ url: norm(p.url), source: `peer:${e.did}` }); } } catch {}
      }
      if (hub && !isHub && st().joined?.listed) try { for (const o of (await getJson(`${hub}/v1/orchestrators`)) || []) if (o?.url && !known.has(norm(o.url))) { known.add(norm(o.url)); fresh.push({ url: norm(o.url), source: "hub" }); } } catch {}
      for (const f of fresh.slice(0, C.crawl_per_scan)) {
        if (Object.keys(st().entries).length >= C.max_entries) break;
        const v = await verifyRemote(f.url).catch(() => null); if (!v) continue;
        if (v.ok) { upsert(v, { source: f.source }); out.found++; }
      }
      refreshCard();
    } finally { scanning = false; }
    return out;
  }

  // ---------- предложение записаться в справочник Xonta ----------
  function offer() {
    if (!hub || isHub) return null;
    const j = st().joined;
    if (j && j.hub === hub && j.listed) return null;
    let publicOk = true; try { const u = new URL(self); publicOk = u.protocol === "https:" && !/^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname); } catch { publicOk = false; }
    return {
      hub, listed: false, public_url: self, ready: publicOk,
      message: publicOk
        ? `This orchestrator is not in the Xonta directory yet. Listing lets agents and other orchestrators find you by the fields and categories you have experience in, and lets yours find them. Only your public card is shared, never agents' data.`
        : `This orchestrator is not in the Xonta directory. Listing needs a public https address, set PUBLIC_URL first.`,
      message_ru: publicOk
        ? `Этот оркестратор ещё не записан в справочник Xonta. Запись позволит агентам и другим оркестраторам находить вас по сферам и категориям, где у вас есть опыт, а вашему находить их. Передаётся только ваша публичная визитка, данные агентов никуда не уходят.`
        : `Этот оркестратор не записан в справочник Xonta. Для записи нужен публичный https-адрес, сначала задайте PUBLIC_URL.`,
      how: publicOk ? [`curl -X POST ${self}/v1/admin/directory/join -H "Authorization: Bearer $ADMIN_TOKEN"`, `or set DIRECTORY_JOIN=1 and restart`, `to silence this: DIRECTORY_URL=off`] : [`set PUBLIC_URL=https://your-domain`, `to silence this: DIRECTORY_URL=off`],
      last_error: j?.error || null,
    };
  }
  async function join() {
    if (!hub) throw err(409, "справочник выключен (DIRECTORY_URL=off)");
    if (isHub) return { listed: true, self: true };
    const r = await safeFetch(`${hub}/v1/orchestrators`, { allowPrivate, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: self }), timeoutMs: 60000, maxBytes: 512 * 1024 });
    const j = r.json();
    upd((d) => { d.joined = { hub, at: new Date().toISOString(), listed: !!j.listed, did: j.did || null, error: j.listed ? null : (j.error || (j.checks || []).filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; ") || `status ${r.status}`) }; });
    refreshCard();
    return j;
  }
  // уже записанный оркестратор раз в сутки сверяется со справочником: не выпал ли
  async function checkJoined() {
    const j = st().joined; if (!hub || isHub || !j?.listed) return;
    try { const r = await safeFetch(`${hub}/v1/orchestrators/${encodeURIComponent(issuer.did)}`, { allowPrivate, timeoutMs: 15000 }); const e = r.ok ? r.json() : null; upd((d) => { d.joined.listed = e?.status === "listed"; d.joined.checked = new Date().toISOString(); }); } catch {}
  }
  function announce(log = console.log) {
    const o = offer(); if (!o) return;
    if (!o.ready && /^https?:\/\/(localhost|127\.)/.test(self)) return; // локальный запуск: предлагать нечего
    log(`\n[xonta directory] ${o.message}\n[xonta directory] ${o.message_ru}\n${o.how.map((h) => `[xonta directory]   ${h}`).join("\n")}\n`);
  }
  const status = () => ({ hub, is_hub: isHub, accepts_registrations: accept, joined: st().joined, known: Object.keys(st().entries).length, listed: Object.values(st().entries).filter((e) => e.status === "listed").length, offer: offer() });
  // список адресов для направлений: проверенные соседи (без себя)
  const peerUrls = () => Object.values(st().entries).filter((e) => e.status === "listed" && e.url !== self).map((e) => e.url);
  const entries = () => Object.values(st().entries).filter((e) => e.status === "listed" && e.url !== self);

  return { card, refreshCard, verifyRemote, register, list, get, scan, offer, join, checkJoined, announce, status, peerUrls, entries, evidenceFor, view, accept, isHub, hub };
}

export function mountDirectory(app, { dir, wrap, admin, limit }) {
  app.get("/.well-known/xonta-orchestrator.json", wrap(() => dir.card()));
  app.get("/v1/orchestrators", wrap((req) => dir.list({ category: req.query?.category || null, field_version: req.query?.field_version || null, domain: req.query?.domain || null, q: req.query?.q || null, all: req.query?.all === "1" })));
  app.get("/v1/orchestrators/:key", wrap((req) => dir.get(req.params.key)));
  app.post("/v1/orchestrators", wrap((req) => {
    if (!dir.accept) throw Object.assign(new Error("этот оркестратор не принимает записи, запишитесь в справочник Xonta"), { status: 403 });
    limit(req, 5, 86400_000, "orch-register");
    return dir.register(req.body || {}, { source: "registration" });
  }));
  app.get("/v1/admin/directory", wrap((req) => { admin(req); return dir.status(); }));
  app.post("/v1/admin/directory/join", wrap(async (req) => { admin(req); return dir.join(); }));
  app.post("/v1/admin/directory/scan", wrap(async (req) => { admin(req); return dir.scan(); }));
}
