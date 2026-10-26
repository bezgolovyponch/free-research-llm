import fs from 'node:fs/promises';
import { countryByCode } from './brief.mjs';
import { areaFromText } from '../search/listings.mjs';

export const GONE_STATUS = new Set([404, 410]);

export const EBIKE_KM = 25;
export const NEAR_KM = 15;
export const SITE_TTL_MS = 30 * 24 * 3600 * 1000;
export const NEW_SITES_PER_PASS = 12;
export const PAGE_READS_PER_PASS = 40;
export const MISS_TTL_MS = 24 * 3600 * 1000;
export const PASS_BUDGET_MS = 8 * 60 * 1000;
export const MODES = {
  cache: { newSites: 0, pageReads: 0, budgetMs: 0 },
  budget: { newSites: NEW_SITES_PER_PASS, pageReads: PAGE_READS_PER_PASS, budgetMs: PASS_BUDGET_MS },
  all: { newSites: 400, pageReads: 400, budgetMs: 60 * 60 * 1000 },
};
export const GEOCODE_GAP_MS = 1100;
export const CLIMATE_YEARS = ['2021-01-01', '2025-12-31'];
export const PITCH_M2 = 40;
export const CAMPING_SHARE = 0.6;
export const RURAL_PARK_MAX_PITCHES = 30;
export const POI_SATURATION = 200;
export const LODGING_SATURATION = 300;
const MAX_SITES = 2000;
export const STORE_VERSION = 4;
export const RETRY_STATUS = new Set([429, 502, 503, 504]);
export const RETRY_WAITS_MS = [10000, 30000];
const USER_AGENT = 'free-research-llm (site fit; https://github.com/bezgolovyponch/free-research-llm)';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const CLIMATE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const HPI_URL = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hpi_a';
const HICP_URL = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_aind';
export const MIN_PLACE_RANK = 12;
const EUROSTAT_CODE = { GR: 'EL' };
export const EU_AGGREGATE = 'EU27_2020';
const LAKE_FILTER = '[natural=water][water~"^(lake|reservoir)$"][name]';
export const TITLE_PLACE_KM = 25;
const COUNT_FILTERS = {
  viewpoints: '[tourism=viewpoint]',
  attractions: '[tourism=attraction]',
  reserves: '[leisure=nature_reserve]',
  protectedAreas: '[boundary~"^(protected_area|national_park)$"]',
  hikingRoutes: '[route=hiking]',
  campsites: '[tourism~"^(camp_site|caravan_site)$"]',
  lodging: '[tourism~"^(hotel|guest_house|hostel|chalet|apartment)$"]',
};
export const WEIGHTS = { sea: 0.2, season: 0.2, noAc: 0.1, explore: 0.2, demand: 0.05, trend: 0.1, cost: 0.05, zoning: 0.1 };

const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = (x) => (x * Math.PI) / 180;
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function nearestKm(lat, lon, points) {
  let best = Infinity;
  for (const p of points) best = Math.min(best, haversineKm(lat, lon, p.lat, p.lon));
  return best === Infinity ? null : round(best);
}

export function siteKey(lat, lon) {
  return `${(Math.round(lat * 50) / 50).toFixed(2)},${(Math.round(lon * 50) / 50).toFixed(2)}`;
}

export function overpassQuery(lat, lon, coastKm = 10) {
  const near = `(around:${NEAR_KM * 1000},${lat},${lon})`;
  return [
    '[out:json][timeout:120];',
    `way(around:${coastKm * 1000},${lat},${lon})[natural=coastline];out geom;`,
    `nwr${near}[natural=beach];out center;`,
    `nwr${near}${LAKE_FILTER};out center;`,
    ...Object.values(COUNT_FILTERS).map((f) => `nwr${near}${f};out count;`),
  ].join('');
}

export function lakeQuery(lat, lon) {
  return `[out:json][timeout:120];nwr(around:${NEAR_KM * 1000},${lat},${lon})${LAKE_FILTER};out center;`;
}

export function parseLakes(json, lat, lon) {
  const lakes = (json?.elements ?? []).filter((e) => e.tags?.natural === 'water' && e.tags?.name).map((e) => ({ lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  return nearestKm(lat, lon, lakes);
}

export function coastQuery(lat, lon) {
  return `[out:json][timeout:120];way(around:${EBIKE_KM * 1000},${lat},${lon})[natural=coastline];out geom;`;
}

function coastPoints(elements) {
  return elements.filter((e) => e.type === 'way' && e.tags?.natural === 'coastline').flatMap((w) => w.geometry ?? []);
}

export function parseSurroundings(json, lat, lon) {
  const elements = json?.elements ?? [];
  const beaches = elements.filter((e) => e.tags?.natural === 'beach').map((b) => ({ lat: b.lat ?? b.center?.lat, lon: b.lon ?? b.center?.lon })).filter((b) => Number.isFinite(b.lat) && Number.isFinite(b.lon));
  const counts = elements.filter((e) => e.type === 'count').map((e) => Number(e.tags?.total ?? 0));
  const named = Object.fromEntries(Object.keys(COUNT_FILTERS).map((key, i) => [key, counts[i] ?? 0]));
  return { coastKm: nearestKm(lat, lon, coastPoints(elements)), beaches: beaches.length, beachKm: nearestKm(lat, lon, beaches), lakeKm: parseLakes(json, lat, lon), lakesNamed: true, ...named };
}

export function parseCoast(json, lat, lon) {
  return nearestKm(lat, lon, coastPoints(json?.elements ?? []));
}

export function monthlyClimate(daily) {
  const months = Array.from({ length: 12 }, () => ({ tmax: [], tmin: [], rain: 0, years: new Set() }));
  (daily?.time ?? []).forEach((day, i) => {
    const m = months[Number(day.slice(5, 7)) - 1];
    if (!m) return;
    const tmax = daily.temperature_2m_max?.[i];
    const tmin = daily.temperature_2m_min?.[i];
    if (Number.isFinite(tmax)) m.tmax.push(tmax);
    if (Number.isFinite(tmin)) m.tmin.push(tmin);
    m.rain += daily.precipitation_sum?.[i] ?? 0;
    m.years.add(day.slice(0, 4));
  });
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  return months.map((m) => ({ tmax: m.tmax.length ? round(mean(m.tmax)) : null, tmin: m.tmin.length ? round(mean(m.tmin)) : null, rain: m.years.size ? Math.round(m.rain / m.years.size) : null }));
}

export function isComfortable(m) {
  return m.tmax !== null && m.tmax >= 18 && m.tmax <= 29 && m.tmin >= 10 && m.rain <= 120;
}

export function isWorkable(m) {
  return m.tmax !== null && m.tmax >= 14 && m.tmax <= 31 && m.tmin >= 5 && m.rain <= 200;
}

export function seasonOf(months) {
  const known = months.filter((m) => m.tmax !== null);
  if (!known.length) return null;
  return {
    comfortable: months.filter(isComfortable).length,
    workable: months.filter(isWorkable).length,
    hottest: Math.max(...known.map((m) => m.tmax)),
    coldest: Math.min(...known.map((m) => m.tmin)),
    months,
  };
}

export function pitchesFor(areaM2) {
  const area = Number(areaM2);
  if (!Number.isFinite(area) || area <= 0) return null;
  return Math.min(RURAL_PARK_MAX_PITCHES, Math.floor((area * CAMPING_SHARE) / PITCH_M2));
}

export function seaScore(km) {
  if (km === null || km === undefined) return 0;
  if (km <= 3) return 1;
  if (km <= 10) return 0.8;
  if (km <= NEAR_KM) return 0.6;
  if (km <= 20) return 0.4;
  return km <= EBIKE_KM ? 0.2 : 0;
}

export function noAcScore(hottest) {
  if (hottest <= 29) return 1;
  return hottest <= 31 ? 0.6 : 0;
}

const saturating = (n, cap) => Math.min(1, Math.log1p(Math.max(0, n)) / Math.log1p(cap));

export function explorePoints(site) {
  return (site.beaches ?? 0) + (site.viewpoints ?? 0) + (site.attractions ?? 0) + (site.reserves ?? 0) + (site.protectedAreas ?? 0) + (site.hikingRoutes ?? 0);
}

const AGRICULTURAL = /r[uú]stic|agr[ií]col|agricultur|poljoprivredn|izuzeto iz gra[dđ]evinsk|outside the building zone|tarla|n[oô]ng nghi[eệ]p|farmland/i;
const BUILDABLE = /urban[oa]?\b|building plot|gra[dđ]evinsk[oa] zemlji|baugrund|baugenehmigung|approved project|projec?to aprovado|th[oổ] c[uư]|imarl[ıi]|constru[cç][aã]o/i;

export function zoningOf(row) {
  const words = `${row.title ?? ''} ${row.place ?? ''} ${row.zoningText ?? ''}`;
  if (AGRICULTURAL.test(words)) return 'agricultural';
  if (BUILDABLE.test(words)) return 'buildable';
  return 'not stated';
}

export function yearly(d) {
  const index = d?.dimension?.time?.category?.index ?? {};
  return Object.fromEntries(Object.entries(index).filter(([, i]) => d.value?.[i] !== undefined).map(([year, i]) => [year, Number(d.value[i])]));
}

export function realChange(nominal, inflation) {
  return round(((1 + nominal / 100) / (1 + inflation / 100) - 1) * 100, 1);
}

export function realCagr(hpi, hicp, years) {
  if (years.length < 2) return null;
  const factor = years.reduce((f, y) => f * ((1 + hpi[y] / 100) / (1 + hicp[y] / 100)), 1);
  return round((factor ** (1 / years.length) - 1) * 100, 1);
}

export function trendOf(hpi, hicp) {
  const years = Object.keys(hpi).filter((y) => hicp[y] !== undefined).sort();
  const year = years.at(-1);
  if (!year) return null;
  return { change: hpi[year], inflation: hicp[year], real: realChange(hpi[year], hicp[year]), year, realCagr: realCagr(hpi, hicp, years), since: years[0] };
}

export function fitOf(row, site, { hpi = null, maxValue = null } = {}) {
  const zoning = zoningOf(row);
  const parts = {
    sea: seaScore(site.coastKm),
    season: site.climate ? site.climate.workable / 12 : 0,
    noAc: site.climate ? noAcScore(site.climate.hottest) : 0,
    explore: saturating(explorePoints(site), POI_SATURATION),
    demand: saturating((site.lodging ?? 0) + (site.campsites ?? 0), LODGING_SATURATION),
    trend: hpi === null ? 0.5 : Math.max(0, Math.min(1, hpi / 15)),
    cost: maxValue && Number.isFinite(row.value) ? 1 - Math.min(1, row.value / maxValue) / 2 : 0.5,
    zoning: zoning === 'buildable' ? 1 : zoning === 'agricultural' ? 0.5 : 0.3,
  };
  const score = Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * parts[k], 0);
  return { score: round(score, 3), parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v, 2)])), zoning, pitches: pitchesFor(row.area), hpi };
}

const NUMBER = '(-?\\d{1,3}\\.\\d{3,})';
const COORD_PATTERNS = [
  new RegExp(`"lat(?:itude)?"\\s*:\\s*"?${NUMBER}"?\\s*,\\s*"(?:lng|lon|long|longitude)"\\s*:\\s*"?${NUMBER}`, 'i'),
  new RegExp(`data-lat(?:itude)?="${NUMBER}"[^>]*?data-(?:lng|lon|long|longitude)="${NUMBER}"`, 'i'),
  new RegExp(`place:location:latitude"\\s+content="${NUMBER}"[\\s\\S]{0,200}?place:location:longitude"\\s+content="${NUMBER}"`, 'i'),
  new RegExp(`(?:[?&](?:q|ll|center|query)=|/@)${NUMBER},\\s*${NUMBER}`),
];

export function pageCoordinates(html) {
  const body = String(html ?? '');
  for (const pattern of COORD_PATTERNS) {
    const m = body.match(pattern);
    if (!m) continue;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(Math.abs(lat) < 1 && Math.abs(lon) < 1)) return { lat, lon };
  }
  return null;
}

const GENERIC_TITLE = /\b(?:terreno|terrenos|rustic|rústic|urban|venda|vende|lote|plot|land|sale|satılık|satilik|tarla|arsa|parcela|finca|solar|quinta|perto|near|com|with|para|for|zona|sea|mar|praia|beach|vista|view|ref|id)\b/i;

export function titlePlace(title, kindTerms = []) {
  const kind = new RegExp(`\\b(?:${kindTerms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || 'x^'})\\b`, 'i');
  const segments = String(title ?? '').split(/\s*[,|–—]\s*|\s+-\s+/).map((s) => s.trim());
  return segments.find((s) => /^\p{Lu}/u.test(s) && !/\d/.test(s) && s.split(/\s+/).length <= 4 && !GENERIC_TITLE.test(s) && !kind.test(s)) ?? null;
}

export function shortSite(site) {
  if (!site) return null;
  const { climate, ...rest } = site;
  return { ...rest, climate: climate ? { comfortable: climate.comfortable, workable: climate.workable, hottest: climate.hottest, coldest: climate.coldest } : null };
}

const fold = (text) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();

export function namesRegion(displayName, query) {
  const parts = String(query).split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return true;
  const region = fold(parts[parts.length - 2]);
  return fold(displayName).includes(region);
}

export class SiteAssessor {
  constructor({ file = '', fetchJson = null, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.file = file;
    this.now = now;
    this.sleep = sleep;
    this.fetchJson = fetchJson ?? ((url, init) => this.httpJson(url, init));
    this.store = { sites: {}, places: {}, hpi: {}, points: {}, facts: {} };
    this.loaded = !file;
    this.writing = Promise.resolve();
    this.lastGeocode = -Infinity;
    this.reads = 0;
    this.limits = MODES.budget;
  }

  async httpJson(url, init = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { ...init, headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(150000) });
      if (res.ok) return res.json();
      if (!RETRY_STATUS.has(res.status) || attempt >= RETRY_WAITS_MS.length) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
      await this.sleep(RETRY_WAITS_MS[attempt]);
    }
  }

  async load() {
    if (this.loaded) return this;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const current = parsed.version === STORE_VERSION;
        const looked = (entry) => String(entry?.point?.by ?? '').startsWith('place');
        const points = Object.fromEntries(Object.entries(parsed.points ?? {}).filter(([, entry]) => current || !looked(entry)));
        this.store = { sites: parsed.sites ?? {}, places: current ? parsed.places ?? {} : {}, hpi: current ? parsed.hpi ?? {} : {}, points, facts: parsed.facts ?? {} };
      }
    } catch {
      this.store = { sites: {}, places: {}, hpi: {}, points: {}, facts: {} };
    }
    this.loaded = true;
    return this;
  }

  persist() {
    if (!this.file) return this.writing;
    for (const table of ['sites', 'places', 'points', 'facts']) {
      const keys = Object.keys(this.store[table]);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SITES))) delete this.store[table][key];
    }
    const body = JSON.stringify({ version: STORE_VERSION, ...this.store });
    this.writing = this.writing.then(() => fs.writeFile(this.file, body)).catch(() => {});
    return this.writing;
  }

  fresh(entry) {
    return Boolean(entry && this.now() - entry.at < SITE_TTL_MS);
  }

  cachedSite(lat, lon) {
    const entry = this.store.sites[siteKey(lat, lon)];
    return this.fresh(entry) ? entry.site : null;
  }

  async geocode(query, countryCode = '') {
    const key = `${countryCode.toLowerCase()}|${query.toLowerCase()}`;
    const known = this.store.places[key];
    if (this.fresh(known)) return known.point;
    const wait = this.lastGeocode + GEOCODE_GAP_MS - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastGeocode = this.now();
    const only = /^[A-Z]{2}$/.test(countryCode) ? `&countrycodes=${countryCode.toLowerCase()}` : '';
    const found = await this.fetchJson(`${NOMINATIM_URL}?format=json&limit=1${only}&q=${encodeURIComponent(query)}`);
    const hit = Array.isArray(found) ? found[0] : null;
    const fine = hit && (hit.place_rank === undefined || Number(hit.place_rank) >= MIN_PLACE_RANK);
    const point = fine && namesRegion(hit.display_name, query) ? { lat: Number(hit.lat), lon: Number(hit.lon), by: `place "${query}"` } : null;
    this.store.places[key] = { at: this.now(), point };
    this.persist();
    return point;
  }

  async locate(row, readPage) {
    if (Number.isFinite(row.lat) && Number.isFinite(row.lon)) return { lat: row.lat, lon: row.lon, by: 'listing data' };
    const known = this.store.points[row.url];
    if (known && this.now() - known.at < (known.point ? SITE_TTL_MS : MISS_TTL_MS)) return known.point;
    if (this.reads >= this.limits.pageReads) return undefined;
    this.reads++;
    const point = await this.findPoint(row, readPage);
    this.store.points[row.url] = { at: this.now(), point };
    this.persist();
    return point;
  }

  async titleConflict(row, point, brief) {
    const name = titlePlace(row.title, brief?.kind?.terms ?? []);
    if (!name || !row.country || String(row.place ?? '').toLowerCase().includes(name.toLowerCase())) return null;
    const named = await this.geocode(`${name}, ${row.country}`, row.countryCode ?? '');
    if (!named) return null;
    const km = haversineKm(point.lat, point.lon, named.lat, named.lon);
    return km > TITLE_PLACE_KM ? `the title names ${name}, ${Math.round(km)} km from where the listing's map puts it` : null;
  }

  noteFacts(url, page) {
    if (page) this.store.facts[url] = { at: this.now(), gone: GONE_STATUS.has(page.status) ? page.status : 0, area: areaFromText(page.text) };
  }

  async factsOf(row, readPage) {
    if (row.area || this.store.facts[row.url] || !readPage || this.reads >= this.limits.pageReads) return this.store.facts[row.url] ?? null;
    this.reads++;
    this.noteFacts(row.url, await readPage(row.url).catch(() => null));
    this.persist();
    return this.store.facts[row.url] ?? null;
  }

  async findPoint(row, readPage) {
    let page = null;
    if (readPage) {
      page = await readPage(row.url).catch(() => null);
      this.noteFacts(row.url, page);
      if (GONE_STATUS.has(page?.status)) return null;
      if (page?.coords) return { ...page.coords, by: 'listing page' };
    }
    const place = String(row.place || page?.place || '').trim();
    if (!place) return null;
    const country = countryByCode(row.countryCode ?? '');
    const countryWords = new Set([row.countryCode, row.country, ...(country ? [country.name, ...country.aliases] : [])].filter(Boolean).map(fold));
    const parts = [...new Set(place.split(/,|\s+-\s+/).map((p) => p.trim()).filter((p) => p && !countryWords.has(fold(p))))];
    for (let k = 0; k < parts.length; k++) {
      const rest = parts.slice(k).join(', ');
      const query = row.country && !rest.toLowerCase().includes(row.country.toLowerCase()) ? `${rest}, ${row.country}` : rest;
      const point = await this.geocode(query, row.countryCode ?? '');
      if (point) return k ? { ...point, by: `${point.by}, the nearest place found for "${place}"` } : point;
    }
    return null;
  }

  async assess(lat, lon) {
    const cached = this.cachedSite(lat, lon);
    if (cached) return cached;
    const post = (query) => this.fetchJson(OVERPASS_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` });
    const site = parseSurroundings(await post(overpassQuery(lat, lon)), lat, lon);
    if (site.coastKm === null) site.coastKm = parseCoast(await post(coastQuery(lat, lon)), lat, lon);
    const [start, end] = CLIMATE_YEARS;
    const weather = await this.fetchJson(`${CLIMATE_URL}?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&start_date=${start}&end_date=${end}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=GMT`);
    site.climate = seasonOf(monthlyClimate(weather?.daily));
    this.store.sites[siteKey(lat, lon)] = { at: this.now(), site };
    this.persist();
    return site;
  }

  async trends(rows) {
    const codes = [...new Set(rows.map((r) => r.countryCode).filter(Boolean)), EU_AGGREGATE];
    const trends = {};
    for (const code of codes) trends[code] = await this.priceTrend(code);
    return { trends, euHpi: trends[EU_AGGREGATE]?.real ?? null };
  }

  async addLakes(lat, lon, site) {
    const post = (query) => this.fetchJson(OVERPASS_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` });
    const withLakes = { ...site, lakeKm: parseLakes(await post(lakeQuery(lat, lon)), lat, lon), lakesNamed: true };
    this.store.sites[siteKey(lat, lon)] = { at: this.store.sites[siteKey(lat, lon)]?.at ?? this.now(), site: withLakes };
    this.persist();
    return withLakes;
  }

  async priceTrend(code) {
    if (!code) return null;
    const known = this.store.hpi[code];
    if (this.fresh(known)) return known.value;
    if (!this.limits.newSites) return known?.value ?? null;
    let value = null;
    try {
      const geo = EUROSTAT_CODE[code] ?? code;
      const hpi = yearly(await this.fetchJson(`${HPI_URL}?unit=RCH_A_AVG&purchase=TOTAL&geo=${geo}&sinceTimePeriod=2020`));
      const hicp = yearly(await this.fetchJson(`${HICP_URL}?unit=RCH_A_AVG&coicop=CP00&geo=${geo}&sinceTimePeriod=2020`));
      value = trendOf(hpi, hicp);
    } catch {
      value = null;
    }
    this.store.hpi[code] = { at: this.now(), value };
    this.persist();
    return value;
  }


  async measureRows(rows, brief, ctx) {
    const { readPage, onProgress, stats, started, maxValue } = ctx;
    const near = [];
    const far = [];
    const gone = [];
    for (const original of rows) {
      try {
        const point = await this.locate(original, readPage);
        const facts = await this.factsOf(original, readPage);
        if (facts?.gone) {
          gone.push({ ...original, goneStatus: facts.gone });
          continue;
        }
        const row = original.area || !facts?.area ? original : { ...original, area: facts.area, areaUnit: 'm²', areaBy: 'listing page' };
        if (point === undefined) {
          stats.pending++;
          near.push({ ...row, site: null, fit: null, siteNote: 'site check queued for the next pass' });
          continue;
        }
        if (!point) {
          stats.unlocated++;
          near.push({ ...row, site: null, fit: null, siteNote: 'location not shown' });
          continue;
        }
        stats.located++;
        let site = this.cachedSite(point.lat, point.lon);
        if (!site) {
          if (ctx.fresh >= this.limits.newSites || this.now() - started > this.limits.budgetMs) {
            stats.pending++;
            near.push({ ...row, lat: point.lat, lon: point.lon, site: null, fit: null, siteNote: 'site check queued for the next pass' });
            continue;
          }
          ctx.fresh++;
          site = await this.assess(point.lat, point.lon);
          onProgress(stats);
        }
        stats.assessed++;
        if (!site.lakesNamed && ctx.fresh < this.limits.newSites && this.now() - started <= this.limits.budgetMs) {
          ctx.fresh++;
          site = await this.addLakes(point.lat, point.lon, site);
        }
        const conflict = await this.titleConflict(row, point, brief);
        const trend = await this.priceTrend(row.countryCode);
        const assessed = { ...row, lat: point.lat, lon: point.lon, locatedBy: point.by, site: shortSite(site), fit: fitOf(row, site, { hpi: trend?.real ?? null, maxValue }), ...(conflict ? { placeConflict: conflict } : {}) };
        if (brief?.coastal && (site.coastKm === null || site.coastKm > EBIKE_KM)) {
          stats.far++;
          far.push(assessed);
        } else near.push(assessed);
      } catch (error) {
        stats.failed++;
        near.push({ ...original, site: null, fit: null, siteNote: `site check failed: ${String(error.message).slice(0, 80)}` });
      }
    }
    return { near, far, gone };
  }

  async apply(candidates, brief, { readPage = null, onProgress = () => {}, mode = 'budget' } = {}) {
    this.limits = MODES[mode] ?? MODES.budget;
    if (!candidates?.kept?.length && !candidates?.outside?.length) return candidates;
    await this.load();
    this.reads = 0;
    const stats = { assessed: 0, located: 0, far: 0, unlocated: 0, pending: 0, failed: 0 };
    const ctx = { readPage, onProgress, stats, started: this.now(), maxValue: brief?.valueRange?.[1] ?? null, fresh: 0 };
    const inside = await this.measureRows(candidates.kept ?? [], brief, ctx);
    const kept = inside.near;
    const { far, gone } = inside;
    const outsideStats = { ...stats };
    const beyond = await this.measureRows(candidates.outside ?? [], brief, { ...ctx, stats: outsideStats });
    kept.sort((a, b) => (b.fit?.score ?? -1) - (a.fit?.score ?? -1));
    const reason = `farther than ${EBIKE_KM} km from the sea`;
    const removed = 'listing removed from the portal';
    const screened = { ...candidates.screened };
    if (far.length) screened[reason] = (screened[reason] ?? 0) + far.length;
    if (gone.length) screened[removed] = (screened[removed] ?? 0) + gone.length;
    const examples = [...(candidates.examples ?? []), ...gone.slice(0, 10).map((r) => ({ title: String(r.title ?? '').slice(0, 100), url: r.url, reasons: [`${removed} (HTTP ${r.goneStatus})`] })), ...far.slice(0, 10).map((r) => ({ title: String(r.title ?? '').slice(0, 100), url: r.url, reasons: [`${reason} (${r.site.coastKm ?? `>${EBIKE_KM}`} km)`] }))].slice(-40);
    return {
      ...candidates,
      kept,
      keptCount: (candidates.keptCount ?? 0) - far.length - gone.length,
      screened,
      screenedCount: (candidates.screenedCount ?? 0) + far.length + gone.length,
      examples,
      far,
      farReason: reason,
      outside: [...beyond.near, ...beyond.far],
      sites: { ...stats, ...(await this.trends([...(candidates.kept ?? []), ...(candidates.outside ?? [])])), at: new Date(this.now()).toISOString() },
    };
  }

}
