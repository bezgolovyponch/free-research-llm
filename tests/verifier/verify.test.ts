import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Verifier, compare, embeddedListingPrices, listingId, jsonLdOffers, namedCountries, numberOf, obligationsOf, pageAreas, statedLimit, pageCoords, textPrices, campingIndex, campingMonths, humidexOf, climateCell } from '../../verifier/verify.mjs';

const project = {
  id: 'p1',
  question: 'Find plots to buy for glamping, 20000EUR max, 10 month a year, mild climate, nearby sea accessible by ebike',
  constraints: { location: 'Spain, Portugal, Turkey' },
  acceptance: { expected: '50 Plots In EU, Vietnam and Turkey', valueRange: [0, 20000], unit: 'EUR' },
  guidance: '"Accessible by e-bike" means the sea is within e-bike distance (about 20 km on ordinary roads)',
};

function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  return async (url: string, init?: RequestInit) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    return routes[key](init);
  };
}

const daily = (tmax: number, tmin: number) => {
  const time: string[] = [];
  for (let y = 2021; y <= 2025; y++) for (let m = 1; m <= 12; m++) time.push(`${y}-${String(m).padStart(2, '0')}-15`);
  return { time, temperature_2m_max: time.map(() => tmax), temperature_2m_min: time.map(() => tmin), temperature_2m_mean: time.map(() => (tmax + tmin) / 2), dew_point_2m_mean: time.map(() => 10), sunshine_duration: time.map(() => 10 * 3600), precipitation_sum: time.map(() => 1), wind_speed_10m_mean: time.map(() => 10) };
};

describe('external verifier: scope', () => {
  it('imports nothing from the app, so it cannot share the app\'s mistakes', () => {
    const dir = path.resolve(__dirname, '../../verifier');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
      const body = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(body).not.toMatch(/from\s+['"]\.\.\/src\//);
      expect(body).not.toMatch(/import\(['"]\.\.\/src\//);
    }
  });
});

describe('external verifier: obligations from the user\'s own words', () => {
  it('takes the price limit, the named countries, the e-bike distance and the months from the user, never from the app', () => {
    const ob = obligationsOf(project);
    expect(ob).toMatchObject({ priceMin: 0, priceMax: 20000, currency: 'EUR', seaKm: 20, seaFrom: 'guidance', minMonths: 10 });
    expect(ob.regions.sort()).toEqual(['ES', 'PT', 'TR', 'VN']);
    expect(ob.climate).toMatchObject({ campingIndexAbove: 3, from: expect.stringMatching(/^Camping Climate Index \(Ma 2021/) });
    expect(namedCountries('plots in the EU')).toEqual([]);
    expect(obligationsOf({ question: 'plots in the EU' }).regions).toHaveLength(27);
  });

  it('checks the sea only when the user asks for it and reads a budget the acceptance left out', () => {
    const czech = { question: 'Find appropriate plots eligible for glamping in Czech Republic with entrance investments 1000000 CZK - test run', acceptance: { expected: 'provide 10 plots for glamping, for around 1000000 price of the plot', valueRange: null, unit: '' }, constraints: { location: 'Czech Republic', budget: '40000' } };
    expect(obligationsOf(czech)).toMatchObject({ priceMin: 0, priceMax: 1000000, currency: 'CZK', priceFrom: 'question', seaKm: null, seaFrom: 'not asked', regions: ['CZ'] });
    expect(obligationsOf(project)).toMatchObject({ priceFrom: 'acceptance', seaFrom: 'guidance' });
    expect(statedLimit('budget 40000')).toBeNull();
    expect(statedLimit('pozemek do 1 000 000 Kč')).toEqual({ max: 1000000, currency: 'CZK' });
    expect(statedLimit('plots 20000EUR max')).toEqual({ max: 20000, currency: 'EUR' });
  });
});

describe('external verifier: its own reading of a listing page', () => {
  it('reads prices, areas and coordinates without the app\'s parsers', () => {
    expect(numberOf('20.000')).toBe(20000);
    expect(numberOf('1 640')).toBe(1640);
    expect(numberOf('12,5')).toBe(12.5);
    expect(jsonLdOffers('<script type="application/ld+json">{"offers":{"price":"20000","priceCurrency":"EUR"}}</script>')).toEqual([{ price: 20000, currency: 'EUR' }]);
    expect(textPrices('Preço 20 000 € · antes 25.000 €')).toEqual([{ price: 20000, currency: 'EUR' }, { price: 25000, currency: 'EUR' }]);
    expect(pageAreas('Área do terreno: 1 640 m² ou 2 ha')).toEqual([1640, 20000]);
    expect(pageCoords('{"latitude": 39.5368, "longitude": -9.0829}')).toEqual({ lat: 39.5368, lon: -9.0829 });
    expect(humidexOf(20, 10)).toBeCloseTo(21.3, 1);
    expect(campingIndex({ mean: 22, dew: 12, sun: 10 * 3600, max: 26, min: 14, rain: 0, wind: 8 })).toBe(8.5);
    expect(campingIndex({ mean: 22, dew: 12, sun: 10 * 3600, max: 26, min: 14, rain: 15, wind: 8 })).toBe(3);
    expect(campingIndex({ mean: 22, dew: 12, sun: null, max: 26, min: 14 })).toBeNull();
    expect(campingMonths(daily(24, 12), { campingIndexAbove: 3 })).toBe(12);
    expect(campingMonths(daily(24, 6), { campingIndexAbove: 3 })).toBe(0);
    expect(compare('price', 20000, [20100], 0.02).status).toBe('confirmed');
    expect(compare('price', 20000, [26000], 0.02).status).toBe('refuted');
    expect(compare('price', 20000, [], 0.02).status).toBe('unconfirmed');
  });
});

describe('external verifier: fail-closed verdicts', () => {
  const row = { url: 'https://imo.example/anuncio/terreno-1', price: 20000, currency: 'EUR', area: 1640, lat: 39.5368, lon: -9.0829, plan: { tier: 'fits' } };
  const listing = (price: number, area: number) => () => new Response(`<html><script type="application/ld+json">{"offers":{"price":"${price}","priceCurrency":"EUR"}}</script><p>${area} m²</p>"latitude": 39.5368, "longitude": -9.0829</html>`, { status: 200 });
  let coastKm: number | null = 2;
  const world = (coast: number | null, country = 'pt', tmax = 24) => {
    coastKm = coast;
    return {
      'nominatim.openstreetmap.org/reverse': () => Response.json({ address: { country_code: country } }),
      'archive-api.open-meteo.com': () => Response.json({ daily: daily(tmax, 12) }),
    };
  };
  const coastline = { nearestKm: (_lat: number, _lon: number, radius: number) => (coastKm !== null && coastKm <= radius ? coastKm : null) };
  const verifier = (routes: Record<string, (init?: RequestInit) => Response>) => new Verifier({ fetchImpl: fakeFetch(routes) as never, sleep: async () => {}, now: () => 0, coastline: coastline as never });

  it('confirms a row only when every obligation is confirmed from primary sources', async () => {
    const out = await verifier({ 'imo.example': listing(20000, 1640), ...world(2) }).verifyRow(row, obligationsOf(project));
    expect(out.verdict).toBe('confirmed');
    expect(out.checks.map((c: { check: string; status: string }) => `${c.check}:${c.status}`)).toEqual(['listing online:confirmed', 'price on the page:confirmed', 'price within the limit:confirmed', 'area on the page:confirmed', 'location source:confirmed', 'in the asked countries:confirmed', 'sea within 20 km:confirmed', '10+ camping months:confirmed']);
  });

  it('refutes a row whose page shows another price, another country, or no sea nearby', async () => {
    expect((await verifier({ 'imo.example': listing(26000, 1640), ...world(2) }).verifyRow(row, obligationsOf(project))).verdict).toBe('refuted');
    expect((await verifier({ 'imo.example': listing(20000, 1640), ...world(2, 'hr') }).verifyRow(row, obligationsOf(project))).verdict).toBe('refuted');
    expect((await verifier({ 'imo.example': listing(20000, 1640), ...world(null) }).verifyRow(row, obligationsOf(project))).verdict).toBe('refuted');
    expect((await verifier({ 'imo.example': listing(20000, 1640), ...world(2, 'pt', 36) }).verifyRow(row, obligationsOf(project))).verdict).toBe('refuted');
  });

  it('compares a limit in its own currency and skips the sea for an inland question', async () => {
    const czech = { question: 'plots eligible for glamping in Czech Republic with entrance investments 1000000 CZK', acceptance: { valueRange: null } };
    const czRow = { url: 'https://www.bezrealitky.cz/nemovitosti-byty-domy/1052623-nabidka-prodej-pozemku-morkuvky', price: 48307, currency: 'CZK', area: 852, lat: 49.84, lon: 16.95, plan: { tier: 'fits' } };
    const page = (price: number) => () => new Response(`<html><script type="application/ld+json">{"offers":{"price":"${price}","priceCurrency":"CZK"}}</script><p>852 m²</p>"latitude": 49.84, "longitude": 16.95</html>`, { status: 200 });
    const ecb = { 'ecb.europa.eu': () => new Response("<Cube currency='CZK' rate='25.0'/>", { status: 200 }) };
    const cheap = await verifier({ 'bezrealitky.cz': page(48307), ...world(null, 'cz'), ...ecb }).verifyRow(czRow, obligationsOf(czech));
    expect(cheap.verdict).toBe('confirmed');
    expect(cheap.checks.some((c: { check: string }) => c.check.startsWith('sea'))).toBe(false);
    const dear = await verifier({ 'bezrealitky.cz': page(1500000), ...world(null, 'cz'), ...ecb }).verifyRow({ ...czRow, price: 1500000 }, obligationsOf(czech));
    expect(dear.checks.find((c: { check: string }) => c.check === 'price within the limit')?.status).toBe('refuted');
  });

  it('leaves a row unconfirmed, and so not accepted, when a source does not answer', async () => {
    coastKm = 2;
    const out = await verifier({ 'imo.example': listing(20000, 1640), 'nominatim.openstreetmap.org/reverse': () => new Response('busy', { status: 503 }), 'archive-api.open-meteo.com': () => Response.json({ daily: daily(24, 12) }) }).verifyRow(row, obligationsOf(project));
    expect(out.verdict).toBe('unconfirmed');
  });

  it('asks a source again after a dropped connection or a busy answer, and gives up after three tries', async () => {
    let calls = 0;
    const flaky = new Verifier({ fetchImpl: (async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      if (calls === 2) return new Response('busy', { status: 429 });
      return Response.json({ ok: 1 });
    }) as never, sleep: async () => {} });
    expect(await flaky.json('https://archive-api.open-meteo.com/v1/archive')).toEqual({ ok: 1 });
    expect(calls).toBe(3);
    let down = 0;
    const dead = new Verifier({ fetchImpl: (async () => {
      down++;
      throw new TypeError('fetch failed');
    }) as never, sleep: async () => {} });
    await expect(dead.json('https://archive-api.open-meteo.com/v1/archive')).rejects.toThrow('fetch failed');
    expect(down).toBe(3);
  });

  it('waits as long as a rate-limited source asks, or 30 s when it does not say', async () => {
    const waits: number[] = [];
    let calls = 0;
    const limited = new Verifier({ fetchImpl: (async () => {
      calls++;
      if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '12' } });
      if (calls === 2) return new Response('slow down', { status: 429 });
      return Response.json({ ok: 1 });
    }) as never, sleep: async (ms: number) => { waits.push(ms); } });
    expect(await limited.json('https://nominatim.openstreetmap.org/reverse')).toEqual({ ok: 1 });
    expect(waits).toEqual([12000, 30000]);
  });

  it('does not ask again when the source refuses the request', async () => {
    let calls = 0;
    const v = new Verifier({ fetchImpl: (async () => {
      calls++;
      return new Response('bad', { status: 400 });
    }) as never, sleep: async () => {} });
    await expect(v.json('https://archive-api.open-meteo.com/v1/archive')).rejects.toThrow('HTTP 400');
    expect(calls).toBe(1);
  });

  it('refutes a listing the portal removed', async () => {
    const out = await verifier({ 'imo.example': () => new Response('gone', { status: 410 }), ...world(2) }).verifyRow(row, obligationsOf(project));
    expect(out.verdict).toBe('refuted');
  });

  it('checks fits first, then trade-offs and rows still to confirm, never weak or blocked rows, and records what it saw', async () => {
    const as = (n: number, tier: string) => ({ ...row, url: `https://imo.example/anuncio/terreno-${n}`, plan: { tier } });
    const record = await verifier({ 'imo.example': listing(20000, 1640), ...world(2) }).verify({ ...project, candidates: { kept: [as(2, 'unverified'), as(3, 'weak'), as(4, 'trade-off'), row, as(5, 'blocked')] } });
    expect(record.results.map((r: { url: string }) => r.url)).toEqual([row.url, as(4, '').url, as(2, '').url]);
    expect(record.confirmed).toEqual([row.url, as(4, '').url, as(2, '').url]);
    expect(record.inputs).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves a plot within the coastline data\'s precision of the limit unconfirmed', async () => {
    const out = await verifier({ 'imo.example': listing(20000, 1640), ...world(19.2) }).verifyRow(row, obligationsOf(project));
    expect(out.checks.find((c: { check: string }) => c.check === 'sea within 20 km')).toMatchObject({ status: 'unconfirmed', detail: '19.2 km (Natural Earth 1:10m coastline; within its 2 km precision of the limit)' });
  });

  it('writes its record after every plot', async () => {
    const saved: number[] = [];
    const record = await verifier({ 'imo.example': listing(20000, 1640), ...world(2) }).verify({ ...project, candidates: { kept: [row, { ...row, url: 'https://imo.example/anuncio/terreno-2' }] } }, { onRow: async (r: { results: unknown[] }) => { saved.push(r.results.length); } });
    expect(saved).toEqual([1, 2]);
    expect(record.complete).toBe(true);
  });

});

describe('external verifier: research claims', () => {
  it('checks each claim against the page it cites, fetching a repeated source only once', async () => {
    const urls: string[] = [];
    const verifier = new Verifier({ fetchImpl: (async (url: string) => {
      urls.push(url);
      return new Response('<html><p>Fees: The building permit costs €950 for small sites.</p></html>', { status: 200 });
    }) as never, sleep: async () => {}, now: () => 0 });
    const project = {
      nodes: [{
        id: 'n1',
        method: 'desk research',
        sources: [{ id: 'S1', url: 'https://www.mzcr.cz/x', title: 'Ministry' }],
        finding: { claims: [
          { text: 'A building permit costs €950', quote: 'The building permit costs €950 for small sites', sourceIds: ['S1'] },
          { text: 'A building permit costs €950 again', quote: 'The building permit costs €950 for small sites', sourceIds: ['S1'] },
        ] },
      }],
    };
    expect(await verifier.verifyClaims(project)).toEqual([
      { nodeId: 'n1', text: 'A building permit costs €950', status: 'confirmed', detail: 'quote, numbers and key terms found' },
      { nodeId: 'n1', text: 'A building permit costs €950 again', status: 'confirmed', detail: 'quote, numbers and key terms found' },
    ]);
    expect(urls).toEqual(['https://www.mzcr.cz/x']);
  });
});

describe('external verifier: each map point is looked up in OpenStreetMap once and stored for later runs', () => {
  it('reuses a stored country for points within about 100 m and never stores an empty answer', async () => {
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frl-verifier-'));
    const urls: string[] = [];
    let answer = 'cz';
    const fetchImpl = async (url: string) => { urls.push(url); return Response.json({ address: answer ? { country_code: answer } : {} }); };
    const first = new Verifier({ fetchImpl: fetchImpl as never, sleep: async () => {}, now: () => 0, cacheDir: dir });
    expect(await first.country({ lat: 49.19501, lon: 16.60801 })).toBe('CZ');
    expect(await first.country({ lat: 49.19504, lon: 16.60799 })).toBe('CZ');
    expect(urls).toHaveLength(1);
    const second = new Verifier({ fetchImpl: fetchImpl as never, sleep: async () => {}, now: () => 0, cacheDir: dir });
    expect(await second.country({ lat: 49.195, lon: 16.608 })).toBe('CZ');
    expect(urls).toHaveLength(1);
    answer = '';
    expect(await second.country({ lat: 50.1, lon: 14.4 })).toBe('');
    answer = 'cz';
    expect(await second.country({ lat: 50.1, lon: 14.4 })).toBe('CZ');
    expect(urls).toHaveLength(3);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('external verifier: one recent year of daily weather per 0.25 degree cell, fetched once by the verifier itself', () => {
  it('snaps nearby plots to one cell and stores its 2025 weather for later runs', async () => {
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    expect(climateCell({ lat: 40.18764, lon: -8.68305 })).toEqual({ lat: 40.125, lon: -8.625 });
    expect(climateCell({ lat: 40.2, lon: -8.6 })).toEqual({ lat: 40.125, lon: -8.625 });
    expect(climateCell({ lat: 40.5, lon: -8.6 })).toEqual({ lat: 40.625, lon: -8.625 });
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frl-verifier-'));
    const urls: string[] = [];
    const fetchImpl = async (url: string) => { urls.push(url); return Response.json({ daily: daily(24, 12) }); };
    const first = new Verifier({ fetchImpl: fetchImpl as never, sleep: async () => {}, now: () => 0, cacheDir: dir });
    expect(await first.months({ lat: 40.18764, lon: -8.68305 }, { campingIndexAbove: 3 })).toBe(12);
    expect(await first.months({ lat: 40.2, lon: -8.6 }, { campingIndexAbove: 3 })).toBe(12);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('latitude=40.125&longitude=-8.625&start_date=2025-01-01&end_date=2025-12-31');
    const second = new Verifier({ fetchImpl: fetchImpl as never, sleep: async () => {}, now: () => 0, cacheDir: dir });
    expect(await second.months({ lat: 40.19, lon: -8.65 }, { campingIndexAbove: 3 })).toBe(12);
    expect(urls).toHaveLength(1);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});


describe('external verifier: the listing price a portal keeps in its own page data', () => {
  const page = (data: unknown) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script><p>Podobné inzeráty 8 000 Kč</p></html>`;
  const data = { props: { pageProps: { dehydratedState: { queries: [
    { queryKey: ['estate', { id: 2532332364 }], state: { data: { name: 'Prodej zahrady 1463 m²', price: 79900, priceSummaryCzk: 79900, priceCzkPerSqM: 55 } } },
    { queryKey: ['similar', { id: 2532332364 }], state: { data: { results: [{ hashId: 111111111, priceCzk: 1490000 }, { hashId: 222222222, priceCzk: 2100000 }] } } },
  ] } } } };
  const url = 'https://www.sreality.cz/detail/prodej/pozemek/zahrada/temice-temice-/2532332364';

  it('takes the listing id from the last long number in the address', () => {
    expect(listingId(url)).toBe('2532332364');
    expect(listingId('https://reality.bazos.cz/inzerat/225641637/korycany-507-m2-pozemek-evc-e3378v014.php')).toBe('225641637');
    expect(listingId('https://example.com/land/plot-12')).toBeNull();
  });

  it('reads only the price stored next to this listing id, never the prices of similar listings on the page', () => {
    expect(embeddedListingPrices(page(data), url)).toEqual([{ price: 79900, currency: 'CZK' }]);
    expect(embeddedListingPrices(page(data), 'https://www.sreality.cz/detail/prodej/pozemek/zahrada/x/999999999')).toEqual([]);
    expect(embeddedListingPrices('<html>no data</html>', url)).toEqual([]);
  });

  it('reads Czech crowns and Polish zloty written on the page', () => {
    expect(textPrices('Cena: 160 735 Kč')).toEqual([{ price: 160735, currency: 'CZK' }]);
    expect(textPrices('por 12.000 € · 983 m² · 12 €/m² · €5/m2')).toEqual([{ price: 12000, currency: 'EUR' }]);
    expect(textPrices('1 200 000 zł')).toEqual([{ price: 1200000, currency: 'PLN' }]);
    expect(textPrices('CZK 5 000')).toEqual([{ price: 5000, currency: 'CZK' }]);
  });
});
