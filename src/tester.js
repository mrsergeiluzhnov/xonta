// Агент-тестер: сам участник со своим DID и ключом. Ходит к целевому агенту только через шлюз A2O2A,
// подписывает запросы, помечает задачи (x-task-id, x-task-category) и считает результат по категориям.
import { randomBytes } from "node:crypto";
import { connectMcp } from "./scan.js";
import { signingFetch } from "./callerauth.js";
import { jcs, sha256hex } from "./crypto.js";

// Детерминированный генератор случайных чисел: набор можно воспроизвести по seed, но заранее он не известен агенту
export function seeded(seed) {
  let s = parseInt(sha256hex(String(seed)).slice(0, 8), 16) || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

export async function runSuite({ gatewayUrl, tester, suite, generate, tasks: n = 30, seed = randomBytes(8).toString("hex") }) {
  seed = String(seed).slice(0, 64);
  const tasks = generate(seeded(seed), n);
  const perCat = {};
  const latencies = [];
  const failures = [];
  for (const [i, task] of tasks.entries()) {
    const taskId = `t-${seed.slice(0, 6)}-${i}`;
    // каждый запрос подписывается заново (тело входит в подпись); метки задачи передаются заголовками
    const fetch = signingFetch({ did: tester.did, privateKey: tester.privateKey, extraHeaders: { "x-task-id": taskId, "x-task-category": encodeURIComponent(task.category) } });
    const client = await connectMcp(gatewayUrl, { name: "xonta-tester", fetch });
    let ok = true;
    try {
      for (const step of task.steps) {
        const t0 = Date.now();
        let parsed = null, passed = false, err = null;
        try {
          const out = await client.callTool({ name: step.tool, arguments: step.args });
          latencies.push(Date.now() - t0);
          if (out.isError) err = (out.content?.[0]?.text || "ошибка").slice(0, 120);
          else { parsed = JSON.parse(out.content?.[0]?.text || "null"); passed = !!step.check(parsed); }
        } catch (e) { err = e.message; }
        if (!passed) { ok = false; failures.push({ task: taskId, category: task.category, tool: step.tool, expect: step.expect, error: err }); }
      }
    } finally { await client.close().catch(() => {}); }
    const c = (perCat[task.category] ||= { passed: 0, total: 0 });
    c.total++; if (ok) c.passed++;
  }
  const categories = Object.entries(perCat).map(([category, c]) => ({ category, passed: c.passed, total: c.total, score: Math.round((100 * c.passed) / c.total) }));
  const passed = categories.reduce((s, c) => s + c.passed, 0), total = categories.reduce((s, c) => s + c.total, 0);
  const casesHash = sha256hex(jcs(tasks.map((t) => ({ category: t.category, steps: t.steps.map((s) => ({ tool: s.tool, args: s.args, expect: s.expect })) }))));
  return {
    categories,
    overall: Math.round((100 * passed) / total),
    latency_ms: { p50: pct(latencies, 50), p95: pct(latencies, 95) },
    evaluation: { data: "synthetic", suite: suite.id, version: suite.version, seed, cases: total, hash: casesHash },
    failures: failures.slice(0, 20),
  };
}
