import fs from 'node:fs/promises';
import path from 'node:path';
import { haversineKm } from './site.mjs';

const TKGM_API = 'https://cbsapi.tkgm.gov.tr/megsiswebapi.v3/api/parsel';
const TKGM_PAGE = 'https://parselsorgu.tkgm.gov.tr/';
const BROWSER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const LOOKUPS_PER_MODE = { cache: 0, budget: 12, all: 60 };
const MISS_RETRY_MS = 7 * 24 * 3600 * 1000;
const PAUSE_MS = 600;
export const MATCH_KM = 3;
export const AREA_TOLERANCE = 0.15;

const PROPERTY = /"@type":"PropertyValue","name":"([^"]+)","value":"?([^"}]*)/g;
const LAT = /\\?"lat(?:itude)?\\?"\s*:\s*\\?"?(-?\d{1,2}\.\d+)/;
const LON = /\\?"(?:lon|lng|longitude)\\?"\s*:\s*\\?"?(-?\d{1,3}\.\d+)/;
const FOREST = /orman/i;

export function listingParcel(html) {
  const text = String(html ?? '');
  const props = Object.fromEntries([...text.matchAll(PROPERTY)].map((m) => [m[1], m[2].trim()]));
  const lat = Number(text.match(LAT)?.[1]);
  const lon = Number(text.match(LON)?.[1]);
  return {
    ada: props.Ada || null,
    parsel: props.Parsel || null,
    zoning: props['İmar Durumu'] || null,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
  };
}

export function registryArea(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const decimalComma = /,\d{1,2}$/.test(s) || (/^\d{1,3}(\.\d{3})+$/.test(s));
  const n = Number(decimalComma ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function ringCentre(geometry) {
  const ring = geometry?.coordinates?.[0];
  if (!Array.isArray(ring) || !ring.length) return null;
  const sum = ring.reduce((a, [lon, lat]) => ({ lat: a.lat + lat, lon: a.lon + lon }), { lat: 0, lon: 0 });
  return { lat: sum.lat / ring.length, lon: sum.lon / ring.length };
}

const squareMetres = (n) => Math.round(n).toLocaleString('en-US');

export function cadastreNotes(row, listingM2) {
  const record = row?.cadastre;
  if (!record?.areaM2) return { why: [], risks: [] };
  const ref = `${record.registry} ${record.place} ${record.ada ? `${record.ada}/` : ''}${record.parsel}`;
  const use = record.landUse ? ` (${record.landUse})` : '';
  const why = [];
  const risks = [];
  const ratio = listingM2 > 0 ? listingM2 / record.areaM2 : null;
  if (ratio !== null && Math.abs(ratio - 1) <= AREA_TOLERANCE) why.push(`official record ${ref}: ${squareMetres(record.areaM2)} m²${use}, matches the listing`);
  if (ratio !== null && ratio < 1 - AREA_TOLERANCE) risks.push(`the listing sells ${squareMetres(listingM2)} m² of a ${squareMetres(record.areaM2)} m² parcel on the official record ${ref}: likely a shared title (hisseli); ask for a single-owner deed (müstakil tapu)`);
  if (ratio !== null && ratio > 1 + AREA_TOLERANCE) risks.push(`the listing states ${squareMetres(listingM2)} m² but the official record ${ref} has ${squareMetres(record.areaM2)} m²: check which parcels the sale includes`);
  if (FOREST.test(record.landUse ?? '')) risks.push(`official land use on ${ref}: forest (${record.landUse}); building and camping need a forestry permit`);
  return { why, risks };
}

export class TurkeyParcelRegistry {
  constructor({ fetchJson, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.fetchJson = fetchJson;
    this.sleep = sleep;
  }

  async find({ ada, parsel, lat, lon }) {
    const atPoint = await this.fetchJson(`${TKGM_API}/${lat}/${lon}/`);
    const village = atPoint?.properties?.mahalleId;
    if (!village) return null;
    const same = String(atPoint.properties.parselNo) === String(parsel) && (!ada || String(atPoint.properties.adaNo) === String(ada));
    let feature = atPoint;
    if (!same) {
      if (!ada) return null;
      await this.sleep(PAUSE_MS);
      feature = await this.fetchJson(`${TKGM_API}/${village}/${ada}/${parsel}`);
    }
    const props = feature?.properties;
    const centre = ringCentre(feature?.geometry);
    if (!props || !centre || haversineKm(lat, lon, centre.lat, centre.lon) > MATCH_KM) return null;
    return { registry: 'TKGM', country: 'TR', place: props.mahalleAd ?? '', ada: props.adaNo || ada || '', parsel: String(props.parselNo ?? parsel), areaM2: registryArea(props.alan), landUse: props.nitelik ?? '', url: TKGM_PAGE };
  }
}

export class ParcelRegistry {
  constructor({ file = '', fetchJson = null, fetchText = null, registries = null, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.file = file;
    this.now = now;
    this.sleep = sleep;
    this.fetchJson = fetchJson ?? ((url) => this.http(url, 'json'));
    this.fetchText = fetchText ?? ((url) => this.http(url, 'text'));
    this.registries = registries ?? { TR: new TurkeyParcelRegistry({ fetchJson: (url) => this.fetchJson(url), sleep }) };
    this.store = { parcels: {} };
    this.loaded = !file;
  }

  async http(url, kind) {
    const res = await fetch(url, { headers: { 'user-agent': BROWSER_AGENT }, signal: AbortSignal.timeout(25000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    return kind === 'json' ? res.json() : res.text();
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.store = { parcels: {}, ...JSON.parse(await fs.readFile(this.file, 'utf8')) };
    } catch {
      this.store = { parcels: {} };
    }
  }

  async save() {
    if (!this.file) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.store));
  }

  fresh(entry) {
    return entry && (entry.record || this.now() - Date.parse(entry.at) < MISS_RETRY_MS);
  }

  async lookup(row) {
    const listing = listingParcel(await this.fetchText(row.url));
    if (!listing.parsel) return { record: null, reason: 'the listing states no parcel number' };
    if (listing.lat === null || listing.lon === null) return { record: null, reason: 'the listing has no map point' };
    await this.sleep(PAUSE_MS);
    const record = await this.registries[row.countryCode].find(listing);
    return { record: record ? { ...record, listingZoning: listing.zoning } : null, reason: record ? '' : 'no registry parcel with that number near the listing point' };
  }

  async apply(candidates, { mode = 'budget' } = {}) {
    const rows = candidates?.kept ?? [];
    const eligible = rows.filter((r) => r.url && this.registries[r.countryCode]);
    if (!eligible.length) return candidates;
    await this.load();
    let budget = LOOKUPS_PER_MODE[mode] ?? LOOKUPS_PER_MODE.budget;
    const stats = { eligible: eligible.length, matched: 0, missed: 0, pending: 0, failed: 0 };
    let changed = false;
    for (const row of eligible) {
      if (this.fresh(this.store.parcels[row.url])) continue;
      if (budget <= 0) break;
      budget -= 1;
      try {
        const { record, reason } = await this.lookup(row);
        this.store.parcels[row.url] = { at: new Date(this.now()).toISOString(), record, reason };
        changed = true;
      } catch {
        stats.failed += 1;
      }
    }
    if (changed) await this.save();
    const kept = rows.map((row) => {
      const entry = this.store.parcels[row.url];
      if (!eligible.includes(row)) return row;
      if (!entry) { stats.pending += 1; return row; }
      if (!entry.record) { stats.missed += 1; return row; }
      stats.matched += 1;
      return { ...row, cadastre: entry.record };
    });
    return { ...candidates, kept, parcels: stats };
  }
}
