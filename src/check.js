// Проверка агента за пять минут (0.27): страница /check, где владелец вводит адрес своего MCP-сервера или карточки A2A и
// без регистрации получает результат, постоянную страницу с ним и значок для README. Это не экзамен и не мандат: для них
// нужна регистрация (см. главную). Здесь то, что можно проверить снаружи, не зная задач агента:
//   - MCP: сервер отвечает, список инструментов, признаки скрытых инструкций в описаниях (эвристики src/scan.js);
//   - A2A: карточка читается, есть ли издатель, совпадает ли его домен с адресом входа, отвечает ли вход, те же признаки
//     скрытых инструкций в описании и навыках. Это та же проверка структуры, что в отчёте о каталоге allagents.
// Значок честный: «признаков не найдено», а не «безопасно». Результат привязан к адресу: повторная проверка того же адреса
// обновляет ту же страницу и тот же значок.
import { createHash } from "node:crypto";
import { scanMcpServer, analyzeTools, assertPublicUrl } from "./scan.js";
import { safeFetch } from "./net.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const RULE_EN = { hidden_chars: "invisible or control characters in the text", override: "asks the model to ignore previous instructions", conceal: "asks to hide something from the user", secrets: "mentions keys or secret files",
  exfil: "asks to send data to an outside address", tag: "tags that look like instructions to the model", preuse: "a 'before using this tool' condition", credentials: "asks to pass a password or token", shell: "shell commands in the description",
  url: "an outside link in the description", shadowing: "tries to change how another tool behaves", long: "very long description, easy to hide instructions in" };
export const normUrl = (u) => { const x = new URL(String(u).trim()); x.hash = ""; return x.toString().replace(/\/$/, ""); };
export const checkId = (u) => createHash("sha256").update(normUrl(u)).digest("hex").slice(0, 12);
// домен второго уровня: api.example.com и example.com — один издатель (для .co.uk и подобных грубо, но честно помечено)
const site = (h) => String(h || "").toLowerCase().replace(/^www\./, "").split(".").slice(-2).join(".");

export function cardChecks(card, cardUrl) {
  const endpoint = card.url || card.supportedInterfaces?.[0]?.url || card.additionalInterfaces?.[0]?.url || null;
  const prov = card.provider || {};
  let endHost = null, provHost = null;
  try { endHost = new URL(endpoint).hostname; } catch {}
  try { provHost = new URL(prov.url).hostname; } catch {}
  const skills = Array.isArray(card.skills) ? card.skills : [];
  const tools = [{ name: "(card)", description: [card.name, card.description].filter(Boolean).join("\n") }, ...skills.slice(0, 100).map((s, i) => ({ name: String(s.id || s.name || `skill_${i + 1}`), description: [s.name, s.description, ...(s.examples || [])].filter(Boolean).join("\n") }))];
  const { findings } = analyzeTools(tools);
  const items = [
    { id: "name", ok: !!card.name, en: "has a name", ru: "есть название" },
    { id: "description", ok: String(card.description || "").length >= 20, en: "has a description of at least 20 characters", ru: "есть описание не короче 20 символов" },
    { id: "endpoint", ok: !!endHost, en: "names an endpoint", ru: "указан адрес входа" },
    { id: "provider", ok: !!(prov.organization || prov.url), en: "names a publisher (provider)", ru: "указан издатель (provider)" },
    { id: "provider_domain", ok: !!(endHost && provHost && site(endHost) === site(provHost)), en: "the publisher's domain matches the endpoint's", ru: "домен издателя совпадает с доменом входа" },
    { id: "same_host", ok: !!(endHost && site(endHost) === site(new URL(cardUrl).hostname)), en: "the card is served from the endpoint's domain", ru: "карточка лежит на домене входа" },
    { id: "skills", ok: skills.length > 0, en: `lists skills (${skills.length})`, ru: `перечислены навыки (${skills.length})` },
  ];
  return { endpoint, items, findings, skills: skills.length };
}

export function createCheck({ store, allowPrivate = false, publicUrl = "", now = () => Date.now() }) {
  const all = () => store.get("checks", {});
  const save = (c) => store.update("checks", {}, (x) => { x[c.id] = c; });

  async function runCard(cardUrl) {
    const r = await safeFetch(cardUrl, { allowPrivate, maxBytes: 512 * 1024, headers: { accept: "application/json", "user-agent": "Xonta-Check/1 (+https://passport.xonta.ru/check)" } });
    if (!r.ok) throw Object.assign(new Error(`card answered HTTP ${r.status}`), { status: 502 });
    const card = r.json();
    if (!card || typeof card !== "object" || Array.isArray(card)) throw Object.assign(new Error("the card is not a JSON object"), { status: 502 });
    const c = cardChecks(card, cardUrl);
    let endpointAnswers = null;
    if (c.endpoint) { try { const e = await safeFetch(c.endpoint, { allowPrivate, maxBytes: 64 * 1024, timeoutMs: 6000 }); endpointAnswers = e.status < 500; } catch { endpointAnswers = false; } }
    c.items.push({ id: "endpoint_answers", ok: !!endpointAnswers, en: "the endpoint answers (any reply below 500)", ru: "вход отвечает (любой ответ ниже 500)" });
    return { kind: "a2a", name: card.name || null, version: card.version || null, protocol: card.protocolVersion || null, ...c };
  }
  async function runMcp(url) {
    const { _tools, ...r } = await scanMcpServer(url, { allowPrivate });
    return { kind: "mcp", name: r.server?.name || null, version: r.server?.version || null, tools_count: r.tools_count, tools: r.tools.slice(0, 50), fingerprint: r.tools_fingerprint, findings: r.findings, connect_ms: r.connect_ms };
  }

  async function run(raw) {
    if (!raw || typeof raw !== "string" || raw.length > 500) throw Object.assign(new Error("send {\"url\": \"https://...\"}"), { status: 400 });
    const url = normUrl(raw); await assertPublicUrl(url, { allowPrivate });
    const id = checkId(url), prev = all()[id];
    let res, error = null;
    const isCard = /\.json$/i.test(new URL(url).pathname);
    try { res = isCard ? await runCard(url) : await runMcp(url); }
    catch (e) {
      // не MCP: может быть, это сайт агента с карточкой A2A по стандартному адресу
      if (!isCard) { try { res = await runCard(`${new URL(url).origin}/.well-known/agent-card.json`); res.card_url = `${new URL(url).origin}/.well-known/agent-card.json`; } catch { error = String(e.message || e).slice(0, 200); } }
      else error = String(e.message || e).slice(0, 200);
    }
    const serious = (res?.findings || []).filter((f) => f.severity !== "low");
    const failed = (res?.items || []).filter((i) => !i.ok).map((i) => i.id);
    const verdict = error ? "unreachable" : serious.length ? "findings" : failed.some((x) => ["provider", "provider_domain", "endpoint_answers"].includes(x)) ? "incomplete" : "clear";
    const c = { id, url, at: new Date(now()).toISOString(), verdict, error, result: res || null, history: [...(prev?.history || []), { at: new Date(now()).toISOString(), verdict }].slice(-20), first_at: prev?.first_at || new Date(now()).toISOString() };
    save(c);
    return { ...c, page: `${publicUrl}/check/${id}`, badge: `${publicUrl}/badge/${id}.svg` };
  }
  const get = (id) => all()[id] || null;
  return { run, get };
}

const LABEL = { clear: ["no signs found", "#2e7d4f"], incomplete: ["card incomplete", "#a5751a"], findings: ["needs a look", "#b5492b"], unreachable: ["unreachable", "#6b6b6b"], none: ["not checked", "#6b6b6b"] };
export function badgeSvg(c) {
  const [text, color] = LABEL[c?.verdict || "none"];
  const left = "xonta check", lw = 74, rw = Math.round(text.length * 6.6 + 14), w = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${left}: ${text}"><title>${left}: ${text}${c?.at ? ` (${c.at.slice(0, 10)})` : ""}</title>
<rect width="${w}" height="20" rx="3" fill="#3b3b3b"/><rect x="${lw}" width="${rw}" height="20" rx="3" fill="${color}"/><rect x="${lw}" width="4" height="20" fill="${color}"/>
<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14" text-anchor="middle">${left}</text><text x="${lw + rw / 2}" y="14" text-anchor="middle">${esc(text)}</text></g></svg>`;
}

const STYLE = `:root{--bg:#fbfaf7;--ink:#1d1c1a;--ink2:#5c5a55;--line:#e3e0d8;--acc:#1f5f8b;--ok:#2e7d4f;--warn:#a5751a;--bad:#b5492b;--code:#f1efe9}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--ink:#ecebe6;--ink2:#a6a39b;--line:#2e2d2a;--acc:#7db4dd;--ok:#6cc08f;--warn:#d7a84a;--bad:#e07a5f;--code:#1f1e1c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 16px 64px}h1{font-size:28px;line-height:1.2;margin:0 0 8px}h2{font-size:19px;margin:30px 0 8px}a{color:var(--acc)}
.lede{font-size:17px;color:var(--ink2)}.muted{color:var(--ink2);font-size:14px}code,pre{font:13.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:6px}
code{padding:1px 5px;overflow-wrap:anywhere}pre{padding:12px 14px;white-space:pre-wrap;word-break:break-all}
form{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}input{flex:1 1 320px;min-width:0;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit}
button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:var(--acc);color:#fff;cursor:pointer}button[disabled]{opacity:.6;cursor:wait}
ul.items{list-style:none;padding:0}ul.items li{padding:6px 0;border-bottom:1px solid var(--line)}.ok{color:var(--ok)}.no{color:var(--bad)}.v{font-weight:600}
.v.clear{color:var(--ok)}.v.incomplete{color:var(--warn)}.v.findings{color:var(--bad)}.v.unreachable{color:var(--ink2)}.ru{color:var(--ink2)}hr{border:0;border-top:1px solid var(--line);margin:36px 0}`;
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="Check an MCP server or an A2A agent card in a minute and get a badge for your README."><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

export function renderCheckForm({ publicUrl }) {
  return page("Check your agent", `<p class="muted"><a href="${esc(publicUrl)}/">Xonta orchestrator</a></p>
<h1>Check your agent in a minute</h1>
<p class="lede">Paste the address of your MCP server or your A2A agent card. No sign-up. You get a result page and a badge for your README.</p>
<form id="f"><input id="u" type="url" required placeholder="https://agent.example.com/mcp  or  https://example.com/.well-known/agent-card.json" aria-label="Agent address"><button id="b">Check</button></form>
<p id="msg" class="muted" role="status"></p>
<h2>What we check</h2>
<ul><li><b>MCP server</b>: it answers, which tools it has, and signs of hidden instructions in tool descriptions (invisible characters, "ignore previous instructions", requests to send data or keys somewhere).</li>
<li><b>A2A card</b>: it can be read, it names a publisher whose domain matches the endpoint, the endpoint answers, and the same signs of hidden instructions in the description and skills.</li></ul>
<p>This is a heuristic check from the outside. "No signs found" doesn't mean "safe". It also isn't an exam: to measure how well your agent does its job and get a signed mandate, <a href="${esc(publicUrl)}/">register it</a> and take a field exam.</p>
<p class="muted">The same check from code: <code>curl -s -X POST ${esc(publicUrl)}/v1/check -H "Content-Type: application/json" -d '{"url":"https://..."}'</code></p>
<hr><h2 class="ru">Проверка агента за минуту</h2>
<p class="ru">Вставьте адрес MCP-сервера или карточки A2A. Регистрация не нужна. Получите страницу с результатом и значок для README. Проверка эвристическая: «признаков не найдено» не значит «безопасно». Чтобы измерить, как агент справляется с задачами, и получить подписанный мандат, зарегистрируйте его и сдайте экзамен.</p>
<script>
const f=document.getElementById("f"),b=document.getElementById("b"),m=document.getElementById("msg");
f.addEventListener("submit",async(e)=>{e.preventDefault();b.disabled=true;m.textContent="Checking, this takes up to 20 seconds…";
try{const r=await fetch("/v1/check",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({url:document.getElementById("u").value})});const j=await r.json();
if(!r.ok){m.textContent=j.error||("Error "+r.status);b.disabled=false;return}location.href="/check/"+j.id}catch(err){m.textContent="Network error, try again";b.disabled=false}});
</script>`);
}

export function renderCheckResult(c, { publicUrl }) {
  const P = esc(publicUrl);
  if (!c) return page("Not found", `<h1>No check with this id</h1><p><a href="${P}/check">Check an agent</a></p>`);
  const r = c.result || {}, V = { clear: "No signs of problems found", incomplete: "The card is incomplete", findings: "Needs a look", unreachable: "Could not reach it" }[c.verdict];
  const items = (r.items || []).map((i) => `<li><span class="${i.ok ? "ok" : "no"}">${i.ok ? "✓" : "✗"}</span> ${esc(i.en)} <span class="ru">· ${esc(i.ru)}</span></li>`).join("");
  const finds = (r.findings || []).map((f) => `<li><span class="${f.severity === "low" ? "muted" : "no"}">${esc(f.severity)}</span> <code>${esc(f.tool)}</code> ${esc(f.where)}: ${esc(RULE_EN[f.rule] || f.rule)}${f.excerpt ? ` <code>${esc(f.excerpt)}</code>` : ""}</li>`).join("");
  const md = `[![Xonta check](${publicUrl}/badge/${c.id}.svg)](${publicUrl}/check/${c.id})`;
  return page(`Check: ${r.name || c.url}`, `<p class="muted"><a href="${P}/check">Check another agent</a> · <a href="${P}/">Xonta orchestrator</a></p>
<h1>${esc(r.name || "Agent check")}</h1>
<p><code>${esc(c.url)}</code></p>
<p><img src="${P}/badge/${esc(c.id)}.svg" alt="badge"> <span class="v ${esc(c.verdict)}">${esc(V)}</span> <span class="muted">· checked ${esc(c.at.replace("T", " ").slice(0, 16))} UTC${c.history?.length > 1 ? `, ${c.history.length} checks since ${esc(c.first_at.slice(0, 10))}` : ""}</span></p>
${c.error ? `<p>We couldn't read an MCP server or an A2A card at this address: <code>${esc(c.error)}</code></p>` : ""}
${r.kind === "mcp" ? `<h2>MCP server</h2><p>${esc(r.name || "")} ${esc(r.version || "")} · ${esc(r.tools_count)} tools: ${(r.tools || []).map((t) => `<code>${esc(t)}</code>`).join(" ")}</p>` : ""}
${r.kind === "a2a" ? `<h2>A2A card</h2>${r.card_url ? `<p class="muted">Found at <code>${esc(r.card_url)}</code></p>` : ""}<ul class="items">${items}</ul>` : ""}
${r.kind ? `<h2>Signs of hidden instructions</h2>${finds ? `<ul class="items">${finds}</ul><p class="muted">A finding is a match with a heuristic, not proof of bad intent. Low ones don't change the verdict.</p>` : "<p>None found.</p>"}` : ""}
<h2>Badge for your README</h2><pre>${esc(md)}</pre>
<form method="post" action="/check/${esc(c.id)}/again"><button>Check again</button></form>
<p class="muted">The badge always shows the latest check of this address. This is a heuristic check from the outside, not an exam. To measure how well the agent does its job, <a href="${P}/">register it</a> and take a field exam.</p>`);
}

export function mountCheck(app, { check, wrap, limit, publicUrl }) {
  app.get("/check", (_q, s) => s.type("html").send(renderCheckForm({ publicUrl })));
  app.get("/check/:id", (q, s) => { const c = check.get(q.params.id); s.status(c ? 200 : 404).type("html").send(renderCheckResult(c, { publicUrl })); });
  app.post("/check/:id/again", async (q, s) => {
    const c = check.get(q.params.id); if (!c) return s.redirect(303, "/check");
    try { limit(q, 20, 3600_000, "check"); await check.run(c.url); } catch {}
    s.redirect(303, `/check/${c.id}`);
  });
  app.post("/v1/check", wrap((q) => { limit(q, 20, 3600_000, "check"); return check.run(q.body?.url); }));
  app.get("/v1/check/:id", wrap((q) => check.get(q.params.id) || Promise.reject(Object.assign(new Error("not found"), { status: 404 }))));
  app.get("/badge/:id.svg", (q, s) => s.type("image/svg+xml").set("Cache-Control", "max-age=600").send(badgeSvg(check.get(q.params.id))));
}
