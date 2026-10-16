// Агент №3 «База знаний»: по обращению отдаёт три статьи. Источник ненадёжен — часть статей в устаревшей версии
// (старые сроки и цены). Ленту на витрину выкладывает оператор площадки (стенд) заранее.
import { z } from "zod";
import { join } from "node:path";
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { startAgent } from "../lab/agentkit.js";

export async function startSupportKb({ port, ownerDid, dataDir }) {
  mkdirSync(dataDir, { recursive: true });
  const stateFile = join(dataDir, "state.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { stock: {}, served: 0 };
  const save = () => { writeFileSync(stateFile + ".tmp", JSON.stringify(state)); renameSync(stateFile + ".tmp", stateFile); };
  const tools = [
    { name: "kb_search", description: "Статьи базы знаний, относящиеся к обращению (до трёх).", input: { ticket_id: z.string().max(40) }, annotations: { readOnlyHint: true },
      run: ({ ticket_id }) => { const f = state.stock[ticket_id]; if (!f) throw new Error("по этому обращению статей нет"); state.served++; save(); return { ticket_id, articles: f }; } },
  ];
  const agent = await startAgent({ port, name: "xonta-support-kb", tools, ownerDid, keyFile: join(dataDir, "agent.jwk"), instructions: "База знаний магазина-песочницы: статьи по обращению клиента.",
    ownerRoutes: { stock: async ({ items = [] }) => { for (const x of items) state.stock[x.ticket_id] = x.articles; const ks = Object.keys(state.stock); if (ks.length > 6000) for (const k of ks.slice(0, ks.length - 6000)) delete state.stock[k]; save(); return { stocked: items.length }; } } });
  agent.state = state;
  return agent;
}
