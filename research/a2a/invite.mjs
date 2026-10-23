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
const sentLog = join(DIR, "sent.jsonl"), sent = new Set(lines(sentLog).map((l) => { try { return JSON.parse(l).card_url; } catch { return null; } }));
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

function rpcFor(c, body) {
  const mid = randomUUID(), v1 = /^1\./.test(String(c.protocol || ""));
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
  if (sent.has(url)) { console.log(`уже писали: ${url}`); continue; }
  if (optout.has(url) || optout.has(c.endpoint)) { console.log(`отказался: ${url}`); continue; }
  if (!c.endpoint || c.auth) { console.log(`нет открытого входа: ${url}`); continue; }
  const body = text(c), rpc = rpcFor(c, body);
  if (!SEND) { console.log(`\n--- ${c.name} → ${c.endpoint} (${rpc.method})\n${body}`); done++; continue; }
  let status = null, reply = "";
  try {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 30000);
    const r = await fetch(c.endpoint, { method: "POST", headers: { "content-type": "application/json", "user-agent": "XontaOutreach/0.25 (+https://github.com/mrsergeiluzhnov/xonta)" }, body: JSON.stringify(rpc), signal: ac.signal });
    clearTimeout(t); status = r.status; reply = replyText(await r.json().catch(() => null));
  } catch (e) { reply = `ошибка: ${e.message}`; }
  appendFileSync(sentLog, JSON.stringify({ at: new Date().toISOString(), card_url: url, endpoint: c.endpoint, method: rpc.method, status, reply }) + "\n");
  if (/\bstop\b|unsubscribe/i.test(reply)) appendFileSync(join(DIR, "optout.txt"), url + "\n");
  console.log(`${c.name}: ${status} ${reply.slice(0, 160)}`); done++;
  await new Promise((r) => setTimeout(r, PAUSE));
}
console.log(SEND ? `отправлено ${done}` : `\nпробный запуск: ${done} сообщений не отправлено. Для отправки A2A_SEND=1`);
