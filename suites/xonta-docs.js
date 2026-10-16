// Набор задач для агента «Xonta Документы» (mcp.xonta.ru). Ответы проверяются независимо:
// контрольные числа ИНН считаются здесь, НДС берётся на суммах, где он делится нацело, остальное — эталонные пары.
export const SUITE = { id: "xonta-docs-basic", version: "1" };

const rnd = (r, n) => Math.floor(r() * n);
const digits = (r, n) => Array.from({ length: n }, () => rnd(r, 10)).join("");
function inn10(r) {
  const d = digits(r, 9).split("").map(Number);
  const w = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const c = (d.reduce((s, x, i) => s + x * w[i], 0) % 11) % 10;
  return d.join("") + c;
}
function inn12(r) {
  const d = digits(r, 10).split("").map(Number);
  const c1 = ([7, 2, 4, 10, 3, 5, 9, 4, 6, 8].reduce((s, w, i) => s + w * d[i], 0) % 11) % 10;
  const c2 = ([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8].reduce((s, w, i) => s + w * [...d, c1][i], 0) % 11) % 10;
  return d.join("") + c1 + c2;
}
const corrupt = (s) => s.slice(0, -1) + ((Number(s.at(-1)) + 1) % 10);

// Генератор задач. Задача = один или несколько шагов (вызовов инструментов) в одной категории.
export function generate(r, n = 30) {
  const tasks = [];
  const add = (category, steps) => tasks.push({ category, steps });
  for (let i = 0; i < n; i++) {
    // каждая третья задача — многошаговая «подготовка счёта», остальные по очереди из пяти категорий
    const kind = i % 3 === 2 ? 5 : (i - Math.floor(i / 3)) % 5;
    if (kind === 0) {
      const ok = r() < 0.6, inn = r() < 0.5 ? inn10(r) : inn12(r);
      add("документы/реквизиты", [{ tool: "validate_requisites", args: { inn: ok ? inn : corrupt(inn) }, check: (o) => o.all_valid === ok, expect: `all_valid=${ok}` }]);
    } else if (kind === 1) {
      const k = 1 + rnd(r, 900);
      add("текст/суммы", [{ tool: "amount_in_words", args: { amount: String(122 * k), vat_rate: "22" }, check: (o) => o.vat?.amount === `${22 * k}.00`, expect: `НДС ${22 * k}.00` }]);
    } else if (kind === 2) {
      const cases = [["2026-12-25", "5", "2027-01-12"], ["2026-10-05", "4", "2026-10-09"], ["2026-11-02", "3", "2026-11-06"]];
      const [date, add_working_days, res] = cases[rnd(r, cases.length)];
      add("даты/календарь", [{ tool: "working_days", args: { date, add_working_days }, check: (o) => o.result_date === res, expect: res }]);
    } else if (kind === 3) {
      const cases = [[{ full_name: "Иванов Иван Петрович" }, "Иванова Ивана Петровича"], [{ full_name: "Кузнецова Анна Сергеевна", case: "дательный" }, "Кузнецовой Анне Сергеевне"], [{ full_name: "Ковальчук Никита Ильич", case: "instrumental" }, "Ковальчуком Никитой Ильичем"]];
      const [args, res] = cases[rnd(r, cases.length)];
      add("текст/склонение", [{ tool: "decline_name", args, check: (o) => o.full === res, expect: res }]);
    } else if (kind === 4) {
      const cases = [[{ text: "Щукина Юлия Цыганова, ЖЕНЯ" }, "Shchukina Iuliia Tsyganova, ZHENIA"], [{ text: "Счёт на оплату № 15!", system: "slug" }, "schet-na-oplatu-15"], [{ text: "Цветочная улица", system: "gost" }, "Cvetochnaya ulica"]];
      const [args, res] = cases[rnd(r, cases.length)];
      add("текст/транслитерация", [{ tool: "transliterate", args, check: (o) => o.result === res, expect: res }]);
    } else {
      // многошаговая задача «подготовка счёта»: проверить ИНН покупателя → посчитать НДС → склонить подписанта.
      // Повторяется часто и детерминирована — материал для сигнала Б (выделить составной инструмент).
      const k = [10, 20, 30][rnd(r, 3)]; // небольшой набор сумм: повторы показывают, детерминирован ли инструмент
      add("документы/подготовка счёта", [
        { tool: "validate_requisites", args: { inn: "7707083893" }, check: (o) => o.all_valid === true, expect: "all_valid=true" },
        { tool: "amount_in_words", args: { amount: String(122 * k), vat_rate: "22" }, check: (o) => o.vat?.amount === `${22 * k}.00`, expect: `НДС ${22 * k}.00` },
        { tool: "decline_name", args: { full_name: "Иванов Иван Петрович" }, check: (o) => o.full === "Иванова Ивана Петровича", expect: "Иванова Ивана Петровича" },
      ]);
    }
  }
  return tasks;
}
