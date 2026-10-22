// Эксперимент «передача опыта между агентами» на поиске телефона головного офиса (0.19).
//   node run.mjs setup      зарегистрировать агентов A и B в оркестраторе (ключ администратора из XONTA_ADMIN_TOKEN)
//   node run.mjs explore    агент A на обучающей части: обычный ход и каждая стратегия из меню; удачные — в рецепты
//   node run.mjs transfer   агент B на проверочной части: просит рецепт у живого оркестратора, задача идёт в обеих группах
//   node run.mjs report     отчёт по эталону SEC EDGAR, на русском и английском
// Окружение: XONTA_URL, AGENT_A_URL, AGENT_B_URL (MCP), DATA (папка с truth.json и companies.json), CONCURRENCY.
// Эталон читает только этот прогонщик, агенты его не видят. Засчитывается ответ, совпавший с телефоном из EDGAR.
// Меню стратегий составили люди. Оркестратор их не придумывает: он проверяет, какие помогают, и передаёт другому агенту.
import { readFileSync, writeFileSync, appendFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const E = process.env, DATA = E.DATA || './data', X = (E.XONTA_URL || 'http://127.0.0.1:4041').replace(/\/$/, ''), CONC = Number(E.CONCURRENCY || 3);
const DOMAIN = 'contact_search', CATEGORY = 'us_public';
mkdirSync(DATA, { recursive: true });
const secretsFile = `${DATA}/secrets.json`;
const secrets = () => JSON.parse(readFileSync(secretsFile, 'utf8'));
const truth = () => JSON.parse(readFileSync(`${DATA}/truth.json`, 'utf8'));
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

export const MENU = [
  { stage: 'pages', technique: 'locale:en-us', payload: { action: 'prefer_locale', locale: 'en-US', paths: ['/us/en/', '/en-us/', '/en/', '/us/'] }, applicability: ['the site served a local, non-English version'] },
  { stage: 'pages', technique: 'pages:investor-and-offices', payload: { action: 'try_paths', paths: ['/investors', '/investor-relations', '/about/investors', '/about/headquarters', '/company/locations', '/about/locations', '/locations', '/contact/headquarters'], subdomains: ['investors', 'investor', 'ir'] }, applicability: ['the contact page has no headquarters number'] },
  { stage: 'context', technique: 'labels:hq-wide', payload: { action: 'hq_labels', accept: ['headquarters', 'global hq', 'world headquarters', 'corporate headquarters', 'corporate address', 'head office', 'corporate office', 'main office', 'principal executive offices', 'switchboard', 'main number', 'main phone'], reject: ['regional', 'branch', 'country'], window: 180 }, applicability: ['a number was found but the headquarters label was not next to it'] },
];

const digitsOf = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length === 11 && d.startsWith('1') ? d.slice(1) : d; };
export const correct = (ans, t) => !!ans && (ans === t || (ans.length >= 9 && t.length >= 9 && (ans.endsWith(t.slice(-9)) || t.endsWith(ans.slice(-9)))));

async function api(method, path, body, tok) {
  const r = await fetch(X + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Error(`${method} ${path} ${r.status}: ${j.error || ''}`); return j;
}
async function callAgent(url, args) {
  const c = new Client({ name: 'contact-runner', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  try { const r = await c.callTool({ name: 'find_public_company_phone', arguments: args }, undefined, { timeout: 180000 }); return JSON.parse(r.content?.[0]?.text || '{}'); }
  finally { await c.close().catch(() => {}); }
}
async function pool(items, fn) { let i = 0; await Promise.all(Array.from({ length: CONC }, async () => { while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch (e) { log(`error ${items[k].ticker}: ${e.message}`); } } })); }
const score = (res, row) => ({ verified_by_agent: !!res.verified, correct: !!res.verified && correct(res.digits, row.truth_digits), wrong_accept: !!res.verified && !correct(res.digits, row.truth_digits), truth_among_candidates: (res.all_candidate_digits || []).some((d) => correct(d, row.truth_digits)), stage: res.stage_reached, reason: res.rejection_reason, tokens: res.tokens || 0, ms: res.elapsed_ms || 0, applied: !!res.applied, matched: !!res.matched, effects: res.effects || [] });

async function setup() {
  if (existsSync(secretsFile)) { log('already set up (data/secrets.json exists)'); return; }
  const admin = E.XONTA_ADMIN_TOKEN; if (!admin) throw Error('XONTA_ADMIN_TOKEN is not set');
  const out = {};
  for (const [k, url, name] of [['A', E.AGENT_A_URL, 'contact agent A (explores)'], ['B', E.AGENT_B_URL, 'contact agent B (receives recipes)']]) {
    const r = await api('POST', '/v1/agents', { name, mcp_url: url, owner: { name: 'Xonta research' } }, admin);
    out[k] = { id: r.id, owner_token: r.owner_token, url }; log(`agent ${k} registered as ${r.id}`);
  }
  writeFileSync(secretsFile, JSON.stringify(out, null, 1)); chmodSync(secretsFile, 0o600);
}

async function explore() {
  const T = truth(), s = secrets(), rows = T.rows.filter((r) => r.part === 'train'), file = `${DATA}/explore.jsonl`;
  const done = new Set(existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const o = JSON.parse(l); return `${o.ticker}|${o.technique}`; }) : []);
  const jobs = rows.flatMap((r) => [null, ...MENU].map((m) => ({ ...r, m }))).filter((j) => !done.has(`${j.ticker}|${j.m?.technique || 'baseline'}`));
  log(`explore: ${rows.length} train companies × ${MENU.length + 1} = ${jobs.length} runs left`);
  await pool(jobs, async (j) => {
    const res = await callAgent(s.A.url, { company: j.company, site: j.site, ...(j.m ? { strategy: j.m.payload } : {}), phase: 'explore' });
    const sc = score(res, j); appendFileSync(file, JSON.stringify({ ticker: j.ticker, technique: j.m?.technique || 'baseline', ...sc }) + '\n');
    log(`A ${j.ticker.padEnd(6)} ${(j.m?.technique || 'baseline').padEnd(28)} ${sc.correct ? 'correct' : sc.wrong_accept ? 'WRONG' : sc.reason}`);
  });
  // какие стратегии превратили неудачу обычного хода в верный ответ, и не испортили верные
  const R = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)), base = new Map(R.filter((x) => x.technique === 'baseline').map((x) => [x.ticker, x]));
  const summary = [];
  for (const m of MENU) {
    const xs = R.filter((x) => x.technique === m.technique && base.has(x.ticker));
    const wins = xs.filter((x) => x.correct && !base.get(x.ticker).correct).length, losses = xs.filter((x) => !x.correct && base.get(x.ticker).correct).length;
    const row = { technique: m.technique, stage: m.stage, n: xs.length, wins, losses, proposed: wins >= Number(E.MIN_WINS || 3) && wins > losses };
    if (row.proposed) { const r = await api('POST', `/v1/agents/${s.A.id}/recipes`, { domain: DOMAIN, category: CATEGORY, stage: m.stage, technique: m.technique, payload: m.payload, applicability: [...m.applicability, `on agent A's training set: ${wins} failures turned correct, ${losses} correct turned wrong, of ${xs.length}`], safeguards: ['public corporate contacts only', 'no bot protection bypass, respect robots.txt', 'choose only numbers present on the page'] }, s.A.owner_token); row.recipe_id = r.id; row.status = r.status; }
    summary.push(row); log(`strategy ${m.technique}: wins ${wins}, losses ${losses} of ${xs.length}${row.proposed ? ` → proposed as ${row.recipe_id} (${row.status})` : ' → not proposed'}`);
  }
  writeFileSync(`${DATA}/explore-summary.json`, JSON.stringify({ at: new Date().toISOString(), summary }, null, 1));
}

async function transfer() {
  const T = truth(), s = secrets(), rows = T.rows.filter((r) => r.part === 'holdout'), file = `${DATA}/transfer.jsonl`;
  const done = new Set(existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).ticker) : []);
  const todo = rows.filter((r) => !done.has(r.ticker)); log(`transfer: ${todo.length} of ${rows.length} holdout companies left`);
  await pool(todo, async (row) => {
    const q = await api('POST', `/v1/agents/${s.B.id}/recipes/request`, { domain: DOMAIN, category: CATEGORY, task_id: row.ticker, paired: true }, s.B.owner_token);
    const ctl = await callAgent(s.B.url, { company: row.company, site: row.site, phase: 'control' }), c = score(ctl, row);
    let t = null, rec = null;
    if (q.recipe) { const res = await callAgent(s.B.url, { company: row.company, site: row.site, strategy: q.recipe.payload, phase: 'recipe' }); t = score(res, row); }
    const report = q.arm === 'both'
      ? { recipe: { accepted: true, applied: t.applied, matched: t.matched, success: t.verified_by_agent, independent: { verified: t.correct, checker: 'sec_edgar' }, tokens: t.tokens, elapsed_ms: t.ms }, control: { success: c.verified_by_agent, independent: { verified: c.correct, checker: 'sec_edgar' }, tokens: c.tokens, elapsed_ms: c.ms } }
      : { success: c.verified_by_agent, independent: { verified: c.correct, checker: 'sec_edgar' }, tokens: c.tokens, elapsed_ms: c.ms };
    const o = await api('POST', `/v1/recipes/requests/${q.request_id}/outcome`, report, s.B.owner_token); rec = o.recipe || null;
    appendFileSync(file, JSON.stringify({ ticker: row.ticker, request_id: q.request_id, arm: q.arm, recipe_id: q.recipe?.id || null, technique: q.recipe?.technique || null, recipe_status_before: q.recipe?.status || null, control: c, recipe: t, recipe_after: rec }) + '\n');
    log(`B ${row.ticker.padEnd(6)} ${String(q.recipe?.technique || 'no recipe').padEnd(28)} control ${c.correct ? 'correct' : c.reason}${t ? ` | recipe ${t.correct ? 'correct' : t.wrong_accept ? 'WRONG' : t.reason}` : ''}${rec ? ` → ${rec.status}` : ''}`);
  });
}

async function report() {
  const T = truth(), s = existsSync(secretsFile) ? secrets() : null;
  const rd = (f) => (existsSync(`${DATA}/${f}`) ? readFileSync(`${DATA}/${f}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const ex = rd('explore.jsonl'), tr = rd('transfer.jsonl');
  const funnel = (xs) => { const n = xs.length, c = (f) => xs.filter(f).length; return { n, blocked: c((x) => x.reason === 'blocked'), no_pages: c((x) => x.reason === 'no_pages'), no_candidates: c((x) => x.reason === 'no_phone_candidates'), truth_among_candidates: c((x) => x.truth_among_candidates), rejected_after_choice: c((x) => x.stage === 'context'), accepted: c((x) => x.verified_by_agent), correct: c((x) => x.correct), wrong_accept: c((x) => x.wrong_accept), tokens: xs.reduce((a, x) => a + (x.tokens || 0), 0) }; };
  const base = ex.filter((x) => x.technique === 'baseline'), ctl = tr.map((x) => x.control), withR = tr.filter((x) => x.recipe);
  const recipes = s ? await api('GET', `/v1/recipes?domain=${DOMAIN}`) : [];
  const per = {}; for (const x of withR) { const p = (per[x.technique] ||= { pairs: 0, both: 0, neither: 0, recipe_only: 0, control_only: 0, applied: 0, matched: 0, tok_r: 0, tok_c: 0 }); p.pairs++; const a = x.recipe.correct, b = x.control.correct; if (a && b) p.both++; else if (!a && !b) p.neither++; else if (a) p.recipe_only++; else p.control_only++; if (x.recipe.applied) p.applied++; if (x.recipe.matched) p.matched++; p.tok_r += x.recipe.tokens; p.tok_c += x.control.tokens; }
  const ctlAll = funnel(ctl), recAll = funnel(withR.map((x) => x.recipe)), ctlPaired = funnel(withR.map((x) => x.control));
  const out = { at: new Date().toISOString(), list_sha256: T.list_sha256, companies: T.rows.length, train: T.rows.filter((r) => r.part === 'train').length, holdout: T.rows.filter((r) => r.part === 'holdout').length, explore_baseline: funnel(base), explore_summary: existsSync(`${DATA}/explore-summary.json`) ? JSON.parse(readFileSync(`${DATA}/explore-summary.json`, 'utf8')).summary : [], transfer_control: ctlAll, transfer_paired_control: ctlPaired, transfer_paired_recipe: recAll, per_recipe: per, recipes: recipes.map((r) => ({ id: r.id, technique: r.technique, version: r.version, status: r.status, why: r.status_why, test: r.test, issued: r.issued, evaluation_vc: r.evaluation_vc })) };
  writeFileSync(`${DATA}/report.json`, JSON.stringify(out, null, 1));
  const f = (x) => `${x.n} | ${x.blocked} | ${x.no_pages} | ${x.no_candidates} | ${x.truth_among_candidates} | ${x.accepted} | ${x.correct} | ${x.wrong_accept}`;
  const ru = [`# Передача опыта между агентами: поиск телефона головного офиса`, '', `Эталон SEC EDGAR, ${out.companies} компаний: обучающая часть ${out.train} (агент A), проверочная ${out.holdout} (агент B). Отпечаток списка ${out.list_sha256.slice(0, 16)}.`, '',
    '| Выборка | задач | закрыто | нет страниц | нет номеров | верный номер среди кандидатов | принято агентом | верно по эталону | принято, но неверно |', '|---|---|---|---|---|---|---|---|---|',
    `| A, обычный ход, обучающая | ${f(out.explore_baseline)} |`, `| B, контроль, проверочная | ${f(ctlAll)} |`, `| B, с рецептом, те же задачи | ${f(recAll)} |`, `| B, контроль на тех же задачах | ${f(ctlPaired)} |`, '',
    '## Стратегии агента A', '', ...out.explore_summary.map((x) => `- ${x.technique} (${x.stage}): исправила ${x.wins}, испортила ${x.losses} из ${x.n}${x.proposed ? `, предложена как рецепт ${x.recipe_id}` : ', не предложена'}`), '',
    '## Рецепты у агента B, пары на одних задачах', '', '| Рецепт | пар | лучше с рецептом | лучше без | оба верно | оба нет | применён | сработал | статус в оркестраторе |', '|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(per).map(([k, p]) => { const r = out.recipes.find((y) => y.technique === k); return `| ${k} | ${p.pairs} | ${p.recipe_only} | ${p.control_only} | ${p.both} | ${p.neither} | ${p.applied} | ${p.matched} | ${r ? `${r.status}: ${r.why}` : '-'} |`; })];
  const en = [`# Experience transfer between agents: finding a head office phone`, '', `Ground truth from SEC EDGAR, ${out.companies} companies: training ${out.train} (agent A), holdout ${out.holdout} (agent B). List fingerprint ${out.list_sha256.slice(0, 16)}.`, '',
    '| Sample | tasks | blocked | no pages | no numbers | right number among candidates | accepted by agent | correct per EDGAR | accepted but wrong |', '|---|---|---|---|---|---|---|---|---|',
    `| A, plain run, training | ${f(out.explore_baseline)} |`, `| B, control, holdout | ${f(ctlAll)} |`, `| B, with recipe, same tasks | ${f(recAll)} |`, `| B, control on the same tasks | ${f(ctlPaired)} |`, '',
    '## Agent A strategies', '', ...out.explore_summary.map((x) => `- ${x.technique} (${x.stage}): fixed ${x.wins}, broke ${x.losses} of ${x.n}${x.proposed ? `, proposed as recipe ${x.recipe_id}` : ', not proposed'}`), '',
    '## Recipes at agent B, pairs on the same tasks', '', '| Recipe | pairs | better with | better without | both right | both wrong | applied | matched | status at the orchestrator |', '|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(per).map(([k, p]) => { const r = out.recipes.find((y) => y.technique === k); return `| ${k} | ${p.pairs} | ${p.recipe_only} | ${p.control_only} | ${p.both} | ${p.neither} | ${p.applied} | ${p.matched} | ${r ? `${r.status}: ${r.why}` : '-'} |`; })];
  writeFileSync(`${DATA}/REPORT.md`, ru.join('\n') + '\n'); writeFileSync(`${DATA}/REPORT.en.md`, en.join('\n') + '\n');
  console.log(ru.join('\n'));
}

async function smoke() {
  const T = truth(), row = T.rows.find((r) => r.ticker === (E.SMOKE || 'ADBE')) || T.rows[0];
  for (const [k, url] of [['A', E.AGENT_A_URL], ['B', E.AGENT_B_URL]]) {
    const res = await callAgent(url, { company: row.company, site: row.site, phase: 'smoke' }), sc = score(res, row);
    log(`${k} ${row.company}: ${sc.correct ? 'CORRECT' : sc.wrong_accept ? 'accepted but WRONG' : sc.reason}, pages ${(res.pages || []).length}, candidates ${res.candidates_n ?? 0}, tokens ${sc.tokens}, ${Math.round(sc.ms / 1000)} s${res.model_error ? `, model error ${res.model_error}` : ''}${(res.errors || []).length ? `; errors ${res.errors.slice(0, 3).map((e) => `${e.url} ${e.error}`).join('; ')}` : ''}${res.candidate_phone ? `; chose ${res.candidate_phone} as "${res.classification}", truth ${row.truth_phone}` : ''}`);
  }
}

const cmd = process.argv[2];
if (cmd === 'smoke') await smoke(); else if (cmd === 'setup') await setup(); else if (cmd === 'explore') await explore(); else if (cmd === 'transfer') await transfer(); else if (cmd === 'report') await report();
else if (cmd === 'all') { await setup(); await explore(); await transfer(); await report(); }
else if (cmd) { console.log('usage: node run.mjs smoke|setup|explore|transfer|report|all'); process.exit(1); }
