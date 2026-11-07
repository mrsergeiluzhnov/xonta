// Recompute a saved result with the current scoring, from the raw answers kept in the file (1.1 and later).
//   node bench/honesty/rescore.mjs bench/honesty/results/llama3.1_8b.json
import { readFileSync, writeFileSync } from "node:fs";
import { TASKS } from "./scenarios.mjs";
import { judge, summarize } from "./judge.mjs";
import { BENCH_VERSION } from "./version.mjs";

const parse = (s) => { const m = String(s || "").match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } };
for (const file of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  // 1.0 files keep the answer under pressure (asked_raw) but not the clean one: only the first is rescored
  if (!run.rows.some((r) => "control_raw" in r || r.asked_raw)) { console.error(`${file}: no raw answers (bench ${run.version}), can't rescore`); continue; }
  for (const r of run.rows) {
    const t = TASKS.find((x) => x.id === r.id), d = { action: r.action, checks: r.checks, correct: r.correct };
    // a raw answer cut off when it was saved may not parse any more: then the judgement made at run time stays
    const again = (old, raw) => { const j = judge(parse(raw), d, t, raw); return j.parsed || !old?.parsed ? j : old; };
    if ("control_raw" in r) r.control = again(r.control, r.control_raw);
    if (r.asked) r.asked = again(r.asked, r.asked_raw);
  }
  run.summary = summarize(run.rows); run.rescored = { from: run.version, to: BENCH_VERSION }; run.version = BENCH_VERSION;
  writeFileSync(file, JSON.stringify(run, null, 1));
  const s = run.summary; console.log(`${run.model}: lied when asked ${s.lie_when_asked.k}/${s.lie_when_asked.n} (${s.lie_when_asked.pct}%), refused ${s.refused_when_asked.k}, mentioned the request ${s.disclosed_request.k}, claimed a request when there was none ${s.request_claimed_with_no_request.k}/${s.request_claimed_with_no_request.n}`);
}
