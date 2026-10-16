// Агент №3 «Поставщик вариантов»: витрина песочницы. По каждому заданию отдаёт агенту-закупщику кучу вариантов —
// товары и платные инструменты от разных продавцов, включая ловушки (мошенники, не тот размер, долгая доставка, скрытая доставка).
// Варианты на витрину выкладывает оператор площадки (стенд) заранее: так закупщик видит то же, что потом проверит эталон.
import { z } from "zod";
import { join } from "node:path";
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { startAgent } from "../lab/agentkit.js";
import * as S from "../skills/xonta-shop.js";

export async function startShopSupplier({ port, ownerDid, dataDir }) {
  mkdirSync(dataDir, { recursive: true });
  const stateFile = join(dataDir, "state.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { stock: {}, served: 0 };
  const save = () => { writeFileSync(stateFile + ".tmp", JSON.stringify(state)); renameSync(stateFile + ".tmp", stateFile); }; // атомарно: обрыв процесса не портит файл
  const tools = [
    { name: "catalog", description: "Категории и товары витрины: электроника, одежда, продукты, дом, билеты и отели, платные инструменты агентов.", input: {}, annotations: { readOnlyHint: true },
      run: () => ({ categories: Object.fromEntries(S.CATEGORIES.map((c) => [c, S.CATEGORY_NAME[c]])), tasks_in_stock: Object.keys(state.stock).length }) },
    { name: "offers", description: "Все варианты по заданию: продавец, рейтинг, отзывы, срок на площадке, цена, доставка, признаки товара.", input: { task_id: z.string().max(40) }, annotations: { readOnlyHint: true },
      run: ({ task_id }) => { const o = state.stock[task_id]; if (!o) throw new Error("по этому заданию вариантов нет"); state.served++; save(); return { task_id, offers: o }; } },
  ];
  const agent = await startAgent({ port, name: "xonta-shop-supplier", tools, ownerDid, keyFile: join(dataDir, "agent.jwk"), instructions: "Витрина песочницы: варианты товаров и платных инструментов по заданию.",
    ownerRoutes: { stock: async ({ items = [] }) => { for (const x of items) state.stock[x.task_id] = x.offers; const ks = Object.keys(state.stock); if (ks.length > 4000) for (const k of ks.slice(0, ks.length - 4000)) delete state.stock[k]; save(); return { stocked: items.length }; } } });
  agent.state = state;
  return agent;
}
