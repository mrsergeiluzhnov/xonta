// Уведомления владельцу: журнал всегда, Telegram — если задан TELEGRAM_BOT_TOKEN и у владельца telegram_chat_id, вебхук — если указан.
import { assertPublicUrl } from "./scan.js";

export function createNotifier({ store, env = process.env, allowPrivate = false }) {
  return async function notify(rec, { title, text, ...rest }) {
    const row = { agent: rec.id, title, text, ...rest, channels: ["log"] };
    const owner = rec.owner || {};
    const jobs = [];
    if (env.TELEGRAM_BOT_TOKEN && owner.telegram_chat_id) {
      row.channels.push("telegram");
      jobs.push(fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: owner.telegram_chat_id, text: `${title}\n\n${text}\n\nАгент: ${rec.name}` }),
        signal: AbortSignal.timeout(8000),
      }));
    }
    if (owner.webhook) {
      row.channels.push("webhook");
      jobs.push(assertPublicUrl(owner.webhook, { allowPrivate }).then(() => fetch(owner.webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: rec.id, title, text, ...rest }), signal: AbortSignal.timeout(8000), redirect: "error" })));
    }
    const results = await Promise.allSettled(jobs);
    row.failed = results.filter((r) => r.status === "rejected" || (r.value && !r.value.ok)).length;
    store.log("notifications", row);
  };
}
