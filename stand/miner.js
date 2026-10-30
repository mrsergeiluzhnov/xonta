// Правила, которые оркестратор находит сам в журнале исходов (0.26). Урок экспериментов осени 2026: агенты плохо выводят
// правила из собственных ошибок, а статистика исходов находит то, чего модель не видит (слово «availability» у сбоев GitHub).
// Здесь — то же для заданий тем: в каждой категории ищем слова, которые встречаются там, где верный ответ один и тот же,
// заметно чаще, чем в остальных заданиях этой категории. Правило — подсказка агенту, статус ему двигают только исходы
// (замер парами у оркестратора), как и правилам агентов.

const STOP = new Set("если когда чтобы перед после через этого этой этот того тому всех всего более менее нужно надо можно также тоже только уже ещё есть быть было были будет который которая которые просит просят задание заданию задании счёт счета счёта".split(" "));
export const words = (s) => [...new Set((String(s).toLowerCase().match(/[a-zа-яё][a-zа-яё-]{3,}/g) || []).filter((w) => !STOP.has(w)))];

// Точный односторонний тест Фишера: вероятность увидеть k и больше «верно act» среди n заданий со словом, если слово
// ни при чём (всего в категории N заданий, из них K с верным act).
const lf = (() => { const c = [0]; return (n) => { for (let i = c.length; i <= n; i++) c[i] = c[i - 1] + Math.log(i); return c[n]; }; })();
const lc = (n, k) => lf(n) - lf(k) - lf(n - k);
export function fisherP(k, n, K, N) {
  let p = 0;
  for (let x = k; x <= Math.min(n, K); x++) p += Math.exp(lc(K, x) + lc(N - K, n - x) - lc(N, n));
  return Math.min(1, p);
}

// rows: [{ id, category, brief, correct }] — по одному на задание (повторы одного задания не учитываются дважды).
// 0.26.1 (run-acc-v2-5): все пять правил 0.26.0 оказались шумом — слово не меняло верный ответ ни на процент (проверено на
// 200 тысячах заданий темы), при этом одно из них («права администратора» → deny) агенты выполнили. Причины: выборки по
// 4–5 заданий и доля считалась не той стороной — P(слово | ответ) вместо P(ответ | слово). Теперь правило выдаётся, только
// если среди заданий со словом верный ответ один и тот же не меньше чем в minShare, таких заданий не меньше minN и случайно
// так выйти могло с вероятностью меньше alpha с поправкой Бонферрони на число проверенных пар «слово — ответ» (тест Фишера).
// Поправка нужна: слов в категории десятки, и без неё по 0,01 на каждое шум находится каждый раунд. Старые задания одни
// и те же в каждом прогоне темы, поэтому случайное совпадение в них повторяется, — вот почему порог строгий.
// share и other — доли верного act среди заданий со словом и без.
export function mineRules(rows, { minN = 5, minShare = 0.7, alpha = 0.05, maxWords = 2 } = {}) {
  const uniq = [...new Map(rows.map((r) => [r.id, r])).values()];
  const out = [], found = [];
  let tests = 0;
  for (const cat of [...new Set(uniq.map((r) => r.category))]) {
    const inCat = uniq.filter((r) => r.category === cat), N = inCat.length;
    const ws = inCat.map((r) => new Set(words(r.brief)));
    for (const act of [...new Set(inCat.map((r) => r.correct))]) {
      const K = inCat.filter((r) => r.correct === act).length;
      if (K === N) continue;
      const test = (list) => {
        const idx = inCat.map((_, i) => i).filter((i) => list.some((w) => ws[i].has(w)));
        const n = idx.length, k = idx.filter((i) => inCat[i].correct === act).length;
        return { n, k, share: n ? k / n : 0, other: N - n ? (K - k) / (N - n) : 0, p: n && N - n ? fisherP(k, n, K, N) : 1 };
      };
      const all = [...new Set(ws.flatMap((x) => [...x]))].map((w) => ({ w, ...test([w]) })).filter((t) => t.n >= minN && N - t.n >= 1);
      tests += all.length;
      const ok = (t) => t.n >= minN && t.share >= minShare && t.share > t.other;
      const cand = all.filter(ok).sort((a, b) => a.p - b.p || b.n - a.n);
      if (!cand.length) continue;
      const pick = [cand[0].w];
      for (const c of cand.slice(1)) { if (pick.length >= maxWords) break; const u = test([...pick, c.w]); if (ok(u) && u.p <= test(pick).p) pick.push(c.w); }
      found.push({ cat, act, pick, t: test(pick) });
    }
  }
  for (const { cat, act, pick, t } of found) if (t.p * Math.max(1, tests) < alpha)
    out.push({ category: cat, action: act, words: pick, share: Math.round(100 * t.share), other: Math.round(100 * t.other), n: t.n, k: t.k, p: Number(t.p.toPrecision(2)), tests });
  return out;
}

export const ruleText = (m) => m.n != null
  ? `в категории ${m.category}: если в задании есть «${m.words.join("» или «")}», верный ответ был ${m.action} в ${m.k} из ${m.n} таких заданий (в остальных заданиях категории — ${m.other}%)`
  : `в категории ${m.category}: если в задании есть «${m.words.join("» или «")}», верный ответ обычно ${m.action} (так в ${m.share}% таких заданий против ${m.other}% остальных)`;
export const techniqueOf = (m) => `xonta:${m.category}:${m.action}:${m.words.join("+")}`.slice(0, 80);
