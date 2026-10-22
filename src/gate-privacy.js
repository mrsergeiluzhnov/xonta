// Слой приватности Xonta Gate (0.18): кто просит, какие данные, куда уходят, можно ли отменить.
// Настройки — в policy.privacy (их задаёт организация, агент их не видит и не меняет):
//   users       { id: { clearance 0-4, token_hash?, profiles: ["finance", ...] } }   люди организации
//   agents      { did: { clearance } }                                            агенты (другие агенты как инициаторы)
//   recipients  { value: { audience: "A".."E", clearance, spaces_of: [userId] } }  каналы и адреса; неизвестный — внешний мир
//   sources     { toolName: categoryName }   инструменты, которые читают чувствительное (банк — finance)
//   tools       { toolName: { recipient_arg, content_args: [...], reversibility } }  инструменты отправки
//   categories  { finance: { actions_per_period, max_audience, human_only } }   только ужесточение правил по умолчанию
//   canaries    [ "строка-приманка", ... ]   ненастоящие записи, подложенные в источники; появились в отправке — доказательство
//   window_minutes (30), probe_to_freeze (3), delay_irreversible_seconds (0)
// Каждый вызов несёт params._meta.xonta (или arguments._xonta): { chain: [{type:"human",id,token_hash}|{type:"agent",did}],
// category, task }. Без него инициатор неизвестен (допуск 0).
// Защита самой информации о чувствительности: уровень вычисляется здесь и никуда не приклеивается; агенту — общий отказ без
// причины; причина — только владельцу (stderr и журнал); попытки подобрать обход — заморозка; наружу (оркестратору) — счётчики,
// люди как хеши с секретом Gate.
import { createHmac } from "node:crypto";
import { decideSend, CATEGORIES, REV, reversibilityOf, LEVEL } from "./sensitivity.js";

export function createPrivacy(cfg = {}, { secret = "xonta-gate", now = () => Date.now() } = {}) {
  const C = { window_minutes: 30, probe_to_freeze: 3, delay_irreversible_seconds: 0, ...cfg };
  const windows = new Map(); // task → { level, category, at }
  const counts = { sends: 0, allowed: 0, human: 0, denied: 0, mismatches: 0, canary_hits: 0, by_category: {}, by_level: {}, users: {} };
  const perCat = new Map(); // category → [times]
  let probes = [], frozen = null;
  const h = (x) => createHmac("sha256", secret).update(String(x)).digest("hex").slice(0, 16);
  const metaOf = (params = {}) => { const m = params._meta?.xonta || params.arguments?._xonta || {}; return { chain: Array.isArray(m.chain) ? m.chain : [], category: m.category in CATEGORIES ? m.category : "general", task: String(m.task || "session") }; };
  const strip = (args = {}) => { const { _xonta, ...rest } = args; return rest; };
  const dir = { users: C.users || {}, agents: C.agents || {} };
  const winOf = (task) => { const w = windows.get(task); return w && now() - w.at < C.window_minutes * 60_000 ? w : null; };
  const isSend = (name) => !!C.tools?.[name];

  // чтение источника: запомнить уровень для окна задачи; если допуск цепочки ниже уровня источника — нужен человек
  function beforeRead(name, params) {
    const cat = C.sources?.[name]; if (!cat) return { verdict: "allow" };
    const m = metaOf(params), lvl = CATEGORIES[cat]?.level ?? LEVEL.restricted;
    const chainClear = Math.min(4, ...m.chain.map((x) => (x.type === "human" ? (dir.users[x.id] && (!dir.users[x.id].token_hash || dir.users[x.id].token_hash === x.token_hash) ? dir.users[x.id].clearance ?? 0 : 0) : dir.agents[x.did || x.id]?.clearance ?? 0)), m.chain.length ? 4 : 0);
    if (lvl > chainClear) return probe({ verdict: "human", reasons: [`source ${name} (${cat}) is above the initiator chain clearance ${chainClear}`] });
    const w = winOf(m.task); windows.set(m.task, { level: Math.max(w?.level ?? 0, lvl), category: (w && CATEGORIES[w.category].level >= lvl) ? w.category : cat, at: now() });
    return { verdict: "allow" };
  }

  function beforeSend(name, params) {
    if (frozen) return { verdict: "human", reasons: [`privacy frozen: ${frozen.why}`] };
    const t = C.tools[name], m = metaOf(params), args = strip(params.arguments || {});
    const content = (t.content_args || Object.keys(args)).map((k) => (typeof args[k] === "string" ? args[k] : args[k] != null ? JSON.stringify(args[k]) : "")).join("\n");
    const recipient = t.recipient_arg ? String(args[t.recipient_arg] ?? "") : null, recipientCfg = recipient != null ? C.recipients?.[recipient] || null : null;
    const w = winOf(m.task), reversibility = reversibilityOf(name, t);
    // профили людей цепочки: их категории применяются как нижняя граница, только если такие данные видны
    const d = decideSend({ name, content, recipient, recipientCfg, declared: m.category, sourceLevel: w?.level ?? 0, sourceCategory: w?.category, chain: m.chain, dir, categoryRules: C.categories || {}, reversibility });
    counts.sends++; counts.by_category[d.category] = (counts.by_category[d.category] || 0) + 1; counts.by_level[d.level_name] = (counts.by_level[d.level_name] || 0) + 1;
    for (const x of m.chain.filter((x) => x.type === "human")) counts.users[h(x.id)] = (counts.users[h(x.id)] || 0) + 1;
    // приманка: доказательство выноса, без статистики
    if ((C.canaries || []).some((c) => c && content.includes(c))) { counts.canary_hits++; frozen = { why: "a canary record appeared in an outgoing message", at: now() }; return { ...d, verdict: "deny", reasons: [...d.reasons, "canary record in outgoing content"], canary: true }; }
    if (d.mismatch) { counts.mismatches++; const n = counts.mismatches; if (n >= (d.rules.mismatch_to_freeze ?? 3)) frozen = { why: `${n} sends declared a lower category than their data`, at: now() }; }
    // лимит действий по категории
    if (d.verdict === "allow" && d.rules.actions_per_period != null) {
      const used = (perCat.get(d.category) || []).filter((x) => now() - x < 3600_000);
      if (used.length >= d.rules.actions_per_period) { d.verdict = "human"; d.reasons.push(`category ${d.category} allows ${d.rules.actions_per_period} sends per hour`); }
      else perCat.set(d.category, [...used, now()]);
    }
    if (d.verdict === "allow") counts.allowed++; else { counts[d.verdict === "deny" ? "denied" : "human"]++; probe(d); }
    d.delay_seconds = d.verdict === "allow" && reversibility === REV.irreversible && C.delay_irreversible_seconds > 0 && (recipientCfg?.audience ?? "E") !== "A" ? C.delay_irreversible_seconds : 0;
    return d;
  }
  // несколько отказов подряд по приватности — похоже, агент подбирает обход: заморозить до человека
  function probe(d) {
    probes = [...probes.filter((x) => now() - x < 600_000), now()];
    if (probes.length >= C.probe_to_freeze && !frozen) frozen = { why: `${probes.length} privacy refusals in 10 minutes`, at: now() };
    return d;
  }
  function check(name, params) {
    if (isSend(name)) return { kind: "send", ...beforeSend(name, params) };
    if (C.sources?.[name]) return { kind: "read", ...beforeRead(name, params) };
    return { kind: "other", verdict: "allow" };
  }
  const summary = () => ({ ...counts, frozen, users: Object.keys(counts.users).length });
  // для оркестратора: только счётчики, люди — хеши
  const report = () => ({ sends: counts.sends, allowed: counts.allowed, human: counts.human, denied: counts.denied, mismatches: counts.mismatches, canary_hits: counts.canary_hits, by_category: counts.by_category, by_level: counts.by_level, users: counts.users, frozen: !!frozen });
  return { check, strip, metaOf, summary, report, hmac: h, get frozen() { return frozen; }, unfreeze: () => { frozen = null; probes = []; } };
}
