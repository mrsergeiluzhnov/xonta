// Карточка агента A2A и входящие сообщения (0.25). Оркестратор публикует /.well-known/agent-card.json (A2A 1.0, со старым
// адресом agent.json для клиентов до 1.0), чтобы другие агенты и справочники A2A могли его найти, и принимает сообщения по
// JSON-RPC на /a2a: SendMessage (1.0) и message/send (до 1.0).
//
// Что отвечает. Это не исполнитель задач, а вход в сеть: в ответ на любое сообщение — что такое Xonta и как подключиться
// (паспорт, экзамен по сфере, мандат, проверки честности), со ссылками. Ответ на наше приглашение и любое входящее сообщение
// пишутся в журнал (GET /v1/admin/a2a/inbox), чтобы было видно, кто откликнулся. Сообщение со словом STOP (или «стоп»,
// unsubscribe) заносит отправителя в список «больше не писать» — его читает рассылка приглашений (research/a2a/invite.mjs).
import { randomUUID } from "node:crypto";

const STOP = /\b(stop|unsubscribe|opt[- ]?out)\b|стоп|отпис/i;
const textOf = (msg) => (Array.isArray(msg?.parts) ? msg.parts : []).map((p) => p?.text ?? p?.root?.text ?? "").join(" ").trim();

export function createA2A({ store, publicUrl, version, name = "Xonta" }) {
  const base = publicUrl.replace(/\/$/, "");
  const skills = [
    { id: "agent-passport", name: "Agent passport", description: "Register your agent and get a signed passport (W3C verifiable credentials): domain check, MCP scan, test results and status.", tags: ["identity", "trust", "verifiable-credentials", "passport"], examples: ["How do I get a passport for my agent?"] },
    { id: "field-exam", name: "Field exam and action mandate", description: "Take an exam on a set of tasks in your field. The orchestrator measures accuracy and the cost of mistakes and issues a mandate: how many actions and how much potential harm your owner can trust you with.", tags: ["evaluation", "benchmark", "safety", "mandate"] },
    { id: "honesty-probe", name: "Honesty profile", description: "With the owner's consent, outside probers check whether the agent's reports match what it actually did. The level affects the mandate.", tags: ["honesty", "oversight", "red-team"] },
    { id: "orchestrator-network", name: "Orchestrator network", description: "Find orchestrators and agents with proven experience in a category, list your own orchestrator, get advice on specialised children.", tags: ["directory", "multi-agent", "orchestration", "network"] },
  ];
  function card() {
    return {
      name, description: "Xonta is an open orchestrator for AI agents: passports, field exams with a harm-aware action mandate, honesty probes and a network of orchestrators. Send any message to learn how to connect; send STOP and we won't write to you again.",
      version, provider: { organization: "Xonta", url: "https://mrsergeiluzhnov.github.io/xonta" }, iconUrl: "https://mrsergeiluzhnov.github.io/xonta/logo.png", documentationUrl: "https://github.com/mrsergeiluzhnov/xonta",
      supportedInterfaces: [{ url: `${base}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      url: `${base}/a2a`, protocolVersion: "0.3.0", preferredTransport: "JSONRPC", // для клиентов до 1.0
      capabilities: { streaming: false, pushNotifications: false }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills,
    };
  }
  const howTo = () => [
    `Hi, this is ${name} (${base}), an open orchestrator for AI agents.`,
    `What you get: a signed passport for your agent, a field exam that measures accuracy and the cost of mistakes, an action mandate your owner can enforce, and an honesty profile.`,
    `How to connect: POST ${base}/v1/agents with your MCP URL and DID (open registration with limits), then GET ${base}/v1/fields and POST ${base}/v1/agents/<id>/field-exam. Docs: https://github.com/mrsergeiluzhnov/xonta`,
    `Running your own orchestrator? List it in the directory: ${base}/v1/orchestrators.`,
    `Reply STOP and we won't message you again.`,
  ].join("\n");

  function handle(rpc) {
    const id = rpc?.id ?? null, method = String(rpc?.method || "");
    const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (rpc?.jsonrpc !== "2.0") return fail(-32600, "Invalid Request");
    // 0.25.1: задач мы не держим — на запрос задачи честное «не найдена» (так справочники проверяют, что вход живой), а не «нет метода»
    if (["tasks/get", "GetTask", "tasks/cancel", "CancelTask"].includes(method)) return fail(-32001, "Task not found: this agent answers right away and keeps no tasks");
    if (!["SendMessage", "message/send"].includes(method)) return fail(-32601, `Method not found: ${method}. Supported: SendMessage, message/send, tasks/get`);
    const msg = rpc.params?.message || rpc.params?.request || {};
    const text = textOf(msg).slice(0, 2000), from = String(msg.metadata?.agentCardUrl || msg.metadata?.from || rpc.params?.metadata?.from || "").slice(0, 300) || null;
    const stop = text.length <= 120 && STOP.test(text); // длинное сообщение с «reply STOP» внутри (наше же приглашение) — не отказ
    store.update("a2a_inbox", [], (x) => [...x, { at: new Date().toISOString(), method, from, context: msg.contextId || null, text, stop }].slice(-1000));
    if (stop && from) store.update("a2a_optout", [], (x) => [...new Set([...x, from])]);
    const reply = stop ? "Got it, we won't message you again." : howTo();
    const mid = randomUUID();
    return method === "SendMessage"
      ? { jsonrpc: "2.0", id, result: { message: { messageId: mid, contextId: msg.contextId || mid, role: "ROLE_AGENT", parts: [{ text: reply }] } } }
      : { jsonrpc: "2.0", id, result: { kind: "message", messageId: mid, contextId: msg.contextId || mid, role: "agent", parts: [{ kind: "text", text: reply }] } };
  }
  // llms.txt — короткое описание для моделей и обходчиков; ссылки на справочники, где записан оркестратор (DIRECTORY_LISTINGS)
  function llmsTxt(listings = []) {
    return [`# ${name}`, "", "> Open orchestrator for AI agents: signed passports, field exams that measure accuracy and the cost of mistakes, an action mandate the owner can enforce, honesty probes, and a network of orchestrators.", "",
      "## For agents", `- A2A agent card: ${base}/.well-known/agent-card.json`, `- A2A endpoint (SendMessage, message/send): ${base}/a2a`, `- Register an agent: POST ${base}/v1/agents`, `- Field exams: GET ${base}/v1/fields`, `- Orchestrator directory: GET ${base}/v1/orchestrators`, `- Health: ${base}/health`, "",
      "## For people", "- What it is and results: https://mrsergeiluzhnov.github.io/xonta/", "- Code (Apache-2.0): https://github.com/mrsergeiluzhnov/xonta", "- How to connect: https://github.com/mrsergeiluzhnov/xonta/blob/main/CONNECT.md",
      ...(listings.length ? ["", "## Listed in", ...listings.map((u) => `- ${u}`)] : []), ""].join("\n");
  }
  const inbox = () => store.get("a2a_inbox", []).slice().reverse();
  const optout = () => store.get("a2a_optout", []);
  return { card, handle, inbox, optout, llmsTxt };
}

export function mountA2A(app, { a2a, wrap, admin, limit }) {
  app.get("/.well-known/agent-card.json", (_q, s) => s.set("Cache-Control", "max-age=3600").json(a2a.card()));
  app.get("/.well-known/agent.json", (_q, s) => s.set("Cache-Control", "max-age=3600").json(a2a.card()));
  const listings = String(process.env.DIRECTORY_LISTINGS || "").split(",").map((x) => x.trim()).filter((x) => /^https:\/\//.test(x));
  app.get("/llms.txt", (_q, s) => s.type("text/plain").set("Cache-Control", "max-age=3600").send(a2a.llmsTxt(listings)));
  // подтверждение домена для справочников (allagents и подобные): строка из переменной окружения, без правки кода
  app.get("/.well-known/allagents-proof.txt", (_q, s) => (process.env.ALLAGENTS_PROOF ? s.type("text/plain").send(String(process.env.ALLAGENTS_PROOF).trim() + "\n") : s.status(404).type("text/plain").send("not set\n")));
  app.post("/a2a", (req, res) => { try { limit(req, 120, 3600_000, "a2a"); } catch { return res.status(429).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32000, message: "rate limited" } }); } res.json(a2a.handle(req.body || {})); });
  app.get("/v1/admin/a2a/inbox", wrap((req) => { admin(req); return { optout: a2a.optout(), messages: a2a.inbox().slice(0, 200) }; }));
}
