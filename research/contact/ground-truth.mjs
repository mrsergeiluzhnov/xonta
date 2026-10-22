// Эталон для эксперимента: телефон, который компания сама указывает в отчётности SEC (EDGAR, поле phone в submissions).
// Агент этот файл не видит. Потом — детерминированное деление на обучающую часть (агент A) и проверочную (агент B).
//   SEC_UA="Xonta research your@email" node ground-truth.mjs [out_dir]
// SEC требует в User-Agent настоящий контакт и не больше 10 запросов в секунду; здесь 4.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const UA = process.env.SEC_UA; if (!UA || !/@/.test(UA)) { console.error('set SEC_UA="Xonta research your@email"'); process.exit(1); }
const out = process.argv[2] || './data', SEED = process.env.SPLIT_SEED || 'contact-2026-10-22', TRAIN = Number(process.env.TRAIN_SHARE || 0.35);
mkdirSync(out, { recursive: true });
const list = JSON.parse(readFileSync(new URL('./companies-us.json', import.meta.url)));
const get = async (url) => { for (let i = 0; i < 3; i++) { const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }); if (r.ok) return r.json(); await new Promise((s) => setTimeout(s, 1500 * (i + 1))); } throw Error(`SEC ${url} failed`); };
const tickers = await get('https://www.sec.gov/files/company_tickers.json');
const byT = new Map(Object.values(tickers).map((x) => [x.ticker.toUpperCase(), x]));
export const digitsOf = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length === 11 && d.startsWith('1') ? d.slice(1) : d; };
const rows = [], missing = [];
for (const [ticker, company, site] of list) {
  const t = byT.get(ticker.toUpperCase()) || byT.get(ticker.replace('-', '.').toUpperCase());
  if (!t) { missing.push({ ticker, why: 'no CIK' }); continue; }
  const cik = String(t.cik_str).padStart(10, '0');
  try {
    const s = await get(`https://data.sec.gov/submissions/CIK${cik}.json`);
    const phone = s.phone || s.addresses?.business?.phone || null;
    if (!phone || digitsOf(phone).length < 9) { missing.push({ ticker, why: 'no phone in EDGAR' }); continue; }
    const biz = s.addresses?.business || {};
    rows.push({ ticker, company, site, cik, sec_name: s.name, truth_phone: phone, truth_digits: digitsOf(phone), hq_country: biz.stateOrCountryDescription || biz.stateOrCountry || null, us: /^[A-Z]{2}$/.test(biz.stateOrCountry || '') });
  } catch (e) { missing.push({ ticker, why: e.message }); }
  await new Promise((s) => setTimeout(s, 250));
}
const h = (x) => parseInt(createHash('sha256').update(`${SEED}|${x}`).digest('hex').slice(0, 8), 16) / 2 ** 32;
for (const r of rows) r.part = h(r.ticker) < TRAIN ? 'train' : 'holdout';
const listHash = createHash('sha256').update(rows.map((r) => `${r.ticker}|${r.part}|${r.truth_digits}`).join('\n')).digest('hex');
writeFileSync(`${out}/truth.json`, JSON.stringify({ made: new Date().toISOString(), source: 'SEC EDGAR submissions, field phone', seed: SEED, train_share: TRAIN, list_sha256: listHash, rows, missing }, null, 1));
// агенту и прогонщику — без эталона
writeFileSync(`${out}/companies.json`, JSON.stringify(rows.map(({ ticker, company, site, part }) => ({ ticker, company, site, part })), null, 1));
console.log(`companies ${rows.length} (train ${rows.filter((r) => r.part === 'train').length}, holdout ${rows.filter((r) => r.part === 'holdout').length}), missing ${missing.length}, list sha256 ${listHash.slice(0, 16)}`);
