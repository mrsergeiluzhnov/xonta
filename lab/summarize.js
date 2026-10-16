// Сводка отчёта эксперимента: node lab/summarize.js [lab/out/report.json]
import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2] || new URL("./out/report.json", import.meta.url), "utf8"));
const out = { params: r.params, arms: {} };
for (const a of ["A", "B"]) {
  const R = r[a];
  const rootId = R.agents.root.id;
  const fb = {}, traffic = {}, learned = {};
  for (const row of R.rounds) for (const [id, s] of Object.entries(row.agents)) { fb[id] = (fb[id] || 0) + s.feedback_sent; traffic[id] = (traffic[id] || 0) + s.traffic; learned[id] = (learned[id] || 0) + s.rules_learned; }
  // раунд 0 — только базовые форматы (100% у всех), поэтому средние считаются с раунда 1
  const tail = R.rounds.slice(1);
  const mean = (key) => +(tail.reduce((s, x) => s + x.bench[key], 0) / tail.length).toFixed(1);
  const below = (key, th) => tail.filter((x) => x.bench[key] < th).length;
  out.arms[a] = {
    bench_root: R.rounds.map((x) => x.bench.root), bench_system: R.rounds.map((x) => x.bench.system),
    eval_root: R.rounds.map((x) => x.agents[rootId]?.eval_overall ?? null),
    mean_root: mean("root"), mean_system: mean("system"), rounds_below_95_system: below("system", 95), rounds_below_95_root: below("root", 95),
    feedback_sent: fb, feedback_total: Object.values(fb).reduce((s, x) => s + x, 0), traffic, rules_learned: learned,
    children: R.children, merges: R.merges.map((m) => ({ round: m.round, status: m.status, before: m.before.overall, after: m.after.overall, gain_pp: m.gain_pp, accepted: m.accepted.map((x) => `${x.from}/${x.category}`), rejected: m.rejected.map((x) => `${x.from}/${x.category}: ${x.reason}`), harmful_rules: [...m.accepted, ...m.rejected].flatMap((x) => x.rules.filter((v) => v.verdict === "ухудшает").map((v) => `${x.from} ${v.category}/${v.signature}: исправляет ${v.fixed}, портит ${v.broken}`)), contributions: m.contributions })),
    proposals: R.proposals.length, signals: R.signals.map((s) => `${s.round}:${s.type}:${s.evidence?.category}:${s.decision}`), poison: R.poison, checks: R.checks?.map((c) => `${c.passed ? "✓" : "✗"} ${c.name} → ${c.status}`),
    final: R.final && { verify: R.final.verify, passports: R.final.passports, cascade: R.final.cascade, anchor: R.final.anchor, inclusion: !!R.final.inclusion_example?.proof },
  };
}
console.log(JSON.stringify(out, null, 1));
