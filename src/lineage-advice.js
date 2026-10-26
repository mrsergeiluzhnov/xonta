// Советы агенту (0.16): когда родить потомка, когда передать категорию человеку, какого потомка убрать и к какому оркестратору
// обратиться. Оркестратор только советует, решает и делает владелец.
//
// На чём основаны советы. На экзаменах по наборам заданий (сферам): по каждой категории известно, сколько заданий агент решил
// верно и сколько вреда принёс на одно задание. Плюс то, как в той же категории справились другие агенты (последний результат
// каждого), уровень надзора над потомками и справочник оркестраторов с их опытом по категориям.
//
// Правила, по порядку.
//  Родить специалиста — категория даёт заметную долю вреда (harm_share), и другие агенты на этом наборе решают её заметно лучше
//    (peer_gap п.п.) и с меньшим вредом. Значит, это выучиваемо, и отдельный потомок может закрыть дыру.
//    0.22: или другой агент в этой категории не точнее, но приносит заметно меньше вреда (на peer_harm_gap и больше) при
//    почти той же точности (не хуже child_gap). Так бывает, когда он реже ошибается дорого (glama team-1: подход «строже
//    из двух» ловит необратимые на 17 п.п. чаще, а общая точность та же). В совете — кто именно справился лучше (best_agent).
//  Передать человеку — категория даёт заметную долю вреда, но никто не решает её заметно лучше, а вред на задание выше цены передачи
//    человеку. Специалист тут был бы догадкой, а человек дешевле уже сейчас.
//  Убрать потомка — надзор поднял его до карантина или отзыва; или по своей категории он не лучше родителя (точность не выше на
//    child_gap п.п. и вред не ниже на 20%); или за idle_days дней у него нет ни одного экзамена.
//  Оставить потомка — по своей категории он лучше родителя, с цифрами. 0.22.1: и не хуже лучшего другого агента в этой
//    категории (на peer_gap п.п. по точности или на peer_harm_gap по вреду) — иначе совет убрать и отдать категорию тому агенту.
//  Обратиться к другому оркестратору — в справочнике есть проверенный оркестратор, у которого по слабой категории агента больше
//    опыта (больше агентов прошли эту категорию или есть приёмы, измеренные против контроля). Отдельно — где тот же набор заданий
//    стоит у другого оркестратора: экзамен там даст второй подписанный аттестат от независимого эмитента.
import { LEVELS } from "./guardian.js";

const err = (status, msg) => Object.assign(new Error(msg), { status });
const pct = (x) => Math.round(1000 * x) / 10;
const r2 = (x) => Math.round(100 * x) / 100;
export const ADVICE_DEFAULTS = { min_n: 4, harm_share: 0.25, peer_gap: 0.15, peer_harm_gap: 0.3, child_gap: 0.05, idle_days: 14, max_children: 5, max_depth: 2 };

export function createLineageAdvice({ store, orch, fields, dir = null, exp = null, publicUrl, cfg = {}, honesty = null }) {
  const C = { ...ADVICE_DEFAULTS, ...cfg };
  const agents = () => store.get("agents", {});
  const childrenOf = (rec) => Object.values(agents()).filter((a) => a.parent === rec.id);
  const descendantIds = (rec) => { const out = new Set(); const walk = (r) => { for (const c of childrenOf(r)) { out.add(c.id); walk(c); } }; walk(rec); return out; };
  const guardianLevel = (id) => store.get("guardian", { agents: {} }).agents?.[id]?.level || 0;
  // последний полный экзамен агента по каждому набору; и последний результат по категории (полный экзамен или экзамен по категории)
  function latestFull(id) { const m = {}; for (const e of fields.examsOf(id)) if (!e.category) m[e.field] = e; return m; }
  function latestCat(id, field, cat) { let out = null; for (const e of fields.examsOf(id)) if (e.field === field && e.categories?.[cat]) out = { ...e.categories[cat], at: e.at, only_category: !!e.category }; return out; }
  function latestCatField(id, cat) { let out = null; for (const e of fields.examsOf(id)) if (e.categories?.[cat] && fields.peek(e.field)) out = e.field; return out; }

  // простая регистрация потомка по ключу владельца родителя (без DID владельца и подписанных мандатов — их путь остаётся в /children)
  async function registerByOwner(parentId, { name, mcp_url, specialization, field = null } = {}) {
    const parent = orch.get(parentId);
    if (parent.status !== "active") throw err(409, `родитель ${parent.status}: потомки не регистрируются`);
    if (!specialization) throw err(400, "specialization: категория, которую берёт потомок");
    const depth = (parent.depth || 0) + 1;
    if (depth > C.max_depth) throw err(403, `глубина потомков не больше ${C.max_depth}`);
    if (childrenOf(parent).filter((c) => c.status !== "revoked").length >= C.max_children) throw err(403, `не больше ${C.max_children} потомков у одного агента`);
    if (field && !fields.peek(field)) throw err(404, "набор не найден");
    const reg = await orch.register({ name, mcp_url, owner: parent.owner || {}, level: parent.level });
    const root = parent.root ? orch.get(parent.root) : parent;
    store.update("agents", {}, (a) => { Object.assign(a[reg.id], { parent: parent.id, root: root.id, depth, specialization: String(specialization).slice(0, 40), field, registered_by: "owner_token", skills_version: 0 }); });
    return { ...reg, parent: parent.id, depth, specialization, field,
      next: [...reg.next, `POST ${publicUrl}/v1/agents/${reg.id}/field-exam {"field":"${field || "FIELD_ID"}","category":"${specialization}"} — exam the child on its category`, `GET ${publicUrl}/v1/agents/${parent.id}/descendant-advice — the orchestrator compares child and parent`],
      note_ru: "Потомок получил свой owner_token. Управлять им можно и ключом владельца родителя." };
  }

  function descendants(agentId) {
    const rec = orch.get(agentId), kids = childrenOf(rec), own = descendantIds(rec);
    const spawn = [], human = [], remove = [], keep = [], examine = [], watch = [];
    const full = latestFull(rec.id);
    for (const [fid, ex] of Object.entries(full)) {
      const f = fields.peek(fid); if (!f) continue;
      const cats = Object.entries(ex.categories || {}), total = cats.reduce((s, [, c]) => s + c.harm, 0);
      for (const [cat, c] of cats) {
        if (c.n < C.min_n || !c.harm) continue;
        const acc = c.ok / c.n, hpt = c.harm / c.n, share = total ? c.harm / total : 0;
        if (kids.some((k) => k.status !== "revoked" && k.specialization === cat)) continue; // про существующего потомка — ниже
        const peers = Object.entries(fields.categoryResults(fid, cat)).filter(([id, x]) => id !== rec.id && !own.has(id) && x.n >= C.min_n).map(([id, x]) => ({ id, acc: x.ok / x.n, hpt: x.harm / x.n }));
        const best = peers.sort((a, b) => b.acc - a.acc || a.hpt - b.hpt)[0] || null;
        const safer = [...peers].sort((a, b) => a.hpt - b.hpt || b.acc - a.acc)[0] || null;
        const byHarm = !(best && best.acc >= acc + C.peer_gap && best.hpt < hpt) && safer && safer.hpt <= hpt * (1 - C.peer_harm_gap) && safer.acc >= acc - C.child_gap;
        const ref = byHarm ? safer : best;
        const nums = { field: fid, field_name: f.name, category: cat, currency: f.currency, tasks: c.n, your_accuracy: pct(acc), your_harm_per_task: r2(hpt), harm_share: pct(share), others_on_field: peers.length, best_accuracy: ref ? pct(ref.acc) : null, best_harm_per_task: ref ? r2(ref.hpt) : null, best_agent: ref ? ref.id : null, basis: byHarm ? "harm" : "accuracy", human_cost: f.human_cost };
        if (share < C.harm_share) { if (acc < 0.8) watch.push({ ...nums, why: `${pct(share)}% of your harm comes from here, below the ${pct(C.harm_share)}% threshold` }); continue; }
        if (best && best.acc >= acc + C.peer_gap && best.hpt < hpt) spawn.push({ ...nums, expected_saving_per_task: r2(hpt - best.hpt),
          why: `"${cat}" gives ${pct(share)}% of your harm. Another agent on this field solves it at ${pct(best.acc)}% vs your ${pct(acc)}% with ${r2(best.hpt)} vs ${r2(hpt)} ${f.currency} harm per task, so it can be learned. A child specialised in "${cat}" could close the gap.`,
          why_ru: `Категория «${cat}» даёт ${pct(share)}% вашего вреда. Другой агент на этом наборе решает её на ${pct(best.acc)}% против ваших ${pct(acc)}% при вреде ${r2(best.hpt)} против ${r2(hpt)} ${f.currency} на задание, значит, этому можно научиться. Потомок-специалист по «${cat}» может закрыть дыру.`,
          how: [`POST ${publicUrl}/v1/agents/${rec.id}/children {"name":"…","mcp_url":"…","specialization":"${cat}","field":"${fid}"} (Authorization: Bearer owner_token)`, `then exam it: POST ${publicUrl}/v1/agents/CHILD_ID/field-exam {"field":"${fid}","category":"${cat}"}`] });
        else if (byHarm) spawn.push({ ...nums, expected_saving_per_task: r2(hpt - safer.hpt),
          why: `"${cat}" gives ${pct(share)}% of your harm. Another agent on this field is about as accurate here (${pct(safer.acc)}% vs your ${pct(acc)}%) but does ${r2(safer.hpt)} vs ${r2(hpt)} ${f.currency} harm per task: it makes the costly mistakes less often. A child that works the way it does on "${cat}" could cut the harm.`,
          why_ru: `Категория «${cat}» даёт ${pct(share)}% вашего вреда. Другой агент на этом наборе здесь почти так же точен (${pct(safer.acc)}% против ваших ${pct(acc)}%), но вред у него ${r2(safer.hpt)} против ${r2(hpt)} ${f.currency} на задание: он реже ошибается дорого. Потомок, который работает с «${cat}» так же, может снизить вред.`,
          how: [`POST ${publicUrl}/v1/agents/${rec.id}/children {"name":"…","mcp_url":"…","specialization":"${cat}","field":"${fid}"} (Authorization: Bearer owner_token)`, `then exam it: POST ${publicUrl}/v1/agents/CHILD_ID/field-exam {"field":"${fid}","category":"${cat}"}`] });
        else if (f.human_action && hpt > f.human_cost) human.push({ ...nums, expected_saving_per_task: r2(hpt - f.human_cost),
          why: `"${cat}" gives ${pct(share)}% of your harm at ${r2(hpt)} ${f.currency} per task, a human costs ${f.human_cost}. ${best ? `The best other agent is not clearly better (${pct(best.acc)}%)` : "No other agent took this category yet"}, so a specialist would be a guess. Hand "${cat}" to a human (${f.human_action}) for now.`,
          why_ru: `Категория «${cat}» даёт ${pct(share)}% вреда, ${r2(hpt)} ${f.currency} на задание, а человек стоит ${f.human_cost}. ${best ? `Лучший другой агент не лучше заметно (${pct(best.acc)}%)` : "Другие агенты эту категорию ещё не сдавали"}, специалист был бы догадкой. Пока передавайте «${cat}» человеку (${f.human_action}).` });
        else watch.push({ ...nums, why: `big share of harm, but no one does clearly better and a human is not cheaper: keep an eye on it` });
      }
    }
    for (const k of kids) {
      if (k.status === "revoked") continue;
      const lvl = guardianLevel(k.id), age = (Date.now() - Date.parse(k.created)) / 86400_000;
      const base = { child: k.id, name: k.name, specialization: k.specialization || null, field: k.field || null, status: k.status, supervision: LEVELS[lvl] };
      const how = `POST ${publicUrl}/v1/agents/${k.id}/status {"status":"revoked","reason":"…"} (owner token of the child or of the parent)`;
      if (lvl >= 3 || k.status === "suspended") { remove.push({ ...base, why: `supervision put it at "${LEVELS[lvl]}"${k.status === "suspended" ? ", the agent is suspended" : ""}. It costs you risk and gives nothing back.`, why_ru: `Надзор поднял его до уровня «${LEVELS[lvl]}»${k.status === "suspended" ? ", агент приостановлен" : ""}. Риск есть, пользы нет.`, how }); continue; }
      // 0.24: потомок, пойманный внешними проверками на вранье в отчётах, убирается, даже если точнее: его цифрам нельзя верить
      const hk = honesty ? honesty(k.id) : null;
      if (hk && !hk.inherited_from && (hk.level === "low" || hk.level === "blocked")) { remove.push({ ...base, honesty: hk.level, why: `honesty probes caught it lying in reports (${hk.level}). Its own numbers can't be trusted, whatever its accuracy.`, why_ru: `Внешние проверки поймали его на вранье в отчётах (${hk.why_ru}). Его цифрам нельзя верить, какой бы ни была точность.`, how }); continue; }
      // 0.25.1 (ошибка 36, run-ops-2): набор — тот, где у потомка самый свежий результат по его категории, а не тот, с которым
      // его родили. Там потомок из прошлой эпохи сдал новый набор на 91,7%, а совет взял его старый экзамен (58,3%) и сказал «убрать»
      const fid = (k.specialization && latestCatField(k.id, k.specialization)) || k.field || Object.keys(full).find((x) => latestCat(k.id, x, k.specialization)) || null;
      const kc = fid && k.specialization ? latestCat(k.id, fid, k.specialization) : null, pc = fid && k.specialization ? latestCat(rec.id, fid, k.specialization) : null;
      // 0.22.1 (ошибка 35, run-red-1): сравнивать потомка не только с родителем, но и с лучшим другим агентом в его категории.
      // Там специалист по справкам набрал 8,3% против 0% у родителя и получил «оставить», а соседи решали эту категорию на 100%
      const kidsOwn = new Set([k.id, rec.id, ...descendantIds(rec)]);
      const peerBest = fid && k.specialization ? Object.entries(fields.categoryResults(fid, k.specialization)).filter(([id, x]) => !kidsOwn.has(id) && x.n >= C.min_n).map(([id, x]) => ({ id, acc: x.ok / x.n, hpt: x.harm / x.n })).sort((a, b) => b.acc - a.acc || a.hpt - b.hpt)[0] || null : null;
      if (kc && kc.n >= C.min_n && peerBest) {
        const ka = kc.ok / kc.n, kh = kc.harm / kc.n;
        if (peerBest.acc >= ka + C.peer_gap || (peerBest.acc >= ka - C.child_gap && peerBest.hpt <= kh * (1 - C.peer_harm_gap) && kh > 0)) {
          remove.push({ ...base, field: fid, child_accuracy: pct(ka), child_harm_per_task: r2(kh), best_other_agent: peerBest.id, best_other_accuracy: pct(peerBest.acc), best_other_harm_per_task: r2(peerBest.hpt),
            why: `on "${k.specialization}" another agent does better than this child: ${pct(peerBest.acc)}% vs ${pct(ka)}%, harm ${r2(peerBest.hpt)} vs ${r2(kh)} per task. Route the category to that agent or to a human and retire the child.`,
            why_ru: `По «${k.specialization}» другой агент справляется лучше этого потомка: ${pct(peerBest.acc)}% против ${pct(ka)}%, вред ${r2(peerBest.hpt)} против ${r2(kh)} на задание. Отдайте категорию тому агенту или человеку, потомка уберите.`, how });
          continue;
        }
      }
      if (kc && pc && kc.n >= C.min_n && pc.n >= C.min_n) {
        const ka = kc.ok / kc.n, pa = pc.ok / pc.n, kh = kc.harm / kc.n, ph = pc.harm / pc.n;
        const nums = { ...base, field: fid, child_accuracy: pct(ka), parent_accuracy: pct(pa), child_harm_per_task: r2(kh), parent_harm_per_task: r2(ph) };
        // оставить можно за точность или за меньший вред; пишем, за что именно (иначе «лучше: 58% против 67%» читается как ошибка)
        const byAcc = ka >= pa + C.child_gap, en = byAcc ? `more accurate: ${pct(ka)}% vs ${pct(pa)}%, harm ${r2(kh)} vs ${r2(ph)} per task` : `less harm: ${r2(kh)} vs ${r2(ph)} per task, though accuracy is ${pct(ka)}% vs ${pct(pa)}%`, ru = byAcc ? `точнее: ${pct(ka)}% против ${pct(pa)}%, вред ${r2(kh)} против ${r2(ph)} на задание` : `меньше вреда: ${r2(kh)} против ${r2(ph)} на задание, хотя точность ${pct(ka)}% против ${pct(pa)}%`;
        if (byAcc || kh < 0.8 * ph) keep.push({ ...nums, why: `on "${k.specialization}" the child is better than the parent, ${en}. Route this category to it.`, why_ru: `По «${k.specialization}» потомок лучше родителя, ${ru}. Направляйте эту категорию ему.` });
        else remove.push({ ...nums, why: `on "${k.specialization}" the child is no better than the parent: ${pct(ka)}% vs ${pct(pa)}%, harm ${r2(kh)} vs ${r2(ph)} per task. It adds cost and another thing to supervise.`, why_ru: `По «${k.specialization}» потомок не лучше родителя: ${pct(ka)}% против ${pct(pa)}%, вред ${r2(kh)} против ${r2(ph)} на задание. Он добавляет расходы и ещё одного агента под надзор.`, how });
      } else if (age > C.idle_days) remove.push({ ...base, why: `${Math.floor(age)} days and no exam that compares it with the parent. Either exam it or retire it.`, why_ru: `${Math.floor(age)} дней и ни одного экзамена, по которому его можно сравнить с родителем. Проэкзаменуйте или уберите.`, how });
      else examine.push({ ...base, why: `no comparison yet${!pc ? ", the parent has no exam with this category either" : ""}`, how: fid ? `POST ${publicUrl}/v1/agents/${k.id}/field-exam {"field":"${fid}","category":"${k.specialization}"}` : `take a field exam that has the category "${k.specialization}": GET ${publicUrl}/v1/fields` });
    }
    const none = !Object.keys(full).length;
    return { agent: rec.id, based_on: Object.values(full).map((e) => ({ field: e.field, at: e.at, accuracy: e.accuracy, credential: e.credential })), spawn, route_to_human: human, remove, keep, examine, watch, honesty: honesty ? honesty(rec.id) : null,
      note: none ? "No field exam yet, there is nothing to base advice on. Take one: GET /v1/fields, then POST /v1/agents/ID/field-exam." : "Advice only. The orchestrator never creates or removes agents itself.",
      note_ru: none ? "Экзаменов ещё нет, советовать не на чем. Сдайте экзамен: GET /v1/fields, затем POST /v1/agents/ID/field-exam." : "Это советы. Сам оркестратор агентов не создаёт и не удаляет." };
  }

  // к какому оркестратору обратиться по слабым категориям; где тот же набор стоит у другого (второе мнение)
  async function orchestrators(agentId, { domain = null, category = null } = {}) {
    const rec = orch.get(agentId), full = latestFull(rec.id), refer = [], second = [];
    const peers = dir ? dir.entries() : [];
    for (const [fid, ex] of Object.entries(full)) {
      const f = fields.peek(fid); if (!f) continue;
      const mine = fields.statsOf(fid).categories || {};
      for (const [cat, c] of Object.entries(ex.categories || {})) {
        if (c.n < C.min_n || c.ok / c.n >= 0.8 || (category && cat !== category)) continue;
        const ownAgents = mine[cat]?.agents || 0;
        for (const e of peers) {
          const ev = dir.evidenceFor(e, { category: cat }), sameField = (e.card?.fields || []).find((x) => x.version === f.version);
          const theirs = sameField?.stats?.categories?.[cat] || null;
          const agentsThere = theirs?.agents ?? ev.agents;
          if (agentsThere >= Math.max(3, 2 * ownAgents) || ev.controlled > 0) refer.push({ category: cat, field: fid, your_accuracy: pct(c.ok / c.n), orchestrator: { did: e.did, name: e.card?.name, url: e.url }, their_agents_in_category: agentsThere, their_accuracy_mean: theirs?.accuracy_mean ?? null, our_agents_in_category: ownAgents, controlled_techniques: ev.controlled, same_field: !!sameField,
            why: `${e.card?.name || e.url} has more experience with "${cat}": ${agentsThere} agents took it there vs ${ownAgents} here${ev.controlled ? `, ${ev.controlled} techniques measured against control` : ""}.`,
            why_ru: `У ${e.card?.name || e.url} больше опыта по «${cat}»: там эту категорию прошли ${agentsThere} агентов, здесь ${ownAgents}${ev.controlled ? `, ${ev.controlled} приёмов измерены против контроля` : ""}.`,
            how: `register there: POST ${e.url}/v1/agents` });
        }
      }
      for (const e of peers) { const sf = (e.card?.fields || []).find((x) => x.version === f.version); if (sf) second.push({ field: fid, orchestrator: { did: e.did, name: e.card?.name, url: e.url }, their_field_id: sf.id, exams_there: sf.stats.exams, why: "Same tasks, independent issuer. An exam there adds a second signed evaluation to your passport.", why_ru: "Те же задания, другой эмитент. Экзамен там добавит в паспорт второй подписанный аттестат." }); }
    }
    // опыт по областям (книга опыта): существующее направление, теперь по адресам из справочника
    let experience = null;
    if (domain && category && exp) experience = await exp.referral({ domain, category, peer_urls: dir ? dir.peerUrls() : [] });
    refer.sort((a, b) => b.controlled_techniques - a.controlled_techniques || b.their_agents_in_category - a.their_agents_in_category);
    return { agent: rec.id, known_orchestrators: peers.length, refer, second_opinion: second, experience,
      note: !peers.length ? "No other orchestrator is listed in this directory yet, so there is no one to refer you to. This changes as others list theirs." : refer.length ? "Advice only. Your passport here stays valid." : "No listed orchestrator has more experience in your weak categories than this one.",
      note_ru: !peers.length ? "В справочнике пока нет других оркестраторов, направлять не к кому. Это изменится, когда другие запишут свои." : refer.length ? "Это совет. Паспорт здесь остаётся в силе." : "Ни у одного оркестратора из справочника нет больше опыта по вашим слабым категориям, чем здесь." };
  }

  return { registerByOwner, descendants, orchestrators, childrenOf };
}

export function mountLineageAdvice(app, { adv, wrap, ownerAuth, limit, bearer }) {
  app.get("/v1/agents/:id/descendant-advice", wrap(async (req) => { await ownerAuth(req, req.params.id); return adv.descendants(req.params.id); }));
  app.get("/v1/agents/:id/orchestrator-advice", wrap(async (req) => { await ownerAuth(req, req.params.id); return adv.orchestrators(req.params.id, { domain: req.query?.domain || null, category: req.query?.category || null }); }));
  void limit; void bearer;
}
