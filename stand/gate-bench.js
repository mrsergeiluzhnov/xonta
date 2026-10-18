// Сколько стоит Xonta Gate: задержка на вызов и размер журнала.
// Один и тот же тестовый MCP-сервер (test/fixtures/fake-mcp.js) вызывается напрямую и через шлюз,
// по N вызовов read_note, сравниваются медиана и 95-й процентиль. Потом считается размер журнала на 1000 вызовов.
// Запуск: node stand/gate-bench.js [N]   (по умолчанию 1000)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const N = Number(process.argv[2] || 1000), WARM = 50;
const root = fileURLToPath(new URL("..", import.meta.url));
const fake = join(root, "test/fixtures/fake-mcp.js"), gate = join(root, "bin/xonta-gate.js");
const dir = mkdtempSync(join(tmpdir(), "xonta-gate-bench-"));
const policy = join(dir, "policy.json");
writeFileSync(policy, JSON.stringify({ rate_per_minute: 1e9, actions_per_period: 1e9 }));

async function measure(command, args) {
  const c = new Client({ name: "bench", version: "0" });
  await c.connect(new StdioClientTransport({ command, args, stderr: "ignore" }));
  await c.listTools();
  for (let i = 0; i < WARM; i++) await c.callTool({ name: "read_note", arguments: { id: String(i) } });
  const t = [];
  for (let i = 0; i < N; i++) {
    const s = process.hrtime.bigint();
    await c.callTool({ name: "read_note", arguments: { id: String(i) } });
    t.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  await c.close();
  t.sort((a, b) => a - b);
  return { median: t[Math.floor(N / 2)], p95: t[Math.floor(N * 0.95)], mean: t.reduce((a, b) => a + b, 0) / N };
}

const direct = await measure(process.execPath, [fake]);
const gated = await measure(process.execPath, [gate, "--dir", dir, "--policy", policy, "--", process.execPath, fake]);
const bytes = statSync(join(dir, "audit.jsonl")).size, calls = N + WARM;
const f = (x) => x.toFixed(2);
console.log(`calls measured: ${N} (after ${WARM} warm-up), node ${process.version}`);
console.log(`direct  median ${f(direct.median)} ms, p95 ${f(direct.p95)} ms`);
console.log(`gate    median ${f(gated.median)} ms, p95 ${f(gated.p95)} ms`);
console.log(`added   median ${f(gated.median - direct.median)} ms, p95 ${f(gated.p95 - direct.p95)} ms`);
console.log(`audit log: ${(bytes / calls * 1000 / 1024).toFixed(0)} KB per 1000 calls (${(bytes / calls).toFixed(0)} bytes per entry)`);
rmSync(dir, { recursive: true, force: true });
