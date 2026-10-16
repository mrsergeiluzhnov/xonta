// Заглушка модели и учебные данные для проверки стенда «Репутация» без сети и без затрат (STAND_MODE=fixture).
// В учебном тексте спрятан маркер настоящей оценки. Заглушка-агент безошибочно видит крайние оценки (1 и 5),
// а средние угадывает тем лучше, чем больше примеров этой группы в её запросе. Это проверка механики, не результат.
import { seeded } from "../src/tester.js";

export function fixtureRows(split, offset, n) {
  const r = seeded(`${split}-${offset}`);
  return Array.from({ length: n }, (_, i) => {
    const label = Math.floor(r() * 5);
    return { text: `[учебный ${split} ${offset + i}] Отзыв об организации. маркер ${label + 1}. ${["Обслуживание", "Интерьер", "Цены", "Персонал"][Math.floor(r() * 4)]} — ${["так себе", "нормально", "отлично", "плохо"][Math.floor(r() * 4)]}.`, label };
  });
}

export function mockAgent(system, user) {
  // учебные «правила»: чем больше ошибок прочитано, тем больше правил (до 6) — так проверяется механика, а не качество
  const nErr = user.split("\n").filter((l) => l.startsWith("«")).length;
  if (system.includes("Ты улучшаешь правила распределения")) { const k = Math.max(1, Math.min(6, Math.floor(nErr / 3))); return JSON.stringify({ rules: Array.from({ length: k }, (_, i) => `учебное правило распределения ${i + 1}`) }); }
  if (system.includes("Ты улучшаешь правила")) {
    const k = Math.max(1, Math.min(6, Math.floor(nErr / 6)));
    const set = (m) => Array.from({ length: Math.min(6, m) }, (_, i) => `учебное правило ${i + 1}`);
    const many = system.match(/Предложи (\d) разн/);
    return JSON.stringify(many ? { candidates: Array.from({ length: Number(many[1]) }, (_, j) => set(k + j)) } : { rules: set(k) });
  }
  if (user.startsWith("TASK: route")) {
    // учебный маршрутизатор: верная группа по маркеру; чем больше правил распределения, тем реже ошибка или «не уверен»
    const choices = [...system.matchAll(/^(\d) — (.+)$/gm)].map((m) => ({ n: Number(m[1]), label: m[2] })).filter((c) => c.n > 0);
    const rules = (system.match(/правило распределения/g) || []).length;
    const items = user.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    return JSON.stringify(items.map((x) => {
      const t = Number((x.text.match(/маркер (\d)/) || [])[1] || 3);
      const right = choices.find((c) => c.label.includes(String(t)))?.n ?? 0;
      const h = [...x.id].reduce((s2, c) => s2 + c.charCodeAt(0) * 7, 0) % 100 / 100;
      const pErr = Math.max(0.05, 0.3 - 0.04 * rules);
      return { id: x.id, group: h < pErr / 2 ? 0 : h < pErr ? (right % choices.length) + 1 : right };
    }));
  }
  const lines = user.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const midExamples = (system.match(/→ [34]\b/g) || []).length + 3 * (system.match(/^- \[(середина|негатив)/gm) || []).length;
  return JSON.stringify(lines.map((x) => {
    const t = Number((x.text.match(/маркер (\d)/) || [])[1] || 3);
    let rating = t;
    if (t === 2 || t === 3 || t === 4) {
      const p = Math.min(Number(process.env.MOCK_P_MAX || 0.9), 0.25 + Number(process.env.MOCK_P_STEP || 0.12) * midExamples);
      const h = [...x.id].reduce((s, c) => s + c.charCodeAt(0), 0) % 100 / 100;
      if (h > p) rating = t >= 3 ? 5 : 1;
    }
    return { id: x.id, rating };
  }));
}
export const mockJudge = mockAgent;
