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
async function pages(path, key, max, keep = () => true) {
  const out = []; let after = null, pagesLeft = Number(process.env.GLAMA_MAX_PAGES || 80);
  seen[key] = { scanned: 0, kept: 0 };
  while (out.length < max && pagesLeft-- > 0) {
    const j = await get(`${path}?first=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    // ответ по документации: { [key]: [...], pageInfo }; на случай другой обёртки — data или edges[].node
    const items = j[key] || j.data || (j.edges || []).map((e) => e.node).filter(Boolean);
    if (!Array.isArray(items)) throw Error(`Glama ${path}: неожиданный ответ, поля ${Object.keys(j).join(", ")}`);
    if (!out.length && !items.length) console.error(`Glama ${path}: пустая первая страница, поля ответа ${Object.keys(j).join(", ")}`);
    seen[key].scanned += items.length; const ok = items.filter(keep); seen[key].kept += ok.length;
    out.push(...ok); const pi = j.pageInfo || j.page_info || {}; if (!pi.hasNextPage) break; after = pi.endCursor; await wait(PAUSE);
  }
  return out.slice(0, max);
}
// В списке /v1/servers поле tools приходит пустым (проверено на настоящем API 23.10): инструменты — в карточке сервера.
// Берём список кандидатов, открываем карточки по одной, пока не наберём MAX_S серверов с инструментами
// (не больше GLAMA_MAX_DETAILS карточек). Сколько карточек открыто и у скольких инструменты есть — в каталоге и отчёте.
const cand = await pages("/v1/servers", "servers", Math.max(MAX_S * 3, 300));
const listHadTools = cand.filter((s) => Array.isArray(s.tools) && s.tools.length).length;
const servers = [], MAX_D = Number(process.env.GLAMA_MAX_DETAILS || 1500); seen.server_cards = { opened: 0, with_tools: 0, failed: 0, list_had_tools: listHadTools };
for (const s of cand) {
  if (servers.length >= MAX_S || seen.server_cards.opened >= MAX_D) break;
  if (Array.isArray(s.tools) && s.tools.length) { servers.push(s); seen.server_cards.with_tools++; continue; }
  try { const d = await get(`/v1/servers/${s.namespace}/${s.slug}`); seen.server_cards.opened++; const full = { ...s, ...(Array.isArray(d.tools) ? d : d.server || d) }; if (Array.isArray(full.tools) && full.tools.length) { servers.push(full); seen.server_cards.with_tools++; } }
  catch (e) { seen.server_cards.failed++; if (seen.server_cards.failed <= 5) console.error(`${s.namespace}/${s.slug}: ${e.message}`); if (seen.server_cards.failed >= 10 && !servers.length) throw Error("карточки серверов не открываются, остановлено"); }
  if (seen.server_cards.opened % 100 === 0 && seen.server_cards.opened) console.log(`карточек открыто ${seen.server_cards.opened}, с инструментами ${seen.server_cards.with_tools}`);
  await wait(PAUSE);
}
if (!servers.length) throw Error(`ни у одного из ${seen.server_cards.opened} открытых серверов нет инструментов в карточке — прогон ничего не измерит`);
console.log(`серверов в списке ${cand.length} (с инструментами прямо в списке ${listHadTools}), карточек открыто ${seen.server_cards.opened}, взято серверов с инструментами ${servers.length}, инструментов ${servers.reduce((s, x) => s + x.tools.length, 0)}`);
const list = await pages("/v1/connectors", "connectors", MAX_C, (c) => !c.deprecatedAt && (c.toolCount ?? 1) > 0), connectors = [];
for (const c of list) { try { const d = await get(`/v1/connectors/${c.namespace}/${c.slug}`); connectors.push({ ...c, ...(Array.isArray(d.tools) ? d : d.connector || d) }); /* в карточке есть и вложенный server, берём верхний уровень, где tools */ } catch (e) { console.error(`${c.namespace}/${c.slug}: ${e.message}`); } await wait(PAUSE); }
console.log(`удалённых серверов ${connectors.length}, инструментов ${connectors.reduce((s, x) => s + (x.tools || []).length, 0)}, с пометками издателя ${connectors.reduce((s, x) => s + (x.tools || []).filter((t) => t.annotations && (t.annotations.readOnlyHint != null || t.annotations.destructiveHint != null)).length, 0)}`);
writeFileSync(`${OUT}/catalog.json`, JSON.stringify({ fetched: new Date().toISOString(), source: "https://glama.ai (MCP Directory API)", scanned: seen, servers, connectors }));
console.log(`сохранено в ${OUT}/catalog.json`);
