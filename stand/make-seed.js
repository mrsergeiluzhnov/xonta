// Засев книги опыта оркестратора A из прошлых прогонов: 5 и 6 (закупки) и 7 (поддержка).
// node stand/make-seed.js <run5/run.json> <run6/run.json> <run7-dir со store оркестратора> > stand/experience-seed/A.json
//  • прогон 7: исходы советов с отпечатками исходных аттестатов (credentials.json), по категориям — из поэкзаменных данных;
//    подборы команды — по всем обращениям (поэкзаменных данных подбора в прогоне 7 не хранили);
//  • прогоны 5 и 6: только итоговые исходы из run.json (аттестатов в архиве нет) — помечены как «архив без подписи».
// Смешанные исходы и рецепты-пакеты в книгу не идут — так же, как в живой работе оркестратора.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { techniqueOf } from "../src/support.js";

const [r5, r6, r7] = process.argv.slice(2);
const J = (f) => JSON.parse(readFileSync(f, "utf8"));
const blank = () => ({ n: 0, success: 0, gain: 0 });
const entries = {}, archive = [];
const short = (x) => createHash("sha256").update(String(x)).digest("hex").slice(0, 6);
function rec({ domain, category = "all", technique, arm, success, gain = 0, run, payload = null, source, original = null, outcome }) {
  const key = `${domain}|${category}|${technique}`;
  const e = (entries[key] ||= { key, domain, category, technique, treated: blank(), control: blank(), runs: [], payload: null, origin: "seed" });
  const g = arm === "control" ? e.control : e.treated; g.n++; if (success) g.success++; g.gain = Math.round(100 * (g.gain + gain)) / 100;
  if (!e.runs.includes(run)) e.runs.push(run);
  if (payload && !e.payload) e.payload = payload;
  archive.push({ key, source, original, technique, category, outcome: { arm, success, gain: Math.round(100 * gain) / 100, ...outcome } });
}

// ---------- прогон 7: поддержка ----------
const st = (n, d) => { try { return J(join(r7, "orchestrator", `${n}.json`)); } catch { return d; } };
const adv = st("sup_advice", {}), exams = st("sup_exams", {}), H = st("sup_heldout", {}), creds = st("credentials", {}), sweeps = st("sup_sweeps", {});
for (const a of Object.values(adv)) {
  const o = a.outcome; if (!o || o.confounded || a.arm_reason === "recipe") continue;
  const technique = techniqueOf(a.type, a.action), arm = a.status === "accepted" ? "treated" : "control";
  const payload = a.type === "fraud_objective" ? { kind: "set_objective", text: a.action.text } : a.type === "team" ? { kind: "team", team: a.action.team } : null;
  const original = o.credential ? { id: o.credential, digest: creds[o.credential]?.hash || null, type: "AdviceOutcome" } : null;
  const source = { run: "run-7", domain: "support", advice: a.id, signed: !!original?.digest };
  rec({ domain: "support", technique, arm, success: o.success, gain: o.regret_before - o.regret_after, run: "run-7", payload, source, original, outcome: { regret_before: o.regret_before, regret_after: o.regret_after, n: o.n, improved: o.improved, worsened: o.worsened } });
  const e1 = (exams[a.target] || []).find((e) => e.round === o.measured_round);
  if (!e1 || !a.baseline) continue;
  const by = {}; for (const id of Object.keys(a.baseline)) if (e1.per[id] && H[id]) (by[H[id].type] ||= []).push(id);
  for (const [cat, l] of Object.entries(by)) {
    if (l.length < 4) continue;
    const b0 = l.reduce((s, id) => s + a.baseline[id], 0) / l.length, a1 = l.reduce((s, id) => s + e1.per[id].regret_pct, 0) / l.length;
    rec({ domain: "support", category: cat, technique, arm, success: b0 - a1 >= 1, gain: b0 - a1, run: "run-7", payload, source, original, outcome: { regret_before: Math.round(100 * b0) / 100, regret_after: Math.round(100 * a1) / 100, n: l.length } });
  }
}
for (const [agent, l] of Object.entries(sweeps)) for (const w of l) {
  const none = w.rows.find((x) => x.team === "none"); if (!none) continue;
  for (const x of w.rows.filter((y) => y.team !== "none")) {
    const technique = `sweep:team:${x.team}`, source = { run: "run-7", domain: "support", sweep: `${agent}@${w.round}`, signed: false }, outcome = { regret_none: none.regret_pct, regret_team: x.regret_pct, n: x.n };
    rec({ domain: "support", technique, arm: "treated", success: none.regret_pct - x.regret_pct >= 1, gain: none.regret_pct - x.regret_pct, run: "run-7", payload: { kind: "team", team: x.team }, source, outcome });
    rec({ domain: "support", technique, arm: "control", success: x.regret_pct - none.regret_pct >= 1, run: "run-7", source, outcome });
  }
}

// ---------- прогоны 5 и 6: закупки (только итоги) ----------
// у отклонённого совета (контроль) текста цели в run.json нет — берётся текст того же совета у выполнивших (он один на прогон)
let SHOP_TEXT = null;
for (const f of [r5, r6]) if (f) for (const a of J(f).advice || []) if (a.type === "scam_objective" && a.done?.objective) SHOP_TEXT ||= a.done.objective;
const SHOP_TECH = (a) => a.type === "scam_objective" ? `objective:scam@${short(a.done?.objective || SHOP_TEXT || "")}` : a.type === "spawn_senior" ? "team:senior" : a.type === "swarm_size" ? "team:check" : a.type === "escalate_category" ? "escalate:category" : a.type;
for (const [file, run] of [[r5, "run-5"], [r6, "run-6"]]) {
  if (!file) continue;
  const R = J(file);
  for (const a of R.advice || []) {
    const o = a.outcome; if (!o || o.confounded || a.arm_reason === "recipe" || o.success == null) continue;
    const arm = a.decision === "accept" ? "treated" : "control";
    rec({ domain: "shop", technique: SHOP_TECH(a), arm, success: o.success, gain: o.regret_before - o.regret_after, run, payload: a.type === "scam_objective" && (a.done?.objective || SHOP_TEXT) ? { kind: "set_objective", text: a.done?.objective || SHOP_TEXT } : null,
      source: { run, domain: "shop", advice: a.id, signed: false }, original: o.credential ? { id: o.credential, digest: null, type: "AdviceOutcome" } : null, outcome: { regret_before: o.regret_before, regret_after: o.regret_after, n: o.n } });
  }
  for (const w of R.sweeps || []) {
    const none = w.rows.find((x) => x.size === 0); if (!none) continue;
    for (const x of w.rows.filter((y) => y.size > 0)) {
      const technique = x.size === 2 ? "sweep:team:check" : `sweep:team:check-${x.size}`, source = { run, domain: "shop", sweep: `${w.buyer}@${w.round}`, signed: false }, outcome = { regret_none: none.regret_pct, regret_team: x.regret_pct, n: x.n };
      rec({ domain: "shop", technique, arm: "treated", success: none.regret_pct - x.regret_pct >= 1, gain: none.regret_pct - x.regret_pct, run, source, outcome });
      rec({ domain: "shop", technique, arm: "control", success: x.regret_pct - none.regret_pct >= 1, run, source, outcome });
    }
  }
}
// ---------- послужной список из архивов: честно, вместе с ошибками ----------
const track = { agents: {}, advice: [], drift: { flags: [], verdicts: [] }, audits: [], budget: {} };
const R7 = (() => { try { return J(join(r7, "run.json")); } catch { return null; } })();
for (const [file, dom] of [[r5, "shop"], [r6, "shop"]]) if (file) { const R = J(file); track.agents[dom] = (track.agents[dom] || 0) + (R.buyers || []).length; for (const a of R.advice || []) if (a.outcome && a.outcome.success != null && a.arm_reason !== "recipe") track.advice.push({ pred: a.predicted, success: !!a.outcome.success, arm: a.decision === "accept" ? "treated" : "control", confounded: !!a.outcome.confounded, domain: dom, source: file.includes("run5") ? "run-5" : "run-6" }); }
if (R7) {
  track.agents.support = (R7.agents || []).length;
  for (const a of Object.values(adv)) if (a.outcome && a.arm_reason !== "recipe") track.advice.push({ pred: a.predicted, success: !!a.outcome.success, arm: a.status === "accepted" ? "treated" : "control", confounded: !!a.outcome.confounded, domain: "support", source: "run-7" });
  for (const e of R7.events || []) if (e.event === "drift_detected") {
    track.drift.flags.push({ agent: `run-7/С${e.agent}`, round: e.round });
    const c = R7.corrupted, verdict = c && c.agent === e.agent && c.round <= e.round ? "confirmed" : "false_alarm";
    track.drift.verdicts.push({ agent: `run-7/С${e.agent}`, flagged_round: e.round, corrupted_round: c?.agent === e.agent ? c.round : null, verdict, note: verdict === "false_alarm" ? "тревога до подмены: правило по среднему вреду на малом числе действий; исправлено в 0.11" : null });
  }
  const au = (R7.audits || []).at(-1), ACC = { cheap: 0.75, precise: 0.97 };
  if (au) for (const [src, truth] of [["kb", au.kb_truth], ["cheap", Math.round(1000 * (1 - ACC.cheap)) / 10], ["precise", Math.round(1000 * (1 - ACC.precise)) / 10]]) { const x = au[src]; if (x?.ci95) track.audits.push({ source: src, estimate: x.rate, ci95: x.ci95, truth, inside: truth >= x.ci95[0] && truth <= x.ci95[1], run: "run-7" }); }
}
process.stdout.write(JSON.stringify({ made: new Date().toISOString(), note: "книга опыта оркестратора A: прогоны 5–6 (закупки, итоги без подписей) и 7 (поддержка, с отпечатками аттестатов)", entries: Object.values(entries), archive, track }, null, 1));
