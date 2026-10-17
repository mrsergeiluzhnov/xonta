// Починка данных оркестраторов перед повтором прогона (0.13).
// 1. Аттестаты AdviceOutcome до 0.13: после подписи в исход дописывалось поле credential (ссылка на сам аттестат) — подпись
//    переставала сходиться. Поле убирается; что восстановлен ровно подписанный текст, проверяется по отпечатку (hash).
// 2. Оркестраторы, которые из-за этого сочли чужие доказательства плохими, получают обратно доверие: записи со ссылкой на
//    починенные аттестаты возвращаются в «ожидает проверки», счётчик плохих доказательств уменьшается.
// 3. Прерванный прогон NET_RUN_ID убирается из книг и начнётся заново.
// node stand/repair-run.js  (ORCH_ROOT — каталог книг, NET_RUN_ID — прерванный прогон)
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { credentialHash } from "../src/vc.js";

const ROOT = process.env.ORCH_ROOT || "/stand-data/orchestrators", RUN = process.env.NET_RUN_ID || "run-10";
const J = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d), W = (f, v) => writeFileSync(f, JSON.stringify(v, null, 1));
const fixed = new Set(); let mismatch = 0;
for (const o of readdirSync(ROOT)) {
  const dir = join(ROOT, o), cf = join(dir, "credentials.json"), C = J(cf, null); if (!C) continue;
  let n = 0;
  for (const [id, rec] of Object.entries(C)) {
    const out = rec.vc?.credentialSubject?.outcome;
    if (out && out.credential === id) { const was = out.credential; delete out.credential; if (credentialHash(rec.vc) === rec.hash) { fixed.add(id); n++; } else { out.credential = was; mismatch++; } }
  }
  if (n) W(cf, C);
  console.log(`${o}: починено аттестатов ${n}`);
}
for (const o of readdirSync(ROOT)) {
  const dir = join(ROOT, o), ef = join(dir, "experience.json"), B = J(ef, null); if (!B) continue;
  let healed = 0;
  for (const p of Object.values(B.foreign || {})) for (const e of Object.values(p.entries || {})) {
    if (e.status === "bad_evidence" && [...fixed].some((id) => String(e.reason || "").includes(id))) { e.status = "pending"; e.reason = "доказательство починено (0.13), проверка заново"; p.trust.bad_evidence = Math.max(0, (p.trust.bad_evidence || 0) - 1); healed++; }
  }
  if (B.track?.imports) B.track.imports = B.track.imports.filter((x) => !(x.status === "bad_evidence" && [...fixed].some((id) => String(x.reason || "").includes(id))));
  const before = (B.runs || []).length; B.runs = (B.runs || []).filter((r) => r.id !== RUN);
  W(ef, B);
  const sr = join(dir, "sup_run.json"); if (J(sr, {}).id === RUN) rmSync(sr);
  console.log(`${o}: доверие восстановлено по ${healed} записям; прерванный прогон ${RUN} ${before !== B.runs.length ? "убран из книги" : "в книге не найден"}`);
}
if (mismatch) console.log(`внимание: ${mismatch} аттестатов не совпали с отпечатком — оставлены как есть`);
