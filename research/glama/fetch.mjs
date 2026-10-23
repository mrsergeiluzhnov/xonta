// Выгрузка каталога Glama через их API (https://glama.ai/mcp/reference). Нужен ключ: GLAMA_API_KEY в окружении.
// Серверы — списком, инструменты приходят сразу в списке. Удалённые серверы (коннекторы) — списком, потом карточка каждого
// (в ней инструменты с пометками издателя). Запросы по одному с паузой, задолго до лимита Glama (100 в секунду).
// Данные Glama лицензированы: показывая их, ссылаемся на Glama и на карточку каждого упомянутого сервера.
//   GLAMA_API_KEY=... node fetch.mjs [out_dir]    GLAMA_MAX_SERVERS (по умолчанию 400), GLAMA_MAX_CONNECTORS (300)
import { writeFileSync, mkdirSync } from "node:fs";

const KEY = process.env.GLAMA_API_KEY, OUT = process.argv[2] || "./data", BASE = "https://glama.ai/api/mcp";
const MAX_S = Number(process.env.GLAMA_MAX_SERVERS || 400), MAX_C = Number(process.env.GLAMA_MAX_CONNECTORS || 300), PAUSE = 150;
if (!KEY) { console.error("нужен GLAMA_API_KEY (создаётся в https://glama.ai/settings/api-keys)"); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(BASE + path, { headers: { authorization: `Bearer ${KEY}`, accept: "application/json" } });
    if (r.status === 429) { await wait(1000 * (Number(r.headers.get("ratelimit-reset")) || 2)); continue; }
    if (r.status === 403) throw Error("Glama ответил 403: проверьте ключ; повторять подряд нельзя — бан не снимается сам");
    if (!r.ok) throw Error(`Glama ${path}: HTTP ${r.status}`);
    return r.json();
  }
  throw Error(`Glama ${path}: лимит не отпускает`);
}
// keep — какие записи из списка брать (у удалённых — без устаревших и с инструментами)
const seen = {};
async function pages(path, key, max, keep = () => true, extra = "") {
  const out = []; let after = null, pagesLeft = Number(process.env.GLAMA_MAX_PAGES || 80);
  seen[key] = seen[key] || { scanned: 0, kept: 0 };
  while (out.length < max && pagesLeft-- > 0) {
    const j = await get(`${path}?first=100${extra}${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    // ответ по документации: { [key]: [...], pageInfo }; на случай другой обёртки — data или edges[].node
    const items = j[key] || j.data || (j.edges || []).map((e) => e.node).filter(Boolean);
    if (!Array.isArray(items)) throw Error(`Glama ${path}: неожиданный ответ, поля ${Object.keys(j).join(", ")}`);
    if (!out.length && !items.length) console.error(`Glama ${path}: пустая первая страница, поля ответа ${Object.keys(j).join(", ")}`);
    seen[key].scanned += items.length; const ok = items.filter(keep); seen[key].kept += ok.length;
    out.push(...ok); const pi = j.pageInfo || j.page_info || {}; if (!pi.hasNextPage) break; after = pi.endCursor; await wait(PAUSE);
  }
  return out.slice(0, max);
}
// Серверы, которые ставят у себя. В списке /v1/servers tools пустой, а по умолчанию список идёт от самых новых, у которых
// Glama ещё не разобрал инструменты (проверено 23.10: 300 карточек подряд без инструментов). Поэтому кандидаты — поиск
// по ходовым темам (там серверы постарше), карточки открываются по одной. Если после GLAMA_PROBE карточек (150) инструментов
// нет ни у одного, эта часть пропускается и прогон идёт по удалённым серверам — у них инструменты и пометки издателя есть.
const QUERIES = (process.env.GLAMA_QUERIES || "github,database,postgres,filesystem,browser,slack,notion,search,docker,kubernetes,email,calendar,jira,aws,google drive,stripe,memory,git").split(",").map((q) => q.trim()).filter(Boolean);
const candMap = new Map();
for (const q of QUERIES) { for (const s of await pages("/v1/servers", "servers", 100, () => true, `&query=${encodeURIComponent(q)}&sort=search-relevance%3Adesc`)) candMap.set(s.id || `${s.namespace}/${s.slug}`, s); await wait(PAUSE); }
const cand = [...candMap.values()];
const servers = [], MAX_D = Number(process.env.GLAMA_MAX_DETAILS || 1500), PROBE = Number(process.env.GLAMA_PROBE || 150);
seen.server_cards = { candidates: cand.length, opened: 0, with_tools: 0, failed: 0, list_had_tools: cand.filter((s) => Array.isArray(s.tools) && s.tools.length).length, skipped: false };
for (const s of cand) {
  if (servers.length >= MAX_S || seen.server_cards.opened >= MAX_D) break;
  if (seen.server_cards.opened >= PROBE && !servers.length) { seen.server_cards.skipped = true; console.log(`у ${PROBE} карточек серверов нет инструментов — эту часть пропускаю, дальше только удалённые серверы`); break; }
  if (Array.isArray(s.tools) && s.tools.length) { servers.push(s); seen.server_cards.with_tools++; continue; }
  try { const d = await get(`/v1/servers/${s.namespace}/${s.slug}`); seen.server_cards.opened++; const full = { ...s, ...(Array.isArray(d.tools) ? d : d.server || d) }; if (Array.isArray(full.tools) && full.tools.length) { servers.push(full); seen.server_cards.with_tools++; } }
  catch (e) { seen.server_cards.failed++; if (seen.server_cards.failed <= 5) console.error(`${s.namespace}/${s.slug}: ${e.message}`); if (seen.server_cards.failed >= 10 && !servers.length) { seen.server_cards.skipped = true; console.error("карточки серверов не открываются — эту часть пропускаю"); break; } }
  if (seen.server_cards.opened % 100 === 0 && seen.server_cards.opened) console.log(`карточек открыто ${seen.server_cards.opened}, с инструментами ${seen.server_cards.with_tools}`);
  await wait(PAUSE);
}
console.log(`кандидатов из поиска ${cand.length}, карточек открыто ${seen.server_cards.opened}, серверов с инструментами ${servers.length}, инструментов ${servers.reduce((s, x) => s + x.tools.length, 0)}`);
const list = await pages("/v1/connectors", "connectors", MAX_C, (c) => !c.deprecatedAt && (c.toolCount ?? 1) > 0), connectors = [];
console.log(`удалённых серверов в списке ${list.length}, открываю карточки`);
for (const c of list) { if (connectors.length && connectors.length % 50 === 0) console.log(`  карточек удалённых ${connectors.length}/${list.length}, инструментов ${connectors.reduce((s, x) => s + (x.tools || []).length, 0)}`); try { const d = await get(`/v1/connectors/${c.namespace}/${c.slug}`); connectors.push({ ...c, ...(Array.isArray(d.tools) ? d : d.connector || d) }); /* в карточке есть и вложенный server, берём верхний уровень, где tools */ } catch (e) { console.error(`${c.namespace}/${c.slug}: ${e.message}`); } await wait(PAUSE); }
if (!servers.length && !connectors.length) throw Error("ни у серверов, ни у удалённых серверов нет инструментов — прогон ничего не измерит");
console.log(`удалённых серверов ${connectors.length}, инструментов ${connectors.reduce((s, x) => s + (x.tools || []).length, 0)}, с пометками издателя ${connectors.reduce((s, x) => s + (x.tools || []).filter((t) => t.annotations && (t.annotations.readOnlyHint != null || t.annotations.destructiveHint != null)).length, 0)}`);
writeFileSync(`${OUT}/catalog.json`, JSON.stringify({ fetched: new Date().toISOString(), source: "https://glama.ai (MCP Directory API)", scanned: seen, servers, connectors }));
console.log(`сохранено в ${OUT}/catalog.json`);
