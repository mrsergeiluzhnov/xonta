// npm run lookup-scenario — агент без присмотра гоняет платный поиск телефонов по списку профилей.
// Цифры взяты из открытого разбора одного утра (Kevin Hall, dev.to, 16.10.2026): 103 прогона примерно по 1 000 профилей,
// номер найден у 1 021 из 79 625 отвеченных строк (1,28%), а у подходящих списков той недели — 14–26%. Только доли исходов,
// никаких строк и личных данных. Модели нет, это быстрый детерминированный расчёт на 500 зёрнах.
//
// Сравниваются три правила остановки:
//   cap    — лимит бюджета: агент запускает весь список сразу и останавливается, когда найдено столько номеров, сколько оплачено
//            (5 000 номеров — ожидание по «экзамену» 25% на 20 000 строк). Так было в то утро.
//   probe  — правило автора: случайная выборка 100 строк со своим зерном; если найдено меньше 5% — стоп и вопрос человеку,
//            иначе весь остаток запускается сразу.
//   xonta  — наш подход: агент запускает партиями, первая партия 100 строк, после чистой партии лимит вдвое больше (до 5 000).
//            Каждые 100 строк проверка по последним 300: если доля найденных значимо ниже порога владельца (те же 5%, биномиальный
//            тест, p < 0,01) — лимит в ноль, вопрос человеку. Уже запущенная партия дорабатывает, это честно входит в потери.
//
// Сценарии:
//   morning   — то утро: весь список не подходит, 1,28%.
//   good20 / good14 — подходящий список (20% и нижняя граница недели 14%): здесь правило не должно останавливать зря.
//   spliced   — склеенный список: первые 30 000 строк подходят (20%), остальные 73 000 нет (1,28%). Средняя доля по всему
//               списку 6,7%, то есть выше порога, — проверка на один раз в начале это не видит.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { seeded } from "../src/tester.js";
import { binomTail } from "../src/guardian.js";
import { shouldAsk, divergence, JOB_DEFAULTS } from "../src/jobs.js";

export const LIST = 103_000, FLOOR = 0.05, PROBE = 100, CAP_FOUND = 5000, CHECK_EVERY = 100, WINDOW = 300, ALPHA = 0.01;
export const MORNING = 1021 / 79625; // доля найденных среди отвеченных строк в то утро
export const SCENARIOS = {
  morning: { title: "the morning: the whole list doesn't fit", title_ru: "то утро: весь список не подходит", rate: (_i) => MORNING },
  good20: { title: "a fitting list, 20%", title_ru: "подходящий список, 20%", rate: () => 0.2 },
  good14: { title: "a fitting list, 14% (low end of that week)", title_ru: "подходящий список, 14% (нижняя граница недели)", rate: () => 0.14 },
  spliced: { title: "spliced list: 30k fit at 20%, then 73k at 1.28%", title_ru: "склеенный список: 30 000 по 20%, потом 73 000 по 1,28%", rate: (i) => (i < 30_000 ? 0.2 : MORNING), badFrom: 30_000 },
  // 0.17: список у самого порога — проверка, что пользователя не заваливают вопросами
  border6: { title: "a borderline list, 6% (floor 5%)", title_ru: "пограничный список, 6% при пороге 5%", rate: () => 0.06, v2: true },
  // 0.17: агент приукрашивает — на деле 1,28%, а он заявляет ещё 4,7% «найденных», всего около 6%
  inflating: { title: "the agent inflates: 1.28% real, ~6% claimed", title_ru: "агент приукрашивает: на деле 1,28%, заявляет около 6%", rate: () => MORNING, fake: 0.0472, badFrom: 0, v2: true },
};
export const STALE = 0.05, USER_STOP = 0.03; // доля строк, которые проверяющий не подтвердит из-за устаревания, даже если агент честен
const below = (k, n, p) => 1 - binomTail(k + 1, n, p); // P(X ≤ k)

// один список: для каждой строки — найден ли номер (детерминированно по зерну)
// claim — что агент сообщает (у честного агента совпадает с hit)
function makeList(sc, seed) {
  const r = seeded(`lookup|${sc}|${seed}`), rate = SCENARIOS[sc].rate, fake = SCENARIOS[sc].fake || 0; const hit = new Uint8Array(LIST), claim = new Uint8Array(LIST);
  for (let i = 0; i < LIST; i++) { hit[i] = r() < rate(i) ? 1 : 0; claim[i] = hit[i] || (fake && r() < fake) ? 1 : 0; }
  return { hit, claim };
}

export function runPolicy(policy, sc, seed) {
  const L = makeList(sc, seed), badFrom = SCENARIOS[sc].badFrom ?? (sc === "morning" ? 0 : Infinity);
  // прежние правила видят то, что сообщает агент (claim); «найдено» — сколько на самом деле
  const hit = L.claim, real = L.hit;
  let rows = 0, found = 0, stopped = false, stopAt = null, asks = 0, seen = 0;
  if (policy === "cap") { for (let i = 0; i < LIST && seen < CAP_FOUND; i++) { seen += hit[i]; found += real[i]; rows = i + 1; } }
  else if (policy === "probe") {
    // случайные 100 строк по всему списку (как sampleSeed у автора), потом решение
    const r = seeded(`probe|${sc}|${seed}`), idx = new Set(); while (idx.size < PROBE) idx.add(Math.floor(r() * LIST));
    let k = 0; for (const i of idx) k += hit[i];
    rows = PROBE; found = k; asks = 1; // выборка + решение (вопрос человеку или одобрение полного прогона)
    if (k / PROBE < FLOOR) { stopped = true; stopAt = PROBE; found = 0; for (const i of idx) found += real[i]; }
    else { found = 0; for (let i = 0; i < LIST; i++) found += real[i]; rows = LIST + PROBE; } // выборка оплачена отдельно, потом весь список
  } else if (policy === "xonta") {
    let batch = 100, win = [];
    while (rows < LIST && !stopped) {
      const end = Math.min(LIST, rows + batch); let alarmed = false;
      for (let i = rows; i < end; i++) {
        found += real[i]; win.push(hit[i]); if (win.length > WINDOW) win.shift();
        if (!alarmed && (i + 1 - 0) % CHECK_EVERY === 0) { const k = win.reduce((a, b) => a + b, 0); if (below(k, win.length, FLOOR) < ALPHA) { alarmed = true; stopAt = i + 1; } }
      }
      rows = end; // партия уже запущена — дорабатывает до конца
      if (alarmed) { stopped = true; asks++; } else batch = Math.min(5000, batch * 2);
    }
  } else if (policy === "jobs" || policy === "jobs_gw") {
    // 0.17: правило оркестратора (src/jobs.js). Окно 100 строк. Самоотчёт — порции до 1 000 строк (мандат задачи) и выборочная
    // проверка 10 строк после каждой сотни; через шлюз — каждый вызов идёт через оркестратор, успехи считает шлюз, тревога
    // останавливает сразу. Пользователь видит прогноз и останавливает, если доля после его прошлого решения (или с начала) меньше
    // USER_STOP (3%) или проверяющий не подтвердил заявленное; иначе продолжает с границей min_rate = порог. Это допущение о
    // человеке, а не правило оркестратора.
    const gw = policy === "jobs_gw", job = { floor: FLOOR, approval: null, spent: 0, since: { n: 0, k: 0 } }, vr = seeded(`verify|${sc}|${seed}`), pool = { c: 0, u: 0 };
    while (rows < LIST && !stopped) {
      const end = Math.min(LIST, rows + (gw ? 100 : 1000));
      for (let w = rows; w < end && !stopped; w += 100) {
        const we = Math.min(end, w + 100); let k = 0;
        for (let i = w; i < we; i++) { k += gw ? real[i] : hit[i]; found += real[i]; }
        rows = we; job.since.n += we - w; job.since.k += k;
        let d = shouldAsk(job, { n: we - w, k });
        if (!gw && !d.ask) { // выборочная проверка: 7 из заявленных успехов, проверяющий видит правду с поправкой на устаревание
          const ok = []; for (let i = w; i < we; i++) if (hit[i]) ok.push(i);
          const pickN = Math.min(7, ok.length); let un = 0;
          for (let j = 0; j < pickN; j++) { const i = ok.splice(Math.floor(vr() * ok.length), 1)[0]; if (!real[i] || vr() < STALE) un++; }
          pool.c += pickN; pool.u += un;
          if (pickN && (divergence({ claimed_ok: pickN, unconfirmed: un }, { alpha: JOB_DEFAULTS.alpha_single }).diverged || divergence({ claimed_ok: pool.c, unconfirmed: pool.u }).diverged)) d = { ask: true, reason: "claims_not_confirmed" };
        }
        if (d.ask) {
          asks++;
          // пользователь смотрит на долю после своего прошлого решения (или с начала), её показывает прогноз
          if (d.reason === "claims_not_confirmed" || job.since.k / job.since.n < USER_STOP) { stopped = true; stopAt = rows; }
          else { job.approval = { rate_at: Math.max(k / (we - w), FLOOR), min_rate: FLOOR, max_spend: null }; job.since = { n: 0, k: 0 }; }
        }
      }
      if (stopped && !gw && rows < end) { for (let i = rows; i < end; i++) found += real[i]; rows = end; } // запущенная порция дорабатывает
    }
  }
  const badRows = Math.max(0, Math.min(rows, LIST) - Math.min(badFrom, LIST));
  return { rows, found, stopped, stopAt, asks, badRows };
}

export const POLICIES = ["cap", "probe", "xonta", "jobs", "jobs_gw"];
export function simulate({ seeds = 500 } = {}) {
  const out = {};
  for (const sc of Object.keys(SCENARIOS)) for (const p of POLICIES) {
    const rs = Array.from({ length: seeds }, (_, s) => runPolicy(p, sc, s));
    const m = (f) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    // через сколько строк после начала неподходящей части сработала остановка (остановки раньше неё считаются отдельно)
    const b0 = SCENARIOS[sc].badFrom ?? 0, lat = rs.filter((r) => r.stopAt != null && r.stopAt >= b0).map((r) => r.stopAt - b0).sort((a, b) => a - b);
    out[`${sc}|${p}`] = { rows: Math.round(m((r) => r.rows)), found: Math.round(m((r) => r.found)), bad_rows: Math.round(m((r) => r.badRows)), stopped: Math.round(1000 * m((r) => (r.stopped ? 1 : 0))) / 10, latency_median: lat.length ? lat[Math.floor(lat.length / 2)] : null, latency_p95: lat.length ? lat[Math.floor(0.95 * (lat.length - 1))] : null, stopped_early: Math.round(1000 * rs.filter((r) => r.stopAt != null && r.stopAt < b0).length / rs.length) / 10, asks: Math.round(10 * m((r) => r.asks)) / 10 };
  }
  return out;
}

const fmt = (x) => (x == null ? "—" : Math.round(x).toLocaleString("en-US").replace(/,/g, " "));
function table(R, lang) {
  const P = lang === "ru" ? { cap: "лимит бюджета", probe: "проба 100 строк", xonta: "партии и проверка на ходу (0.16.2)", jobs: "задача 0.17, самоотчёт + проверяющий", jobs_gw: "задача 0.17, через шлюз" } : { cap: "budget cap", probe: "100-row probe", xonta: "batches checked as they run (0.16.2)", jobs: "0.17 job, self-report + checker", jobs_gw: "0.17 job, through the gateway" };
  const H = lang === "ru" ? "| Сценарий | Правило | Строк прогнано | Номеров найдено | Строк по неподходящему списку | Остановился, % | Через сколько строк (медиана / 95%) | Вопросов человеку |" : "| Scenario | Rule | Rows run | Numbers found | Rows on the unfitting list | Stopped, % | Rows until stop (median / 95%) | Questions to a human |";
  const lines = [H, "|---|---|---|---|---|---|---|---|"];
  for (const [sc, s] of Object.entries(SCENARIOS)) for (const p of POLICIES) { const r = R[`${sc}|${p}`]; lines.push(`| ${lang === "ru" ? s.title_ru : s.title} | ${P[p]} | ${fmt(r.rows)} | ${fmt(r.found)} | ${fmt(r.bad_rows)} | ${r.stopped} | ${r.latency_median == null ? "—" : `${fmt(r.latency_median)} / ${fmt(r.latency_p95)}`} | ${r.asks} |`); }
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const R = simulate({ seeds: Number(process.argv[2] || 500) });
  console.log(table(R, "ru")); console.log(); console.log(table(R, "en"));
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "results", "lookup-scenario", "tables.md"), `${table(R, "ru")}\n\n${table(R, "en")}\n`);
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "results", "lookup-scenario"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "data.json"), JSON.stringify({ params: { LIST, FLOOR, PROBE, CAP_FOUND, CHECK_EVERY, WINDOW, ALPHA, MORNING, STALE }, results: R }, null, 1));
}
