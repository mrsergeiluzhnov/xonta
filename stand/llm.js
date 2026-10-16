// Вызов языковой модели: Anthropic Messages API или любой OpenAI-совместимый API (YandexGPT, GigaChat-прокси, OpenRouter…).
// Учёт токенов и жёсткий бюджет: при превышении вызовы прекращаются с ошибкой, а не тратят деньги дальше.
// LLM_PROVIDER=mock — детерминированная заглушка для проверки стенда без сети и без затрат.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// GigaChat: ключ авторизации меняется на токен доступа (живёт 30 минут); токен общий для всех ролей процесса
let gigaTok = null;
async function gigachatToken(apiKey) {
  if (gigaTok && gigaTok.key === apiKey && gigaTok.expires - Date.now() > 60_000) return gigaTok.token;
  const r = await fetch(process.env.GIGACHAT_OAUTH_URL || "https://ngw.devices.sberbank.ru:9443/api/v2/oauth", { method: "POST", signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", RqUID: randomUUID(), authorization: `Basic ${apiKey}` },
    body: `scope=${encodeURIComponent(process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS")}` });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw Object.assign(new Error(`GigaChat OAuth: HTTP ${r.status} ${j.message || j.error || ""}`), { status: r.status });
  gigaTok = { key: apiKey, token: j.access_token, expires: Number(j.expires_at) > 1e12 ? Number(j.expires_at) : Number(j.expires_at) * 1000 };
  return gigaTok.token;
}
// LLM_MAX_CONCURRENCY — общий предел одновременных запросов к модели на весь процесс (у GigaChat для физлиц — один поток)
let active = 0; const waiters = [];
const MAXC = () => Number(process.env.LLM_MAX_CONCURRENCY || 0);
async function acquire() { if (!MAXC()) return; if (active < MAXC()) { active++; return; } await new Promise((ok) => waiters.push(ok)); active++; }
function release() { if (!MAXC()) return; active--; const w = waiters.shift(); if (w) w(); }

export function createLLM({ provider = process.env.LLM_PROVIDER || "mock", model, apiKey = process.env.LLM_API_KEY, baseUrl = process.env.LLM_BASE_URL,
  budgetTokens = Number(process.env.LLM_BUDGET_TOKENS || 3_000_000), usageFile = null, role = "agent", mock = null, shared = null } = {}) {
  // shared — общий бюджет на несколько ролей (например, на всех агентов стенда): { used, limit }
  const usage = { calls: 0, input: 0, output: 0, errors: 0 };
  const log = (row) => { if (!usageFile) return; try { mkdirSync(dirname(usageFile), { recursive: true }); appendFileSync(usageFile, JSON.stringify({ ts: new Date().toISOString(), role, model, ...row }) + "\n"); } catch {} };

  async function raw(system, user, { maxTokens = 2000, temperature = 0 } = {}) {
    if (usage.input + usage.output >= budgetTokens) throw new Error(`бюджет токенов исчерпан (${budgetTokens})`);
    if (shared && shared.used >= shared.limit) throw new Error(`общий бюджет токенов стенда исчерпан (${shared.limit})`);
    if (provider === "mock") { const text = mock(system, user); usage.calls++; usage.input += Math.ceil((system.length + user.length) / 4); usage.output += Math.ceil(text.length / 4); return text; }
    if (!apiKey && !(provider === "gigachat" && process.env.GIGACHAT_AUTH_KEY)) throw new Error("не задан LLM_API_KEY (или GIGACHAT_AUTH_KEY для GigaChat)");
    // повторы: при 429 (лимит запросов) и 5xx — до LLM_RETRIES попыток с растущей паузой (не больше 30 с)
    const RETRIES = Number(process.env.LLM_RETRIES || 5);
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        let r, j, text, inTok, outTok;
        await acquire();
        try {
        if (provider === "gigachat") {
          const tok = await gigachatToken(process.env.GIGACHAT_AUTH_KEY || apiKey);
          // temperature < 0.001 — у GigaChat «режим строгого контроля, дающий одинаковые ответы»
          r = await fetch(`${(process.env.GIGACHAT_BASE_URL || "https://api.giga.chat").replace(/\/$/, "")}/v1/chat/completions`, { method: "POST", signal: AbortSignal.timeout(120_000),
            headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${tok}` },
            body: JSON.stringify({ model, max_tokens: maxTokens, temperature: temperature > 0 ? temperature : 0.0005, messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
          j = await r.json().catch(() => ({}));
          if (r.status === 401) gigaTok = null;
          if (!r.ok) throw Object.assign(new Error(j?.message || `HTTP ${r.status}`), { status: r.status === 401 ? 503 : r.status });
          text = j.choices?.[0]?.message?.content || ""; inTok = j.usage?.prompt_tokens || 0; outTok = j.usage?.completion_tokens || 0;
        } else if (provider === "anthropic") {
          r = await fetch(`${baseUrl || "https://api.anthropic.com"}/v1/messages`, { method: "POST", signal: AbortSignal.timeout(120_000),
            headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model, max_tokens: maxTokens, temperature, system, messages: [{ role: "user", content: user }] }) });
          j = await r.json();
          if (!r.ok) throw Object.assign(new Error(j?.error?.message || `HTTP ${r.status}`), { status: r.status });
          text = (j.content || []).map((c) => c.text || "").join(""); inTok = j.usage?.input_tokens || 0; outTok = j.usage?.output_tokens || 0;
        } else {
          r = await fetch(`${(baseUrl || "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`, { method: "POST", signal: AbortSignal.timeout(120_000),
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...(process.env.LLM_FOLDER_ID ? { "OpenAI-Project": process.env.LLM_FOLDER_ID } : {}) },
            body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
          j = await r.json();
          if (!r.ok) throw Object.assign(new Error(j?.error?.message || `HTTP ${r.status}`), { status: r.status });
          text = j.choices?.[0]?.message?.content || ""; inTok = j.usage?.prompt_tokens || 0; outTok = j.usage?.completion_tokens || 0;
        }
        } finally { release(); }
        usage.calls++; usage.input += inTok; usage.output += outTok; if (shared) shared.used += inTok + outTok;
        log({ in: inTok, out: outTok });
        return text;
      } catch (e) {
        usage.errors++;
        log({ error: String(e.message).slice(0, 200) });
        if (e.status && e.status < 500 && e.status !== 429) throw e;
        if (attempt === RETRIES - 1) throw e;
        await new Promise((ok) => setTimeout(ok, Math.min(30_000, (e.status === 429 ? 4000 : 2000) * (attempt + 1) ** 2)));
      }
    }
  }

  // Ответ в JSON: модель просят вернуть только JSON, разбор терпим к обрамлению ```json
  async function json(system, user, opts) {
    const text = await raw(`${system}\n\nОтвечай только JSON без пояснений.`, user, opts);
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = (m ? m[1] : text).trim();
    const start = body.search(/[[{]/);
    try { return JSON.parse(body.slice(start)); }
    catch {
      // модель дописала текст после JSON — обрезаем по последней закрывающей скобке того же вида
      const close = body[start] === "[" ? "]" : "}";
      for (let end = body.lastIndexOf(close); end > start; end = body.lastIndexOf(close, end - 1)) { try { return JSON.parse(body.slice(start, end + 1)); } catch {} }
      throw new Error(`модель вернула не JSON: ${text.slice(0, 160)}`);
    }
  }

  return { raw, json, usage, model, provider };
}
