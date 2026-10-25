// Выгрузка каталога allagents для исследования «можно ли верить карточке» — с письменного согласия allagents (25.10.2026).
// Условия: только публичное API, медленно (один запрос в несколько секунд), один проход, User-Agent с названием Xonta;
// в публикации только сводные цифры со ссылкой на https://allagents.app; результаты по агентам не публикуются;
// черновик отчёта сначала отправляется allagents; агентам из каталога никаких сообщений.
//
// Шаг 1: список (/agents?format=json по страницам) — в нём уже есть отметки каталога (reach, badges, liveness).
// Шаг 2: полные карточки (/agent/<slug>?format=json) — только для выборки, поровну по эталону, ALLAGENTS_SAMPLE (1200).
// Повторный запуск продолжает с места остановки и не запрашивает уже полученное.
//   node research/cards/allagents-fetch.mjs /root/allagents-data
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const DIR = process.argv[2] || "./allagents-data", BASE = "https://allagents.app";
const PAUSE = Math.max(2000, Number(process.env.ALLAGENTS_PAUSE_MS || 3000)), SAMPLE = Number(process.env.ALLAGENTS_SAMPLE || 1200);
const UA = "XontaResearch/0.25 (+https://github.com/mrsergeiluzhnov/xonta; study agreed with allagents)";
mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(BASE + path, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { const wait = Number(r.headers.get("retry-after") || 60) * 1000; console.log(`429, ждём ${wait / 1000} с`); await sleep(wait); continue; }
      if (!r.ok) return { error: `HTTP ${r.status}` };
      return { json: await r.json() };
    } catch (e) { if (i === 2) return { error: e.message }; await sleep(PAUSE * 2); }
  }
  return { error: "не удалось" };
}

// шаг 1: список
const listFile = join(DIR, "list.json"), list = existsSync(listFile) ? JSON.parse(readFileSync(listFile, "utf8")) : { pages: 0, total: null, agents: [] };
if (!list.done) {
  for (let page = list.pages; ; page++) {
    const r = await get(`/agents?format=json&page=${page}&limit=25`);
    if (r.error) { console.log(`страница ${page}: ${r.error}, останавливаюсь — повторный запуск продолжит`); writeFileSync(listFile, JSON.stringify(list)); process.exit(1); }
    const items = r.json.agents || []; list.total = r.json.total ?? list.total; list.agents.push(...items); list.pages = page + 1;
    if (page % 20 === 0) { console.log(`список: страница ${page}, карточек ${list.agents.length} из ${list.total}`); writeFileSync(listFile, JSON.stringify(list)); }
    if (!items.length || !r.json.next) { list.done = true; break; }
    await sleep(PAUSE);
  }
  writeFileSync(listFile, JSON.stringify(list));
}
const seen = new Set(), agents = list.agents.filter((a) => a.slug && !seen.has(a.slug) && seen.add(a.slug));
const badge = (a, kind) => (a.reach?.badges || []).some((b) => b.kind === kind && b.state === "verified");
const answers = (a) => a.reach?.answers === true || a.liveness?.answers === true;
const n = (f) => agents.filter(f).length;
console.log(`список готов: ${agents.length} карточек; дверь отвечает ${n(answers)}, keeper ✓ ${n((a) => badge(a, "owner"))}, A2A ✓ ${n((a) => badge(a, "a2a"))}, MCP ✓ ${n((a) => badge(a, "mcp"))}, x402 ✓ ${n((a) => badge(a, "x402"))}`);

// шаг 2: выборка для полных карточек — поровну «отвечает / нет», внутри — все с keeper ✓ в первую очередь
const fp = (s) => createHash("sha256").update(s).digest("hex");
const order = (xs) => xs.sort((a, b) => (badge(b, "owner") - badge(a, "owner")) || fp(a.slug).localeCompare(fp(b.slug)));
const yes = order(agents.filter(answers)), no = order(agents.filter((a) => !answers(a)));
const pick = []; for (let i = 0; pick.length < SAMPLE && (i < yes.length || i < no.length); i++) { if (yes[i]) pick.push(yes[i]); if (no[i] && pick.length < SAMPLE) pick.push(no[i]); }
const cardsFile = join(DIR, "cards.json"), cards = existsSync(cardsFile) ? JSON.parse(readFileSync(cardsFile, "utf8")) : {};
let k = 0;
for (const a of pick) {
  if (cards[a.slug]) continue;
  const r = await get(`/agent/${encodeURIComponent(a.slug)}?format=json`);
  cards[a.slug] = r.error ? { error: r.error, list: a } : { card: r.json.agent || r.json, list: a };
  if (++k % 25 === 0) { writeFileSync(cardsFile, JSON.stringify(cards)); console.log(`карточки: ${Object.keys(cards).length} из ${pick.length}`); }
  await sleep(PAUSE);
}
writeFileSync(cardsFile, JSON.stringify(cards));
console.log(`готово: ${Object.keys(cards).length} полных карточек в ${cardsFile}`);
