import fs from 'node:fs/promises';

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
export const RETRY_STATUS = new Set([429, 502, 503, 504]);
export const RETRY_WAITS_MS = [10000, 30000];
const USER_AGENT = 'free-research-llm (site fit; https://github.com/bezgolovyponch/free-research-llm)';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const CLIMATE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const HPI_URL = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hpi_a';
const EUROSTAT_CODE = { GR: 'EL' };
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
    ...Object.values(COUNT_FILTERS).map((f) => `nwr${near}${f};out count;`),
  ].join('');
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
  return { coastKm: nearestKm(lat, lon, coastPoints(elements)), beaches: beaches.length, beachKm: nearestKm(lat, lon, beaches), ...named };
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

export function shortSite(site) {
  if (!site) return null;
  const { climate, ...rest } = site;
  return { ...rest, climate: climate ? { comfortable: climate.comfortable, workable: climate.workable, hottest: climate.hottest, coldest: climate.coldest } : null };
}

export class SiteAssessor {
  constructor({ file = '', fetchJson = null, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.file = file;
    this.now = now;
    this.sleep = sleep;
    this.fetchJson = fetchJson ?? ((url, init) => this.httpJson(url, init));
    this.store = { sites: {}, places: {}, hpi: {}, points: {} };
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
      if (parsed && typeof parsed === 'object') this.store = { sites: parsed.sites ?? {}, places: parsed.places ?? {}, hpi: parsed.hpi ?? {}, points: parsed.points ?? {} };
    } catch {
      this.store = { sites: {}, places: {}, hpi: {}, points: {} };
    }
    this.loaded = true;
    return this;
  }

  persist() {
    if (!this.file) return this.writing;
    for (const table of ['sites', 'places', 'points']) {
      const keys = Object.keys(this.store[table]);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SITES))) delete this.store[table][key];
    }
    const body = JSON.stringify(this.store);
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
    const point = Array.isArray(found) && found.length ? { lat: Number(found[0].lat), lon: Number(found[0].lon), by: `place "${query}"` } : null;
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

  async findPoint(row, readPage) {
    let page = null;
    if (readPage) {
      page = await readPage(row.url).catch(() => null);
      if (page?.coords) return { ...page.coords, by: 'listing page' };
    }
    const place = String(row.place || page?.place || '').trim();
    if (!place) return null;
    const parts = place.split(',').map((p) => p.trim()).filter(Boolean);
    for (let k = 0; k < parts.length; k++) {
      const rest = parts.slice(k).join(', ');
      if (row.country && rest.toLowerCase() === row.country.toLowerCase()) break;
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

  async priceTrend(code) {
    if (!code) return null;
    const known = this.store.hpi[code];
    if (this.fresh(known)) return known.value;
    if (!this.limits.newSites) return known?.value ?? null;
    let value = null;
    try {
      const geo = EUROSTAT_CODE[code] ?? code;
      const d = await this.fetchJson(`${HPI_URL}?unit=RCH_A_AVG&purchase=TOTAL&geo=${geo}&sinceTimePeriod=2020`);
      const years = Object.entries(d?.dimension?.time?.category?.index ?? {}).sort((a, b) => b[1] - a[1]);
      const latest = years.find(([, i]) => d.value?.[i] !== undefined);
      value = latest ? { change: Number(d.value[latest[1]]), year: latest[0] } : null;
    } catch {
      value = null;
    }
    this.store.hpi[code] = { at: this.now(), value };
    this.persist();
    return value;
  }

  async apply(candidates, brief, { readPage = null, onProgress = () => {}, mode = 'budget' } = {}) {
    this.limits = MODES[mode] ?? MODES.budget;
    if (!candidates?.kept?.length) return candidates;
    await this.load();
    const started = this.now();
    const maxValue = brief?.valueRange?.[1] ?? null;
    let fresh = 0;
    const stats = { assessed: 0, located: 0, far: 0, unlocated: 0, pending: 0, failed: 0 };
    const kept = [];
    const far = [];
    this.reads = 0;
    for (const row of candidates.kept) {
      try {
        const point = await this.locate(row, readPage);
        if (point === undefined) {
          stats.pending++;
          kept.push({ ...row, site: null, fit: null, siteNote: 'site check queued for the next pass' });
          continue;
        }
        if (!point) {
          stats.unlocated++;
          kept.push({ ...row, site: null, fit: null, siteNote: 'location not shown' });
          continue;
        }
        stats.located++;
        let site = this.cachedSite(point.lat, point.lon);
        if (!site) {
          if (fresh >= this.limits.newSites || this.now() - started > this.limits.budgetMs) {
            stats.pending++;
            kept.push({ ...row, lat: point.lat, lon: point.lon, site: null, fit: null, siteNote: 'site check queued for the next pass' });
            continue;
          }
          fresh++;
          site = await this.assess(point.lat, point.lon);
          onProgress(stats);
        }
        stats.assessed++;
        const trend = await this.priceTrend(row.countryCode);
        const assessed = { ...row, lat: point.lat, lon: point.lon, locatedBy: point.by, site: shortSite(site), fit: fitOf(row, site, { hpi: trend?.change ?? null, maxValue }) };
        if (brief?.coastal && (site.coastKm === null || site.coastKm > EBIKE_KM)) {
          stats.far++;
          far.push(assessed);
        } else kept.push(assessed);
      } catch (error) {
        stats.failed++;
        kept.push({ ...row, site: null, fit: null, siteNote: `site check failed: ${String(error.message).slice(0, 80)}` });
      }
    }
    kept.sort((a, b) => (b.fit?.score ?? -1) - (a.fit?.score ?? -1));
    const reason = `farther than ${EBIKE_KM} km from the sea`;
    const screened = far.length ? { ...candidates.screened, [reason]: (candidates.screened?.[reason] ?? 0) + far.length } : candidates.screened;
    const examples = [...(candidates.examples ?? []), ...far.slice(0, 10).map((r) => ({ title: String(r.title ?? '').slice(0, 100), url: r.url, reasons: [`${reason} (${r.site.coastKm ?? `>${EBIKE_KM}`} km)`] }))].slice(-40);
    return {
      ...candidates,
      kept,
      keptCount: candidates.keptCount - far.length,
      screened,
      screenedCount: candidates.screenedCount + far.length,
      examples,
      sites: { ...stats, at: new Date(this.now()).toISOString() },
    };
  }
}
