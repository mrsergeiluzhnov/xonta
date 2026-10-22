// Агент поиска публичного телефона головного офиса, версия 4. Основа — agent-round3 владельца, исправлены ошибки, найденные
// в его прогонах (22.10):
//   - ссылки с #фрагментом считались отдельной страницей и съедали лимит страниц;
//   - HTML-сущности не раскодировались (&#43;44 терял плюс);
//   - регулярное выражение склеивало почтовый индекс с номером (Apple: «95014 (408) 996») и принимало диапазоны
//     из выпадающих списков за телефон (Cisco: «5 - 19 20 - 49»);
//   - robots.txt не учитывался. Теперь страницы, закрытые для всех роботов, не запрашиваются.
// Защита от ботов (HTTP 403) не обходится: агент честно представляется, такая компания записывается как «закрыто».
// Модель выбирает только ID из найденных на странице кандидатов и не может выдумать номер.
//
// Стратегии (рецепты) — необязательный аргумент strategy, объект с action:
//   prefer_locale  { locale, paths }   просить английскую версию и пробовать /us/en/ и т.п., если сайт отдал местную
//   try_paths      { paths, subdomains }  дополнительные страницы: для инвесторов, адреса офисов
//   hq_labels      { accept, reject, window }  как распознавать обозначение головного офиса рядом с номером
// В ответе: applied (стратегия использована), matched (она изменила ход работы на этой задаче), stage_reached и причина.
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import net from 'node:net';
import dns from 'node:dns';

net.setDefaultAutoSelectFamily(false);
dns.setDefaultResultOrder('ipv4first');

const port = Number(process.env.CONTACT_AGENT_PORT || 4320);
const UA = process.env.CONTACT_UA || 'XontaContactResearch/4.0 (public corporate contacts only)';
const MAX_PAGES = Number(process.env.CONTACT_MAX_PAGES || 6);
const app = express(); app.use(express.json({ limit: '128kb' }));
let token = null, tokenUntil = 0;
const blocked = (a) => a === '::1' || a.startsWith('127.') || a.startsWith('10.') || a.startsWith('192.168.') || a.startsWith('169.254.') || (a.startsWith('172.') && Number(a.split('.')[1]) >= 16 && Number(a.split('.')[1]) <= 31) || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80') || a === '0.0.0.0';
async function safeUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || isIP(u.hostname) || u.hostname === 'localhost') throw Error('Unsafe URL');
  const ips = await lookup(u.hostname, { all: true });
  if (!ips.length || ips.some((x) => blocked(x.address))) throw Error('Unsafe destination');
  u.hash = '';
  return u;
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', shy: '' };
export function decode(s) { return String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m); }
const norm = (href) => { const u = new URL(href); u.hash = ''; return u.href; };

// robots.txt: правила для всех роботов (User-agent: *). Шаблоны с * и $, Allow и Disallow; решает самое длинное совпавшее
// правило, при равенстве Allow. Пустой Disallow ничего не запрещает
const robotsCache = new Map();
export function parseRobots(txt) {
  const rules = []; let group = [], inRules = false;
  for (const raw of String(txt).split('\n')) {
    const line = raw.replace(/#.*$/, '').trim(); if (!line) continue;
    const k = line.slice(0, line.indexOf(':')).trim().toLowerCase(), v = line.slice(line.indexOf(':') + 1).trim();
    if (k === 'user-agent') { if (inRules) { group = []; inRules = false; } group.push(v.toLowerCase()); }
    else if (k === 'allow' || k === 'disallow') { inRules = true; if (group.includes('*') && v) rules.push({ allow: k === 'allow', pat: v }); }
  }
  return rules;
}
export function robotsAllows(rules, path) {
  let best = null;
  for (const r of rules) {
    const re = new RegExp('^' + r.pat.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.pat.length > best.pat.length || (r.pat.length === best.pat.length && r.allow))) best = r;
  }
  return !best || best.allow;
}
async function allowed(u, headers) {
  if (!robotsCache.has(u.origin)) {
    let rules = [];
    try { const r = await fetch(u.origin + '/robots.txt', { headers, redirect: 'follow', signal: AbortSignal.timeout(8000) }); if (r.ok) rules = parseRobots(await r.text()); } catch {}
    robotsCache.set(u.origin, rules);
  }
  return robotsAllows(robotsCache.get(u.origin), u.pathname + u.search);
}

async function page(url, { lang = null, redirects = 0 } = {}) {
  const u = await safeUrl(url);
  const headers = { 'user-agent': UA, accept: 'text/html,text/plain', ...(lang ? { 'accept-language': `${lang},en;q=0.8` } : {}) };
  if (!(await allowed(u, headers))) throw Error('robots.txt disallows');
  const start = Date.now();
  const r = await fetch(u, { headers, redirect: 'manual', signal: AbortSignal.timeout(12000) });
  if (r.status >= 300 && r.status < 400) {
    const location = r.headers.get('location'); if (!location) throw Error(`Redirect ${r.status} without Location`);
    if (redirects >= 5) throw Error('Too many redirects');
    return page(new URL(location, u).href, { lang, redirects: redirects + 1 });
  }
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !/text\/html|text\/plain/.test(type)) throw Error(`HTTP ${r.status}`);
  const html = (await r.text()).slice(0, 800000);
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    try { const t = new URL(decode(m[1]), u); t.hash = ''; if (t.protocol === 'https:' && (t.origin === u.origin || t.hostname.endsWith('.' + u.hostname.replace(/^www\./, '')))) if (!links.includes(t.href)) links.push(t.href); } catch {}
  }
  const text = decode(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<(br|\/p|\/div|\/li|\/td|\/tr|\/h\d)\b[^>]*>/gi, ' | ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').slice(0, 25000);
  return { url: u.href, text, links, latency_ms: Date.now() - start, status: r.status };
}

async function auth() {
  if (token && Date.now() < tokenUntil) return token;
  if (!process.env.GIGACHAT_AUTH_KEY) throw Error('GIGACHAT_AUTH_KEY missing');
  const r = await fetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', { method: 'POST', headers: { Authorization: `Basic ${process.env.GIGACHAT_AUTH_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', RqUID: randomUUID() }, body: new URLSearchParams({ scope: process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS' }), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw Error(`OAuth HTTP ${r.status}`);
  const j = await r.json(); token = j.access_token; tokenUntil = Date.now() + 25 * 60000; return token;
}
async function model(messages) {
  const t = await auth();
  const r = await fetch(process.env.GIGACHAT_CHAT_URL || 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.GIGACHAT_MODEL || 'GigaChat', temperature: 0, messages }), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw Error(`GigaChat HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const j = await r.json(); return { text: j.choices?.[0]?.message?.content || '', usage: j.usage || null };
}
const parse = (text) => { try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); } catch { const m = String(text).match(/\{[\s\S]*\}/); try { return m ? JSON.parse(m[0]) : {}; } catch { return {}; } } };

const LOCALE_RE = /\/(?!en(?:-us)?\/)([a-z]{2}[-_][a-z]{2}|[a-z]{2}(?=\/))\//i;
export function isForeignLocale(url) { const p = new URL(url).pathname.toLowerCase(); if (/\/(en-us|us\/en|en_us|us-en)\b/.test(p)) return false; return /\/(ru|kz|de|fr|es|it|pl|tr|cn|zh|ja|jp|ko|kr|br|pt|nl|se|uk|in|eu)([-_][a-z]{2})?(\/|$)/.test(p) || /\/[a-z]{2}-(ru|kz|de|fr|es|it|pl|tr|cn|jp|kr|br|eu|in)(\/|$)/.test(p); }

function discover(p, extraRe = null) {
  const scores = new Map();
  for (const href of p.links || []) {
    try {
      const u = new URL(href), path = (u.pathname + ' ' + u.search).toLowerCase();
      if (/login|signup|cookie|cart|privacy|career|jobs|legal\/|terms|\.pdf$/.test(path)) continue;
      let s = 0;
      if (/contact/.test(path)) s += 10;
      if (/headquarter|office-location|corporate-office|locations|offices/.test(path)) s += 8;
      if (/about|company|imprint|who-we-are/.test(path)) s += 3;
      if (extraRe && extraRe.test(path)) s += 9;
      if (s > 0) scores.set(norm(href), Math.max(s, scores.get(norm(href)) || 0));
    } catch {}
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
}

const normalizedPhone = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length === 11 && d.startsWith('1') ? d.slice(1) : d; };
// номер: необязательный код страны, затем 2–4 группы; почтовый индекс (5 цифр) перед скобкой не захватывается
const PHONE = /(?<![\d-])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?|\d{1,4}[\s.-])\d{2,4}(?:[\s.-]\d{2,5}){1,3}(?![\d-])/g;
export function extractPhones(pages, hq = null) {
  const out = [], seen = new Set();
  for (const p of pages) {
    for (const m of p.text.matchAll(PHONE)) {
      const raw = m[0].trim(), digits = raw.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) continue;
      if (/\d\s+-\s+\d/.test(raw)) continue;                     // диапазоны из выпадающих списков: «5 - 19 20 - 49»
      if (/^\d{4}[-./]\d{2}[-./]\d{2}/.test(raw) || /[%$€£]/.test(raw)) continue;
      const pos = m.index, before = p.text.slice(Math.max(0, pos - 160), pos), after = p.text.slice(pos + raw.length, pos + raw.length + 80);
      if (/(?:uptime|availability|revenue|volume|payments processed|subscriptions|employees|founded|patents)/i.test(before.slice(-60))) continue;
      const key = digits.slice(-10); if (seen.has(key)) continue; seen.add(key);
      const c = { phone: raw, digits: normalizedPhone(raw), source: p.url, before, after, context: (before + raw + after).replace(/\s+/g, ' ').trim() };
      c.score = score(c, hq); out.push(c); if (out.length >= 120) break;
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.map((x, i) => ({ id: 'P' + (i + 1), ...x }));
}
const DEFAULT_HQ = { accept: ['headquarters', 'head office', 'corporate office', 'main office', 'registered office', 'switchboard', 'central office'], reject: ['regional', 'branch'], window: 110 };
function score(c, hq) {
  const H = hq || DEFAULT_HQ, b = c.before.slice(-H.window).toLowerCase(), a = c.after.slice(0, 30).toLowerCase();
  let s = 0;
  const acc = H.accept.some((w) => b.includes(w)), rej = (H.reject || []).some((w) => new RegExp(`\\b${w}\\b[^|]{0,40}$`).test(b));
  if (/(?:global|corporate|worldwide|world)\s+(?:headquarters|hq)/.test(b)) s += 15; else if (acc && !rej) s += 10;
  if (/(?:tel|telephone|phone|switchboard|call|main)\s*[:.]?\s*$/.test(b)) s += 8;
  if (/contact/.test(b)) s += 2;
  if (/(?:fax|facsimile)\s*[:.]?\s*$/.test(b)) s -= 30;
  if (/support|customer service|customer care|hotline|helpdesk|technical/.test(b.slice(-80))) s -= 15;
  if (/sales/.test(b.slice(-60))) s -= 12;
  if (/residents|investor relations\s*[:.]?\s*$|media|press/.test(b.slice(-60))) s -= 8;
  if (rej) s -= 10;
  if (/fax/.test(a)) s -= 1;
  return s;
}
function heuristic(c) {
  const b = c.before.slice(-100).toLowerCase();
  if (/(?:fax|facsimile)\s*[:.]?\s*$/.test(b)) return 'fax';
  if (/(?:residents)/.test(b)) return 'regional';
  if (/(?:customer support|technical support|customer service|helpdesk|support hotline)\s*[:.]?\s*$/.test(b)) return 'support';
  if (/(?:sales|sales team|sales hotline)\s*[:.]?\s*$/.test(b)) return 'sales';
  return 'unknown';
}
function corporateEvidence(c, hq) {
  const H = hq || DEFAULT_HQ, b = c.before.slice(-H.window).toLowerCase();
  const rej = (H.reject || []).some((w) => new RegExp(`\\b${w}\\b[^|]{0,40}$`).test(b));
  return !rej && H.accept.some((w) => b.includes(w));
}

async function research({ company, site, strategy = null, phase = 'v4' }) {
  const started = Date.now(), pages = [], errors = [], attempted = new Set();
  const st = strategy && typeof strategy === 'object' ? strategy : null;
  const act = st?.action || null, effects = [];
  const lang = act === 'prefer_locale' ? (st.locale || 'en-US') : null;
  const origin = new URL(site).origin, host = new URL(site).hostname.replace(/^www\./, '');
  const queue = [origin + '/'], fallback = [origin + '/contact', origin + '/contact-us', origin + '/about/contact', origin + '/company/contact', origin + '/about'];
  let extraRe = null;
  if (act === 'try_paths') {
    for (const p of st.paths || []) fallback.unshift(origin + (p.startsWith('/') ? p : '/' + p));
    for (const s of st.subdomains || []) fallback.push(`https://${s}.${host}/`);
    extraRe = /investor|headquarter|locations|offices/;
  }
  let localeRetried = false;
  while (pages.length < MAX_PAGES && attempted.size < 14) {
    let url = queue.shift() || fallback.shift(); if (!url) break;
    url = norm(url); if (attempted.has(url)) continue; attempted.add(url);
    try {
      const p = await page(url, { lang });
      if (pages.some((x) => x.url === p.url)) continue;
      pages.push(p);
      if (act === 'prefer_locale' && !localeRetried && isForeignLocale(p.url)) {
        localeRetried = true; effects.push(`local version ${new URL(p.url).pathname}, trying English`);
        for (const path of (st.paths || ['/us/en/', '/en-us/', '/en/', '/us/'])) queue.unshift(origin + path);
      }
      for (const href of discover(p, extraRe)) if (!attempted.has(href) && !queue.includes(href)) queue.push(href);
    } catch (e) { errors.push({ url, error: e.message.slice(0, 80) }); }
  }
  if (act === 'try_paths') { const extra = pages.filter((p) => /investor|headquarter|locations|offices/.test(p.url) || (st.subdomains || []).some((s) => new URL(p.url).hostname.startsWith(s + '.'))); if (extra.length) effects.push(`extra pages ${extra.length}`); }
  const base = { company, phase, verified: false, phone: null, digits: null, source: null, quote: null, pages: pages.map((p) => ({ url: p.url, status: p.status })), errors, elapsed_ms: 0, model_calls: 0, tokens: 0, strategy: act, applied: !!act, matched: false };
  const blockedAll = errors.length && errors.every((e) => /HTTP 403|robots/.test(e.error));
  if (!pages.length) return { ...base, stage_reached: 'pages', rejection_reason: blockedAll ? 'blocked' : 'no_pages', matched: effects.length > 0, effects, elapsed_ms: Date.now() - started };
  const hq = act === 'hq_labels' ? { accept: st.accept || DEFAULT_HQ.accept, reject: st.reject || DEFAULT_HQ.reject, window: Number(st.window || 160) } : null;
  const ex = extractPhones(pages, hq);
  if (!ex.length) return { ...base, stage_reached: 'candidates', rejection_reason: 'no_phone_candidates', matched: effects.length > 0, effects, elapsed_ms: Date.now() - started };
  const forModel = ex.slice(0, 15).map((x) => ({ id: x.id, context: x.context.slice(0, 330), source: x.source }));
  const prompt = `Company: ${company}\nOfficial website: ${site}\n\nBelow are phone-number candidates extracted directly from public pages of the company's website.\nChoose the MAIN CORPORATE PHONE of the company's global headquarters (the switchboard or main number of the head office).\nDo not choose customer support, sales, fax, investor or media lines, regional or country offices, or personal numbers.\nSelect only an existing candidate ID. Do not generate phone numbers.\nReturn JSON {"selected_id":"P1 or null","classification":"corporate|support|sales|fax|regional|unknown","reason":"short"}\nIf there is no reliable headquarters phone, return selected_id null.\n\nCandidates:\n${JSON.stringify(forModel)}`;
  let answer;
  try { answer = await model([{ role: 'system', content: 'You classify public corporate telephone evidence. Select only supplied candidate IDs. Return strict JSON.' }, { role: 'user', content: prompt }]); }
  catch (e) { return { ...base, stage_reached: 'model', rejection_reason: 'model_error', model_error: e.message.slice(0, 120), elapsed_ms: Date.now() - started }; }
  const d = parse(answer.text), sel = forModel.some((x) => x.id === d.selected_id) ? ex.find((x) => x.id === d.selected_id) : null;
  const cls = String(d.classification || 'unknown').toLowerCase();
  let reason = null;
  if (!sel) reason = 'model_selected_none';
  else if (!/corporate|headquarter|\bhq\b|head office|main|switchboard/.test(cls) || /support|sales|fax|regional|branch|investor|media/.test(cls)) reason = 'not_corporate';
  else { const h = heuristic(sel); if (h !== 'unknown') reason = 'evidence_indicates_' + h; else if (!corporateEvidence(sel, hq)) reason = 'corporate_context_missing'; }
  if (hq && sel && corporateEvidence(sel, hq) !== corporateEvidence(sel, null)) effects.push('label rule changed the decision');
  const ok = reason === null;
  return { ...base, stage_reached: ok ? 'accepted' : 'context', verified: ok, phone: ok ? sel.phone : null, digits: ok ? sel.digits : null, source: ok ? sel.source : null, quote: ok ? sel.context : null,
    candidate_phone: sel?.phone || null, candidate_digits: sel?.digits || null, candidate_quote: sel?.context?.slice(0, 300) || null, classification: cls, rejection_reason: reason, model_reason: d.reason ? String(d.reason).slice(0, 200) : null, model_classification: cls,
    candidates_n: ex.length, all_candidate_digits: ex.slice(0, 30).map((x) => x.digits), model_calls: 1, tokens: answer.usage?.total_tokens ?? null, matched: effects.length > 0, effects, elapsed_ms: Date.now() - started };
}

if (process.argv[1] && process.argv[1].endsWith('agent-v4.mjs') || process.env.CONTACT_AGENT_SERVE === '1') {
  app.get('/health', (_, res) => res.json({ ok: true, service: 'xonta-contact-v4', model: process.env.GIGACHAT_MODEL || 'GigaChat' }));
  app.post('/mcp', async (req, res) => {
    const server = new McpServer({ name: 'xonta-contact-v4', version: '4.0.0' });
    server.registerTool('find_public_company_phone', { description: 'Find the public headquarters phone of a company on its own website. Public corporate contacts only.', inputSchema: { company: z.string(), site: z.string().url(), strategy: z.record(z.any()).optional(), phase: z.string().optional() } }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await research(args)) }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); } catch (e) { console.error('MCP', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
  });
  app.get('/mcp', (_, res) => res.status(405).end());
  app.listen(port, '0.0.0.0', () => console.log(`contact v4 listening ${port}, model ${process.env.GIGACHAT_MODEL || 'GigaChat'}`));
}
export { research };
