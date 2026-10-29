// Выгрузка истории инцидентов с открытых страниц статуса (Statuspage): по умолчанию GitHub и DigitalOcean.
// API /api/v2/incidents.json отдаёт только последние 50, поэтому коды инцидентов берутся со страниц истории
// (/history.json?page=N, если его нет — из ссылок /history?page=N), а сами инциденты — по одному (/incidents/<код>.json).
// Медленно: пауза между запросами INC_PAUSE_MS (по умолчанию 2 с), User-Agent с названием Xonta. Повторный запуск
// продолжает с места остановки. Только чтение открытых страниц, никаких ключей.
//   node research/incidents/fetch.mjs /root/incidents-data
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = process.argv[2] || "./incidents-data";
const PAUSE = Math.max(1500, Number(process.env.INC_PAUSE_MS || 2000));
const TARGET = Number(process.env.INC_TARGET || 400), MAX_PAGES = Number(process.env.INC_MAX_PAGES || 40);
const SINCE = process.env.INC_SINCE || "2023-01-01";
const UA = "XontaResearch/0.25 (+https://github.com/mrsergeiluzhnov/xonta; incident history study, slow single pass)";
// INC_SERVICES=имя=адрес,имя=адрес — другие страницы на Statuspage. Cloudflare с осени 2026 ушёл со Statuspage на свою страницу:
// история и отдельные инциденты там больше не отдаются (404), только последние 50 в /api/v2/incidents.json.
export const SERVICES = process.env.INC_SERVICES
  ? Object.fromEntries(process.env.INC_SERVICES.split(",").map((x) => x.split("=")).filter((p) => p.length === 2 && /^https:\/\//.test(p[1])))
  : { github: "https://www.githubstatus.com", digitalocean: "https://status.digitalocean.com" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, accept = "application/json") {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { accept, "user-agent": UA }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { const wait = Number(r.headers.get("retry-after") || 60) * 1000; console.log(`429, ждём ${wait / 1000} с`); await sleep(wait); continue; }
      if (!r.ok) return { status: r.status };
      return { status: r.status, type: r.headers.get("content-type") || "", text: await r.text() };
    } catch (e) { if (i === 2) return { error: e.message }; await sleep(PAUSE * 2); }
  }
  return { error: "не удалось" };
}

// все коды инцидентов из ответа страницы истории: JSON (любая вложенность) или HTML со ссылками
export function codesFrom(text) {
  const out = new Set();
  try {
    const walk = (x) => {
      if (Array.isArray(x)) return x.forEach(walk);
      if (x && typeof x === "object") { if (typeof x.code === "string" && /^[a-z0-9]{6,20}$/.test(x.code) && ("impact" in x || "name" in x)) out.add(x.code); Object.values(x).forEach(walk); }
    };
    walk(JSON.parse(text));
  } catch {
    for (const m of text.matchAll(/\/incidents\/([a-z0-9]{6,20})(?=["'?#/])/g)) out.add(m[1]);
  }
  return [...out];
}

// инцидент в коротком виде; обновления — от первого к последнему
export function slim(j, service) {
  const inc = j.incident || j;
  if (!inc?.id && !inc?.code) return null;
  const ups = (inc.incident_updates || []).map((u) => ({ status: u.status, body: u.body || "", at: u.created_at || u.display_at,
    components: (u.affected_components || []).map((c) => c.name).filter(Boolean) })).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { service, code: inc.code || inc.shortlink?.split("/").pop() || inc.id, name: inc.name || "", impact: inc.impact || null,
    created_at: inc.created_at, started_at: inc.started_at || null, resolved_at: inc.resolved_at || null,
    components: [...new Set([...(inc.components || []).map((c) => c.name), ...ups.flatMap((u) => u.components)])].filter(Boolean), updates: ups };
}

async function run() {
  mkdirSync(DIR, { recursive: true });
  for (const [service, base] of Object.entries(SERVICES)) {
    const file = join(DIR, `${service}.json`);
    const st = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { codes: [], pages: 0, incidents: {}, mode: null };
    // шаг 1: коды
    if (!st.codes_done) {
      // свежие 50 из API — тоже коды
      const recent = await get(`${base}/api/v2/incidents.json`);
      if (recent.text) for (const c of codesFrom(recent.text)) if (!st.codes.includes(c)) st.codes.push(c);
      for (let page = st.pages + 1; page <= MAX_PAGES && st.codes.length < TARGET; page++) {
        await sleep(PAUSE);
        let r = st.mode !== "html" ? await get(`${base}/history.json?page=${page}`) : null;
        let codes = r?.text && /json/.test(r.type) ? codesFrom(r.text) : [];
        if (!codes.length) { await sleep(PAUSE); r = await get(`${base}/history?page=${page}`, "text/html"); codes = r?.text ? codesFrom(r.text) : []; if (codes.length) st.mode = "html"; }
        else st.mode = "json";
        const fresh = codes.filter((c) => !st.codes.includes(c));
        st.codes.push(...fresh); st.pages = page;
        console.log(`${service}: страница истории ${page} (${st.mode || "?"}), новых кодов ${fresh.length}, всего ${st.codes.length}`);
        writeFileSync(file, JSON.stringify(st));
        if (!fresh.length) break;
      }
      st.codes_done = true; writeFileSync(file, JSON.stringify(st));
    }
    // шаг 2: инциденты по одному
    let k = 0, old = 0;
    for (const code of st.codes) {
      if (st.incidents[code]) continue;
      await sleep(PAUSE);
      let r = await get(`${base}/incidents/${code}.json`);
      if (!r.text) { await sleep(PAUSE); r = await get(`${base}/api/v2/incidents/${code}.json`); }
      let inc = null; try { inc = r.text ? slim(JSON.parse(r.text), service) : null; } catch {}
      st.incidents[code] = inc || { error: r.error || `HTTP ${r.status}` };
      if (inc && inc.created_at && inc.created_at.slice(0, 10) < SINCE) old++;
      if (++k % 20 === 0) { console.log(`${service}: инцидентов ${Object.keys(st.incidents).length} из ${st.codes.length}`); writeFileSync(file, JSON.stringify(st)); }
    }
    writeFileSync(file, JSON.stringify(st));
    const ok = Object.values(st.incidents).filter((x) => x && !x.error && x.created_at >= SINCE);
    const by = (f) => ok.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
    const mins = (x) => (x.resolved_at ? Math.round((Date.parse(x.resolved_at) - Date.parse(x.started_at || x.created_at)) / 60000) : null);
    console.log(`${service}: готово ${ok.length} инцидентов с ${SINCE} (ошибок ${Object.values(st.incidents).filter((x) => x?.error).length}); серьёзность ${JSON.stringify(by((x) => x.impact))}; закрыты за час ${ok.filter((x) => mins(x) !== null && mins(x) <= 60).length}, дольше ${ok.filter((x) => mins(x) > 60).length}; с ${ok.map((x) => x.created_at).sort()[0]?.slice(0, 10)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await run();
