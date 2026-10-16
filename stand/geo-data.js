// Данные Georeview (mteb/GeoreviewClassification, MIT): отзывы об организациях с оценкой автора (label = оценка − 1).
// Загружаются через открытый API Hugging Face порциями по 100 строк и кэшируются на диске.
// Части: test (2048) — эталон оркестратора; validation (5000) — трафик клиента; train (50000) — поставщик данных.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewId, groupOf } from "../skills/xonta-geo.js";

export const DATASET = process.env.GEO_DATASET || "mteb/GeoreviewClassification";
const API = process.env.GEO_API || "https://datasets-server.huggingface.co";

export function createGeoData({ dir, fixture = null }) {
  mkdirSync(dir, { recursive: true });
  const stats = { requests: 0, cached: 0 };
  async function page(split, offset) {
    const file = join(dir, `${split}-${offset}.json`);
    if (existsSync(file)) { stats.cached++; return JSON.parse(readFileSync(file, "utf8")); }
    let rows;
    if (fixture) rows = fixture(split, offset, 100);
    else {
      let r, j;
      for (let a = 0; a < 4; a++) {
        r = await fetch(`${API}/rows?dataset=${encodeURIComponent(DATASET)}&config=default&split=${split}&offset=${offset}&length=100`, { signal: AbortSignal.timeout(60000) });
        if (r.ok) { j = await r.json(); break; }
        await new Promise((ok) => setTimeout(ok, 3000 * (a + 1)));
      }
      if (!j) throw new Error(`Hugging Face: HTTP ${r?.status} для ${split}@${offset}`);
      rows = (j.rows || []).map((x) => x.row);
      await new Promise((ok) => setTimeout(ok, 500));
    }
    stats.requests++;
    const out = rows.map((x) => { const text = String(x.text).replace(/\\n/g, "\n").trim(); const rating = Number(x.label) + 1; return { id: reviewId(text), text, rating, category: groupOf(rating) }; });
    writeFileSync(file, JSON.stringify(out));
    return out;
  }
  async function slice(split, offset, n) {
    const out = [];
    for (let o = Math.floor(offset / 100) * 100; out.length < n + (offset % 100); o += 100) { const p = await page(split, o); out.push(...p); if (p.length < 100) break; }
    return out.slice(offset % 100, offset % 100 + n);
  }
  return { slice, stats, source: { dataset: DATASET, license: "MIT", origin: "Yandex Geo Reviews Dataset 2023" } };
}
