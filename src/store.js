// Простое файловое хранилище: JSON-коллекции и журналы JSONL в DATA_DIR. Для прототипа и одиночного сервера.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export function openStore(dir) {
  mkdirSync(dir, { recursive: true });
  const cache = new Map();
  const file = (name) => join(dir, `${name}.json`);
  function load(name, def) {
    if (cache.has(name)) return cache.get(name);
    const v = existsSync(file(name)) ? JSON.parse(readFileSync(file(name), "utf8")) : def;
    cache.set(name, v);
    return v;
  }
  function save(name) {
    const tmp = file(name) + ".tmp";
    writeFileSync(tmp, JSON.stringify(cache.get(name), null, 1));
    renameSync(tmp, file(name));
  }
  const log = (name, row) => appendFileSync(join(dir, `${name}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
  function readLog(name, sinceIso) {
    const f = join(dir, `${name}.jsonl`);
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && (!sinceIso || r.ts >= sinceIso));
  }
  return {
    dir,
    get: (name, def = {}) => load(name, def),
    put(name, value) { cache.set(name, value); save(name); },
    update(name, def, fn) { const v = load(name, def); const out = fn(v) ?? v; cache.set(name, out); save(name); return out; },
    log,
    readLog,
  };
}
