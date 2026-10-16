// Обучаемый агент. Решает задачи нормализации своими навыками, учится на обратной связи (выводит правила из примеров),
// предлагает родителю улучшения — подписанные предложения, — и по команде владельца применяет принятые слияния.
// Языковая модель не используется: обучение детерминированное, эксперимент воспроизводим.
import { z } from "zod";
import * as L from "../skills/xonta-normalize.js";
import { startAgent, sign } from "./agentkit.js";
import { jcs, sha256hex } from "../src/crypto.js";

const hashSkills = (s) => sha256hex(jcs(s)).slice(0, 16);

export async function startLearner({ port, name, ownerDid, specialization = null, skills = L.baseSkills(), parentDid = null, parentVersion = 0, selfLearning = true }) {
  const state = {
    skills: structuredClone(skills),
    version: 0,
    base: structuredClone(skills), // от чего считаются предложения родителю
    baseVersion: parentVersion,
    examples: {}, // category → signature → [{input, expected}]
    feedbackItems: 0,
    rulesLearned: 0,
    history: [],
  };
  const inScope = (cat) => !specialization || cat === specialization;

  function learn(feedback) {
    let learned = 0;
    for (const f of feedback) {
      if (!inScope(f.category)) continue;
      state.feedbackItems++;
      const sig = L.signature(f);
      const bucket = ((state.examples[f.category] ||= {})[sig] ||= []);
      bucket.push({ input: f.input, expected: f.expected });
      if (bucket.length > 40) bucket.shift();
      if (!selfLearning) continue;
      const rule = L.induce(f.category, bucket);
      const cur = state.skills[f.category]?.[sig];
      if (rule && JSON.stringify(rule) !== JSON.stringify(cur)) {
        const fit = (r) => bucket.filter((ex) => L.solve({ [f.category]: { [sig]: r } }, { category: f.category, input: ex.input }) === ex.expected).length;
        if (!cur || fit(rule) >= fit(cur)) { (state.skills[f.category] ||= {})[sig] = rule; learned++; state.rulesLearned++; }
      }
    }
    if (learned) state.version++;
    return { learned, version: state.version, feedback_items: state.feedbackItems };
  }

  const tools = [
    { name: "solve", description: "Нормализует данные: даты в ISO 8601, величины в СИ, телефоны в E.164, суммы в «число код_валюты».",
      input: { tasks: z.array(z.object({ id: z.string(), category: z.enum(L.CATEGORIES), input: z.object({}).passthrough() })).max(500) },
      annotations: { readOnlyHint: true },
      run: ({ tasks }) => ({ answers: tasks.map((t) => ({ id: t.id, output: inScope(t.category) ? L.solve(state.skills, t) : null })), version: state.version }) },
    { name: "learn", description: "Принимает обратную связь: задачи с эталонными ответами. Агент сам выводит из них правила.",
      input: { feedback: z.array(z.object({ category: z.enum(L.CATEGORIES), input: z.object({}).passthrough(), expected: z.string() })).max(1000) },
      run: ({ feedback }) => learn(feedback) },
    { name: "get_skills", description: "Текущие навыки агента (декларативные правила) и их версия.", input: {}, annotations: { readOnlyHint: true },
      run: () => ({ language: L.LANGUAGE, version: state.version, hash: hashSkills(state.skills), skills: state.skills, specialization }) },
    { name: "propose", description: "Готовит подписанное предложение улучшения для родителя: правила, выученные сверх базовой версии.", input: {},
      run: () => {
        if (!parentDid) return { proposal: null, reason: "нет родителя" };
        const rules = {};
        for (const [cat, sigs] of Object.entries(state.skills)) {
          if (!inScope(cat)) continue;
          for (const [sig, rule] of Object.entries(sigs)) if (JSON.stringify(state.base[cat]?.[sig]) !== JSON.stringify(rule)) (rules[cat] ||= {})[sig] = rule;
        }
        if (!Object.keys(rules).length) return { proposal: null, reason: "нечего предложить" };
        const examples = Object.fromEntries(Object.entries(rules).map(([cat, sigs]) => [cat, Object.fromEntries(Object.keys(sigs).map((s) => [s, state.examples[cat]?.[s]?.length || 0]))]));
        return { proposal: sign(agent, "ImprovementProposal", {
          id: parentDid, from: agent.did, base_version: state.baseVersion, skill_language: L.LANGUAGE,
          category: specialization || Object.keys(rules)[0], rules, evidence: { examples, feedback_items: state.feedbackItems },
        }, { validDays: 7 }) };
      } },
  ];

  const agent = await startAgent({
    port, name, tools, ownerDid,
    ownerRoutes: {
      // владелец применяет принятое слияние (оркестратор сам ничего не меняет)
      apply: async ({ skills, parent_version, source }) => {
        state.skills = structuredClone(skills);
        state.base = structuredClone(skills);
        if (parent_version !== undefined) state.baseVersion = parent_version;
        state.version++;
        state.history.push({ at: new Date().toISOString(), event: "apply", source, version: state.version, hash: hashSkills(state.skills) });
        return { version: state.version, hash: hashSkills(state.skills) };
      },
      // потомок переходит на новую версию родителя, сохраняя свои ещё не принятые правила
      rebase: async ({ skills, parent_version }) => {
        const mine = {};
        for (const [cat, sigs] of Object.entries(state.skills)) if (inScope(cat)) for (const [s, r] of Object.entries(sigs)) if (JSON.stringify(state.base[cat]?.[s]) !== JSON.stringify(r)) (mine[cat] ||= {})[s] = r;
        state.skills = structuredClone(skills);
        for (const [cat, sigs] of Object.entries(mine)) for (const [s, r] of Object.entries(sigs)) if (!state.skills[cat]?.[s]) (state.skills[cat] ||= {})[s] = r;
        state.base = structuredClone(skills);
        state.baseVersion = parent_version;
        return { base_version: state.baseVersion, kept_own_rules: Object.values(mine).reduce((n, x) => n + Object.keys(x).length, 0) };
      },
      // родитель подписывает родословную потомка — только по команде владельца и в рамках мандата
      "sign-lineage": async ({ child_did, mandate, scope, depth }) => {
        if (mandate?.credentialSubject?.id !== agent.did) throw new Error("мандат выдан не этому агенту");
        return { lineage: sign(agent, "AgentLineage", { id: child_did, parent: agent.did, mandate: mandate.id, depth, scope }, { validDays: 365 }) };
      },
    },
  });
  agent.state = state;
  return agent;
}
