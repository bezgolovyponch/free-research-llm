import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { EBIKE_KM, NEW_SITES_PER_PASS, SiteAssessor, fitOf, haversineKm, monthlyClimate, overpassQuery, pageCoordinates, parseSurroundings, pitchesFor, seaScore, seasonOf, siteKey, zoningOf } from '../../src/research/site.mjs';

const VIR = { lat: 44.3, lon: 15.09 };
const BINH_DUONG = { lat: 11.0, lon: 106.65 };

function daily(byMonth: (m: number) => [number, number, number]) {
  const time: string[] = [];
  const tmax: number[] = [];
  const tmin: number[] = [];
  const rain: number[] = [];
  for (const year of [2024, 2025]) {
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 30; d++) {
        const [hi, lo, r] = byMonth(m);
        time.push(`${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
        tmax.push(hi);
        tmin.push(lo);
        rain.push(r / 30);
      }
    }
  }
  return { time, temperature_2m_max: tmax, temperature_2m_min: tmin, precipitation_sum: rain };
}

const mediterranean = daily((m) => (m <= 2 || m === 12 ? [12, 5, 90] : m >= 6 && m <= 8 ? [30, 20, 20] : [22, 12, 60]));
const tropical = daily(() => [33, 24, 180]);

function overpassAt(point: { lat: number; lon: number }, coastOffset: number | null) {
  const elements = [
    ...(coastOffset === null ? [] : [{ type: 'way', tags: { natural: 'coastline' }, geometry: [{ lat: point.lat + coastOffset, lon: point.lon }] }]),
    { type: 'way', tags: { natural: 'beach' }, center: { lat: point.lat + 0.01, lon: point.lon } },
    ...[13, 4, 2, 3, 5, 2, 40].map((total) => ({ type: 'count', tags: { total: String(total) } })),
  ];
  return { elements };
}

function fakeNet(opts: { coastFor?: (lat: number) => number | null; geocode?: Record<string, { lat: number; lon: number }> } = {}) {
  const calls: string[] = [];
  const fetchJson = async (url: string, init?: { body?: string }) => {
    if (url.includes('nominatim')) {
      calls.push('geocode');
      const q = decodeURIComponent(url.split('q=')[1]);
      calls.push(url.match(/countrycodes=(\w+)/)?.[1] ?? 'any');
      const hit = opts.geocode?.[q];
      return hit ? [{ lat: String(hit.lat), lon: String(hit.lon) }] : [];
    }
    if (url.includes('overpass')) {
      calls.push('overpass');
      const body = decodeURIComponent(String(init?.body ?? '').replace(/^data=/, ''));
      const [lat, lon] = body.match(/around:\d+,(-?[\d.]+),(-?[\d.]+)/)!.slice(1).map(Number);
      const offset = opts.coastFor ? opts.coastFor(lat) : 0.005;
      if (!body.includes('natural=beach')) return { elements: offset === null ? [] : [{ type: 'way', tags: { natural: 'coastline' }, geometry: [{ lat: lat + offset, lon }] }] };
      return overpassAt({ lat, lon }, offset !== null && offset < 0.09 ? offset : null);
    }
    if (url.includes('open-meteo')) {
      calls.push('climate');
      return { daily: url.includes('latitude=11.') ? tropical : mediterranean };
    }
    if (url.includes('eurostat')) {
      calls.push('hpi');
      return { dimension: { time: { category: { index: { 2024: 0, 2025: 1 } } } }, value: { 0: 10.4, 1: 13.9 } };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchJson };
}

const noSleep = async () => {};

describe('site measurements', () => {
  it('measures great-circle distance and rounds locations to a cache key', () => {
    expect(haversineKm(44.3, 15.09, 44.3, 15.09)).toBe(0);
    expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(111.2, 0);
    expect(siteKey(44.301, 15.089)).toBe('44.30,15.08');
  });

  it('scores the sea by e-bike distance and nothing beyond the e-bike limit', () => {
    expect(seaScore(0.5)).toBe(1);
    expect(seaScore(8)).toBe(0.8);
    expect(seaScore(EBIKE_KM)).toBe(0.2);
    expect(seaScore(EBIKE_KM + 1)).toBe(0);
    expect(seaScore(null)).toBe(0);
  });

  it('turns daily weather into monthly means and counts workable glamping months', () => {
    const months = monthlyClimate(mediterranean);
    expect(months[0]).toEqual({ tmax: 12, tmin: 5, rain: 90 });
    const season = seasonOf(months)!;
    expect(season).toMatchObject({ workable: 9, comfortable: 6, hottest: 30, coldest: 5 });
    expect(seasonOf(monthlyClimate(tropical))).toMatchObject({ workable: 0, hottest: 33 });
    expect(seasonOf(monthlyClimate({ time: [] }))).toBeNull();
  });

  it('sizes a rural camping park from the plot area', () => {
    expect(pitchesFor(640)).toBe(9);
    expect(pitchesFor(20000)).toBe(30);
    expect(pitchesFor(null)).toBeNull();
  });

  it('reads zoning words in the listing languages', () => {
    expect(zoningOf({ title: 'Zemljište 100 m od mora, izuzeto iz građevinske zone' })).toBe('agricultural');
    expect(zoningOf({ title: 'Terreno rústico 4720 m²' })).toBe('agricultural');
    expect(zoningOf({ title: 'Terreno Urbano | Coimbra' })).toBe('buildable');
    expect(zoningOf({ title: 'Land for sale' })).toBe('not stated');
  });

  it('finds coordinates a listing page publishes', () => {
    expect(pageCoordinates('{"latitude": 44.301234, "longitude": 15.091234}')).toEqual({ lat: 44.301234, lon: 15.091234 });
    expect(pageCoordinates('<div data-lat="38.22915" data-lng="-7.681057">')).toEqual({ lat: 38.22915, lon: -7.681057 });
    expect(pageCoordinates('<a href="https://maps.google.com/?q=37.1556,-8.0768">')).toEqual({ lat: 37.1556, lon: -8.0768 });
    expect(pageCoordinates('{"lat": 0.000, "lng": 0.000}')).toBeNull();
    expect(pageCoordinates('no map here')).toBeNull();
  });

  it('parses one combined OpenStreetMap answer into distances and counts', () => {
    expect(overpassQuery(VIR.lat, VIR.lon)).toContain('[natural=coastline]');
    const site = parseSurroundings(overpassAt(VIR, 0.005), VIR.lat, VIR.lon);
    expect(site).toMatchObject({ coastKm: 0.6, beaches: 1, beachKm: 1.1, viewpoints: 13, attractions: 4, reserves: 2, protectedAreas: 3, hikingRoutes: 5, campsites: 2, lodging: 40 });
  });

  it('ranks a plot by the business criteria, so a stunning short-season site still scores', () => {
    const site = { ...parseSurroundings(overpassAt(VIR, 0.005), VIR.lat, VIR.lon), climate: seasonOf(monthlyClimate(mediterranean)) };
    const fit = fitOf({ title: 'Poljoprivredno zemljište 240 m od uvale', value: 12110, area: 1211 }, site, { hpi: 13.9, maxValue: 20000 });
    expect(fit.parts).toMatchObject({ sea: 1, season: 0.75, noAc: 0.6, zoning: 0.5 });
    expect(fit.pitches).toBe(18);
    expect(fit.score).toBeGreaterThan(0.6);
    const inland = fitOf({ title: 'Land', value: 15000 }, { ...site, coastKm: 60, viewpoints: 0, attractions: 0, beaches: 0, reserves: 0, protectedAreas: 0, hikingRoutes: 0 }, { hpi: null, maxValue: 20000 });
    expect(inland.score).toBeLessThan(fit.score - 0.3);
  });
});

describe('SiteAssessor', () => {
  const rows = [
    { title: 'Poljoprivredno zemljište 240 m od uvale', url: 'https://famalo.example/14451', value: 12110, area: 1211, place: 'Vir', country: 'Croatia', countryCode: 'HR', coast: true },
    { title: 'Land for sale', url: 'https://dot.example/3735470', value: 16578, area: 150, place: 'Thuan Giao, Thuan An, Binh Duong', country: 'Vietnam', countryCode: 'VN', coast: false },
    { title: 'Terreno para venda', url: 'https://imo.example/ID1j4lK', value: 5000, area: 4720, place: '', country: 'Portugal', countryCode: 'PT', coast: false },
  ];
  const table = { found: 10, kept: rows, keptCount: 3, toCheck: [], toCheckCount: 0, screened: { 'price outside 0–20000 EUR': 7 }, screenedCount: 7, examples: [] };
  const brief = { coastal: true, valueRange: [0, 20000] };

  it('screens out listings beyond an e-bike ride from the sea and ranks the rest by fit', async () => {
    const net = fakeNet({ coastFor: (lat) => (lat > 40 ? 0.005 : null), geocode: { 'Vir, Croatia': VIR, 'Thuan Giao, Thuan An, Binh Duong, Vietnam': BINH_DUONG } });
    const assessor = new SiteAssessor({ fetchJson: net.fetchJson, sleep: noSleep });
    const readPage = async (url: string) => (url.includes('imo.example') ? { coords: { lat: 39.02564, lon: -9.114252 } } : { coords: null });
    const out = await assessor.apply(table, brief, { readPage });
    expect(out.keptCount).toBe(1);
    expect(out.screened[`farther than ${EBIKE_KM} km from the sea`]).toBe(2);
    expect(out.screenedCount).toBe(9);
    expect(out.kept.map((r: { url: string }) => r.url)).toEqual(['https://famalo.example/14451']);
    expect(out.kept[0]).toMatchObject({ locatedBy: 'place "Vir, Croatia"', site: { coastKm: 0.6, climate: { workable: 9 } }, fit: { zoning: 'agricultural', hpi: 13.9 } });
    expect(out.sites).toMatchObject({ assessed: 3, located: 3, far: 2, unlocated: 0 });
    expect(out.examples.at(-1).reasons[0]).toMatch(/farther than 25 km from the sea/);
    expect(net.calls.filter((c) => /^(hr|vn|any)$/.test(c))).toEqual(['hr', 'vn']);
  });

  it('keeps every row when the brief does not ask for the sea, and marks rows it cannot locate', async () => {
    const net = fakeNet({ geocode: { 'Vir, Croatia': VIR } });
    const out = await new SiteAssessor({ fetchJson: net.fetchJson, sleep: noSleep }).apply(table, { coastal: false, valueRange: [0, 20000] }, { readPage: null });
    expect(out.keptCount).toBe(3);
    expect(out.kept[0].url).toBe('https://famalo.example/14451');
    expect(out.kept.find((r: { url: string }) => r.url.includes('imo.example')).siteNote).toBe('location not shown');
    expect(out.kept.find((r: { url: string }) => r.url.includes('dot.example')).site).toBeNull();
  });

  it('caches sites, places and points on disk, so a second pass makes no network calls', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-site-'));
    const file = path.join(dir, 'sites.json');
    const net = fakeNet({ geocode: { 'Vir, Croatia': VIR } });
    const first = new SiteAssessor({ file, fetchJson: net.fetchJson, sleep: noSleep });
    await first.apply({ ...table, kept: [rows[0]], keptCount: 1 }, brief, {});
    await first.writing;
    const before = net.calls.length;
    const second = new SiteAssessor({ file, fetchJson: net.fetchJson, sleep: noSleep });
    const out = await second.apply({ ...table, kept: [rows[0]], keptCount: 1 }, brief, {});
    expect(net.calls.length).toBe(before);
    expect(out.kept[0].site.coastKm).toBe(0.6);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('measures at most a fixed number of new places per pass and queues the rest', async () => {
    const many = Array.from({ length: NEW_SITES_PER_PASS + 3 }, (_, i) => ({ ...rows[0], url: `https://famalo.example/${i}`, lat: 40 + i * 0.1, lon: 15 }));
    const net = fakeNet();
    const out = await new SiteAssessor({ fetchJson: net.fetchJson, sleep: noSleep }).apply({ ...table, kept: many, keptCount: many.length }, brief, {});
    expect(out.sites).toMatchObject({ assessed: NEW_SITES_PER_PASS, pending: 3 });
    expect(out.kept.filter((r: { siteNote?: string }) => r.siteNote === 'site check queued for the next pass')).toHaveLength(3);
  });

  it('keeps a row and says why when a free service fails', async () => {
    const out = await new SiteAssessor({ fetchJson: async () => { throw new Error('HTTP 429 from overpass-api.de'); }, sleep: noSleep }).apply({ ...table, kept: [{ ...rows[0], lat: VIR.lat, lon: VIR.lon }], keptCount: 1 }, brief, {});
    expect(out.keptCount).toBe(1);
    expect(out.kept[0].siteNote).toBe('site check failed: HTTP 429 from overpass-api.de');
  });

  it('waits between place lookups, as the geocoder asks', async () => {
    const waits: number[] = [];
    let t = 0;
    const net = fakeNet({ geocode: { 'A, Croatia': VIR, 'B, Croatia': VIR } });
    const assessor = new SiteAssessor({ fetchJson: net.fetchJson, now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; } });
    await assessor.geocode('A, Croatia');
    await assessor.geocode('B, Croatia');
    expect(waits).toEqual([1100]);
  });
});
