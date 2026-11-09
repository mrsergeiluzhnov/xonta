// Тема market (0.31): задания на котировках, загрузка свечей с Мосбиржи и запасной путь без сети.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as M from "../stand/domains/market.js";

const synth = await M.loadMarket({ source: "synthetic" });
M.useMarket(synth);
const tasks = (era, n = 300) => Array.from({ length: n }, (_, k) => M.makeTask(`t-${era}-${k}`, era));

test("задания корректны во всех эпохах и повторяются по зерну", () => {
  for (const era of [0, 1, 2]) for (const t of tasks(era)) {
    assert.ok(M.CATEGORIES.includes(t.category), t.category);
    assert.ok(M.ACTIONS.includes(t.truth.correct));
    assert.notEqual(t.truth.correct, M.HUMAN);
    for (const a of M.ACTIONS.filter((x) => x !== t.truth.correct && x !== M.HUMAN)) assert.ok(Number.isFinite(t.truth.harm[a]) && t.truth.harm[a] >= 0, `${t.category} ${a}`);
    assert.equal(t.truth.harm[t.truth.correct], undefined);
    assert.ok(t.truth.amount > 0 && Object.keys(M.CHECKS).every((c) => typeof t.checks[c] === "string"));
  }
  assert.deepEqual(M.makeTask("same", 1), M.makeTask("same", 1));
});

test("эпохи меняют мир: в 1 чаще устаревшая цена, в 2 — превышение предела", () => {
  const share = (ts, cat, right) => ts.filter((t) => t.category === cat && t.truth.correct === right).length / ts.length;
  assert.ok(share(tasks(1), "stale_price", "hold") > share(tasks(0), "stale_price", "hold") * 2);
  assert.ok(share(tasks(2), "concentration", "hold") > share(tasks(0), "concentration", "hold") * 2);
});

test("лишнее по лотам ограничено покупательной способностью счёта", () => {
  for (const t of tasks(0, 600).filter((x) => x.category === "lot_units")) {
    assert.equal(t.truth.correct, "fix");
    assert.ok(t.truth.amount <= M.BUYING_POWER + 400000, `${t.truth.amount}`);
    assert.ok(t.truth.harm.execute < M.BUYING_POWER, `${t.truth.harm.execute}`);
  }
});

test("заглушка решает ловушки, только если видит нужную проверку", () => {
  for (const t of tasks(0).filter((x) => x.category !== "regular_order")) {
    const key = M.KEY_CHECK[t.category][0];
    assert.equal(M.mockAction(`${t.brief}\n${key}: ${t.checks[key]}`, "Проверки не покупаешь"), t.truth.correct, `${t.category}: ${t.checks[key]}`);
  }
});

// ответы ISS в том виде, в каком их отдаёт Мосбиржа: columns + data, свечи страницами по 500
function fakeIss() {
  const tickers = M.TICKERS, calls = [];
  const get = async (url) => {
    calls.push(url);
    if (url.includes("iss.only=securities")) return { securities: { columns: ["SECID", "LOTSIZE", "SHORTNAME"], data: tickers.map((s) => [s, s === "SNGS" ? 100 : 10, s]) } };
    const start = Number(new URL(url).searchParams.get("start")), total = 620;
    const data = Array.from({ length: Math.max(0, Math.min(500, total - start)) }, (_, k) => { const i = start + k, p = 100 + Math.sin(i / 9) * 10; return [p, p * 1.01, p * 1.02, p * 0.98, 1e6, 1e4, `2025-01-01 00:00:00`.replace("01-01", `${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`), "x"]; });
    return { candles: { columns: ["open", "close", "high", "low", "value", "volume", "begin", "end"], data } };
  };
  return { get, calls };
}

test("свечи с Мосбиржи: страницы, сохранённая копия, повторный запуск без сети", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mkt-")), f = fakeIss();
  const m = await M.loadMarket({ source: "moex", from: "2025-01-01", till: "2026-10-30", cacheDir: dir, get: f.get });
  assert.equal(m.source, "moex");
  assert.equal(m.inst.SBER.days.length, 620);
  assert.equal(m.inst.SNGS.lot, 100);
  assert.match(m.note, /Настоящие дневные свечи Мосбиржи/);
  assert.ok(existsSync(join(dir, "moex-2025-01-01_2026-10-30.json")));
  const again = await M.loadMarket({ source: "moex", from: "2025-01-01", till: "2026-10-30", cacheDir: dir, get: async () => { throw new Error("сети нет"); } });
  assert.equal(again.source, "moex"); assert.match(again.note, /сохранённой копии/);
  M.useMarket(m); const t = M.makeTask("moex-1", 0); assert.equal(t.truth.source, "moex"); M.useMarket(synth);
});

test("Мосбиржа недоступна: синтетика и громкая пометка, а не тихая подмена", async () => {
  const m = await M.loadMarket({ source: "moex", cacheDir: null, get: async () => { throw new Error("403"); } });
  assert.equal(m.source, "synthetic"); assert.equal(m.fallback, true);
  assert.match(m.note, /ВНИМАНИЕ: Мосбиржа недоступна/);
});

test("без пар и крупных лотов ловушки не выдумываются", () => {
  const only = { source: "moex", inst: { GAZP: { lot: 1, days: synth.inst.GAZP.days }, LKOH: { lot: 1, days: synth.inst.LKOH.days } } };
  M.useMarket(only);
  for (const t of Array.from({ length: 200 }, (_, k) => M.makeTask(`np-${k}`, 0))) assert.ok(!["wrong_ticker", "lot_units"].includes(t.category));
  M.useMarket(synth);
});
