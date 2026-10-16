// Вежливый сборщик публичных страниц.
// - читает robots.txt площадки и не открывает запрещённые адреса (своя группа XontaReviewsBot, иначе «*»);
// - не чаще одной страницы в FETCH_INTERVAL_MS на площадку и не больше FETCH_DAILY_LIMIT страниц в сутки;
// - представляется честно (User-Agent с адресом описания);
// - не обходит защиту: капча, 401/403/429/498 — площадка помечается заблокированной до конца суток, сбор с неё прекращается;
// - кэширует страницы на диске на сутки, чтобы не ходить повторно.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const BOT = process.env.FETCH_USER_AGENT || "XontaReviewsBot/0.1 (+https://xonta.ru/bot; research; contact: bot@xonta.ru)";
const TOKEN = "xontareviewsbot";

export class BlockedError extends Error { constructor(host, why) { super(`${host}: ${why}`); this.host = host; this.why = why; } }
export class DisallowedError extends Error { constructor(url) { super(`robots.txt запрещает: ${url}`); this.url = url; } }

// --- robots.txt (RFC 9309): группы по user-agent, Allow/Disallow с * и $, побеждает самое длинное совпадение, при равенстве — Allow
export function parseRobots(text) {
  const groups = []; let cur = null, lastWasAgent = false;
  for (const line of String(text).split(/\r?\n/)) {
    const l = line.replace(/#.*/, "").trim(); if (!l) continue;
    const i = l.indexOf(":"); if (i < 0) continue;
    const k = l.slice(0, i).trim().toLowerCase(), v = l.slice(i + 1).trim();
    if (k === "user-agent") { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (!cur) continue;
    if (k === "allow" || k === "disallow") cur.rules.push({ allow: k === "allow", path: v });
    if (k === "crawl-delay") cur.delay = Number(v) || undefined;
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && TOKEN.includes(a)));
  const pick = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return { rules: pick.flatMap((g) => g.rules), delay: pick.map((g) => g.delay).find(Boolean) };
}
export function robotsAllows(parsed, pathAndQuery) {
  let best = null;
  for (const r of parsed.rules) {
    if (!r.path) continue; // пустой Disallow ничего не запрещает
    const p = r.path.endsWith("$") ? r.path.slice(0, -1).replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$" : r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    if (new RegExp("^" + p).test(pathAndQuery) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

// кодировка: из заголовка, иначе из <meta charset>, иначе UTF-8 (часть русских сайтов до сих пор в windows-1251)
export function decode(buf, contentType = "") {
  let cs = (String(contentType).match(/charset=([\w-]+)/i) || [])[1];
  if (!cs) cs = (buf.subarray(0, 4096).toString("latin1").match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
  try { return new TextDecoder((cs || "utf-8").toLowerCase()).decode(buf); } catch { return buf.toString("utf8"); }
}

const CAPTCHA = /showcaptcha|smartcaptcha|captcha-|Подтвердите, что запросы отправляли вы|Вы не робот|are you a robot|cf-chl|Access denied|доступ ограничен/i;

export function createFetcher({ dir, intervalMs = Number(process.env.FETCH_INTERVAL_MS || 8000), dailyLimit = Number(process.env.FETCH_DAILY_LIMIT || 300), overrides = {} } = {}) {
  mkdirSync(join(dir, "pages"), { recursive: true });
  const robots = new Map(), last = new Map(), blocked = new Map(), count = new Map();
  const stats = { fetched: 0, cached: 0, disallowed: 0, blocked: 0, errors: 0 };
  const day = () => new Date().toISOString().slice(0, 10);
  // overrides: { "market.yandex.ru": "http://localhost:4199/market" } — только для проверки стенда на учебных страницах
  const real = (u) => { const url = new URL(u); const o = overrides[url.host]; return o ? new URL(o.replace(/\/$/, "") + url.pathname + url.search) : url; };

  async function getRobots(orig) {
    const key = orig.origin;
    if (robots.has(key)) return robots.get(key);
    const o = overrides[orig.host];
    const robotsUrl = o ? `${o.replace(/\/$/, "")}/robots.txt` : `${key}/robots.txt`;
    let parsed;
    try {
      const r = await fetch(robotsUrl, { headers: { "user-agent": BOT }, signal: AbortSignal.timeout(20000) });
      if (r.status >= 400 && r.status < 500 && ![401, 403].includes(r.status)) parsed = { rules: [] }; // нет robots.txt — ограничений нет
      else if (!r.ok) parsed = { rules: [{ allow: false, path: "/" }], note: `robots.txt недоступен (${r.status}) — считаем всё запрещённым` };
      else parsed = parseRobots(await r.text());
    } catch (e) { parsed = { rules: [{ allow: false, path: "/" }], note: `robots.txt не получен: ${e.message}` }; }
    robots.set(key, parsed);
    return parsed;
  }

  async function get(u, { maxAgeMs = 24 * 3600_000 } = {}) {
    const orig = new URL(u), url = real(u), host = orig.host;
    const file = join(dir, "pages", createHash("sha256").update(orig.href).digest("hex").slice(0, 24) + ".html");
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs < maxAgeMs) { stats.cached++; return readFileSync(file, "utf8"); }
    const b = blocked.get(host);
    if (b && b.day === day()) { stats.blocked++; throw new BlockedError(host, b.why); }
    const rb = await getRobots(orig);
    if (!robotsAllows(rb, orig.pathname + orig.search)) { stats.disallowed++; throw new DisallowedError(orig.href); }
    const k = `${host}|${day()}`;
    if ((count.get(k) || 0) >= dailyLimit) throw new BlockedError(host, `суточный лимит ${dailyLimit} страниц исчерпан`);
    const wait = Math.max(intervalMs, (rb.delay || 0) * 1000) - (Date.now() - (last.get(host) || 0));
    if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
    last.set(host, Date.now()); count.set(k, (count.get(k) || 0) + 1);
    let r, text;
    try {
      r = await fetch(url, { headers: { "user-agent": BOT, "accept-language": "ru-RU,ru;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(30000) });
      text = decode(Buffer.from(await r.arrayBuffer()), r.headers.get("content-type"));
    } catch (e) { stats.errors++; throw new Error(`${host}: сеть: ${e.message}`); }
    if ([401, 403, 429, 498].includes(r.status) || CAPTCHA.test(r.url) || (CAPTCHA.test(text.slice(0, 20000)) && text.length < 200_000)) {
      const why = `защита площадки (HTTP ${r.status}${CAPTCHA.test(r.url + text.slice(0, 20000)) ? ", капча" : ""}) — сбор остановлен до завтра, обход не выполняется`;
      blocked.set(host, { day: day(), why }); stats.blocked++;
      throw new BlockedError(host, why);
    }
    if (!r.ok) { stats.errors++; throw new Error(`${host}: HTTP ${r.status}`); }
    writeFileSync(file, text); stats.fetched++;
    return text;
  }

  return { get, stats, robotsFor: async (u) => getRobots(new URL(u)), blocked };
}

// HTML → видимый текст (для извлечения отзывов моделью); скрипты и стили выбрасываются, но JSON-данные страницы сохраняются отдельно
export function htmlToText(html, max = 60000) {
  const data = [...String(html).matchAll(/<script[^>]*type="application\/(?:ld\+)?json"[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n").slice(0, 20000);
  const text = String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|p|div|li|h\d|article|section|tr)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return { text: text.slice(0, max), data };
}
