import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { climateOf } from '../../src/research/cci.mjs';
import { TREND_RETRY_CAP_MS, backoffMs, transientError, namesRegion, EBIKE_KM, NEW_SITES_PER_PASS, PAGE_READS_PER_PASS, SiteAssessor, measureOrder, fitOf, haversineKm, overpassQuery, pageCoordinates, parseSurroundings, pitchesFor, siteKey, zoningOf } from '../../src/research/site.mjs';

const VIR = { lat: 44.3, lon: 15.09 };
const DA_NANG = { lat: 16.055, lon: 108.22, name: 'Thai Hoa, Hai Chau, Da Nang, Vietnam' };
const BINH_DUONG = { lat: 11.0, lon: 106.65 };

function daily(byMonth: (m: number) => [number, number, number, number]) {
  const time: string[] = [];
  const tmax: number[] = [];
  const tmin: number[] = [];
  const rain: number[] = [];
  const tmean: number[] = [];
  const dew: number[] = [];
  const sun: number[] = [];
  const wind: number[] = [];
  for (const year of [2024, 2025]) {
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 30; d++) {
        const [hi, lo, r, hours] = byMonth(m);
        time.push(`${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
        tmax.push(hi);
        tmin.push(lo);
        rain.push(r / 30);
        tmean.push((hi + lo) / 2);
        dew.push(lo);
        sun.push(hours * 3600);
        wind.push(10);
      }
    }
  }
  return { time, temperature_2m_max: tmax, temperature_2m_min: tmin, precipitation_sum: rain, temperature_2m_mean: tmean, dew_point_2m_mean: dew, sunshine_duration: sun, wind_speed_10m_mean: wind };
}

const mediterranean = daily((m) => (m <= 2 || m === 12 ? [12, 5, 90, 5] : m >= 6 && m <= 8 ? [30, 20, 20, 12] : [22, 12, 60, 9]));
const tropical = daily(() => [35, 24, 180, 6]);

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
      return hit ? [{ lat: String(hit.lat), lon: String(hit.lon), display_name: (hit as { name?: string }).name ?? q }] : [];
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
      if (url.includes('prc_hicp_aind')) return { dimension: { time: { category: { index: { 2024: 0, 2025: 1 } } } }, value: { 0: 2.4, 1: 2 } };
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


  it('counts a camping month when its mean index is above 3 (acceptable or better, Ma 2021 Table 4), never a month of adverse days capped at 3', () => {
    const season = climateOf(mediterranean)!;
    expect(season).toMatchObject({ workable: 9, good: 9, comfortable: 9, hottest: 30, coldest: 5 });
    expect(season.months[0]).toMatchObject({ cci: 3, tmax: 12, tmin: 5, rain: 90 });
    expect(season.months.filter((m: { cci: number }) => m.cci === 3)).toHaveLength(3);
    const time: string[] = [];
    for (let y = 2021; y <= 2025; y++) for (let d = 1; d <= 28; d++) time.push(`${y}-01-${String(d).padStart(2, '0')}`);
    const mild = climateOf({ time, temperature_2m_mean: time.map(() => 14), dew_point_2m_mean: time.map(() => 8), sunshine_duration: time.map(() => 5 * 3600), temperature_2m_max: time.map(() => 19), temperature_2m_min: time.map(() => 9), precipitation_sum: time.map(() => 0), wind_speed_10m_mean: time.map(() => 5) })!;
    expect(mild.months[0].cci).toBe(4);
    expect(mild).toMatchObject({ workable: 1, good: 0, comfortable: 0 });
    expect(climateOf(tropical)).toMatchObject({ workable: 0, hottest: 35, cci: { hotDays: 360 } });
    expect(climateOf({ time: [] })).toBeNull();
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

  it('finds the nearest lake or reservoir for the potential of an inland plot', async () => {
    const { lakeQuery, parseLakes } = await import('../../src/research/site.mjs');
    expect(lakeQuery(39.5, -8.3)).toContain('[natural=water][water~"^(lake|reservoir)$"][name]');
    expect(overpassQuery(39.5, -8.3)).toContain('[natural=water]');
    expect(parseLakes({ elements: [{ type: 'way', tags: { natural: 'water', water: 'reservoir', name: 'Albufeira de Castelo do Bode' }, center: { lat: 39.51, lon: -8.3 } }, { type: 'way', tags: { natural: 'water', water: 'reservoir' }, center: { lat: 39.5001, lon: -8.3 } }] }, 39.5, -8.3)).toBe(1.1);
    expect(parseLakes({ elements: [] }, 39.5, -8.3)).toBeNull();
  });

  it('describes a plot by measured facts only, with no hand-weighted score', () => {
    const fit = fitOf({ title: 'Poljoprivredno zemljište 240 m od uvale', value: 12110, area: 1211 }, { hpi: 13.9 });
    expect(fit).toEqual({ zoning: 'agricultural', pitches: 18, hpi: 13.9 });
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
    expect(out.kept[0]).toMatchObject({ locatedBy: 'place "Vir, Croatia"', site: { coastKm: 0.6, climate: { workable: 9 } }, fit: { zoning: 'agricultural', hpi: 11.7 } });
    expect(out.sites.trends.HR).toEqual({ change: 13.9, inflation: 2, real: 11.7, year: '2025', realCagr: 9.7, since: '2024' });
    expect(out.sites.euHpi).toBe(11.7);
    expect(out.sites).toMatchObject({ assessed: 3, located: 3, far: 2, unlocated: 0 });
    expect(out.examples.at(-1).reasons[0]).toMatch(/farther than 25 km from the sea/);
    expect(net.calls.filter((c) => /^(hr|vn|any)$/.test(c))).toEqual(['hr', 'vn']);
    expect(out.far.map((r: { url: string }) => r.url).sort()).toEqual(['https://dot.example/3735470', 'https://imo.example/ID1j4lK']);
    expect(out.farReason).toBe(`farther than ${EBIKE_KM} km from the sea`);
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

  it('re-measures the climate of a cached site measured before the Camping Climate Index from the stored weather cell, with no new map or weather queries', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-site-'));
    const file = path.join(dir, 'sites.json');
    const net = fakeNet({ geocode: { 'Vir, Croatia': VIR } });
    const first = new SiteAssessor({ file, fetchJson: net.fetchJson, sleep: noSleep });
    await first.apply({ ...table, kept: [rows[0]], keptCount: 1 }, brief, {});
    await first.writing;
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const entry of Object.values(stored.sites) as { site: { climate: object } }[]) entry.site.climate = { comfortable: 7, workable: 12, hottest: 24, coldest: 8 };
    await fs.writeFile(file, JSON.stringify(stored));
    const before = net.calls.length;
    const second = new SiteAssessor({ file, fetchJson: net.fetchJson, sleep: noSleep });
    const out = await second.apply({ ...table, kept: [rows[0]], keptCount: 1 }, brief, {});
    expect(net.calls.slice(before)).toEqual([]);
    expect(out.kept[0].site.climate.cci).toMatchObject({ monthly: expect.any(Array) });
    await second.writing;
    const third = new SiteAssessor({ file, fetchJson: net.fetchJson, sleep: noSleep });
    await third.apply({ ...table, kept: [rows[0]], keptCount: 1 }, brief, {});
    expect(net.calls.length).toBe(before);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('measures the most promising plots first without changing which rows come back or their order', async () => {
    const store = { points: { 'https://p.example/2': { point: { lat: 40.1, lon: -8.6 } }, 'https://p.example/3': { point: { lat: 41.1, lon: -8.6 } } }, sites: { [siteKey(40.1, -8.6)]: { site: { climate: { cci: {} } } } } };
    const rows = [{ url: 'https://p.example/0' }, { url: 'https://p.example/1', coast: true }, { url: 'https://p.example/2' }, { url: 'https://p.example/3', coast: true }, { url: 'https://p.example/4', lat: 39, lon: -9 }];
    expect(measureOrder(rows, store)).toEqual([2, 3, 4, 1, 0]);
    const net = fakeNet({ geocode: { 'Vir, Croatia': VIR } });
    const assessor = new SiteAssessor({ fetchJson: net.fetchJson, sleep: noSleep });
    assessor.limits = { newSites: 1, pageReads: 0, budgetMs: 60000 };
    const first = { title: 'Terreno', url: 'https://p.example/first', lat: 45.2, lon: 14.6, value: 5000, area: 2000 };
    const late = { title: 'Terreno junto ao mar', url: 'https://p.example/late', lat: VIR.lat, lon: VIR.lon, value: 5000, area: 2000, coast: true };
    const out = await assessor.measureRows([first, late], { coastal: false }, { readPage: null, onProgress: () => {}, stats: { assessed: 0, located: 0, far: 0, unlocated: 0, pending: 0, failed: 0 }, started: Date.now(), fresh: 0 });
    expect(out.near.map((r: { url: string }) => r.url)).toEqual(['https://p.example/first', 'https://p.example/late']);
    expect(out.near[0].siteNote).toBe('site check queued for the next pass');
    expect(out.near[1].site).not.toBeNull();
  });

  it('completes the hard checks from the coastline file and the stored climate when the map service fails, and fills the rest when it answers', async () => {
    const net = fakeNet({ geocode: { 'Vir, Croatia': VIR } });
    let mapDown = true;
    const fetchJson = async (url: string, init?: { body?: string }) => {
      if (mapDown && url.includes('overpass')) throw new Error('HTTP 502 from overpass-api.de');
      return net.fetchJson(url, init);
    };
    const coastFile = { nearestKm: async () => 12.3 };
    const assessor = new SiteAssessor({ fetchJson, sleep: noSleep, coastFile: coastFile as never });
    const row = { ...rows[0], lat: VIR.lat, lon: VIR.lon };
    const first = await assessor.apply({ ...table, kept: [row], keptCount: 1 }, brief, {});
    expect(first.kept[0].site).toMatchObject({ coastKm: 12.3, coastBy: 'Natural Earth 1:10m coastline', mapPending: true, climate: { cci: expect.any(Object) } });
    expect(first.sites.mapPending).toBe(1);
    mapDown = false;
    const second = await assessor.apply({ ...table, kept: [row], keptCount: 1 }, brief, {});
    expect(second.kept[0].site.mapPending).toBeUndefined();
    expect(second.kept[0].site).toMatchObject({ coastKm: 0.6, viewpoints: 13 });
  });

  it('caps map queries per pass and gives the other plots the coastline-file distance at once', async () => {
    const net = fakeNet({ geocode: { 'Vir, Croatia': VIR } });
    const budget = new SiteAssessor({ fetchJson: net.fetchJson, sleep: noSleep, coastFile: { nearestKm: async () => 3.1 } as never });
    budget.limits = { newSites: 5, pageReads: 0, budgetMs: 60000, mapQueries: 0 };
    const measured = await budget.measureRows([{ ...rows[0], lat: VIR.lat, lon: VIR.lon }], brief, { readPage: null, onProgress: () => {}, stats: { assessed: 0, located: 0, far: 0, unlocated: 0, pending: 0, failed: 0 }, started: Date.now(), fresh: 0 });
    expect(measured.near[0].site).toMatchObject({ coastKm: 3.1, mapPending: true });
    expect(net.calls.filter((c) => c === 'overpass')).toHaveLength(0);
  });

  it('drops looked-up places and points from an older store, keeping measured sites', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-site-'));
    const file = path.join(dir, 'sites.json');
    const now = Date.now();
    await fs.writeFile(file, JSON.stringify({ sites: { [siteKey(VIR.lat, VIR.lon)]: { at: now, site: { coastKm: 9 } } }, places: { 'hr|vir, croatia': { at: now, point: VIR } }, points: { 'https://x.example/1': { at: now, point: { ...VIR, by: 'place "Vir, Croatia"' } }, 'https://x.example/2': { at: now, point: { ...VIR, by: 'listing page' } } }, hpi: { HR: { at: now, value: { change: 13.9, year: '2025' } } } }));
    const assessor = await new SiteAssessor({ file }).load();
    expect(assessor.store.places).toEqual({});
    expect(Object.keys(assessor.store.points)).toEqual(['https://x.example/2']);
    expect(assessor.store.hpi).toEqual({});
    expect(assessor.cachedSite(VIR.lat, VIR.lon)).toEqual({ coastKm: 9 });
    assessor.persist();
    await assessor.writing;
    expect(JSON.parse(await fs.readFile(file, 'utf8')).version).toBe(4);
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

  it('looks up the place the listing page states when the card had none', async () => {
    const net = fakeNet({ geocode: { 'Thuan Giao, Binh Duong, Vietnam': BINH_DUONG } });
    const out = await new SiteAssessor({ fetchJson: net.fetchJson, sleep: noSleep }).apply({ ...table, kept: [{ ...rows[1], place: '' }], keptCount: 1 }, { coastal: false }, { readPage: async () => ({ coords: null, place: 'Thuan Giao, Binh Duong' }) });
    expect(out.kept[0]).toMatchObject({ locatedBy: 'place "Thuan Giao, Binh Duong, Vietnam"', site: { climate: { workable: 0 } } });
  });

  it('refuses a country, state or province match: too coarse to measure the sea from', async () => {
    const coarse = async (url: string) => (url.includes('nominatim') ? [{ lat: '39.0', lon: '35.0', display_name: 'Türkiye', place_rank: 4 }] : null);
    const assessor = new SiteAssessor({ fetchJson: coarse as never, sleep: noSleep });
    expect(await assessor.geocode('Türkiye', 'TR')).toBeNull();
    const town = async (url: string) => (url.includes('nominatim') ? [{ lat: '39.5', lon: '-9.0', display_name: 'Famalicão, Nazaré, Leiria, Portugal', place_rank: 16 }] : null);
    expect(await new SiteAssessor({ fetchJson: town as never, sleep: noSleep }).geocode('Famalicão, Nazaré, Portugal', 'PT')).toMatchObject({ lat: 39.5, lon: -9 });
  });

  it('turns a nominal house-price change into a real one with the same year of inflation', async () => {
    const { realCagr, realChange, trendOf, yearly } = await import('../../src/research/site.mjs');
    expect(realChange(41.5, 34.9)).toBe(4.9);
    expect(realChange(5.5, 2.5)).toBe(2.9);
    expect(trendOf({ 2024: 10, 2025: 41.5 }, { 2024: 58.5, 2025: 34.9 })).toEqual({ change: 41.5, inflation: 34.9, real: 4.9, year: '2025', realCagr: -14.7, since: '2024' });
    expect(realCagr({ 2021: 10, 2022: 10 }, { 2021: 0, 2022: 0 }, ['2021', '2022'])).toBe(10);
    expect(realCagr({ 2025: 5 }, { 2025: 2 }, ['2025'])).toBeNull();
    expect(trendOf({ 2025: 5 }, { 2024: 2 })).toBeNull();
    expect(yearly({ dimension: { time: { category: { index: { 2024: 0, 2025: 1 } } } }, value: { 1: 3.2 } })).toEqual({ 2025: 3.2 });
  });

  it('falls back to the nearest larger place the geocoder knows', async () => {
    const net = fakeNet({ geocode: { 'Binh Duong, Vietnam': BINH_DUONG } });
    const out = await new SiteAssessor({ fetchJson: net.fetchJson, sleep: noSleep }).apply({ ...table, kept: [{ ...rows[1], place: 'Chanh Nghia, Thu Dau Mot, Binh Duong' }], keptCount: 1 }, { coastal: false }, {});
    expect(out.kept[0].locatedBy).toBe('place "Binh Duong, Vietnam", the nearest place found for "Chanh Nghia, Thu Dau Mot, Binh Duong"');
  });

  it('never looks up a country code or name as a place, so a vague listing is not pinned to a village called "TR"', async () => {
    const net = fakeNet({ geocode: { 'TR, Turkey': { lat: 41.38, lon: 33.78 }, 'Türkiye, Turkey': { lat: 39, lon: 35 } } });
    const turkish = { title: 'Tarla', url: 'https://emlak.example/ilan/tarla-1', value: 5000, area: 1400, place: 'Dursunbey, Balıkesir, TR', country: 'Turkey', countryCode: 'TR', coast: false };
    const out = await new SiteAssessor({ fetchJson: net.fetchJson, sleep: noSleep }).apply({ ...table, kept: [turkish, { ...turkish, url: 'https://emlak.example/ilan/tarla-2', place: 'Türkiye' }], keptCount: 2 }, { coastal: false }, {});
    expect(out.kept.map((r: { siteNote?: string }) => r.siteNote)).toEqual(['location not shown', 'location not shown']);
    const asked = net.calls.filter((c) => c === 'geocode').length;
    expect(asked).toBe(2);
  });

  it('screens out a listing the portal removed and takes a missing area from the listing page', async () => {
    const readPage = async (url: string) => (url.endsWith('gone') ? { status: 410, text: '', coords: null } : { status: 200, text: 'Área bruta 120 m² · Área do terreno: 2 500 m²', coords: { lat: 39.02564, lon: -9.114252 } });
    const rowsIn = [{ ...rows[2], url: 'https://imo.example/gone' }, { ...rows[2], url: 'https://imo.example/ok', area: null }];
    const out = await new SiteAssessor({ fetchJson: fakeNet().fetchJson, sleep: noSleep }).apply({ ...table, kept: rowsIn, keptCount: 2 }, { coastal: false }, { readPage });
    expect(out.kept.map((r: { url: string }) => r.url)).toEqual(['https://imo.example/ok']);
    expect(out.kept[0]).toMatchObject({ area: 2500, areaUnit: 'm²', areaBy: 'listing page' });
    expect(out.screened['listing removed from the portal']).toBe(1);
    expect(out.examples.some((e: { reasons: string[] }) => e.reasons[0] === 'listing removed from the portal (HTTP 410)')).toBe(true);
    expect(out.keptCount).toBe(1);
  });

  it('reads each listing page once a day at most, and only a fixed number of new pages per pass', async () => {
    let reads = 0;
    const readPage = async () => { reads++; return { coords: null, place: '' }; };
    const many = Array.from({ length: PAGE_READS_PER_PASS + 5 }, (_, i) => ({ ...rows[2], url: `https://imo.example/ID${i}` }));
    const assessor = new SiteAssessor({ fetchJson: fakeNet().fetchJson, sleep: noSleep });
    const first = await assessor.apply({ ...table, kept: many, keptCount: many.length }, { coastal: false }, { readPage });
    expect(reads).toBe(PAGE_READS_PER_PASS);
    expect(first.sites).toMatchObject({ unlocated: PAGE_READS_PER_PASS, pending: 5 });
    await assessor.apply({ ...table, kept: many, keptCount: many.length }, { coastal: false }, { readPage });
    expect(reads).toBe(PAGE_READS_PER_PASS + 5);
  });

  it('makes no network call in cache mode, so loop trials see the same table as their baseline', async () => {
    const net = fakeNet({ geocode: { 'Vir, Croatia': VIR } });
    const assessor = new SiteAssessor({ fetchJson: net.fetchJson, sleep: noSleep });
    let reads = 0;
    const readPage = async () => { reads++; return { coords: null, place: '' }; };
    const cold = await assessor.apply({ ...table, kept: [rows[0], rows[2]], keptCount: 2 }, brief, { mode: 'cache', readPage });
    expect(net.calls).toEqual([]);
    expect(reads).toBe(0);
    expect(cold.sites).toMatchObject({ assessed: 0, pending: 2 });
    await assessor.apply({ ...table, kept: [rows[0]], keptCount: 1 }, brief, {});
    const calls = net.calls.length;
    const warm = await assessor.apply({ ...table, kept: [rows[0], rows[2]], keptCount: 2 }, brief, { mode: 'cache', readPage });
    expect(net.calls.length).toBe(calls);
    expect(warm.sites).toMatchObject({ assessed: 1, pending: 1 });
  });

  it('measures every listing in one pass at loop start', async () => {
    const many = Array.from({ length: NEW_SITES_PER_PASS + 3 }, (_, i) => ({ ...rows[0], url: `https://famalo.example/${i}`, lat: 40 + i * 0.1, lon: 15 }));
    const out = await new SiteAssessor({ fetchJson: fakeNet().fetchJson, sleep: noSleep }).apply({ ...table, kept: many, keptCount: many.length }, brief, { mode: 'all' });
    expect(out.sites).toMatchObject({ assessed: NEW_SITES_PER_PASS + 3, pending: 0 });
  });

  it('refuses a geocoder match outside the region the place names, and tries the larger place', async () => {
    expect(namesRegion('Thủ Dầu Một, Bình Dương, Việt Nam', 'Phu Loi, Binh Duong, Vietnam')).toBe(true);
    expect(namesRegion('Thai Hoa, Hai Chau, Da Nang, Vietnam', 'Thai Hoa, Binh Duong, Vietnam')).toBe(false);
    const net = fakeNet({ geocode: { 'Thai Hoa, Binh Duong, Vietnam': DA_NANG, 'Binh Duong, Vietnam': BINH_DUONG } });
    const out = await new SiteAssessor({ fetchJson: net.fetchJson, sleep: noSleep }).apply({ ...table, kept: [{ ...rows[1], place: 'Thai Hoa, Binh Duong - Binh Duong' }], keptCount: 1 }, { coastal: false }, {});
    expect(out.kept[0]).toMatchObject({ lat: BINH_DUONG.lat, lon: BINH_DUONG.lon });
    expect(out.kept[0].locatedBy).toContain('the nearest place found');
  });

  it('retries a busy free service, then gives up with its status', async () => {
    const waits: number[] = [];
    const statuses = [502, 429, 200];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { const status = statuses.shift()!; return new Response(status === 200 ? '{"ok":1}' : 'busy', { status }); }) as typeof fetch;
    try {
      const assessor = new SiteAssessor({ sleep: async (ms: number) => { waits.push(ms); } });
      expect(await assessor.httpJson('https://overpass-api.de/api/interpreter')).toEqual({ ok: 1 });
      expect(waits).toEqual([10000, 30000]);
      statuses.push(503, 503, 503);
      await expect(assessor.httpJson('https://overpass-api.de/api/interpreter')).rejects.toThrow('HTTP 503 from overpass-api.de');
      statuses.length = 0;
      statuses.push(404);
      await expect(assessor.httpJson('https://overpass-api.de/api/interpreter')).rejects.toThrow('HTTP 404 from overpass-api.de');
    } finally {
      globalThis.fetch = realFetch;
    }
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

describe('title and map agree', () => {
  it('takes the place a title names, skipping generic words and numbers', async () => {
    const { titlePlace } = await import('../../src/research/site.mjs');
    expect(titlePlace('Terreno rústico, perto do mar, Vieira de Leiria, 290m2', ['terreno'])).toBe('Vieira de Leiria');
    expect(titlePlace('Terreno para venda', ['terreno'])).toBeNull();
    expect(titlePlace('Terreno Urbano | Coimbra | 20.000 €', ['terreno'])).toBe('Coimbra');
    expect(titlePlace('Plot of land of 1,640 m² Nazaré , Centro Region , Portugal', ['plot', 'land'])).toBeNull();
  });

  it('flags a listing whose map point is far from the place its title names', async () => {
    const LISBON = { lat: 38.7777, lon: -9.0953 };
    const VIEIRA = { lat: 39.8722, lon: -8.9304 };
    const net = fakeNet({ geocode: { 'Vieira de Leiria, Portugal': VIEIRA } });
    const row = { title: 'Terreno rústico, perto do mar, Vieira de Leiria, 290m2', url: 'https://imo.example/ID1iQd5', value: 4990, area: 290, place: 'Expo Norte, Parque das Nações, Lisboa', country: 'Portugal', countryCode: 'PT', lat: LISBON.lat, lon: LISBON.lon };
    const out = await new SiteAssessor({ fetchJson: net.fetchJson, sleep: noSleep }).apply({ found: 1, kept: [row], keptCount: 1, toCheck: [], toCheckCount: 0, screened: {}, screenedCount: 0, examples: [] }, { coastal: false, kind: { terms: ['terreno'] } }, {});
    expect(out.kept[0].placeConflict).toBe("the title names Vieira de Leiria, 123 km from where the listing's map puts it");
    const agrees = await new SiteAssessor({ fetchJson: net.fetchJson, sleep: noSleep }).apply({ found: 1, kept: [{ ...row, lat: VIEIRA.lat, lon: VIEIRA.lon }], keptCount: 1, toCheck: [], toCheckCount: 0, screened: {}, screenedCount: 0, examples: [] }, { coastal: false, kind: { terms: ['terreno'] } }, {});
    expect(agrees.kept[0].placeConflict).toBeUndefined();
  });
});

describe('two measuring instances on one cache file', () => {
  it('keep each other\'s measurements: every write merges what is on disk, newer entries win', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-site-merge-'));
    const file = path.join(dir, 'sites.json');
    let now = 1000;
    const a = await new SiteAssessor({ file, now: () => now }).load();
    const b = await new SiteAssessor({ file, now: () => now }).load();
    a.store.sites['1.00,1.00'] = { at: now, site: { coastKm: 1 } };
    await a.persist();
    now = 2000;
    b.store.sites['2.00,2.00'] = { at: now, site: { coastKm: 2 } };
    await b.persist();
    await a.reload();
    expect(Object.keys(a.store.sites).sort()).toEqual(['1.00,1.00', '2.00,2.00']);
    const disk = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(Object.keys(disk.sites).sort()).toEqual(['1.00,1.00', '2.00,2.00']);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('Overpass instances', () => {
  it('moves to the next public instance when one refuses, and keeps using the one that answered', async () => {
    const { OVERPASS_URLS } = await import('../../src/research/site.mjs');
    const asked: string[] = [];
    const fetchJson = async (url: string) => {
      asked.push(url);
      if (url === OVERPASS_URLS[0]) throw new Error('fetch failed');
      return { elements: [] };
    };
    const assessor = new SiteAssessor({ fetchJson, sleep: noSleep });
    expect(await assessor.overpass('[out:json];')).toEqual({ elements: [] });
    expect(await assessor.overpass('[out:json];')).toEqual({ elements: [] });
    expect(asked).toEqual([OVERPASS_URLS[0], OVERPASS_URLS[1], OVERPASS_URLS[1]]);
    await expect(new SiteAssessor({ fetchJson: async () => { throw new Error('down'); }, sleep: noSleep }).overpass('q')).rejects.toThrow('down');
  });

  it('rests an instance that failed for ten minutes instead of waiting on it again for every place', async () => {
    const { OVERPASS_URLS, INSTANCE_REST_MS } = await import('../../src/research/site.mjs');
    let now = 0;
    const asked: string[] = [];
    const fetchJson = async (url: string) => {
      asked.push(url);
      if (url === OVERPASS_URLS[1]) throw new Error('timeout');
      if (url === OVERPASS_URLS[0] && now < 1) throw new Error('refused');
      return { elements: [] };
    };
    const assessor = new SiteAssessor({ fetchJson, sleep: noSleep, now: () => now });
    await assessor.overpass('q');
    expect(asked).toEqual([OVERPASS_URLS[0], OVERPASS_URLS[1], OVERPASS_URLS[2]]);
    asked.length = 0;
    await assessor.overpass('q');
    expect(asked).toEqual([OVERPASS_URLS[2]]);
    now = INSTANCE_REST_MS + 5;
    assessor.overpassAt = 0;
    asked.length = 0;
    await assessor.overpass('q');
    expect(asked).toEqual([OVERPASS_URLS[0]]);
  });
});

describe('price trend: retried with full-jitter backoff until the source answers (AWS SDK standard retry)', () => {
  const json = (rows: number[]) => ({ dimension: { time: { category: { index: { '2020': 0, '2021': 1, '2022': 2, '2023': 3, '2024': 4 } } } }, value: Object.fromEntries(rows.map((v, i) => [String(i), v])) });
  type Assessor = { priceTrend(code: string): Promise<{ real: number } | null>; trendGaps(codes: string[]): { missing: string[]; due: string[] }; store: { hpi: Record<string, { failures?: number; retryAt?: number; value?: unknown }> } };

  it('waits a random share of a doubling window, never above the cap', () => {
    expect(backoffMs(0, { random: () => 0 })).toBe(0);
    expect(backoffMs(0, { random: () => 0.999, base: 1000, cap: 60000 })).toBe(999);
    expect(backoffMs(3, { random: () => 0.5, base: 1000, cap: 60000 })).toBe(4000);
    expect(backoffMs(30, { random: () => 0.999, base: 1000, cap: 60000 })).toBe(59940);
  });

  it('treats dropped connections and timeouts as transient, and HTTP refusals as final', () => {
    expect(transientError(new TypeError('fetch failed'))).toBe(true);
    expect(transientError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    expect(transientError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe(true);
    expect(transientError(new Error('HTTP 404 from ec.europa.eu'))).toBe(false);
  });

  it('records an outage, waits out the backoff without calling, then retries and keeps the answer', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-trend-'));
    let clock = 1_000_000_000_000;
    let down = true;
    let calls = 0;
    const fetchJson = async (url: string) => {
      calls++;
      if (down) throw new TypeError('fetch failed');
      return url.includes('prc_hpi') ? json([5, 6, 7, 8, 9]) : json([1, 2, 3, 4, 2]);
    };
    const assessor = new (SiteAssessor as unknown as new (o: object) => Assessor)({ file: path.join(dir, 'sites.json'), fetchJson, now: () => clock, sleep: async () => {} });
    expect(await assessor.priceTrend('PT')).toBeNull();
    const failed = assessor.store.hpi.PT;
    expect(failed).toMatchObject({ failures: 1, value: null });
    expect(failed.retryAt).toBeGreaterThanOrEqual(clock);
    expect(assessor.trendGaps(['PT']).missing).toContain('PT');
    calls = 0;
    down = false;
    if (failed.retryAt! > clock) {
      expect(await assessor.priceTrend('PT')).toBeNull();
      expect(calls).toBe(0);
      expect(assessor.trendGaps(['PT']).due).not.toContain('PT');
    }
    clock = failed.retryAt! + 1;
    expect(assessor.trendGaps(['PT']).due).toContain('PT');
    const got = await assessor.priceTrend('PT');
    expect(got).toMatchObject({ real: expect.any(Number), year: '2024' });
    expect(assessor.store.hpi.PT).toMatchObject({ value: got });
    expect(assessor.store.hpi.PT.retryAt).toBeUndefined();
    expect(assessor.trendGaps(['PT']).missing).not.toContain('PT');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps retrying through a long outage, with the wait growing but capped', async () => {
    let clock = 0;
    const assessor = new (SiteAssessor as unknown as new (o: object) => Assessor)({ fetchJson: async () => { throw new TypeError('fetch failed'); }, now: () => clock, sleep: async () => {} });
    for (let i = 0; i < 25; i++) {
      await assessor.priceTrend('ES');
      clock = (assessor.store.hpi.ES.retryAt ?? clock) + 1;
    }
    expect(assessor.store.hpi.ES.failures).toBe(25);
    expect(assessor.store.hpi.ES.retryAt! - clock).toBeLessThanOrEqual(TREND_RETRY_CAP_MS);
  });
});

describe('httpJson retries a dropped connection, not a refusal', () => {
  it('retries a network error and returns the answer', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    });
    const waits: number[] = [];
    const assessor = new SiteAssessor({ sleep: async (ms: number) => { waits.push(ms); } });
    expect(await assessor.httpJson('https://stats.example/data')).toEqual({ ok: 1 });
    expect(calls).toBe(2);
    expect(waits).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('does not retry a 404, and honours noRetry for network errors', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls++; return new Response('no', { status: 404 }); });
    const assessor = new SiteAssessor({ sleep: async () => {} });
    await expect(assessor.httpJson('https://stats.example/missing')).rejects.toThrow('HTTP 404');
    expect(calls).toBe(1);
    calls = 0;
    vi.stubGlobal('fetch', async () => { calls++; throw new TypeError('fetch failed'); });
    await expect(assessor.httpJson('https://stats.example/x', { noRetry: true })).rejects.toThrow('fetch failed');
    expect(calls).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe('shared cache merge keeps a fetched price series over a newer failure', () => {
  it('never lets a failed or empty read replace a series another worker fetched', () => {
    const assessor = new SiteAssessor({ sleep: async () => {} }) as unknown as { merge(o: object): void; store: { hpi: Record<string, unknown> } };
    assessor.store.hpi = { PT: { at: 100, value: { real: 2 } }, ES: { at: 300, value: null, failures: 2, retryAt: 900 } };
    assessor.merge({ sites: {}, places: {}, points: {}, facts: {}, hpi: { PT: { at: 500, value: null, failures: 1, retryAt: 700 }, ES: { at: 200, value: { real: 4 } } } });
    expect(assessor.store.hpi.PT).toMatchObject({ value: { real: 2 } });
    expect(assessor.store.hpi.ES).toMatchObject({ value: { real: 4 } });
    assessor.merge({ hpi: { PT: { at: 600, value: { real: 3 } } } });
    expect(assessor.store.hpi.PT).toMatchObject({ value: { real: 3 } });
  });
});
