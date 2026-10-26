import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { namesRegion, EBIKE_KM, NEW_SITES_PER_PASS, PAGE_READS_PER_PASS, SiteAssessor, fitOf, haversineKm, monthlyClimate, overpassQuery, pageCoordinates, parseSurroundings, pitchesFor, seaScore, seasonOf, siteKey, zoningOf } from '../../src/research/site.mjs';

const VIR = { lat: 44.3, lon: 15.09 };
const DA_NANG = { lat: 16.055, lon: 108.22, name: 'Thai Hoa, Hai Chau, Da Nang, Vietnam' };
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

  it('finds the nearest lake or reservoir for the potential of an inland plot', async () => {
    const { lakeQuery, parseLakes } = await import('../../src/research/site.mjs');
    expect(lakeQuery(39.5, -8.3)).toContain('[natural=water][water~"^(lake|reservoir)$"][name]');
    expect(overpassQuery(39.5, -8.3)).toContain('[natural=water]');
    expect(parseLakes({ elements: [{ type: 'way', tags: { natural: 'water', water: 'reservoir', name: 'Albufeira de Castelo do Bode' }, center: { lat: 39.51, lon: -8.3 } }, { type: 'way', tags: { natural: 'water', water: 'reservoir' }, center: { lat: 39.5001, lon: -8.3 } }] }, 39.5, -8.3)).toBe(1.1);
    expect(parseLakes({ elements: [] }, 39.5, -8.3)).toBeNull();
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
