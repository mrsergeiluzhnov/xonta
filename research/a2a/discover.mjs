// Поиск агентов A2A для приглашения в Xonta (0.25). Только чтение: список из открытого реестра A2A и публичные карточки
// агентов (/.well-known/agent-card.json) — то, что агенты сами публикуют, чтобы их находили. Никаких сообщений здесь нет.
//
// Источник по умолчанию — a2aregistry.org (открытый, MIT, сам проверяет живость карточек). Свой реестр — A2A_REGISTRY.
// Выход в DIR (по умолчанию ./a2a-data): registry.json (сырой список), candidates.json (разобранные карточки с оценкой,
// не публиковать — это список чужих агентов), SUMMARY.md (сводные цифры, можно публиковать).
//
// Кого считаем подходящим для приглашения: карточка читается, есть JSON-RPC вход без обязательной авторизации, и по навыкам
// агент про агентов (оркестрация, оценка, доверие, реестры, платежи агентов) — ему Xonta может быть полезна. Отдельно
// отмечаем тех, кто прямо пишет, что открыт к контакту (partnership, collaboration, contact, inquiry).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.argv[2] || "./a2a-data", REG = (process.env.A2A_REGISTRY || "https://a2aregistry.org").replace(/\/$/, "");
const MAX = Number(process.env.A2A_MAX_AGENTS || 2000), PAUSE = Number(process.env.A2A_PAUSE_MS || 300);
const UA = "XontaDiscovery/0.25 (+https://github.com/mrsergeiluzhnov/xonta)";
mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, timeout = 10000, maxBytes = 512_000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { accept: "application/json", "user-agent": UA }, signal: ac.signal, redirect: "follow" });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const text = await r.text(); if (text.length > maxBytes) return { error: `слишком большой ответ (${Math.round(text.length / 1024)} КБ)` };
    try { return { json: JSON.parse(text) }; } catch { return { error: "не JSON" }; }
  } catch (e) { return { error: e.name === "AbortError" ? "таймаут" : e.message }; } finally { clearTimeout(t); }
}
const listOf = (j) => (Array.isArray(j) ? j : j?.agents || j?.items || j?.data || j?.results || []);

// 1. список: открытый реестр (по умолчанию) или выгрузка Agenstry (A2A_SOURCE=agenstry, CC-BY-4.0, не чаще 6 раз в час —
// файл сохраняется и при повторном запуске берётся из папки)
const SOURCE = process.env.A2A_SOURCE || "registry";
const reg = [];
if (SOURCE === "agenstry") {
  const { existsSync, createReadStream, createWriteStream } = await import("node:fs");
  const { createGunzip } = await import("node:zlib"), { createInterface } = await import("node:readline"), { Readable } = await import("node:stream"), { pipeline } = await import("node:stream/promises");
  const gz = join(DIR, "agenstry-feed.jsonl.gz");
  if (!existsSync(gz)) {
    const r = await fetch("https://agenstry.com/api/feed/all.jsonl.gz", { headers: { "user-agent": UA } });
    if (!r.ok) { console.log(`выгрузка Agenstry: HTTP ${r.status}`); process.exit(1); }
    await pipeline(Readable.fromWeb(r.body), createWriteStream(gz)); console.log("выгрузка Agenstry сохранена");
  }
  const types = {}, all = []; let first = null, sampleA2A = null;
  const typeOf = (o) => String(o.type || o.kind || o.entity_type || o.protocol || o.source_type || "").toLowerCase();
  const isA2A = (o) => /a2a/.test(typeOf(o)) || !!(o.agent_card || o.agentCard || o.card_url || o.agent_card_url || o.well_known_uri);
  const live = (o) => [o.live, o.is_live, o.responding, o.alive, o.healthy, o.is_healthy, o.reachable].some((v) => v === true) || /^(live|up|healthy|responding|ok)$/i.test(String(o.status || o.liveness || o.health || ""));
  for await (const line of createInterface({ input: createReadStream(gz).pipe(createGunzip()), crlfDelay: Infinity })) {
    if (!line.trim()) continue; let o; try { o = JSON.parse(line); } catch { continue; }
    first ||= o; const t = typeOf(o) || "?"; types[t] = (types[t] || 0) + 1;
    if (isA2A(o)) { sampleA2A ||= o; all.push({ live: live(o), card_url: o.card_url || o.agent_card_url || o.well_known_uri || o.wellKnownURI || (/\.json(\?|$)/.test(o.url || "") ? o.url : o.url || o.endpoint ? (() => { try { return `${new URL(o.url || o.endpoint).origin}/.well-known/agent-card.json`; } catch { return null; } })() : null), id: o.id || o.slug || o.name || null, name: o.name || null }); }
  }
  console.log(`записей по типам: ${Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`поля записи агента: ${Object.keys(sampleA2A || first || {}).join(", ")}`);
  console.log(`пример агента A2A: ${JSON.stringify(sampleA2A || {}).slice(0, 700)}`);
  const seen = new Set();
  for (const x of all.filter((x) => x.card_url).sort((a, b) => b.live - a.live)) { if (seen.has(x.card_url)) continue; seen.add(x.card_url); reg.push({ wellKnownURI: x.card_url, id: x.id, name: x.name, is_healthy: x.live }); if (reg.length >= MAX) break; }
  console.log(`агентов A2A: ${all.length}, живых по Agenstry: ${all.filter((x) => x.live).length}, берём ${reg.length} (сначала живые)`);
} else for (let off = 0; reg.length < MAX; off += 100) {
  const r = await getJson(`${REG}/api/agents?limit=100&offset=${off}`, 60000, 50_000_000); // в списке реестра карточки целиком — страница бывает в мегабайты
  if (r.error) { console.log(`реестр, offset ${off}: ${r.error}`); break; }
  const page = listOf(r.json); if (!off) console.log(`формат ответа: ${Array.isArray(r.json) ? "массив" : Object.keys(r.json || {}).join(", ")}; поля агента: ${Object.keys(page[0] || {}).slice(0, 25).join(", ")}`); reg.push(...page); console.log(`реестр: ${reg.length}`);
  if (page.length < 100) break; await sleep(PAUSE);
}
writeFileSync(join(DIR, "registry.json"), JSON.stringify(reg, null, 1));

// 2. карточки
const AGENTISH = /\b(agent|orchestrat|multi-agent|evaluat|benchmark|trust|safety|guardrail|oversight|registry|directory|marketplace|discover|identity|credential|payment|wallet|mcp|a2a)\w*/gi;
const OPEN = /\b(partner|collaborat|contact|inquir|networking|introduc|outreach)\w*/i;
const cardUrlOf = (a) => a.wellKnownURI || a.well_known_uri || a.agent_card_url || a.cardUrl || a.card_url || (a.url ? `${String(a.url).replace(/\/$/, "")}/.well-known/agent-card.json` : null);
function parse(card) {
  const ifs = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : card.url ? [{ url: card.url, protocolBinding: card.preferredTransport || "JSONRPC", protocolVersion: card.protocolVersion || "0.x" }] : [];
  const rpc = ifs.find((i) => /jsonrpc/i.test(i.protocolBinding || i.transport || "JSONRPC"));
  const skills = (Array.isArray(card.skills) ? card.skills : []).map((s) => ({ id: s.id, name: s.name, tags: s.tags || [], description: String(s.description || "").slice(0, 300) }));
  const text = [card.name, card.description, ...skills.flatMap((s) => [s.name, s.description, ...(s.tags || [])])].join(" ");
  const auth = !!(card.security?.length || card.securityRequirements?.length || (card.securitySchemes && Object.keys(card.securitySchemes).length));
  const hits = [...new Set((text.match(AGENTISH) || []).map((x) => x.toLowerCase()))];
  return { name: String(card.name || "").slice(0, 120), description: String(card.description || "").slice(0, 400), version: card.version || null, provider: card.provider?.organization || null, provider_url: card.provider?.url || null,
    endpoint: rpc?.url || null, protocol: rpc?.protocolVersion || null, auth, skills, agentish: hits, open_to_contact: OPEN.test(text) };
}
const out = [];
for (const [k, a] of reg.entries()) {
  const url = cardUrlOf(a); if (!url) { out.push({ registry: a.id || a.name || null, card_url: null, error: "нет адреса карточки" }); continue; }
  const r = await getJson(url);
  const row = { registry: a.id || a.name || null, card_url: url, registry_healthy: a.is_healthy ?? a.healthy ?? null };
  if (r.error) row.error = r.error; else Object.assign(row, parse(r.json));
  row.invitable = !row.error && !!row.endpoint && !row.auth && /^https:/.test(row.endpoint || "") && (row.agentish?.length || 0) >= 2;
  out.push(row); if (k % 25 === 0) console.log(`карточки: ${k + 1}/${reg.length}, подходит ${out.filter((x) => x.invitable).length}`);
  await sleep(PAUSE);
}
writeFileSync(join(DIR, "candidates.json"), JSON.stringify(out, null, 1));

// 3. сводка
const n = (f) => out.filter(f).length, pc = (x) => (out.length ? `${Math.round((100 * x) / out.length)}%` : "-");
const tagCount = {}; for (const r of out) for (const s of r.skills || []) for (const t of s.tags || []) tagCount[String(t).toLowerCase()] = (tagCount[String(t).toLowerCase()] || 0) + 1;
const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([t, c]) => `${t} (${c})`).join(", ");
const protos = {}; for (const r of out.filter((x) => x.protocol)) protos[r.protocol] = (protos[r.protocol] || 0) + 1;
const S = [`# Агенты A2A в открытом реестре`, ``, `Источник: ${SOURCE === "agenstry" ? "Agenstry (agenstry.com, выгрузка под CC-BY-4.0)" : REG}, ${new Date().toISOString().slice(0, 10)}. Только публичные карточки, сообщений не отправляли.`, ``,
  `- в реестре: ${reg.length}`, `- карточка читается: ${n((x) => !x.error)} (${pc(n((x) => !x.error))})`, `- есть вход JSON-RPC по https: ${n((x) => /^https:/.test(x.endpoint || ""))}`,
  `- требуют авторизации: ${n((x) => x.auth)}`, `- про агентов (2+ совпадения по навыкам): ${n((x) => (x.agentish?.length || 0) >= 2)}`, `- прямо открыты к контакту: ${n((x) => x.open_to_contact)}`,
  `- подходят для приглашения: ${n((x) => x.invitable)}`, ``, `Версии протокола: ${Object.entries(protos).map(([k, v]) => `${k} - ${v}`).join(", ") || "-"}`, ``, `Частые теги навыков: ${topTags || "-"}`, ``];
writeFileSync(join(DIR, "SUMMARY.md"), S.join("\n"));
console.log(S.join("\n"));
