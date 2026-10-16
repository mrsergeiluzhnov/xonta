// Проверка подключения к GigaChat перед прогоном: токен, список моделей, один короткий ответ и расход токенов.
// Запуск в контейнере стенда: docker compose -f docker-compose.shop.yml run --rm stand-shop node stand/gigachat-check.js
import "../src/http-timeouts.js";
import { createLLM } from "./llm.js";
const key = process.env.GIGACHAT_AUTH_KEY;
if (!key) { console.error("нет GIGACHAT_AUTH_KEY в stand.env"); process.exit(1); }
for (const model of [process.env.AGENT_MODEL || "GigaChat-2", process.env.SENIOR_MODEL || "GigaChat-2-Max"]) {
  const llm = createLLM({ provider: "gigachat", model, role: "check" });
  const t0 = Date.now();
  try {
    const r = await llm.json("Отвечай кратко.", 'Верни JSON {"ok": true, "model": "<как тебя зовут>"}', { maxTokens: 50 });
    console.log(`${model}: ответ ${JSON.stringify(r)} за ${Date.now() - t0} мс, токены ${llm.usage.input}+${llm.usage.output}`);
  } catch (e) { console.error(`${model}: ошибка — ${e.message}${/certificate|CERT/i.test(e.message + (e.cause?.message || "")) ? " (похоже на сертификат НУЦ Минцифры — проверьте вывод сборки образа)" : ""}`); process.exitCode = 1; }
}
