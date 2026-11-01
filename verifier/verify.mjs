import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COAST_MARGIN_KM, Coastline } from './coast.mjs';

export const PRICE_TOLERANCE = 0.02;
export const AREA_TOLERANCE = 0.05;
export const DEFAULT_SEA_KM = 25;
export const FETCH_ATTEMPTS = 3;
export const RETRY_WAIT_MS = 3000;
const CHECK_ORDER = { fits: 0, 'trade-off': 1, unverified: 2 };
const retryable = (status) => status === 429 || status >= 500;
const UA = 'free-research-llm-verifier (independent check; https://github.com/bezgolovyponch/free-research-llm)';
const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const ECB = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

export const COUNTRY_NAMES = {
  PT: ['portugal'], ES: ['spain', 'espana'], TR: ['turkey', 'turkiye'], VN: ['vietnam', 'viet nam'], HR: ['croatia', 'hrvatska'], IT: ['italy', 'italia'], GR: ['greece'], FR: ['france'], DE: ['germany', 'deutschland'], BG: ['bulgaria'], CY: ['cyprus'], MT: ['malta'], AL: ['albania'], ME: ['montenegro'], MA: ['morocco'],
  CZ: ['czechia', 'czech republic'], PL: ['poland'], RO: ['romania'], SI: ['slovenia'], AT: ['austria'], NL: ['netherlands'], BE: ['belgium'], IE: ['ireland'], DK: ['denmark'], SE: ['sweden'], FI: ['finland'], EE: ['estonia'], LV: ['latvia'], LT: ['lithuania'], SK: ['slovakia'], HU: ['hungary'], LU: ['luxembourg'],
};
export const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

const fold = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function namedCountries(text) {
  const t = fold(text);
  return Object.entries(COUNTRY_NAMES).filter(([, names]) => names.some((n) => new RegExp(`(^|[^a-z])${n}([^a-z]|$)`).test(t))).map(([code]) => code);
}

const SEA_WORDS = /(^|[^a-z])(sea|ocean|coast|coastal|beach|seaside|shore|e-?bike)([^a-z]|$)/;
const BUDGET_WORDS = /(^|[^a-z])(max|maximum|up to|under|below|budget|invest[a-z]*|entrance|enterance|entry|at most|around|az)([^a-z]|$)|(^|[^a-z])do\s+\d|≤/;
const LIMIT_CURRENCIES = { eur: 'EUR', '€': 'EUR', euro: 'EUR', czk: 'CZK', kc: 'CZK', pln: 'PLN', zl: 'PLN', usd: 'USD', $: 'USD', gbp: 'GBP', '£': 'GBP', try: 'TRY', tl: 'TRY' };
const LIMIT_AMOUNT = /(\d[\d\s.,]*\d|\d)\s*(eur|euro|€|czk|kc|pln|zl|usd|gbp|try|tl)(?![a-z])|(€|\$|£)\s*(\d[\d\s.,]*\d|\d)/;

export function statedLimit(...texts) {
  for (const clause of fold(texts.filter(Boolean).join(', ')).split(/[,;]|\bbut\b|\band\b/)) {
    if (!BUDGET_WORDS.test(clause)) continue;
    const m = clause.match(LIMIT_AMOUNT);
    if (m) return { max: numberOf(m[1] ?? m[4]), currency: LIMIT_CURRENCIES[m[2] ?? m[3]] };
  }
  return null;
}

export function obligationsOf(project) {
  const words = [project.question, project.acceptance?.expected, ...Object.values(project.constraints ?? {})].filter((v) => typeof v === 'string').join(' ');
  const named = namedCountries(words);
  const euWord = /(^|[^a-z])(eu|european union)([^a-z]|$)/.test(fold(words));
  const regions = [...new Set([...named, ...(euWord && !named.some((c) => EU.includes(c)) ? EU : [])])];
  const months = String(project.question ?? '').match(/(\d{1,2})\s*months?\b/i);
  const km = String(project.guidance ?? '').match(/about\s+(\d{1,3})\s*km/i);
  const range = project.acceptance?.valueRange ?? null;
  const stated = range ? null : statedLimit(project.question, project.acceptance?.expected);
  const sea = SEA_WORDS.test(fold(`${words} ${project.guidance ?? ''}`));
  return {
    priceMin: range?.[0] ?? 0,
    priceMax: range?.[1] ?? stated?.max ?? null,
    currency: String((range ? project.acceptance?.unit : stated?.currency) || 'EUR').toUpperCase(),
    priceFrom: range ? 'acceptance' : stated ? 'question' : 'none',
    regions,
    seaKm: !sea ? null : km ? Number(km[1]) : DEFAULT_SEA_KM,
    seaFrom: !sea ? 'not asked' : km ? 'guidance' : 'default',
    minMonths: months ? Number(months[1]) : null,
    climate: { campingIndexAbove: 3, from: 'Camping Climate Index (Ma 2021, ch. 2, eq. 3, Tables 3–4): monthly mean index above 3, acceptable or better' },
  };
}

export function numberOf(text) {
  let s = String(text ?? '').replace(/[\s  ]/g, '');
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function jsonLdOffers(html) {
  const out = [];
  for (const m of String(html ?? '').matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const walk = (v) => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) return v.forEach(walk);
      if (v.price !== undefined && (v.priceCurrency || v.currency)) out.push({ price: numberOf(v.price), currency: String(v.priceCurrency ?? v.currency).toUpperCase() });
      Object.values(v).forEach(walk);
    };
    walk(data);
  }
  return out.filter((o) => o.price !== null);
}

const SYMBOL = { '€': 'EUR', '£': 'GBP', $: 'USD', '₺': 'TRY', '₫': 'VND' };

export function textPrices(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/(€|£|\$|₺|₫|EUR|TRY|TL|VND|GBP|USD)\s?(\d[\d.,\s ]{0,15}\d|\d)|(\d[\d.,\s ]{0,15}\d|\d)\s?(€|£|₺|₫|EUR|TRY|TL|VND|GBP|USD)/g)) {
    const raw = m[2] ?? m[3];
    const sym = m[1] ?? m[4];
    const price = numberOf(raw);
    if (price !== null) out.push({ price, currency: SYMBOL[sym] ?? (sym === 'TL' ? 'TRY' : sym) });
  }
  return out;
}

export function pageText(html) {
  return String(html ?? '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&euro;/g, '€').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

export function pageAreas(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/(\d[\d.,\s ]{0,12}\d|\d)\s?(m²|m2|sqm|ha\b|hectares?)/gi)) {
    const n = numberOf(m[1]);
    if (n === null || n <= 0) continue;
    out.push(/^h/i.test(m[2]) ? n * 10000 : n);
  }
  return out;
}

export function pageCoords(html) {
  const m = String(html ?? '').match(/"lat(?:itude)?"\s*:\s*"?(-?\d{1,3}\.\d{3,})"?\s*,\s*"(?:lng|lon|long|longitude)"\s*:\s*"?(-?\d{1,3}\.\d{3,})/i);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(Math.abs(lat) < 1 && Math.abs(lon) < 1) ? { lat, lon } : null;
}

export function kmBetween(a, b) {
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const THERMAL_SCORES = [{ from: 42, score: 0 }, { from: 34, score: 7 }, { from: 28, score: 10 }, { from: 24, score: 9 }, { from: 20, score: 8 }, { from: 16, score: 7 }, { from: 12, score: 6 }, { from: 8, score: 5 }, { from: 4, score: 4 }, { from: 2, score: 3 }];
const SUNSHINE_SCORES = [{ from: 14, score: 10 }, { from: 12, score: 9 }, { from: 9, score: 8 }, { from: 6, score: 4 }, { from: 4, score: 2 }];
const ADVERSE_DAY = { nightBelowC: 8, dayAboveC: 34, rainAboveMm: 10, windAboveKmh: 23, capScore: 3 };
export const CLIMATE_YEAR = 2025;
export const CLIMATE_CELL_DEG = 0.25;

export function climateCell({ lat, lon }) {
  const centre = (x) => Math.round((Math.floor(x / CLIMATE_CELL_DEG) * CLIMATE_CELL_DEG + CLIMATE_CELL_DEG / 2) * 1000) / 1000;
  return { lat: centre(lat), lon: centre(lon) };
}

export const CLIMATE_DAILY = 'temperature_2m_mean,temperature_2m_max,temperature_2m_min,dew_point_2m_mean,sunshine_duration,precipitation_sum,wind_speed_10m_mean';

const scoreFrom = (value, scores) => scores.find((s) => value >= s.from)?.score ?? 0;

export function humidexOf(airC, dewC) {
  const hPa = 6.11 * Math.exp(5417.753 * (1 / 273.16 - 1 / (dewC + 273.15)));
  return airC + 0.5555 * (hPa - 10);
}

export function campingIndex(day) {
  if (![day.mean, day.dew, day.sun, day.max, day.min].every(Number.isFinite)) return null;
  const index = 0.5 * scoreFrom(humidexOf(day.mean, day.dew), THERMAL_SCORES) + 0.5 * scoreFrom(day.sun / 3600, SUNSHINE_SCORES);
  const adverse = day.min < ADVERSE_DAY.nightBelowC || day.max > ADVERSE_DAY.dayAboveC || (day.rain ?? 0) > ADVERSE_DAY.rainAboveMm || (day.wind ?? 0) > ADVERSE_DAY.windAboveKmh;
  return adverse ? Math.min(index, ADVERSE_DAY.capScore) : index;
}

export function campingMonths(daily, rule) {
  const sums = Array.from({ length: 12 }, () => ({ total: 0, days: 0 }));
  (daily?.time ?? []).forEach((day, i) => {
    const index = campingIndex({ mean: daily.temperature_2m_mean?.[i], dew: daily.dew_point_2m_mean?.[i], sun: daily.sunshine_duration?.[i], max: daily.temperature_2m_max?.[i], min: daily.temperature_2m_min?.[i], rain: daily.precipitation_sum?.[i], wind: daily.wind_speed_10m_mean?.[i] });
    if (index === null) return;
    const m = sums[Number(day.slice(5, 7)) - 1];
    m.total += index;
    m.days++;
  });
  return sums.filter((m) => m.days && Math.round((m.total / m.days) * 10) / 10 > rule.campingIndexAbove).length;
}

export function compare(name, appValue, found, tolerance) {
  if (appValue === null || appValue === undefined) return { check: name, status: 'unconfirmed', detail: 'the app gave no value' };
  if (!found.length) return { check: name, status: 'unconfirmed', detail: 'not found on the page' };
  const best = found.reduce((a, b) => (Math.abs(b - appValue) < Math.abs(a - appValue) ? b : a));
  const ok = Math.abs(best - appValue) <= tolerance * Math.max(1, Math.abs(appValue));
  return { check: name, status: ok ? 'confirmed' : 'refuted', detail: `page ${best}, app ${appValue}` };
}

export class Verifier {
  constructor({ fetchImpl = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), coastline = null, cacheDir = '' } = {}) {
    this.fetch = fetchImpl;
    this.climateFile = cacheDir ? path.join(cacheDir, `climate-${CLIMATE_YEAR}.json`) : '';
    this.climateCells = null;
    this.coastline = coastline;
    this.loadCoast = () => Coastline.load({ cacheDir, fetchImpl });
    this.now = now;
    this.sleep = sleep;
    this.lastNominatim = 0;
    this.rates = null;
  }

  async get(url, init = {}) {
    const { timeoutMs = 120000, ...rest } = init;
    const res = await this.fetch(url, { ...rest, headers: { 'user-agent': UA, ...(rest.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
    return res;
  }

  async json(url, init) {
    let failure = null;
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
      if (attempt > 1) await this.sleep(RETRY_WAIT_MS * (attempt - 1));
      let res;
      try {
        res = await this.get(url, init);
      } catch (error) {
        failure = error;
        continue;
      }
      if (res.ok) return res.json();
      failure = new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
      if (!retryable(res.status)) break;
    }
    throw failure;
  }

  async eurRates() {
    if (this.rates) return this.rates;
    const res = await this.get(ECB);
    const xml = await res.text();
    this.rates = { EUR: 1 };
    for (const m of xml.matchAll(/currency='([A-Z]{3})' rate='([\d.]+)'/g)) this.rates[m[1]] = Number(m[2]);
    return this.rates;
  }

  async toEur(price, currency) {
    if (currency === 'EUR') return price;
    const rates = await this.eurRates();
    return rates[currency] ? price / rates[currency] : null;
  }

  async country(point) {
    const wait = this.lastNominatim + 1100 - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastNominatim = this.now();
    const d = await this.json(`${NOMINATIM_REVERSE}?format=json&zoom=10&lat=${point.lat}&lon=${point.lon}`);
    return String(d?.address?.country_code ?? '').toUpperCase();
  }

  async seaKm(point, radiusKm) {
    if (!this.coastline) this.coastline = await this.loadCoast();
    return this.coastline.nearestKm(point.lat, point.lon, radiusKm);
  }

  async cellDaily(point) {
    if (!this.climateCells) {
      try {
        this.climateCells = this.climateFile ? JSON.parse(await fs.readFile(this.climateFile, 'utf8')) : {};
      } catch {
        this.climateCells = {};
      }
    }
    const cell = climateCell(point);
    const key = `${cell.lat},${cell.lon}`;
    if (this.climateCells[key]) return this.climateCells[key];
    const d = await this.json(`${ARCHIVE}?latitude=${cell.lat}&longitude=${cell.lon}&start_date=${CLIMATE_YEAR}-01-01&end_date=${CLIMATE_YEAR}-12-31&daily=${CLIMATE_DAILY}&timezone=GMT`);
    this.climateCells[key] = d?.daily ?? null;
    if (this.climateFile && this.climateCells[key]) await fs.writeFile(this.climateFile, JSON.stringify(this.climateCells));
    return this.climateCells[key];
  }

  async months(point, rule) {
    return campingMonths(await this.cellDaily(point), rule);
  }


  async verifyRow(row, ob) {
    const checks = [];
    let html = '';
    try {
      const res = await this.get(row.url);
      html = res.ok ? await res.text() : '';
      checks.push({ check: 'listing online', status: res.ok ? 'confirmed' : res.status === 404 || res.status === 410 ? 'refuted' : 'unconfirmed', detail: `HTTP ${res.status}` });
    } catch (error) {
      checks.push({ check: 'listing online', status: 'unconfirmed', detail: String(error.message).slice(0, 80) });
    }
    const text = pageText(html);
    const prices = [...jsonLdOffers(html), ...textPrices(text)].filter((p) => p.currency === String(row.currency || ob.currency).toUpperCase()).map((p) => p.price);
    checks.push(compare('price on the page', row.price, prices, PRICE_TOLERANCE));
    const eur = row.price !== null && row.price !== undefined ? await this.toEur(row.price, String(row.currency || ob.currency).toUpperCase()).catch(() => null) : null;
    const minEur = await this.toEur(ob.priceMin, ob.currency).catch(() => null);
    const maxEur = ob.priceMax === null ? null : await this.toEur(ob.priceMax, ob.currency).catch(() => null);
    const limitKnown = minEur !== null && (ob.priceMax === null || maxEur !== null);
    checks.push(eur === null || !limitKnown ? { check: 'price within the limit', status: 'unconfirmed', detail: 'no exchange rate' } : { check: 'price within the limit', status: eur >= minEur && (maxEur === null || eur <= maxEur * (1 + PRICE_TOLERANCE)) ? 'confirmed' : 'refuted', detail: `€${Math.round(eur)} against ${ob.priceMin}–${ob.priceMax ?? 'no limit'} ${ob.currency}` });
    if (row.area) checks.push(compare('area on the page', row.areaM2 ?? row.area, pageAreas(text), AREA_TOLERANCE));
    const own = pageCoords(html);
    const point = own ?? (Number.isFinite(row.lat) && Number.isFinite(row.lon) ? { lat: row.lat, lon: row.lon } : null);
    if (!point) checks.push({ check: 'location', status: 'unconfirmed', detail: 'no coordinates' });
    else {
      checks.push({ check: 'location source', status: own ? 'confirmed' : 'unconfirmed', detail: own ? 'coordinates read from the listing page' : 'the app\'s point was used' });
      try {
        const code = await this.country(point);
        checks.push({ check: 'in the asked countries', status: ob.regions.length ? (ob.regions.includes(code) ? 'confirmed' : 'refuted') : 'confirmed', detail: code || 'unknown' });
      } catch (error) {
        checks.push({ check: 'in the asked countries', status: 'unconfirmed', detail: String(error.message).slice(0, 80) });
      }
      if (ob.seaKm !== null) {
        try {
          const km = await this.seaKm(point, ob.seaKm + 5);
          const close = km !== null && Math.abs(km - ob.seaKm) < COAST_MARGIN_KM;
          checks.push({ check: `sea within ${ob.seaKm} km`, status: close ? 'unconfirmed' : km !== null && km <= ob.seaKm ? 'confirmed' : 'refuted', detail: `${km === null ? `no coastline within ${ob.seaKm + 5} km` : `${km} km`} (Natural Earth 1:10m coastline${close ? `; within its ${COAST_MARGIN_KM} km precision of the limit` : ''})` });
        } catch (error) {
          checks.push({ check: `sea within ${ob.seaKm} km`, status: 'unconfirmed', detail: String(error.message).slice(0, 80) });
        }
      }
      if (ob.minMonths) {
        try {
          const n = await this.months(point, ob.climate);
          checks.push({ check: `${ob.minMonths}+ camping months`, status: n >= ob.minMonths ? 'confirmed' : 'refuted', detail: `${n} months by the ${ob.climate.from}` });
        } catch (error) {
          checks.push({ check: `${ob.minMonths}+ camping months`, status: 'unconfirmed', detail: String(error.message).slice(0, 80) });
        }
      }
    }
    const refuted = checks.filter((c) => c.status === 'refuted');
    const unconfirmed = checks.filter((c) => c.status === 'unconfirmed' && c.check !== 'location source');
    return { url: row.url, verdict: refuted.length ? 'refuted' : unconfirmed.length ? 'unconfirmed' : 'confirmed', checks };
  }

  async verify(project, { onRow = async () => {} } = {}) {
    const ob = obligationsOf(project);
    const rows = (project.candidates?.kept ?? []).filter((r) => Object.hasOwn(CHECK_ORDER, r.plan?.tier ?? '')).sort((a, b) => CHECK_ORDER[a.plan.tier] - CHECK_ORDER[b.plan.tier]);
    const inputs = crypto.createHash('sha256').update(JSON.stringify({ ob, rows: rows.map((r) => [r.url, r.price, r.currency, r.area, r.lat, r.lon]) })).digest('hex');
    const results = [];
    const record = () => ({ id: project.id, at: new Date(this.now()).toISOString(), inputs, obligations: ob, results: [...results], confirmed: results.filter((r) => r.verdict === 'confirmed').map((r) => r.url), complete: results.length === rows.length });
    for (const row of rows) {
      results.push(await this.verifyRow(row, ob));
      await onRow(record());
    }
    return record();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [id] = argv;
  const dataAt = argv.indexOf('--data');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = dataAt > -1 ? argv[dataAt + 1] : path.join(root, 'data');
  if (!id) {
    console.log('usage: node verifier/verify.mjs <research id> [--data <data dir>] [--projects <projects dir>]');
    return 1;
  }
  const projectsAt = argv.indexOf('--projects');
  const projectsDir = projectsAt > -1 ? argv[projectsAt + 1] : path.join(dataDir, 'projects');
  const project = JSON.parse(await fs.readFile(path.join(projectsDir, `${id}.json`), 'utf8'));
  const out = path.join(dataDir, 'verification');
  await fs.mkdir(out, { recursive: true });
  const save = (record) => fs.writeFile(path.join(out, `${id}.json`), JSON.stringify(record, null, 1));
  const record = await new Verifier({ cacheDir: out }).verify(project, { onRow: save });
  await save(record);
  await fs.appendFile(path.join(out, `${id}.jsonl`), `${JSON.stringify({ at: record.at, inputs: record.inputs, confirmed: record.confirmed.length, checked: record.results.length })}\n`);
  console.log(`verified ${record.results.length} row(s): ${record.confirmed.length} confirmed, ${record.results.filter((r) => r.verdict === 'refuted').length} refuted, ${record.results.filter((r) => r.verdict === 'unconfirmed').length} unconfirmed`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = await main();
