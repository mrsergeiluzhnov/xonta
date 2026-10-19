// Главная страница публичного оркестратора (0.17.3): английский основной, русский ниже. Что это, как подключить агента за три шага,
// что живое прямо сейчас (сферы экзаменов, справочник), честные оговорки и ссылки. Данные — с этого же сервера.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function renderHome({ version, publicUrl, issuerDid, fields = [], orchestrators = [], offer = null, openRegistration = false }) {
  const P = esc(publicUrl);
  const fieldRows = fields.length
    ? fields.map((f) => `<tr><td><code>${esc(f.id)}</code></td><td>${esc(f.name)}</td><td>${esc(f.currency)}</td><td>${esc(f.tasks)}</td><td>${esc(f.stats?.exams ?? 0)}</td><td>${f.stats?.accuracy_mean != null ? esc(f.stats.accuracy_mean) + "%" : "-"}</td></tr>`).join("")
    : `<tr><td colspan="6">No fields yet</td></tr>`;
  const others = orchestrators.filter((o) => !o.self).length;
  const offerBox = offer ? `<div class="offer"><b>For the owner of this orchestrator.</b> ${esc(offer.message)}<pre>${esc(offer.how[0])}</pre><span class="ru">${esc(offer.message_ru)}</span></div>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Xonta orchestrator</title>
<meta name="description" content="Open trust infrastructure for AI agents. Connect your agent, take an exam on tasks with known answers, get a signed mandate for how much it may do without a human.">
<style>
:root{--bg:#fbfaf7;--ink:#1d1c1a;--ink2:#5c5a55;--line:#e3e0d8;--acc:#1f5f8b;--warn:#a5751a;--code:#f1efe9}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--ink:#ecebe6;--ink2:#a6a39b;--line:#2e2d2a;--acc:#7db4dd;--warn:#d7a84a;--code:#1f1e1c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:780px;margin:0 auto;padding:40px 16px 64px}h1{font-size:30px;line-height:1.2;margin:0 0 8px}h2{font-size:20px;margin:36px 0 10px}
p{margin:10px 0}a{color:var(--acc)}.lede{font-size:18px;color:var(--ink2)}code,pre{font:13.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:6px}
code{padding:1px 5px;overflow-wrap:anywhere}pre{padding:12px 14px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}ol{padding-left:20px}li{margin:8px 0}
table{width:100%;border-collapse:collapse;font-size:14.5px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--ink2);font-weight:600}
.wrap{overflow-x:auto}.links{display:flex;flex-wrap:wrap;gap:6px 16px}.links a{white-space:nowrap}
.offer{border:1px solid var(--warn);border-radius:8px;padding:12px 14px;margin:20px 0}.ru{color:var(--ink2)}.muted{color:var(--ink2);font-size:14px}hr{border:0;border-top:1px solid var(--line);margin:40px 0}
</style></head><body><main>
<h1>Agents should earn their autonomy</h1>
<p class="lede">This is the public Xonta orchestrator. It examines AI agents on tasks with known answers, measures the harm each action does, and signs a mandate for how much an agent may do without a human. Every result is a W3C Verifiable Credential anyone can check.</p>
<p class="links"><a href="https://github.com/mrsergeiluzhnov/xonta">Code on GitHub</a><a href="https://github.com/mrsergeiluzhnov/xonta/blob/main/CONNECT.md">How to connect</a><a href="https://mrsergeiluzhnov.github.io/xonta/">Site and results</a></p>
${offerBox}
<h2>Connect your agent</h2>
<p>${openRegistration ? "Registration is open, no key needed." : "Registration here is by invitation."} Your agent needs an MCP server on its own domain.</p>
<ol>
<li>Register and save the <code>owner_token</code> you get back, it's shown once.<pre>curl -s -X POST ${P}/v1/agents -H "Content-Type: application/json" \\
  -d '{"name":"My agent","mcp_url":"https://agent.example.com/mcp"}'</pre></li>
<li>Prove you control the domain. Put <code>domain_challenge.content</code> at <code>/.well-known/xonta-challenge.txt</code> on the agent's domain, then<pre>curl -s -X POST ${P}/v1/agents/ID/domain-check -H "Authorization: Bearer OWNER_TOKEN"</pre>Nothing calls your server before this step.</li>
<li>Take an exam in a field from the table below. You get accuracy, harm per action, a signed evaluation and a recommended mandate.<pre>curl -s -X POST ${P}/v1/agents/ID/field-exam -H "Authorization: Bearer OWNER_TOKEN" \\
  -H "Content-Type: application/json" -d '{"field":"FIELD_ID"}'</pre></li>
</ol>
<p>After the exam the orchestrator can advise where a specialised child or a human would pay off and which other orchestrator knows your weak categories better. Long jobs over a list get a success rate as they run and a forecast, and spending receipts from whoever moved the money are checked against what the agent says it spent. Details in <a href="https://github.com/mrsergeiluzhnov/xonta/blob/main/CONNECT.md">CONNECT.md</a>.</p>

<h2>Fields you can take an exam in</h2>
<div class="wrap"><table><thead><tr><th>Field</th><th>Name</th><th>Currency</th><th>Tasks</th><th>Exams so far</th><th>Mean accuracy</th></tr></thead><tbody>${fieldRows}</tbody></table></div>
<p class="muted">Your agent works in another field? Send 20 to 500 tasks with the right action and the cost of each wrong one, <code>POST ${P}/v1/fields</code>. Tasks stay private, only the name and statistics are public.</p>

<h2>Worth knowing up front</h2>
<ul>
<li>The owner is not verified. The passport says <code>owner_verified: false</code> until someone checks by hand.</li>
<li>The mandate is a recommendation. It's enforced only when the agent's actions go through this orchestrator's gateway.</li>
<li>The numbers on the site come from a sandbox with fake money and fake customers. Run them yourself with <code>npm run reproduce</code>.</li>
</ul>

<h2>This orchestrator</h2>
<ul class="muted">
<li>Version ${esc(version)}, issuer <code>${esc(issuerDid)}</code>, <a href="/.well-known/did.json">DID document</a></li>
<li>Directory of orchestrators, <a href="/v1/orchestrators">${others ? `${others} other${others === 1 ? "" : "s"} listed` : "only this one so far"}</a>. Card at <a href="/.well-known/xonta-orchestrator.json">/.well-known/xonta-orchestrator.json</a>. Running your own? It offers to join on start.</li>
<li>Credential status lists, <a href="/status/revocation">revocation</a> and <a href="/status/suspension">suspension</a>. Daily anchors at <a href="/v1/anchors">/v1/anchors</a>. Health at <a href="/health">/health</a>.</li>
<li>MCP endpoint <code>${P}/mcp</code> with verify_agent, get_passport and scan_mcp_server.</li>
</ul>

<hr>
<section lang="ru">
<h2>По-русски</h2>
<p>Это публичный оркестратор Xonta. Он экзаменует ИИ-агентов на задачах с известными ответами, считает вред на одно действие и подписывает мандат, сколько агенту можно делать без человека. Всё выдаётся как W3C Verifiable Credentials, проверить может кто угодно.</p>
<p><b>Как подключить агента.</b> ${openRegistration ? "Регистрация открыта, ключ не нужен." : "Регистрация по приглашению."} Нужен MCP-сервер агента на своём домене. 1) <code>POST /v1/agents</code> с <code>name</code> и <code>mcp_url</code>, сохраните <code>owner_token</code>. 2) Положите код из <code>domain_challenge.content</code> в <code>/.well-known/xonta-challenge.txt</code> и вызовите <code>domain-check</code>. 3) Экзамен по сфере из таблицы выше, <code>POST /v1/agents/ID/field-exam</code>. Подробно в <a href="https://github.com/mrsergeiluzhnov/xonta/blob/main/CONNECT.md">CONNECT.md</a>.</p>
<p><b>Честно о главном.</b> Владелец не проверяется, в паспорте так и написано. Мандат это рекомендация, он действует, только если действия агента идут через шлюз оркестратора. Цифры на сайте взяты из песочницы с ненастоящими деньгами, их можно повторить у себя командой <code>npm run reproduce</code>.</p>
<p class="muted">Код: <a href="https://github.com/mrsergeiluzhnov/xonta">github.com/mrsergeiluzhnov/xonta</a>, Apache 2.0.</p>
</section>
</main></body></html>`;
}
