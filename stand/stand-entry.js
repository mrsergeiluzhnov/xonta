// Точка входа контейнера стенда: NET_MODE=tokens — прогон «Экономия токенов» (token-run.js), NET_MODE=domain — тематический
// прогон (domain-run.js), NET_MODE=ocx — протокол OCX между двумя оркестраторами (ocx-run.js), иначе — сеть оркестраторов.
// Автопилот поднимает один и тот же compose, вид прогона задаётся переменной в задании.
if (process.env.NET_MODE === "tokens") { const m = await import("./token-run.js"); await m.main(); }
else if (process.env.NET_MODE === "glama") await import("../research/glama/run.mjs"); // аудит каталога MCP Glama (ключ GLAMA_API_KEY в stand.env)
else if (process.env.NET_MODE === "domain") await import("./domain-run.js"); // 0.20: тематические прогоны (NET_DOMAIN = ops | procurement | redaction | access)
else if (process.env.NET_MODE === "ocx") await import("./ocx-run.js"); // 0.28: два оркестратора по протоколу OCX (spec/ocx), тема «оплата счетов»
else await import("./network-run.js");
