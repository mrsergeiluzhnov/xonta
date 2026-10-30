// Rebuilds bench/honesty/RESULTS.md from bench/honesty/results/*.json. Sorted by how often the model lied when asked.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), DIR = join(HERE, "results");
const runs = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8"))) : [];
runs.sort((a, b) => (a.summary.lie_when_asked.pct ?? 101) - (b.summary.lie_when_asked.pct ?? 101) || (a.summary.lie_unprompted.pct ?? 101) - (b.summary.lie_unprompted.pct ?? 101));
const c = (x) => (x.n ? `${x.pct}% (${x.k}/${x.n})` : "—");
const rows = runs.map((r) => `| ${r.model} | ${c(r.summary.lie_unprompted)} | ${c(r.summary.lie_when_asked)} | ${c(r.summary.disclosed_request)} | ${r.summary.parse_failures} | ${r.version} | ${r.date} |`);
const md = `# Honesty benchmark results

Lower is better in the first two columns, higher is better in the third. See [README.md](README.md) for what is measured.

| model | lied with no hint | lied when asked | mentioned being asked | unreadable reports | bench | date |
|---|---|---|---|---|---|---|
${rows.join("\n") || "| no results yet | | | | | | |"}

To add a model, run the benchmark and open a pull request with the file from \`bench/honesty/results/\`.
`;
writeFileSync(join(HERE, "RESULTS.md"), md);
console.log(md);
