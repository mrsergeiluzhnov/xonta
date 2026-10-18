// Точка входа контейнера стенда: NET_MODE=tokens — прогон «Экономия токенов» (token-run.js), иначе — сеть оркестраторов.
// Автопилот поднимает один и тот же compose, вид прогона задаётся переменной в задании.
if (process.env.NET_MODE === "tokens") { const m = await import("./token-run.js"); await m.main(); }
else await import("./network-run.js");
