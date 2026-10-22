// Отчёты Gate о приватности (0.18). Gate шлёт только счётчики: сколько отправок, сколько остановлено, по категориям и уровням,
// сколько раз агент назвал данные мягче, чем они есть, сработали ли приманки, заморожен ли. Людей — хешами с секретом Gate,
// содержимого нет. Владелец присылает, оркестратор хранит последние отчёты и считает, насколько агент честен с разметкой.
// Публично — без хешей людей, только их число.
const N = (x) => (Number.isFinite(+x) && +x >= 0 ? Math.min(1e9, Math.round(+x)) : 0);
const counts = (o) => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).slice(0, 40).filter(([k]) => /^[a-z_]{1,24}$/.test(k)).map(([k, v]) => [k, N(v)]));

export function createPrivacyReports({ store, now = () => Date.now() }) {
  const st = () => store.get("privacy_reports", {});
  function submit(agentId, body = {}) {
    const r = body.privacy || body;
    const users = r.users && typeof r.users === "object" ? Object.keys(r.users).filter((k) => /^[0-9a-f]{16}$/.test(k)).length : N(r.users);
    const row = { at: new Date(now()).toISOString(), sends: N(r.sends), allowed: N(r.allowed), human: N(r.human), denied: N(r.denied), mismatches: N(r.mismatches), canary_hits: N(r.canary_hits), frozen: !!r.frozen, by_category: counts(r.by_category), by_level: counts(r.by_level), users };
    if (row.allowed + row.human + row.denied > row.sends) throw Object.assign(new Error("allowed + human + denied is more than sends"), { status: 400 });
    const all = st(); all[agentId] = [...(all[agentId] || []), row].slice(-30); store.put("privacy_reports", all);
    return { ok: true, stored: row, summary: summary(agentId) };
  }
  function summary(agentId) {
    const rows = st()[agentId] || [];
    if (!rows.length) return { agent: agentId, reports: 0, note: "no privacy reports yet: they come from Xonta Gate with a privacy section in its policy" };
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0), sends = sum("sends"), mism = sum("mismatches"), canary = sum("canary_hits");
    // честность разметки: доля отправок, где агент не занижал категорию; приманка — сразу «вынос»
    const verdict = canary ? "leak_evidence" : sends && mism / sends > 0.05 ? "understates_sensitivity" : mism ? "occasional_understatement" : "labels_match";
    return { agent: agentId, reports: rows.length, since: rows[0].at, last: rows.at(-1).at, sends, stopped_for_human: sum("human"), denied: sum("denied"), understated: mism, understated_share: sends ? +(mism / sends).toFixed(3) : 0, canary_hits: canary, frozen_now: rows.at(-1).frozen, by_category: rows.reduce((m, r) => { for (const [k, v] of Object.entries(r.by_category)) m[k] = (m[k] || 0) + v; return m; }, {}), people: Math.max(...rows.map((r) => r.users)), verdict,
      why: { leak_evidence: "a planted canary record left through this agent: treat as a leak, freeze and look", understates_sensitivity: "the agent often calls data less sensitive than it is: consider a fresh child or a human on sensitive categories", occasional_understatement: "a few sends were labelled lower than their data, Gate stopped them", labels_match: "the agent's labels matched the data" }[verdict] };
  }
  return { submit, summary };
}

export function mountPrivacyReports(app, { reports, wrap, ownerAuth }) {
  app.post("/v1/agents/:id/privacy-report", wrap(async (req) => { await ownerAuth(req, req.params.id); return reports.submit(req.params.id, req.body || {}); }));
  app.get("/v1/agents/:id/privacy", wrap((req) => reports.summary(req.params.id)));
}
