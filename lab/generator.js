// Агент-генератор тестовых данных: отдаёт задачи с эталонными ответами по раундам (новые форматы появляются постепенно).
// Небольшая доля меток намеренно неверна — как в реальных данных; обучаемые агенты должны быть к этому устойчивы.
import { z } from "zod";
import * as L from "../skills/xonta-normalize.js";
import { seeded } from "../src/tester.js";
import { startAgent } from "./agentkit.js";

export async function startGenerator({ port, ownerDid, noise = 0.02 }) {
  let issued = 0;
  const tools = [
    { name: "generate_tasks", description: "Генерирует задачи нормализации с эталонными ответами. Воспроизводимо по seed.",
      input: { round: z.number().int().min(0).max(100), n: z.number().int().min(1).max(2000), seed: z.string().max(128),
        only_category: z.enum(L.CATEGORIES).optional(), clean: z.boolean().optional() },
      annotations: { readOnlyHint: true },
      run: ({ round, n, seed, only_category, clean }) => {
        const tasks = L.generateTasks(seeded(seed), { n, round, onlyCategory: only_category || null, noise: clean ? 0 : noise });
        issued += tasks.length;
        return { tasks, issued_total: issued, skill_language: L.LANGUAGE };
      } },
  ];
  return startAgent({ port, name: "xonta-lab-generator", tools, ownerDid });
}
