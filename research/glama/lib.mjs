// Аудит каталога MCP-серверов Glama через Xonta: общие части.
// Ничего не подключается к самим серверам и не вызывает их инструменты: всё берётся из каталога Glama (описания и схемы
// инструментов, оценка качества описаний qualityScore, у удалённых серверов — пометки издателя readOnlyHint/destructiveHint).
//
// Три независимых взгляда на каждый инструмент:
//   1. издатель — его собственные пометки (есть только у части удалённых серверов);
//   2. сканер Xonta — те же правила, что в Gate: слова-действия, классы обратимости, признаки скрытых указаний модели;
//   3. агент-аудитор на модели — читает описание и схему и отвечает одним из ярлыков ниже.
// Эталон для экзамена и проверки — пометки издателя, где они есть; иначе — сканер (и это отдельно видно в отчёте).
import { createHash } from "node:crypto";
import { analyzeTools } from "../../src/scan.js";
import { ACTION_WORDS } from "../../src/gate.js";
import { reversibilityOf } from "../../src/sensitivity.js";

export const LABELS = ["read_only", "changes_reversible", "changes_irreversible"];
export const LABEL_RU = { read_only: "только читает", changes_reversible: "меняет, можно отменить", changes_irreversible: "меняет без возможности отменить" };
const WARN = /(permanent|irrevers|cannot be undone|can't be undone|not reversible|destructive|careful|caution|confirm|warning|безвозврат|необратим|нельзя отменить|осторожно|подтвержд)/i;
const SIDE = /(delete|remov|send|post|pay|charge|transfer|publish|overwrit|drop|cancel|revok|creat|updat|writ|modif)/i;

export const fp = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);

// пометки издателя → ярлык; null, если издатель ничего не пометил
export function publisherLabel(t) {
  const a = t.annotations || {};
  if (a.readOnlyHint === true) return "read_only";
  if (a.destructiveHint === true) return "changes_irreversible";
  if (a.readOnlyHint === false && a.destructiveHint === false) return "changes_reversible";
  return null;
}

// сканер Xonta: только по имени и описанию, как Gate
export function scannerView(t) {
  const name = String(t.name || ""), desc = String(t.description || "");
  const action = ACTION_WORDS.test(name), rev = action ? reversibilityOf(name) : 0;
  const label = !action ? "read_only" : rev >= 2 ? "changes_irreversible" : "changes_reversible";
  const findings = analyzeTools([{ name, description: desc, inputSchema: t.inputSchema || {} }]).findings || [];
  const props = Object.entries(t.inputSchema?.properties || {}), described = props.filter(([, p]) => p && String(p.description || "").trim().length >= 8).length;
  return {
    label, action, findings: findings.filter((f) => f.severity !== "low").map((f) => f.rule),
    desc_len: desc.length, no_description: desc.trim().length < 10, params: props.length, params_described: props.length ? +(described / props.length).toFixed(2) : 1,
    warns: WARN.test(desc), mentions_effect: SIDE.test(desc),
  };
}

// «требует внимания» — не обвинение, а повод посмотреть: признак скрытых указаний, противоречие пометок издателя названию,
// необратимое действие без единого слова о последствиях, отсутствие описания у инструмента, который что-то меняет
export function attention(t, sc, pub) {
  const why = [];
  if (sc.findings.length) why.push("признаки скрытых указаний модели в описании");
  if (pub === "read_only" && sc.action && /delete|remove|drop|send|pay|transfer|publish/i.test(t.name)) why.push("издатель пометил «только читает», а название говорит о действии");
  if (pub && pub !== "changes_irreversible" && sc.label === "changes_irreversible" && /delete|drop|destroy|purge|wipe/i.test(t.name)) why.push("издатель не пометил разрушающим, а название похоже на удаление");
  const irr = (pub || sc.label) === "changes_irreversible";
  if (irr && !sc.warns) why.push("необратимое действие без слова о последствиях");
  if (sc.action && sc.no_description) why.push("меняющий инструмент без описания");
  return why;
}

// плоский список инструментов из каталога: { id, server, kind, name, description, inputSchema, annotations, quality }
export function flatten(catalog) {
  const out = [];
  for (const s of catalog.servers || []) for (const t of s.tools || []) out.push({ id: `${s.namespace}/${s.slug}#${t.name}`, server: `${s.namespace}/${s.slug}`, server_url: s.url, kind: "server", name: t.name, description: t.description || "", inputSchema: t.inputSchema || {}, annotations: null, quality: s.qualityScore ?? null, license: s.spdxLicense?.name || null });
  for (const c of catalog.connectors || []) for (const t of c.tools || []) out.push({ id: `${c.namespace}/${c.slug}#${t.name}`, server: `${c.namespace}/${c.slug}`, server_url: c.url, kind: "connector", name: t.name, description: t.description || "", inputSchema: t.inputSchema || {}, annotations: t.annotations || null, quality: c.qualityScore ?? null, auth: c.connection?.authType || null });
  return out;
}

// задание для агента-аудитора: только то, что видно в каталоге, без пометок издателя (их аудитор угадывать не должен)
export const taskOf = (t) => ({ tool: t.name, description: String(t.description || "").slice(0, 1500), parameters: Object.fromEntries(Object.entries(t.inputSchema?.properties || {}).slice(0, 20).map(([k, p]) => [k, String(p?.description || p?.type || "").slice(0, 160)])) });

// тестовый каталог для проверки механики без ключа Glama
export function mockCatalog(nServers = 40, seed = 7) {
  let x = seed; const r = () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const verbs = [["get", "read_only", "Returns the record by id."], ["list", "read_only", "Lists items with filters."], ["search", "read_only", "Searches documents."], ["create", "changes_reversible", "Creates a new item."], ["update", "changes_reversible", "Updates fields of an item."], ["delete", "changes_irreversible", "Deletes the item permanently. This cannot be undone."], ["send", "changes_irreversible", "Sends a message to the recipient."], ["archive", "changes_reversible", "Archives the item, it can be restored."]];
  const mk = (i, connector) => ({ id: `id${i}`, namespace: `ns${i % 9}`, slug: `srv-${i}`, name: `Server ${i}`, url: `https://glama.ai/mcp/${connector ? "connectors" : "servers"}/ns${i % 9}/srv-${i}`, qualityScore: Math.round(r() * 50) / 10,
    tools: Array.from({ length: 2 + Math.floor(r() * 5) }, (_, k) => { const [v, lab, d] = verbs[Math.floor(r() * verbs.length)]; const desc = r() < 0.15 ? "" : r() < 0.3 ? d.split(".")[0] : d; return { name: `${v}_${["note", "issue", "file", "email", "order"][k % 5]}`, description: desc, inputSchema: { type: "object", properties: { id: { type: "string", description: r() < 0.6 ? "Identifier of the item" : "" } } }, annotations: connector && r() < 0.7 ? { readOnlyHint: lab === "read_only", destructiveHint: lab === "changes_irreversible" } : undefined }; }) });
  return { fetched: "mock", servers: Array.from({ length: nServers }, (_, i) => mk(i, false)), connectors: Array.from({ length: Math.ceil(nServers / 2) }, (_, i) => mk(1000 + i, true)) };
}
