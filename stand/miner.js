// Правила, которые оркестратор находит сам в журнале исходов (0.26). Урок экспериментов осени 2026: агенты плохо выводят
// правила из собственных ошибок, а статистика исходов находит то, чего модель не видит (слово «availability» у сбоев GitHub).
// Здесь — то же для заданий тем: в каждой категории ищем слова, которые встречаются там, где верный ответ один и тот же,
// заметно чаще, чем в остальных заданиях этой категории. Правило — подсказка агенту, статус ему двигают только исходы
// (замер парами у оркестратора), как и правилам агентов.

const STOP = new Set("если когда чтобы перед после через этого этой этот того тому всех всего более менее нужно надо можно также тоже только уже ещё есть быть было были будет который которая которые просит просят задание заданию задании счёт счета счёта".split(" "));
export const words = (s) => [...new Set((String(s).toLowerCase().match(/[a-zа-яё][a-zа-яё-]{3,}/g) || []).filter((w) => !STOP.has(w)))];

// rows: [{ id, category, brief, correct }] — по одному на задание (повторы одного задания не учитываются дважды)
export function mineRules(rows, { minPos = 4, minShare = 0.3, ratio = 3, maxWords = 2 } = {}) {
  const uniq = [...new Map(rows.map((r) => [r.id, r])).values()];
  const out = [];
  for (const cat of [...new Set(uniq.map((r) => r.category))]) {
    const inCat = uniq.filter((r) => r.category === cat);
    for (const act of [...new Set(inCat.map((r) => r.correct))]) {
      const pos = inCat.filter((r) => r.correct === act), neg = inCat.filter((r) => r.correct !== act);
      if (pos.length < minPos || neg.length < minPos) continue;
      const cnt = (xs) => { const c = {}; for (const r of xs) for (const w of words(r.brief)) c[w] = (c[w] || 0) + 1; return c; };
      const cp = cnt(pos), cn = cnt(neg);
      const cand = Object.keys(cp).map((w) => ({ w, ps: cp[w] / pos.length, pn: (cn[w] || 0) / neg.length }))
        .filter((x) => x.ps >= minShare && x.ps >= ratio * (x.pn + 0.05))
        .sort((a, b) => (b.ps - b.pn) - (a.ps - a.pn)).slice(0, maxWords);
      if (!cand.length) continue;
      out.push({ category: cat, action: act, words: cand.map((x) => x.w), share: Math.round(100 * cand[0].ps), other: Math.round(100 * cand[0].pn), pos: pos.length, neg: neg.length });
    }
  }
  return out;
}

export const ruleText = (m) => `в категории ${m.category}: если в задании есть «${m.words.join("» или «")}», верный ответ обычно ${m.action} (так в ${m.share}% таких заданий против ${m.other}% остальных)`;
export const techniqueOf = (m) => `xonta:${m.category}:${m.action}:${m.words.join("+")}`.slice(0, 80);
