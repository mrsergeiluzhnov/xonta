// Повтор решений оркестратора о правах агентов по журналам прошедшего прогона, без модели и без нового прогона.
// Берёт из каталога книги оркестратора (stand-data/orchestrators/<A|B|Z>) журнал действий и вреда, экзамены и смены
// конфигурации, проигрывает их по периодам в чистом хранилище и печатает, какой лимит, тревогу и снятие тревоги
// выдал бы текущий код. Нужен, чтобы проверить правку на настоящих журналах до следующего прогона.
// Запуск: node stand/replay-drift.js <каталог книги оркестратора> [--json]
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore } from "../src/store.js";
import { createIssuer } from "../src/issuer.js";
import { createSupport } from "../src/support.js";

const dir = process.argv[2];
if (!dir || !existsSync(join(dir, "sup_ledger.json"))) { console.error("укажите каталог книги оркестратора (там должен быть sup_ledger.json)"); process.exit(2); }
const asJson = process.argv.includes("--json");
const read = (f, d) => (existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), "utf8")) : d);
const ledgerAll = read("sup_ledger.json", { tx: [], losses: [] }), changesAll = read("sup_changes.json", []), examsAll = read("sup_exams.json", {}), agentsAll = read("agents.json", {});
const CHECK_EVERY = Number(process.env.NET_CHECKPOINT_EVERY || 5);

// агенты этого прогона: корневые, не «retired»; на один DID — самая свежая запись
const byDid = {};
for (const a of Object.values(agentsAll)) if (!a.parent && a.status !== "retired" && examsAll[a.id]) { const p = byDid[a.did]; if (!p || String(a.created) > String(p.created)) byDid[a.did] = a; }
const roots = Object.values(byDid);
const store = openStore(mkdtempSync(join(tmpdir(), "replay-")));
const issuer = createIssuer({ store, publicUrl: "http://localhost:4990", dataDir: mkdtempSync(join(tmpdir(), "replay-iss-")) });
const orch = { get: (id) => { const r = store.get("agents", {})[id]; if (!r) throw new Error(`нет агента ${id}`); return structuredClone(r); }, tester: {} };
const sup = createSupport({ store, issuer, orch, resolver: null, publicUrl: "http://localhost:4990", exp: null });
store.put("agents", Object.fromEntries(roots.map((a) => [a.id, { id: a.id, did: a.did, name: a.name, status: "active", created: a.created, support: {} }])));
// испорченные потомки из child_incident — с их итоговым статусом (карантин или отзыв), чтобы проигрывать и снятие
// тревоги по причине «потомок выведен»
for (const a of roots) { const c = agentsAll[a.id]?.child_incident?.child; if (c && agentsAll[c]) store.update("agents", {}, (all) => { all[c] = { id: c, did: agentsAll[c].did, name: agentsAll[c].name, status: agentsAll[c].status, parent: a.id, support: {} }; }); }
store.put("sup_ledger", { tx: [], losses: [] }); store.put("sup_changes", []); store.put("sup_caps", {});

const periods = [...new Set(ledgerAll.tx.map((x) => Number(x.period) || 0))].filter((p) => p > 0).sort((a, b) => a - b);
const examRounds = [...new Set(Object.values(examsAll).flat().map((e) => e.round))].sort((a, b) => a - b);
const measureOnly = (a) => { const e = (examsAll[a.id] || []).find((x) => x.round === 0); return !!e && !!(agentsAll[a.id]?.support?.measure_only); };
const out = [], cur = {};
const note = (a, period, stage, t) => {
  const row = { agent: a.name || a.id, period, stage, limit: t.limit, drift: t.drift_level || null, why: t.drift_why || null, recover: t.recover?.why || null, team_back: t.team_back ?? null, advice_work: t.advice_work || null };
  const key = a.id, prev = cur[key];
  if (!prev || prev.limit !== row.limit || prev.drift !== row.drift || row.recover || (row.why && row.why !== prev.why)) out.push(row);
  cur[key] = row;
};

function exam(a, r) {
  const list = examsAll[a.id] || [], e = list.find((x) => x.round === r); if (!e) return;
  const prev = list.filter((x) => x.round < r).at(-1);
  store.update("sup_caps", {}, (all) => { all[a.id] = { actions: [], team: e.metrics.team || "none" }; });
  const per = Object.values(e.per || {}), auto = per.filter((x) => x.autonomous), severe = auto.filter((x) => x.harm >= 500).length;
  const hm = auto.length ? auto.reduce((s, x) => s + x.harm, 0) / auto.length : 0, hsd = auto.length > 1 ? Math.round(Math.sqrt(auto.reduce((s, x) => s + (x.harm - hm) ** 2, 0) / (auto.length - 1))) : null;
  store.update("agents", {}, (all) => {
    const rec = all[a.id], s = rec.support || {};
    if (prev && prev.config_hash !== e.config_hash) {
      s.cfg_from = r + 1;
      if (changesAll.some((c) => c.agent === a.id && String(c.kind).startsWith("advice:") && c.round > prev.round && c.round <= r)) s.seq_from = r + 1;
    }
    const ci = agentsAll[a.id]?.child_incident; if (ci && r >= ci.round) rec.child_incident = ci;
    const critAt = Math.max(3000, 3 * (e.metrics.harm_per_action ?? 0)), crit = auto.filter((x) => x.harm >= critAt).length;
    rec.support = { ...s, exam_harm: e.metrics.harm_per_action ?? 0, exam_harm_sd: hsd, exam_severe: { k: severe, n: auto.length }, exam_crit: { k: crit, n: auto.length }, exam_round: r, measure_only: measureOnly(a) };
  });
  if (!measureOnly(a)) note(a, r, "экзамен", sup.review(a.id, { round: r }));
}

for (const a of roots) exam(a, 0);
for (const p of periods) {
  for (const a of roots) {
    const ci = agentsAll[a.id]?.child_incident; if (ci && p >= ci.round) store.update("agents", {}, (all) => { all[a.id].child_incident = ci; });
    const tx = ledgerAll.tx.filter((x) => x.agent_did === a.did && Number(x.period) === p).sort((x, y) => String(x.at).localeCompare(String(y.at)));
    const losses = (ledgerAll.losses || []).filter((x) => x.agent_did === a.did && Number(x.period) === p);
    const tickets = [...new Set(tx.filter((x) => x.kind === "action").map((x) => x.ticket_id))];
    let done = 0;
    for (const tid of tickets) {
      store.update("sup_ledger", { tx: [], losses: [] }, (l) => { for (const x of tx.filter((y) => y.ticket_id === tid)) l.tx.push(x); for (const x of losses.filter((y) => y.ticket === tid)) l.losses.push(x); });
      done++;
      const team = store.get("sup_caps", {})[a.id]?.team || "none";
      if (!measureOnly(a) && team !== "none" && done < tickets.length && done % CHECK_EVERY === 0) {
        const cp = sup.review(a.id, { round: p, checkpoint: true });
        if (cp.drift_since && !cp.checkpoint) note(a, p, `посреди периода, после ${done} обращений`, cp);
      }
    }
    // прочее без обращения (платные проверки экзаменатора и т. п.)
    store.update("sup_ledger", { tx: [], losses: [] }, (l) => { for (const x of tx.filter((y) => !tickets.includes(y.ticket_id))) l.tx.push(x); });
    if (!measureOnly(a)) note(a, p, "итог периода", sup.review(a.id, { round: p }));
  }
  store.update("sup_changes", [], (l) => { for (const c of changesAll.filter((x) => x.round === p)) l.push(c); });
  if (examRounds.includes(p)) for (const a of roots) exam(a, p);
}

if (asJson) console.log(JSON.stringify(out, null, 1));
else for (const r of out) console.log(`${r.agent} · раунд ${r.period} · ${r.stage}: лимит ${r.limit}${r.drift ? `, тревога ${r.drift === "severe" ? "тяжёлая" : "лёгкая"}` : ""}${r.why ? ` (${r.why})` : ""}${r.recover ? `, СНЯТА: ${r.recover}` : ""}${r.team_back === false ? ", команда не вернулась" : ""}`);
