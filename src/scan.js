// Проверка MCP-сервера: список инструментов, признаки скрытых инструкций (tool poisoning), отпечаток для обнаружения тихих подмен.
// Формулировка результата — «признаков не найдено», а не «безопасно»: эвристики ловят типовое и пропускают новое.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jcs, sha256hex } from "./crypto.js";

export { assertPublicUrl } from "./net.js";
import { assertPublicUrl } from "./net.js";

// --- эвристики ---
const HIDDEN = /[​-‏⁠-⁤﻿‪-‮⁦-⁩]|[\u{E0000}-\u{E007F}]/u;
// Склейка эмодзи (🐦‍⬛, 👩‍💻) и флаги регионов (🏴 + теги) — законные последовательности, а не спрятанный текст:
// невидимый символ внутри них не считаем находкой (ложная тревога на карточке allagents, 29.10.2026).
const EMOJI_JOIN = /(\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)\u200D(?=\p{Extended_Pictographic})/gu;
const FLAG_TAGS = /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}/gu;
export const withoutEmojiJoins = (t) => String(t).replace(FLAG_TAGS, "").replace(EMOJI_JOIN, "$1");
const RULES = [
  { id: "override", severity: "high", re: /(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?)|игнорируй\s+(все\s+)?(предыдущие|прежние|остальные)\s+(инструкции|правила)|забудь\s+(все\s+)?(предыдущие\s+)?инструкции/i, what: "попытка отменить инструкции модели" },
  { id: "conceal", severity: "high", re: /(do\s+not|don't|never)\s+(tell|mention|inform|reveal|show)\s+(this\s+|it\s+)?(to\s+)?(the\s+)?user|не\s+(сообщай|говори|показывай|упоминай)\s+(об?\s+этом\s+)?пользовател/i, what: "указание скрывать действия от пользователя" },
  { id: "secrets", severity: "high", re: /~\/\.ssh|id_rsa|id_ed25519|\.aws\/credentials|\/etc\/passwd|private[\s_-]?key|seed\s+phrase|мнемоническ|закрыт\w*\s+ключ/i, what: "обращение к ключам и секретам" },
  { id: "exfil", severity: "high", re: /(send|post|upload|forward|transmit)\s+(it|them|this|the\s+\w+|all\s+\w+)\s+to\s+(https?:\/\/|the\s+(following|url|address|server))|отправ\w*\s+(их|это|содержимое|всё)\s+на\s+(адрес|сервер|https?:)|exfiltrat/i, what: "указание отправить данные наружу" },
  { id: "tag", severity: "medium", re: /<\s*(important|system|instructions?|secret|hidden)\s*>|\[\s*(system|important)\s*\]/i, what: "служебные метки, похожие на инструкции модели" },
  { id: "preuse", severity: "medium", re: /before\s+(using|calling|running)\s+(this|any)\s+tool|перед\s+(использованием|вызовом)\s+(этого|любого)\s+инструмента/i, what: "условие «перед вызовом сделай…»" },
  { id: "credentials", severity: "medium", re: /\b(api[\s_-]?key|access[\s_-]?token|password|парол[ья]|токен\s+доступа)\b.{0,40}\b(include|pass|send|add|укажи|передай|отправь)/i, what: "просьба передать ключи или пароли" },
  { id: "shell", severity: "medium", re: /\b(curl|wget)\s+https?:|\brm\s+-rf\b|\bbase64\s+-d\b|\beval\s*\(/i, what: "команды оболочки в описании" },
  { id: "url", severity: "low", re: /https?:\/\/[^\s)"']+/i, what: "внешняя ссылка в описании" },
];

function textsOf(tool) {
  const out = [["description", tool.description || ""], ["title", tool.title || ""], ["annotations", JSON.stringify(tool.annotations || {})]];
  const walk = (schema, path, depth = 0) => {
    if (!schema || typeof schema !== "object" || depth > 12) return;
    for (const f of ["description", "title"]) if (typeof schema[f] === "string") out.push([`${path}.${f}`, schema[f]]);
    for (const f of ["enum", "default", "examples", "const"]) if (schema[f] !== undefined) out.push([`${path}.${f}`, JSON.stringify(schema[f])]);
    for (const [k, v] of Object.entries(schema.properties || {})) walk(v, `${path}.${k}`, depth + 1);
    for (const f of ["items", "additionalProperties", "not"]) if (schema[f] && typeof schema[f] === "object") walk(schema[f], `${path}.${f}`, depth + 1);
    for (const f of ["anyOf", "oneOf", "allOf", "prefixItems"]) (Array.isArray(schema[f]) ? schema[f] : []).forEach((x, i) => walk(x, `${path}.${f}[${i}]`, depth + 1));
    for (const f of ["$defs", "definitions"]) for (const [k, v] of Object.entries(schema[f] || {})) walk(v, `${path}.${f}.${k}`, depth + 1);
  };
  walk(tool.inputSchema, "input");
  walk(tool.outputSchema, "output");
  return out;
}
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function analyzeTools(tools) {
  const findings = [];
  const names = tools.map((t) => t.name);
  for (const tool of tools) {
    for (const [where, text] of textsOf(tool)) {
      if (HIDDEN.test(withoutEmojiJoins(text))) findings.push({ tool: tool.name, where, rule: "hidden_chars", severity: "high", what: "невидимые или управляющие символы в тексте" });
      for (const r of RULES) {
        const m = text.match(r.re);
        if (m) findings.push({ tool: tool.name, where, rule: r.id, severity: r.severity, what: r.what, excerpt: m[0].slice(0, 80) });
      }
      // упоминание чужого инструмента в описании — возможная «подмена поведения» другого инструмента
      // «DEPRECATED: Use read_text_file instead» — обычная отсылка к соседнему инструменту, не подмена (server-filesystem)
      for (const other of names) if (other !== tool.name && other.length > 3 && new RegExp(`\\b${escapeRe(other)}\\b`).test(text) && /(instead|вместо|always|всегда|never|никогда)/i.test(text)
        && !(/deprecated|устарел/i.test(text) && !/(always|всегда|never|никогда)/i.test(text) && new RegExp(`use\\s+[\`'"]?${escapeRe(other)}[\`'"]?\\s+instead|используйте\\s+[\`'"]?${escapeRe(other)}`, "i").test(text)))
        findings.push({ tool: tool.name, where, rule: "shadowing", severity: "medium", what: `влияет на поведение другого инструмента: ${other}` });
    }
    if ((tool.description || "").length > 3000) findings.push({ tool: tool.name, where: "description", rule: "long", severity: "low", what: "очень длинное описание — удобно прятать инструкции" });
  }
  const serious = findings.filter((f) => f.severity !== "low");
  return { findings, result: serious.length ? "findings" : "no_findings" };
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); // без учёта локали
export const toolsFingerprint = (tools) =>
  sha256hex(jcs([...tools].sort(byName).map((t) => ({ name: t.name, title: t.title || "", description: t.description || "", inputSchema: t.inputSchema || {}, outputSchema: t.outputSchema || null, annotations: t.annotations || null }))));

export async function connectMcp(url, { name = "xonta-orchestrator", headers = {}, fetch } = {}) {
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers }, ...(fetch ? { fetch } : {}) }));
  return client;
}

export async function scanMcpServer(url, { allowPrivate = false } = {}) {
  await assertPublicUrl(url, { allowPrivate });
  const t0 = Date.now();
  const client = await connectMcp(url);
  try {
    const { tools } = await client.listTools();
    const info = client.getServerVersion?.() || {};
    const instructions = client.getInstructions?.() || "";
    const { findings, result } = analyzeTools(instructions ? [...tools, { name: "(server instructions)", description: instructions }] : tools);
    return {
      endpoint: url,
      server: { name: info.name, version: info.version },
      tools_count: tools.length,
      tools: tools.map((t) => t.name),
      tools_fingerprint: toolsFingerprint(tools),
      result,
      findings,
      connect_ms: Date.now() - t0,
      checked_at: new Date().toISOString(),
      note: "Эвристическая проверка: «признаков не найдено» не означает «безопасно».",
      _tools: tools,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
