// Бюллетени безопасности GitHub (GitHub Advisory Database, проверенные) по экосистемам — в том же виде, что история сбоев,
// чтобы их разбирал research/incidents/team.mjs (INC_TASK=advisory). Серьёзность из бюллетеня: high и critical — «крупное»,
// medium и low — «мелкое». Из описания вырезаются прямые подсказки (слова о серьёзности и векторы CVSS).
// Открытое API без ключа (60 запросов в час; с GITHUB_TOKEN больше, токену права не нужны): по 100 бюллетеней за запрос, пауза между запросами.
// Почему не вредоносные пакеты: npm удаляет их из реестра, а архивы с самим вредоносным кодом на сервер не тянем.
//   node research/advisories/fetch.mjs /root/incidents-data            (ADV_ECOSYSTEMS=npm,pip ADV_MAX=600)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.argv[2] || "./incidents-data", ECOS = (process.env.ADV_ECOSYSTEMS || "npm,pip").split(","), MAX = Number(process.env.ADV_MAX || 600);
const UA = "XontaResearch/0.26 (+https://github.com/mrsergeiluzhnov/xonta; advisory triage study)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const scrub = (s) => String(s || "")
  .replace(/CVSS:\d\.\d\/[A-Z:\/]+/g, " ").replace(/\b(critical|high|medium|moderate|low)[- ](severity|risk|impact)\b/gi, " ")
  .replace(/\bseverity\b[^.\n]{0,40}/gi, " ").replace(/\s+/g, " ").trim();

mkdirSync(DIR, { recursive: true });
for (const eco of ECOS) {
  const incidents = {}; let url = `https://api.github.com/advisories?type=reviewed&ecosystem=${eco}&per_page=100`;
  while (url && Object.keys(incidents).length < MAX) {
    const r = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": UA, "x-github-api-version": "2022-11-28", ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
    if (!r.ok) { console.log(`${eco}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`); break; }
    for (const a of await r.json()) {
      if (!a.ghsa_id || !a.summary || !["low", "medium", "high", "critical"].includes(a.severity) || a.withdrawn_at) continue;
      const pk = [...new Set((a.vulnerabilities || []).map((v) => v.package?.name).filter(Boolean))].slice(0, 5);
      incidents[a.ghsa_id] = { service: `ghsa-${eco}`, code: a.ghsa_id, name: scrub(a.summary).slice(0, 200), impact: ["high", "critical"].includes(a.severity) ? "major" : "minor", severity: a.severity,
        created_at: a.published_at, started_at: a.published_at, resolved_at: a.published_at, components: pk,
        updates: [{ status: "investigating", body: scrub(a.description).slice(0, 1500) || scrub(a.summary), at: a.published_at, components: pk }] };
    }
    const next = (r.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
    console.log(`${eco}: ${Object.keys(incidents).length}`);
    await sleep(process.env.GITHUB_TOKEN ? 1000 : 4000);
  }
  writeFileSync(join(DIR, `ghsa-${eco}.json`), JSON.stringify({ codes: Object.keys(incidents), incidents }));
  const v = Object.values(incidents), by = (k) => v.filter((x) => x.severity === k).length;
  console.log(`ghsa-${eco}: готово ${v.length}; critical ${by("critical")}, high ${by("high")}, medium ${by("medium")}, low ${by("low")}`);
}
