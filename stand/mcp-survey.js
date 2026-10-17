// Срез по публичным MCP-серверам: что можно измерить объективно, без оценки «безопасно / опасно».
// Список — из открытого реестра MCP (удалённые серверы с адресом streamable-http) или из своего файла (SURVEY_LIST, по адресу в строке).
// Для каждого сервера — одно подключение и один запрос списка инструментов. Инструменты НЕ вызываются.
// Что считается:
//   • доступен ли сервер, просит ли авторизацию;
//   • сколько инструментов, есть ли инструкции сервера;
//   • признаки скрытых инструкций в описаниях (эвристики сканера Xonta: обход инструкций, скрытие от пользователя, ключи и файлы,
//     отправка данных наружу, невидимые символы, влияние на другие инструменты);
//   • есть ли у домена DID-документ (/.well-known/did.json) — может ли сервер доказать, кто он;
//   • отпечаток инструментов: при повторном срезе (SURVEY_PREV) видно, у кого описания сменились без смены версии.
// Итог: REPORT.md — только сводные цифры, без названий; results-*.json — по каждому серверу, для себя (не публикуется).
// Запуск: node stand/mcp-survey.js  (SURVEY_DIR — куда писать, SURVEY_MAX — сколько серверов, SURVEY_CONCURRENCY — сколько сразу)
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { connectMcp, analyzeTools, toolsFingerprint, assertPublicUrl } from "../src/scan.js";

const E = process.env, DIR = E.SURVEY_DIR || "/stand-data/mcp-survey", MAX = Number(E.SURVEY_MAX || 500), CONC = Math.max(1, Number(E.SURVEY_CONCURRENCY || 3));
const PRIV = E.SURVEY_ALLOW_PRIVATE === "1"; // только для проверки самого скрипта на локальном сервере
const TIMEOUT = Number(E.SURVEY_TIMEOUT_MS || 20000), REGISTRY = E.SURVEY_REGISTRY || "https://registry.modelcontextprotocol.io";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: нет ответа за ${ms / 1000} с`)), ms))]);
mkdirSync(DIR, { recursive: true });

// ---------- список серверов ----------
async function fromRegistry() {
  const urls = new Map();
  for (const ver of ["v0.1", "v0"]) {
    let cursor = null, pages = 0;
    try {
      do {
        const r = await withTimeout(fetch(`${REGISTRY}/${ver}/servers?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`), TIMEOUT, "реестр");
        if (!r.ok) throw new Error(`реестр ${ver}: ${r.status}`);
        const j = await r.json();
        for (const it of j.servers || []) {
          const s = it.server || it;
          for (const rm of s.remotes || []) if (rm?.url && /streamable/i.test(rm.type || rm.transport_type || "streamable-http")) urls.set(rm.url, { name: s.name || null, version: s.version || null });
        }
        cursor = j.metadata?.nextCursor || j.metadata?.next_cursor || null; pages++;
      } while (cursor && urls.size < MAX * 2 && pages < 200);
      if (urls.size) { log(`реестр ${ver}: страниц ${pages}, удалённых серверов ${urls.size}`); break; }
    } catch (e) { log(`реестр ${ver}: ${e.message}`); }
  }
  return [...urls].map(([url, m]) => ({ url, ...m }));
}
const list = E.SURVEY_LIST ? readFileSync(E.SURVEY_LIST, "utf8").split("\n").map((x) => x.trim()).filter((x) => (PRIV ? /^https?:\/\//.test(x) : /^https:\/\//.test(x))).map((url) => ({ url, name: null, version: null })) : await fromRegistry();
const targets = list.slice(0, MAX);
if (!targets.length) { log("список серверов пуст — нечего проверять"); process.exit(1); }
log(`проверяю ${targets.length} серверов, по ${CONC} одновременно; инструменты не вызываются, только список`);

// ---------- проверка одного сервера ----------
async function didOf(url) {
  try { const u = new URL(url), r = await withTimeout(fetch(`${u.origin}/.well-known/did.json`, { redirect: "manual" }), 8000, "did"); if (!r.ok) return false; const j = await r.json(); return typeof j?.id === "string" && j.id.startsWith("did:"); } catch { return false; }
}
async function check(t) {
  const row = { url: t.url, name: t.name, version: t.version, checked_at: new Date().toISOString() };
  try { await assertPublicUrl(t.url, { allowPrivate: PRIV }); } catch (e) { return { ...row, status: "skipped", reason: e.message }; }
  let client = null;
  try {
    client = await withTimeout(connectMcp(t.url, { name: "xonta-mcp-survey" }), TIMEOUT, "подключение");
    const { tools } = await withTimeout(client.listTools(), TIMEOUT, "список инструментов");
    const instructions = client.getInstructions?.() || "", info = client.getServerVersion?.() || {};
    const { findings } = analyzeTools(instructions ? [...tools, { name: "(server instructions)", description: instructions }] : tools);
    const rules = [...new Set(findings.filter((f) => f.severity !== "low").map((f) => f.rule))];
    return { ...row, status: "ok", server_version: info.version || null, tools: tools.length, instructions: !!instructions, rules, high: findings.some((f) => f.severity === "high"), external_links: findings.some((f) => f.rule === "url"), fingerprint: toolsFingerprint(tools), did: await didOf(t.url) };
  } catch (e) {
    const m = String(e?.message || e);
    return { ...row, status: /401|403|unauthori|forbidden|auth/i.test(m) ? "auth_required" : "unreachable", reason: m.slice(0, 160), did: await didOf(t.url) };
  } finally { if (client) await client.close().catch(() => {}); }
}
const results = []; let next = 0;
await Promise.all(Array.from({ length: CONC }, async () => { while (next < targets.length) { const t = targets[next++]; results.push(await check(t)); if (results.length % 25 === 0) log(`проверено ${results.length} из ${targets.length}`); } }));

// ---------- повторный срез: описания сменились без смены версии ----------
let changed = null;
if (E.SURVEY_PREV && existsSync(E.SURVEY_PREV)) {
  const prev = new Map(JSON.parse(readFileSync(E.SURVEY_PREV, "utf8")).results.filter((x) => x.status === "ok").map((x) => [x.url, x]));
  const both = results.filter((x) => x.status === "ok" && prev.has(x.url));
  changed = { compared: both.length, changed: both.filter((x) => x.fingerprint !== prev.get(x.url).fingerprint).length, changed_same_version: both.filter((x) => x.fingerprint !== prev.get(x.url).fingerprint && (x.server_version || x.version) === (prev.get(x.url).server_version || prev.get(x.url).version)).length };
}

// ---------- сводка без названий ----------
const day = new Date().toISOString().slice(0, 10), n = results.length, ok = results.filter((x) => x.status === "ok");
const pct = (k, d = n) => (d ? `${Math.round(1000 * k / d) / 10}%` : "—");
const count = (f, l = results) => l.filter(f).length;
const RULE = { override: "просьба игнорировать прежние инструкции", conceal: "просьба скрыть что-то от пользователя", secrets: "упоминание ключей, паролей, системных файлов", exfil: "просьба отправить данные на внешний адрес", hidden_chars: "невидимые или управляющие символы", tag: "служебные метки вроде <important>", preuse: "«перед использованием этого инструмента…»", credentials: "просьба передать ключ или токен в параметрах", shell: "команды оболочки в описании", shadowing: "влияние на поведение другого инструмента" };
const byRule = Object.keys(RULE).map((r) => [r, count((x) => x.rules?.includes(r), ok)]).filter(([, k]) => k > 0).sort((a, b) => b[1] - a[1]);
const toolsSorted = ok.map((x) => x.tools).sort((a, b) => a - b), median = toolsSorted.length ? toolsSorted[Math.floor(toolsSorted.length / 2)] : null;
const L = [
  `# Срез по публичным MCP-серверам — ${day}`,
  ``,
  `Источник списка: ${E.SURVEY_LIST ? "свой список адресов" : `открытый реестр MCP (${REGISTRY})`}, удалённые серверы с транспортом streamable-http. Проверено ${n}.`,
  `К каждому серверу — одно подключение и один запрос списка инструментов; инструменты не вызывались. Названия серверов в сводку не входят.`,
  ``,
  `| Что измерено | Серверов | Доля |`,
  `|---|---|---|`,
  `| Ответили и отдали список инструментов | ${ok.length} | ${pct(ok.length)} |`,
  `| Просят авторизацию до списка инструментов | ${count((x) => x.status === "auth_required")} | ${pct(count((x) => x.status === "auth_required"))} |`,
  `| Недоступны или не ответили за ${TIMEOUT / 1000} с | ${count((x) => x.status === "unreachable")} | ${pct(count((x) => x.status === "unreachable"))} |`,
  `| Могут доказать, кто они (DID-документ на домене) | ${count((x) => x.did)} | ${pct(count((x) => x.did))} |`,
  `| Есть хотя бы один признак скрытых инструкций (из ответивших) | ${count((x) => x.rules?.length, ok)} | ${pct(count((x) => x.rules?.length, ok), ok.length)} |`,
  `| Из них признак высокой важности | ${count((x) => x.high, ok)} | ${pct(count((x) => x.high, ok), ok.length)} |`,
  `| Внешние ссылки в описаниях инструментов | ${count((x) => x.external_links, ok)} | ${pct(count((x) => x.external_links, ok), ok.length)} |`,
  `| Инструкции сервера (общий текст для модели) | ${count((x) => x.instructions, ok)} | ${pct(count((x) => x.instructions, ok), ok.length)} |`,
  ``,
  `Инструментов на сервер: медиана ${median ?? "—"}, максимум ${toolsSorted.at(-1) ?? "—"}.`,
  ``,
  ...(byRule.length ? [`Какие признаки встречались (у скольких ответивших серверов):`, ``, `| Признак | Серверов |`, `|---|---|`, ...byRule.map(([r, k]) => `| ${RULE[r]} | ${k} |`), ``] : [`Признаков скрытых инструкций у ответивших серверов не найдено.`, ``]),
  ...(changed ? [`Повторный срез: сравнено ${changed.compared} серверов, описания инструментов сменились у ${changed.changed}, из них без смены версии — у ${changed.changed_same_version}.`, ``] : []),
  `Как читать: признак — это совпадение с эвристикой сканера, а не доказательство злого умысла. Многие совпадения безобидны (например, инструмент для работы с ключами честно пишет про ключи). «Признаков нет» тоже не означает «безопасно».`,
  ``,
  `Методика и код сканера: src/scan.js, сам срез: stand/mcp-survey.js (Xonta, github.com/mrsergeiluzhnov/xonta).`,
];
writeFileSync(join(DIR, "REPORT.md"), L.join("\n") + "\n");
writeFileSync(join(DIR, `results-${day}.json`), JSON.stringify({ date: day, source: E.SURVEY_LIST || REGISTRY, results }, null, 1));
log(`готово: ${join(DIR, "REPORT.md")} (сводка без названий), ${join(DIR, `results-${day}.json`)} (по серверам — для себя)`);
process.exit(0);
