// Агент №3 «Поставщик данных» для стенда «Репутация»: приносит размеченные отзывы (обучающая часть Georeview, 50 000)
// и передаёт их агенту репутации через шлюз оркестратора, подписывая каждый вызов своим ключом. У поставщика свой владелец.
import { z } from "zod";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { startAgent } from "../lab/agentkit.js";
import { connectMcp } from "../src/scan.js";
import { signingFetch } from "../src/callerauth.js";

export async function startGeoSupplier({ port, ownerDid, dataDir, data }) {
  mkdirSync(dataDir, { recursive: true });
  const stateFile = join(dataDir, "state.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { cursor: 0, delivered: 0, by_category: {} };
  const save = () => writeFileSync(stateFile, JSON.stringify(state));

  const tools = [
    { name: "supply", description: "Отдаёт размеченные отзывы об организациях (текст + оценка автора) из открытого набора Georeview.",
      input: { n: z.number().int().min(1).max(500), offset: z.number().int().min(0).optional() }, annotations: { readOnlyHint: true },
      run: async ({ n, offset }) => ({ reviews: await data.slice("train", offset ?? state.cursor, n), source: data.source }) },
    { name: "coverage", description: "Сколько отзывов передано и по каким группам.", input: {}, annotations: { readOnlyHint: true }, run: () => state },
  ];

  const agent = await startAgent({
    port, name: "xonta-geo-supplier", tools, ownerDid, keyFile: join(dataDir, "agent.jwk"),
    instructions: "Поставщик размеченных отзывов из открытого набора Georeview (MIT).",
    ownerRoutes: {
      // по команде владельца: взять следующую порцию и передать агенту через шлюз — отдельно по группам (метка категории задачи)
      // порция в два шага: prepare берёт отзывы, send передаёт одну группу (каждый вызов укладывается в таймаут HTTP)
      // key — получатель порции (дерево): у каждого своя отложенная порция, чужая подготовка её не затирает
      prepare: async ({ n, key = "default" }) => {
        const batch = await data.slice("train", state.cursor, n);
        state.cursor += batch.length;
        state.pendingBy ||= {};
        const pending = (state.pendingBy[key] = {});
        for (const r of batch) (pending[r.category] ||= []).push(r);
        state.delivered += batch.length; save();
        return { delivered: batch.length, cursor: state.cursor, categories: Object.keys(pending) };
      },
      send: async ({ gateway_url, category, budget, key = "default" }) => {
        const pending = state.pendingBy?.[key] || {};
        const reviews = pending[category] || [];
        if (!reviews.length) return { category, result: { checked: 0, correct: 0, learned: 0 } };
        const client = await connectMcp(gateway_url, { name: "geo-supplier", fetch: signingFetch({ did: agent.did, privateKey: agent.privateKey, extraHeaders: { "x-task-category": encodeURIComponent(category), "x-task-id": `ingest-${state.cursor}-${category}` } }) });
        try {
          const res = await client.callTool({ name: "ingest", arguments: { reviews, budget, source: agent.did } }, undefined, { timeout: Number(process.env.MCP_TOOL_TIMEOUT_MS || 600000) });
          const text = (res.content || []).map((c) => c.text || "").join("");
          state.by_category[category] = (state.by_category[category] || 0) + reviews.length;
          delete pending[category]; save();
          return { category, result: res.isError ? { error: text.slice(0, 200) } : JSON.parse(text) };
        } finally { await client.close().catch(() => {}); }
      },
      deliver: async ({ gateway_url, n, budget }) => {
        const batch = await data.slice("train", state.cursor, n);
        state.cursor += batch.length;
        const groups = {};
        for (const r of batch) (groups[r.category] ||= []).push(r);
        const results = {};
        for (const [category, reviews] of Object.entries(groups)) {
          const client = await connectMcp(gateway_url, { name: "geo-supplier", fetch: signingFetch({ did: agent.did, privateKey: agent.privateKey, extraHeaders: { "x-task-category": encodeURIComponent(category), "x-task-id": `ingest-${state.cursor}-${category}` } }) });
          try {
            const res = await client.callTool({ name: "ingest", arguments: { reviews, budget, source: agent.did } }, undefined, { timeout: Number(process.env.MCP_TOOL_TIMEOUT_MS || 600000) });
            const text = (res.content || []).map((c) => c.text || "").join("");
            results[category] = res.isError ? { error: text.slice(0, 200) } : JSON.parse(text);
          } finally { await client.close().catch(() => {}); }
          state.by_category[category] = (state.by_category[category] || 0) + reviews.length;
        }
        state.delivered += batch.length; save();
        return { delivered: batch.length, cursor: state.cursor, results };
      },
    },
  });
  agent.state = state;
  return agent;
}
