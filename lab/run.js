// Лабораторный эксперимент: как растёт агент с паспортом, сколько обратной связи получает,
// как рождаются, проверяются и подписываются его потомки и как их улучшения возвращаются к нему.
//
// Две ветви на одних и тех же данных (одинаковые seed):
//   A — корень + потомки по сигналу оркестратора, слияние предложений раз в MERGE_EVERY раундов;
//   B — контроль: тот же корень один, сигналы владелец не принимает.
// Каждый агент за раунд усваивает не больше FEEDBACK_BUDGET исправлений — так моделируется ограниченная
// «ёмкость» одного агента. Это допущение модели, а не свойство мира; оно вынесено в параметры и в отчёт.
//
// Запуск: node lab/run.js  (параметры — переменные окружения ниже)
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as L from "../skills/xonta-normalize.js";
import { seeded } from "../src/tester.js";
import { connectMcp } from "../src/scan.js";
import { signRequest, signingFetch } from "../src/callerauth.js";
import { startOwner, ownerCall, sign } from "./agentkit.js";
import { startLearner } from "./learner.js";
import { startGenerator } from "./generator.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const E = process.env;
const P = {
  rounds: Number(E.ROUNDS || 10),
  traffic: Number(E.TRAFFIC || 300),
  budget: Number(E.FEEDBACK_BUDGET || 25),
  merge_every: Number(E.MERGE_EVERY || 2),
  poison_round: Number(E.POISON_ROUND ?? 6),
  bench: Number(E.BENCH || 800),
  seed: E.SEED || "xonta-lab-1",
  weights: { units: 0.35, dates: 0.3, phones: 0.2, money: 0.15 },
  noise: 0.02,
  mandate: { max_children: 3, max_depth: 1, categories: L.CATEGORIES },
};
const ADMIN = "lab-admin-token";
const OUT = join(HERE, "out");
const log = (...a) => console.log(...a);

// ---------- инфраструктура ----------
async function startOrchestrator(port) {
  const dataDir = mkdtempSync(join(tmpdir(), "xonta-lab-"));
  const child = spawn(process.execPath, [join(ROOT, "src/server.js")], {
    env: { ...E, PORT: String(port), PUBLIC_URL: `http://localhost:${port}`, DATA_DIR: dataDir, ALLOW_PRIVATE_TARGETS: "1", AUTO_ANCHOR: "0", SIGNAL_COOLDOWN_MIN: "0", ADMIN_TOKEN: ADMIN, TRUST_PROXY: "0", HELDOUT_SEED: `${P.seed}-heldout` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errOut = "";
  child.stderr.on("data", (d) => { errOut += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${port}/health`)).ok) return { url: `http://localhost:${port}`, child, dataDir, stop: () => { child.kill(); rmSync(dataDir, { recursive: true, force: true }); } }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("оркестратор не запустился: " + errOut);
}

function makeApi(base) {
  return async function api(method, path, body, { token, signer } = {}) {
    const url = base + path, raw = body === undefined ? "" : JSON.stringify(body);
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (signer) Object.assign(headers, signRequest({ did: signer.did, privateKey: signer.privateKey, method, url, body: raw }));
    const r = await fetch(url, { method, headers, body: method === "GET" ? undefined : raw });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, body: j };
  };
}
const must = (res, what) => { if (!res.ok) throw new Error(`${what}: ${res.status} ${res.body?.error || JSON.stringify(res.body).slice(0, 200)}`); return res.body; };

async function mcp(url, tool, args, { signer, headers = {} } = {}) {
  const fetch = signer ? signingFetch({ did: signer.did, privateKey: signer.privateKey, extraHeaders: headers }) : undefined;
  const c = await connectMcp(url, { name: "xonta-lab", fetch, headers });
  try {
    const out = await c.callTool({ name: tool, arguments: args });
    const text = (out.content || []).map((x) => x.text || "").join("");
    if (out.isError) throw new Error(`${tool}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally { await c.close().catch(() => {}); }
}

// Порча обратной связи систематической ошибкой партнёра по данным (согласованная, поэтому «выучивается»)
const POISON = {
  dates: { pattern: "date-us-slash", ok: (t) => Number(t.expected.slice(8)) <= 12 && t.expected.slice(5, 7) !== t.expected.slice(8), bad: (t) => { const [y, m, d] = t.expected.split("-"); return `${y}-${d}-${m}`; } },
  units: { pattern: "unit-metric", ok: (t) => / cm$/.test(t.input.text), bad: (t) => t.expected.replace(/^([\d.]+)/, (x) => String(Number((Number(x) * 10).toFixed(3)))) },
  phones: { pattern: "phone-GB", ok: () => true, bad: (t) => t.expected.replace(/^\+44/, "+45") },
  money: { pattern: "money-eur", ok: () => true, bad: (t) => t.expected.replace(/ EUR$/, " USD") },
};

// ---------- одна ветвь эксперимента ----------
async function runArm(arm, basePort) {
  const withChildren = arm === "A";
  log(`\n=== Ветвь ${arm}: ${withChildren ? "корень + потомки" : "контроль, без потомков"} ===`);
  const orch = await startOrchestrator(basePort);
  const api = makeApi(orch.url);
  const closers = [orch.stop];
  const R = { arm, params: P, rounds: [], agents: {}, children: [], proposals: [], merges: [], signals: [], checks: [], poison: null };
  try {
    // участники: владелец корня, владелец генератора (другой человек/организация), клиент-потребитель
    const ownerR = await startOwner({ port: basePort + 1 }); closers.push(ownerR.close);
    const ownerG = await startOwner({ port: basePort + 2 }); closers.push(ownerG.close);
    const client = await startOwner({ port: basePort + 3 }); closers.push(client.close);
    const gen = await startGenerator({ port: basePort + 4, ownerDid: ownerG.did, noise: P.noise }); closers.push(gen.close);
    const root = await startLearner({ port: basePort + 10, name: "lab-root", ownerDid: ownerR.did }); closers.push(root.close);

    async function onboard(agent, owner, name, extra = {}) {
      const reg = must(await api("POST", "/v1/agents", { name, mcp_url: agent.mcp, did: agent.did, owner_did: owner.did, ...extra }, { signer: owner }), `регистрация ${name}`);
      await ownerCall(owner, `${agent.url}/owner/challenge`, { token: reg.domain_challenge.content });
      must(await api("POST", `/v1/agents/${reg.id}/domain-check`, {}, { signer: owner }), `домен ${name}`);
      const scan = must(await api("POST", `/v1/agents/${reg.id}/scan`, {}, { signer: owner }), `проверка ${name}`);
      return { ...reg, scan: scan.report.result };
    }
    const G = await onboard(gen, ownerG, "lab-generator");
    const Rr = await onboard(root, ownerR, "lab-root");
    must(await api("POST", `/v1/admin/agents/${Rr.id}/owner-verified`, { kind: "company", note: "лабораторный владелец" }, { token: ADMIN }), "проверка владельца");
    R.agents.generator = { id: G.id, did: gen.did, scan: G.scan };
    R.agents.root = { id: Rr.id, did: root.did, scan: Rr.scan };
    log(`генератор ${G.id} (${G.scan}), корень ${Rr.id} (${Rr.scan})`);

    // мандат владельца: сколько потомков, какой глубины и в каких категориях может родить корень
    const mandate = sign(ownerR, "AgentMandate", { id: root.did, ...P.mandate, auto_apply: false, note: "потомки только по сигналу оркестратора и решению владельца" });
    const kids = []; // { rec, agent, category, born }
    const learners = () => [{ id: Rr.id, agent: root, category: null }, ...kids.map((k) => ({ id: k.reg.id, agent: k.agent, category: k.category }))];
    const route = (cat) => kids.find((k) => k.category === cat && k.active) || null;

    async function spawnChild(category, round, signalId) {
      if (signalId) must(await api("POST", `/v1/signals/${signalId}`, { action: "accept" }, { token: Rr.owner_token }), "решение по сигналу");
      const port = basePort + 11 + kids.length;
      const agent = await startLearner({ port, name: `lab-${category}`, ownerDid: ownerR.did, specialization: category, skills: root.state.skills, parentDid: root.did, parentVersion: root.state.version });
      closers.push(agent.close);
      const { lineage } = await ownerCall(ownerR, `${root.url}/owner/sign-lineage`, { child_did: agent.did, mandate, scope: { category }, depth: 1 });
      const reg = must(await api("POST", `/v1/agents/${Rr.id}/children`, { name: `lab-${category}`, mcp_url: agent.mcp, did: agent.did, mandate, lineage, specialization: category }, { signer: ownerR }), `потомок ${category}`);
      await ownerCall(ownerR, `${agent.url}/owner/challenge`, { token: reg.domain_challenge.content });
      must(await api("POST", `/v1/agents/${reg.id}/domain-check`, {}, { signer: ownerR }), "домен потомка");
      const scan = must(await api("POST", `/v1/agents/${reg.id}/scan`, {}, { signer: ownerR }), "проверка потомка");
      const k = { reg, agent, category, born: round, active: true };
      kids.push(k);
      R.children.push({ id: reg.id, did: agent.did, category, born_round: round, signal: signalId || null, scan: scan.report.result, lineage_credential: reg.lineage.id, parent_signature: lineage.id, mandate: mandate.id });
      log(`  ↳ потомок ${reg.id} «${category}» рождён в раунде ${round}: мандат ✓, родословная ✓, домен ✓, проверка MCP: ${scan.report.result}`);
      return k;
    }

    // ---------- раунды ----------
    for (let r = 0; r < P.rounds; r++) {
      const row = { round: r, agents: {} };
      const stat = (id) => (row.agents[id] ||= { traffic: 0, traffic_correct: 0, feedback_available: 0, feedback_sent: 0, rules_learned: 0 });
      const learnedBefore = Object.fromEntries(learners().map((x) => [x.id, x.agent.state.rulesLearned]));

      // 1) трафик: клиент берёт задачи у генератора через шлюз и отправляет агентам через шлюз (подписанно, с меткой категории)
      const { tasks } = await mcp(`${orch.url}/gw/${G.id}/mcp`, "generate_tasks", { round: r, n: P.traffic, seed: `${P.seed}-traffic-${r}` }, { signer: client });
      // генератор отдаёт задачи равномерно по категориям — веса трафика задаёт клиент выборкой
      const rnd = seeded(`${P.seed}-mix-${r}`);
      const picked = tasks.filter((t) => rnd() < P.weights[t.category] * 4 * 0.75);
      const groups = new Map();
      for (const t of picked) { const target = (withChildren && route(t.category)) || null; const id = target ? target.reg.id : Rr.id; (groups.get(id) || groups.set(id, []).get(id)).push(t); }
      const wrong = new Map();
      for (const [id, list] of groups) {
        for (const cat of L.CATEGORIES) {
          const part = list.filter((t) => t.category === cat);
          for (let i = 0; i < part.length; i += 20) {
            const chunk = part.slice(i, i + 20);
            const res = await mcp(`${orch.url}/gw/${id}/mcp`, "solve", { tasks: chunk.map(({ id, category, input }) => ({ id, category, input })) }, { signer: client, headers: { "x-task-id": `r${r}-${id}-${cat}-${i}`, "x-task-category": cat } });
            const out = new Map(res.answers.map((a) => [a.id, a.output]));
            for (const t of chunk) {
              const s = stat(id); s.traffic++;
              if (out.get(t.id) === t.expected) s.traffic_correct++; else (wrong.get(id) || wrong.set(id, []).get(id)).push(t);
            }
          }
        }
      }
      // 2) обратная связь: исправления неверных ответов, не больше FEEDBACK_BUDGET на агента за раунд
      for (const [id, list] of wrong) {
        const s = stat(id); s.feedback_available = list.length;
        const fb = list.slice(0, P.budget).map(({ category, input, expected }) => ({ category, input, expected }));
        if (fb.length) { await mcp(`${orch.url}/gw/${id}/mcp`, "learn", { feedback: fb }, { signer: client }); s.feedback_sent = fb.length; }
      }
      // 2а) испорченная партия обратной связи (систематическая ошибка партнёра) — один раз, одному потомку
      if (withChildren && r === P.poison_round && kids.length) {
        const k = kids[0], pz = POISON[k.category];
        const pool = (await mcp(`${orch.url}/gw/${G.id}/mcp`, "generate_tasks", { round: r, n: 1500, seed: `${P.seed}-poison`, only_category: k.category, clean: true }, { signer: client })).tasks;
        const bad = pool.filter((t) => t.pattern === pz.pattern && pz.ok(t)).slice(0, 40).map((t) => ({ category: t.category, input: t.input, expected: pz.bad(t) }));
        await mcp(`${orch.url}/gw/${k.reg.id}/mcp`, "learn", { feedback: bad }, { signer: client });
        R.poison = { round: r, agent: k.reg.id, category: k.category, pattern: pz.pattern, items: bad.length };
        log(`  ⚠ раунд ${r}: потомку ${k.reg.id} отправлено ${bad.length} систематически неверных исправлений (${pz.pattern})`);
      }
      for (const x of learners()) stat(x.id).rules_learned = x.agent.state.rulesLearned - (learnedBefore[x.id] ?? 0);

      // 3) предложения потомков и слияние у корня (раз в MERGE_EVERY раундов)
      if (withChildren && kids.length && (r + 1) % P.merge_every === 0) {
        let submitted = 0;
        for (const k of kids.filter((k) => k.active)) {
          const { proposal } = await mcp(k.agent.mcp, "propose", {}); // владелец обращается к своему агенту напрямую
          if (!proposal) continue;
          const res = await api("POST", "/v1/proposals", { proposal });
          R.proposals.push({ round: r, from: k.reg.id, category: k.category, id: proposal.id, rules: Object.values(proposal.credentialSubject.rules).reduce((n, x) => n + Object.keys(x).length, 0), accepted_for_review: res.ok, error: res.ok ? undefined : res.body.error });
          if (res.ok) submitted++;
        }
        if (submitted) {
          const m = must(await api("POST", `/v1/agents/${Rr.id}/merge`, { generator: G.id, round: r }, { signer: ownerR }), "слияние");
          const { merged_skills, ...rec } = m;
          R.merges.push(rec);
          log(`  ⇄ слияние ${m.id}: ${m.status}, корень ${m.before.overall}% → ${m.after.overall}% (+${m.gain_pp} п.п.), принято ${m.accepted.length}, отклонено ${m.rejected.length}${m.conflicts.length ? `, конфликтов ${m.conflicts.length}` : ""}`);
          for (const x of m.rejected) log(`     ✗ ${x.from}/${x.category}: ${x.reason}`);
          for (const x of [...m.accepted, ...m.rejected]) for (const v of x.rules.filter((v) => v.verdict === "ухудшает")) log(`     ✗ правило ${v.category}/${v.signature} от ${x.from}: исправляет ${v.fixed}, портит ${v.broken}`);
          if (m.status === "recommended") {
            // решение владельца: применить у корня и перевести потомков на новую базу
            await ownerCall(ownerR, `${root.url}/owner/apply`, { skills: merged_skills, source: m.id });
            for (const k of kids.filter((k) => k.active)) await ownerCall(ownerR, `${k.agent.url}/owner/rebase`, { skills: root.state.skills, parent_version: root.state.version });
          }
        }
      }

      // 4) аттестованная оценка на отложенной выборке генератора + сигналы
      for (const x of learners()) {
        const ev = must(await api("POST", `/v1/agents/${x.id}/evaluate`, { generator: G.id, round: r }, { signer: ownerR }), `оценка ${x.id}`);
        Object.assign(stat(x.id), { eval_overall: ev.overall, eval_categories: Object.fromEntries(ev.categories.map((c) => [c.category, c.score])), skills_version: ev.skills.version, evaluation_credential: ev.credential.id, merges_applied: ev.merges_applied });
        for (const s of ev.signals) {
          R.signals.push({ round: r, agent: x.id, id: s.id, type: s.type, evidence: s.evidence, decision: null });
          if (s.type === "spawn_specialist" && x.id === Rr.id) {
            const can = withChildren && kids.filter((k) => k.active).length < P.mandate.max_children && !route(s.evidence.category);
            R.signals.at(-1).decision = can ? "accepted" : withChildren ? "skipped" : "ignored (контроль)";
            if (can) await spawnChild(s.evidence.category, r, s.id);
          }
        }
      }

      // 5) общий эталонный замер (одинаковый для обеих ветвей): корень сам по себе и «система» с маршрутизацией к потомкам
      const bench = L.generateTasks(seeded(`${P.seed}-bench-${r}`), { n: P.bench, round: r, weights: P.weights, noise: 0 });
      const rootAcc = L.accuracy(root.state.skills, bench);
      const sysOk = bench.filter((t) => { const k = withChildren && route(t.category); return L.solve((k ? k.agent : root).state.skills, t) === t.expected; }).length;
      row.bench = { root: +(100 * rootAcc.overall).toFixed(1), system: +(100 * sysOk / bench.length).toFixed(1), root_categories: Object.fromEntries(Object.entries(rootAcc.categories).map(([c, v]) => [c, +(100 * v).toFixed(1)])) };
      R.rounds.push(row);
      log(`раунд ${r}: эталон корень ${row.bench.root}%, система ${row.bench.system}% | ` + Object.entries(row.agents).map(([id, s]) => `${id}: трафик ${s.traffic}, верно ${s.traffic_correct}, исправлений ${s.feedback_sent}/${s.feedback_available}, правил +${s.rules_learned}, оценка ${s.eval_overall}%`).join(" | "));
    }

    // ---------- проверки на злоупотребления (ветвь A) ----------
    if (withChildren && kids.length) {
      const k = kids[0];
      const check = async (name, fn, expect) => { const res = await fn(); R.checks.push({ name, status: res.status, passed: res.status === expect, error: res.body?.error }); log(`  проверка «${name}»: ${res.status} ${res.status === expect ? "✓" : "✗"} ${res.body?.error || ""}`); };
      const { proposal } = await mcp(k.agent.mcp, "propose", {});
      const base = proposal || sign(k.agent, "ImprovementProposal", { id: root.did, from: k.agent.did, base_version: 0, skill_language: L.LANGUAGE, category: k.category, rules: { [k.category]: { x: {} } } }, { validDays: 7 });
      const tampered = structuredClone(base); tampered.credentialSubject.rules = { [k.category]: { "tampered-sig": { order: ["d", "m", "y"] } } };
      await check("подделанное предложение (правила изменены после подписи)", () => api("POST", "/v1/proposals", { proposal: tampered }), 400);
      const other = L.CATEGORIES.find((c) => c !== k.category);
      await check("предложение вне области потомка", () => api("POST", "/v1/proposals", { proposal: sign(k.agent, "ImprovementProposal", { id: root.did, from: k.agent.did, base_version: 0, skill_language: L.LANGUAGE, category: other, rules: { [other]: { "x": { cc: "0", strip: "" } } } }, { validDays: 7 }) }), 403);
      const stranger = await startOwner({ port: basePort + 20 }); closers.push(stranger.close);
      await check("предложение от незарегистрированного агента", () => api("POST", "/v1/proposals", { proposal: sign(stranger, "ImprovementProposal", { id: root.did, skill_language: L.LANGUAGE, rules: { dates: {} } }, { validDays: 7 }) }), 403);
      const fakeMandate = sign(stranger, "AgentMandate", { id: root.did, max_children: 10, max_depth: 5, categories: L.CATEGORIES });
      await check("потомок по мандату, подписанному не владельцем", () => api("POST", `/v1/agents/${Rr.id}/children`, { name: "x", mcp_url: `http://localhost:${basePort + 21}/mcp`, did: `did:web:localhost%3A${basePort + 21}`, mandate: fakeMandate, lineage: {}, specialization: "dates" }, { signer: ownerR }), 400);
      await check("регистрация потомка не владельцем", () => api("POST", `/v1/agents/${Rr.id}/children`, { name: "x", mcp_url: `http://localhost:${basePort + 21}/mcp`, did: `did:web:localhost%3A${basePort + 21}`, mandate, lineage: {}, specialization: "dates" }, { signer: stranger }), 403);
      if (kids.length >= P.mandate.max_children) {
        await check("потомок сверх лимита мандата", () => api("POST", `/v1/agents/${Rr.id}/children`, { name: "x", mcp_url: `http://localhost:${basePort + 21}/mcp`, did: `did:web:localhost%3A${basePort + 21}`, mandate, lineage: {}, specialization: "dates" }, { signer: ownerR }), 403);
      }
    }

    // ---------- итог: паспорта, проверка, фиксация ----------
    const verify = async (x) => must(await api("POST", "/v1/verify", { agent: x }), "verify");
    R.final = { verify: {}, passports: {} };
    for (const x of learners()) {
      const v = await verify(x.agent.did);
      R.final.verify[x.id] = { level: v.level, lineage: v.lineage, owner_inherited_from: v.owner_inherited_from, contributions: v.contributions, missing: v.missing_for_next_level, profile: v.profile };
      const p = must(await api("GET", `/v1/agents/${x.id}/passport`), "паспорт");
      const byType = {};
      for (const c of p.credentials) { const t = [].concat(c.type).at(-1); const b = (byType[t] ||= { issued: 0, revoked: 0, suspended: 0 }); b.issued++; if (c._status.revocation) b.revoked++; if (c._status.suspension) b.suspended++; }
      R.final.passports[x.id] = byType;
    }
    R.final.lineage = must(await api("GET", `/v1/agents/${Rr.id}/lineage`), "родословная").tree;
    R.final.proposals = must(await api("GET", `/v1/agents/${Rr.id}/proposals`), "предложения");
    R.final.generator_passport = must(await api("GET", `/v1/agents/${G.id}/passport`), "паспорт генератора").credentials.map((c) => [].concat(c.type).at(-1));
    const anchor = must(await api("POST", "/v1/admin/anchor", {}, { token: ADMIN }), "фиксация");
    R.final.anchor = { root: anchor.root, events: anchor.count, chained_to: anchor.prev_root, methods: anchor.method?.map((m) => ({ type: m.type, ok: !!m.proof, error: m.error })) };
    const contribution = R.merges.flatMap((m) => m.contributions)[0];
    if (contribution) R.final.inclusion_example = must(await api("GET", `/v1/credentials/${encodeURIComponent(contribution.credential)}/inclusion`), "доказательство вхождения");

    // каскад: отзыв корня приостанавливает потомков (не отзывает молча) — уровень потомков падает до 0
    if (withChildren && kids.length) {
      const st = must(await api("POST", `/v1/agents/${Rr.id}/status`, { status: "revoked", reason: "лаборатория: проверка каскада" }, { signer: ownerR }), "отзыв");
      const after = await verify(kids[0].agent.did);
      R.final.cascade = { revoked: Rr.id, descendants_suspended: st.descendants_suspended, child_level_after: after.level, child_status_after: after.status };
      log(`каскад: отзыв ${Rr.id} → приостановлены ${st.descendants_suspended.join(", ")}; уровень потомка теперь ${after.level}`);
    }
    R.final.learners = learners().map((x) => ({ id: x.id, category: x.category, version: x.agent.state.version, feedback_items: x.agent.state.feedbackItems, rules_learned: x.agent.state.rulesLearned, history: x.agent.state.history }));
    return R;
  } finally {
    for (const c of closers.reverse()) try { c(); } catch {}
  }
}

const PB = Number(E.PORT_BASE || 4400);
const A = await runArm("A", PB);
const B = await runArm("B", PB + 100);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, E.OUT_NAME || "report.json"), JSON.stringify({ generated: new Date().toISOString(), params: P, A, B }, null, 1));
log(`\nготово: ${join(OUT, E.OUT_NAME || "report.json")}`);
const failed = (A.checks || []).filter((c) => !c.passed);
if (failed.length) { console.error("не прошли проверки:", failed.map((c) => c.name).join("; ")); process.exit(1); }
process.exit(0);
