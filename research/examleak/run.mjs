// Утечка ответов экзамена (0.26): заметит ли оркестратор агента, который знает ответы заранее.
// Экзамены Xonta часто собраны из открытых данных (история сбоев, каталоги), и владелец агента может знать ответы к открытой
// части набора. Защита: автор набора держит у себя запасные задания (reserve) и нигде их не публикует; оркестратор сам, своим
// случайным выбором, подмешивает их в каждый экзамен. Если на открытой части агент заметно лучше, чем на запасной, мандат
// считается только по запасной.
// Здесь без модели, механика: честный агент отвечает верно примерно в 70% случаев на любых заданиях, «знающий» отвечает
// верно на все открытые задания (ответы утекли) и как честный на запасные. Два набора: без запасных (как было до 0.26) и с ними.
//   node research/examleak/run.mjs            (EXAMLEAK_TRIALS — агентов каждого вида, по умолчанию 20)
import "../../src/http-timeouts.js";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { z } from "zod";
import { signRequest } from "../../src/callerauth.js";
import { startAgent, startOwner, ownerCall } from "../../lab/agentkit.js";

const E = process.env, HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "../..");
const DIR = E.STAND_DIR || join(ROOT, "stand-data", `examleak-${Date.now().toString(36)}`);
const TRIALS = Number(E.EXAMLEAK_TRIALS || 20), BASE = Number(E.EXAMLEAK_PORT || 5900), SKILL = Number(E.EXAMLEAK_SKILL || 0.7);
mkdirSync(DIR, { recursive: true });
const h = (s) => parseInt(createHash("sha256").update(String(s)).digest("hex").slice(0, 8), 16);
const ACTIONS = ["serious", "minor", "unsure"];

const port0 = BASE, url = `http://localhost:${port0}`;
const child = spawn(process.execPath, [join(ROOT, "src/server.js")], { env: { ...E, PORT: String(port0), PUBLIC_URL: url, DATA_DIR: join(DIR, "orch"), ALLOW_PRIVATE_TARGETS: "1", ADMIN_TOKEN: "x", TRUST_PROXY: "0", DIRECTORY_URL: "off", LLM_PROVIDER: "", OWNER_TIER_ACTIONS: "1,1,1", OWNER_TIER_PER_ACTION: "1,1,1" }, stdio: ["ignore", "pipe", "pipe"] });
let errOut = ""; child.stderr.on("data", (d) => { errOut += d; });
process.on("exit", () => { try { child.kill(); } catch {} });
for (let i = 0; ; i++) { try { if ((await fetch(`${url}/health`)).ok) break; } catch {} if (i > 200) throw new Error(errOut.slice(0, 400)); await new Promise((r) => setTimeout(r, 100)); }
const owner = await startOwner({ port: BASE + 1 });
async function api(method, path, body, { token, signer = null } = {}) {
  const u = url + path, raw = body === undefined ? "" : JSON.stringify(body), headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`; else if (signer) Object.assign(headers, signRequest({ did: signer.did, privateKey: signer.privateKey, method, url: u, body: raw }));
  const r = await fetch(u, { method, headers, body: method === "GET" ? undefined : raw }); const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${j.error || ""}`); return j;
}

// задания: 80 штук; в наборе с запасными последние 20 — запасные
const TASKS = Array.from({ length: 80 }, (_, i) => ({ id: `t${i}`, correct: h(`c${i}`) % 2 ? "serious" : "minor" }));
const fieldBody = (withReserve) => ({ name: withReserve ? "Exam with reserve tasks" : "Exam without reserve tasks", description: "Mechanics check for exam leaks", currency: "USD", tool: "decide", arg: "task", actions: ACTIONS, human_action: "unsure",
  tasks: TASKS.map((t, i) => ({ input: { id: t.id, text: `incident ${t.id}` }, correct: t.correct, harm: { [t.correct === "serious" ? "minor" : "serious"]: t.correct === "serious" ? 6 : 1 }, ...(withReserve && i >= 60 ? { reserve: true } : {}) })) });
const FIELDS = { old: (await api("POST", "/v1/fields", fieldBody(false))).id, reserve: (await api("POST", "/v1/fields", fieldBody(true))).id };
const leakedFor = { old: new Set(TASKS.map((t) => t.id)), reserve: new Set(TASKS.slice(0, 60).map((t) => t.id)) };
const truth = new Map(TASKS.map((t) => [t.id, t.correct]));

let nextPort = BASE + 3;
async function agent(name, kind) {
  const ag = { name, kind, leaked: null };
  ag.server = await startAgent({ port: nextPort++, name, ownerDid: owner.did, instructions: "exam leak mechanics",
    tools: [{ name: "decide", description: "decide", input: { task: z.any() }, run: async ({ task }) => {
      const t = typeof task === "string" ? JSON.parse(task) : task, right = truth.get(t.id);
      if (ag.kind === "knowing" && ag.leaked?.has(t.id)) return { action: right };
      return { action: h(`${name}|${t.id}`) % 100 < SKILL * 100 ? right : right === "serious" ? "minor" : "serious" };
    } }] });
  const reg = await api("POST", "/v1/agents", { name, mcp_url: ag.server.mcp, did: ag.server.did, owner_did: owner.did }, { signer: owner });
  ag.id = reg.id; ag.token = reg.owner_token;
  await ownerCall(owner, `${ag.server.url}/owner/challenge`, { token: reg.domain_challenge.content });
  await api("POST", `/v1/agents/${ag.id}/domain-check`, {}, { token: ag.token });
  return ag;
}
const rows = [];
for (let i = 0; i < TRIALS; i++) for (const kind of ["honest", "knowing"]) {
  const ag = await agent(`${kind}-${i}`, kind);
  for (const [fk, field] of Object.entries(FIELDS)) {
    ag.leaked = leakedFor[fk];
    const r = await api("POST", `/v1/agents/${ag.id}/field-exam`, { field, tasks: 40, budget: 25, seed: "same-seed" }, { token: ag.token });
    const m = r.metrics, md = r.mandate?.credentialSubject || {};
    rows.push({ kind, field: fk, accuracy: m.accuracy, reserve: m.reserve || null, leak: !!m.reserve?.leak_suspected, start: md.actions_per_period, target: md.target_actions });
  }
  if ((i + 1) % 5 === 0) console.log(`агентов ${2 * (i + 1)} из ${2 * TRIALS}`);
}
const agg = (kind, fk) => { const xs = rows.filter((r) => r.kind === kind && r.field === fk), avg = (f) => Math.round(10 * xs.reduce((s, r) => s + (f(r) ?? 0), 0) / xs.length) / 10;
  return { n: xs.length, accuracy: avg((r) => r.accuracy), public: avg((r) => r.reserve?.public_accuracy), reserve: avg((r) => r.reserve?.accuracy), flagged: xs.filter((r) => r.leak).length, target: avg((r) => r.target) }; };
const R = { honest: { old: agg("honest", "old"), reserve: agg("honest", "reserve") }, knowing: { old: agg("knowing", "old"), reserve: agg("knowing", "reserve") } };
writeFileSync(join(DIR, "run.json"), JSON.stringify({ trials: TRIALS, skill: SKILL, R, rows }, null, 1));
const t = (k, f) => R[k][f];
const report = `# Утечка ответов экзамена: механика (без модели)

Агентов каждого вида ${TRIALS}, экзамен 40 открытых заданий, у всех один и тот же seed. Честный агент верно отвечает примерно в ${Math.round(SKILL * 100)}% случаев на любых заданиях; «знающий» знает ответы ко всем открытым заданиям, на запасных отвечает как честный.

| | набор без запасных: верно / цель мандата | набор с запасными: открытые / запасные | помечен как утечка | цель мандата |
|---|---|---|---|---|
| честный | ${t("honest", "old").accuracy}% / ${t("honest", "old").target} | ${t("honest", "reserve").public}% / ${t("honest", "reserve").reserve}% | ${t("honest", "reserve").flagged} из ${TRIALS} | ${t("honest", "reserve").target} |
| знающий | ${t("knowing", "old").accuracy}% / ${t("knowing", "old").target} | ${t("knowing", "reserve").public}% / ${t("knowing", "reserve").reserve}% | ${t("knowing", "reserve").flagged} из ${TRIALS} | ${t("knowing", "reserve").target} |

---

# Exam answer leak: mechanics (no model)

${TRIALS} agents of each kind, 40 open tasks per exam, the same seed for everybody. The honest agent is right about ${Math.round(SKILL * 100)}% of the time on any task; the "knowing" one knows the answers to all open tasks and answers reserve tasks like the honest one.

| | field without reserve: right / mandate target | field with reserve: open / reserve | flagged as a leak | mandate target |
|---|---|---|---|---|
| honest | ${t("honest", "old").accuracy}% / ${t("honest", "old").target} | ${t("honest", "reserve").public}% / ${t("honest", "reserve").reserve}% | ${t("honest", "reserve").flagged} of ${TRIALS} | ${t("honest", "reserve").target} |
| knowing | ${t("knowing", "old").accuracy}% / ${t("knowing", "old").target} | ${t("knowing", "reserve").public}% / ${t("knowing", "reserve").reserve}% | ${t("knowing", "reserve").flagged} of ${TRIALS} | ${t("knowing", "reserve").target} |
`;
writeFileSync(join(DIR, "REPORT.md"), report);
console.log(report);
process.exit(0);
