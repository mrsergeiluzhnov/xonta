// Ложные срабатывания Xonta Gate на официальных MCP-серверах.
// Каждый сервер запускается локально из npm, у него только спрашивается список инструментов.
// Инструменты не вызываются, к чужим сайтам и API ничего не уходит (токены — заглушки, нужны только чтобы сервер стартовал).
// Для каждого инструмента: что решил шлюз (read / action / BLOCK) и какие были предупреждения.
// Запуск: node stand/gate-survey.js > gate-survey.json
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicy } from "../src/gate.js";

const sandbox = mkdtempSync(join(tmpdir(), "gate-survey-"));
const DUMMY = "dummy-not-a-real-token";
export const SERVERS = [
  { pkg: "@modelcontextprotocol/server-filesystem", args: [sandbox] },
  { pkg: "@modelcontextprotocol/server-memory" },
  { pkg: "@modelcontextprotocol/server-everything", args: ["stdio"] },
  { pkg: "@modelcontextprotocol/server-sequential-thinking" },
  { pkg: "@modelcontextprotocol/server-github", env: { GITHUB_PERSONAL_ACCESS_TOKEN: DUMMY } },
  { pkg: "@modelcontextprotocol/server-gitlab", env: { GITLAB_PERSONAL_ACCESS_TOKEN: DUMMY } },
  { pkg: "@modelcontextprotocol/server-slack", env: { SLACK_BOT_TOKEN: DUMMY, SLACK_TEAM_ID: "T000" } },
  { pkg: "@modelcontextprotocol/server-puppeteer" },
  { pkg: "@modelcontextprotocol/server-brave-search", env: { BRAVE_API_KEY: DUMMY } },
  { pkg: "@modelcontextprotocol/server-google-maps", env: { GOOGLE_MAPS_API_KEY: DUMMY } },
  { pkg: "@modelcontextprotocol/server-postgres", args: ["postgresql://localhost:1/none"] },
  { pkg: "@modelcontextprotocol/server-redis", args: ["redis://localhost:1"] },
  { pkg: "@modelcontextprotocol/server-everart", env: { EVERART_API_KEY: DUMMY } },
  { pkg: "@modelcontextprotocol/server-aws-kb-retrieval", env: { AWS_ACCESS_KEY_ID: DUMMY, AWS_SECRET_ACCESS_KEY: DUMMY, AWS_REGION: "us-east-1" } },
];

async function survey({ pkg, args = [], env = {} }) {
  const c = new Client({ name: "gate-survey", version: "0" });
  try {
    await c.connect(new StdioClientTransport({ command: "npx", args: ["-y", pkg, ...args], env: { ...process.env, ...env }, stderr: "ignore" }), { timeout: 180000 });
    const { tools } = await c.listTools(undefined, { timeout: 60000 });
    const pol = createPolicy({}), r = pol.setTools(tools);
    return {
      pkg, tools: tools.map((t) => {
        const h = r.hidden.find((x) => x.tool === t.name);
        return { name: t.name, decision: h ? "BLOCK" : pol.isAction(t.name) ? "action" : "read", why: h?.why, warnings: r.findings.filter((f) => f.tool === t.name).map((f) => `${f.rule}:${f.severity}`), description: (t.description || "").slice(0, 300) };
      }),
    };
  } catch (e) { return { pkg, error: String(e?.message || e).slice(0, 200) }; }
  finally { try { await c.close(); } catch {} }
}

const out = [];
for (const s of SERVERS) { const r = await survey(s); process.stderr.write(`${s.pkg}: ${r.error ? "ERROR " + r.error : r.tools.length + " tools"}\n`); out.push(r); }
process.stdout.write(JSON.stringify(out, null, 1));
process.exit(0);
