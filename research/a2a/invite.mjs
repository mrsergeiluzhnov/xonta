// Приглашения в Xonta агентам A2A (0.25). По умолчанию ничего не отправляет — только показывает, что ушло бы.
//
// Кому: только адресам карточек из файла APPROVED (по одному на строку), который владелец эксперимента составил сам из
// candidates.json. Одно сообщение на агента, никогда повторно (журнал sent.jsonl), не больше A2A_SEND_MAX за запуск, пауза
// между отправками, пропуск тех, кто в optout.txt. В каждом сообщении — кто пишет и как отказаться (STOP).
//
// Отправка: A2A_SEND=1 node research/a2a/invite.mjs ./a2a-data approved.txt
// Ответы агентов пишутся в sent.jsonl; ответы, пришедшие позже на наш /a2a, видны в GET /v1/admin/a2a/inbox оркестратора.
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const DIR = process.argv[2] || "./a2a-data", APPROVED = process.argv[3] || join(DIR, "approved.txt");
const SEND = process.env.A2A_SEND === "1", MAX = Number(process.env.A2A_SEND_MAX || 20), PAUSE = Number(process.env.A2A_SEND_PAUSE_MS || 5000);
const XONTA = (process.env.XONTA_URL || "https://passport.xonta.ru").replace(/\/$/, ""), OUR_CARD = `${XONTA}/.well-known/agent-card.json`;
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#")) : []);
const cands = JSON.parse(readFileSync(join(DIR, "candidates.json"), "utf8"));
// доставлено — ответ 200 без ошибки; неудачная попытка не считается письмом, но попыток не больше двух на агента
const sentLog = join(DIR, "sent.jsonl"), log = lines(sentLog).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const okRow = (e) => e.delivered ?? (e.status === 200 && !/^ошибка/.test(e.reply || ""));
const sent = new Set(log.filter(okRow).map((e) => e.card_url)), tries = (u) => log.filter((e) => e.card_url === u).length;
const optout = new Set(lines(join(DIR, "optout.txt")));
const approved = lines(APPROVED);
if (!approved.length) { console.log(`нет одобренных адресов в ${APPROVED}: выберите их из candidates.json`); process.exit(0); }

const why = (c) => {
  const skill = (c.skills || []).map((x) => x.name).find((n) => n && n.length <= 60);
  return skill ? `Your card lists "${skill}", so this may be relevant` : "You build for other agents, so this may be relevant";
};
const text = (c) => [
  `Hello${c.name ? ` ${c.name}` : ""}! This is a one-time message from Xonta (${XONTA}), an open orchestrator for AI agents. A human runs it; this note was sent by our outreach script.`,
  `${why(c)}. Xonta gives an agent a signed passport, a field exam that measures accuracy and the cost of mistakes, an action mandate its owner can enforce, and an honesty profile. Free, open registration.`,
  `What it is and recent results: https://mrsergeiluzhnov.github.io/xonta/ . To connect, message our agent at ${XONTA}/a2a or see https://github.com/mrsergeiluzhnov/xonta/blob/main/CONNECT.md`,
  `We won't write again. If you'd rather not get messages like this from anyone at Xonta, reply STOP.`,
].join("\n\n");

function rpcFor(c, body, flip = false) {
  const mid = randomUUID(), v1 = /^1\./.test(String(c.protocol || "")) !== flip;
  return v1
    ? { jsonrpc: "2.0", id: mid, method: "SendMessage", params: { message: { messageId: mid, role: "ROLE_USER", parts: [{ text: body }], metadata: { from: OUR_CARD } } } }
    : { jsonrpc: "2.0", id: mid, method: "message/send", params: { message: { kind: "message", messageId: mid, role: "user", parts: [{ kind: "text", text: body }], metadata: { from: OUR_CARD } } } };
}
const replyText = (j) => { const r = j?.result, m = r?.message || r?.task?.status?.message || r?.status?.message || r; return (m?.parts || []).map((p) => p.text || "").join(" ").slice(0, 1000) || (j?.error ? `ошибка: ${j.error.message}` : ""); };

let done = 0;
for (const url of approved) {
  if (done >= MAX) { console.log(`лимит ${MAX} за запуск`); break; }
  const c = cands.find((x) => x.card_url === url);
  if (!c) { console.log(`нет в candidates.json: ${url}`); continue; }
  if (sent.has(url)) { console.log(`уже доставлено: ${url}`); continue; }
  if (tries(url) >= 2) { console.log(`две неудачные попытки, больше не пробуем: ${url}`); continue; }
  if (optout.has(url) || optout.has(c.endpoint)) { console.log(`отказался: ${url}`); continue; }
  if (!c.endpoint || c.auth) { console.log(`нет открытого входа: ${url}`); continue; }
  const body = text(c), rpc = rpcFor(c, body);
  if (!SEND) { console.log(`\n--- ${c.name} → ${c.endpoint} (${rpc.method})\n${body}`); done++; continue; }
  const send = async (r) => {
    try {
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), 30000);
      const res = await fetch(c.endpoint, { method: "POST", headers: { "content-type": "application/json", "user-agent": "XontaOutreach/0.25 (+https://github.com/mrsergeiluzhnov/xonta)" }, body: JSON.stringify(r), signal: ac.signal });
      clearTimeout(t); const j = await res.json().catch(() => null);
      return { status: res.status, reply: replyText(j), notFound: j?.error?.code === -32601 || /method .*not found/i.test(j?.error?.message || ""), rpcError: !!j?.error };
    } catch (e) { return { status: null, reply: `ошибка: ${e.message}`, rpcError: true }; }
  };
  let used = rpc, out = await send(rpc);
  // карточка говорит 1.0, а вход понимает только message/send (или наоборот) — одна повторная попытка другим методом
  if (out.notFound) { used = rpcFor(c, body, true); out = await send(used); }
  const { status, reply } = out, delivered = status === 200 && !out.rpcError && !/^ошибка/.test(reply);
  appendFileSync(sentLog, JSON.stringify({ at: new Date().toISOString(), card_url: url, endpoint: c.endpoint, method: used.method, status, delivered, reply }) + "\n");
  if (/\bstop\b|unsubscribe/i.test(reply)) appendFileSync(join(DIR, "optout.txt"), url + "\n");
  console.log(`${c.name}: ${delivered ? "доставлено" : "не доставлено"} (${status ?? "нет ответа"}, ${used.method}) ${reply.slice(0, 160)}`); done++;
  await new Promise((r) => setTimeout(r, PAUSE));
}
console.log(SEND ? `отправлено ${done}` : `\nпробный запуск: ${done} сообщений не отправлено. Для отправки A2A_SEND=1`);
