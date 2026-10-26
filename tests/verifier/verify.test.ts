import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Verifier, compare, jsonLdOffers, namedCountries, numberOf, obligationsOf, pageAreas, pageCoords, textPrices, workableMonths } from '../../verifier/verify.mjs';

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
  return { time, temperature_2m_max: time.map(() => tmax), temperature_2m_min: time.map(() => tmin), precipitation_sum: time.map(() => 1) };
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
    expect(ob.workable.from).toMatch(/^app-defined/);
    expect(namedCountries('plots in the EU')).toEqual([]);
    expect(obligationsOf({ question: 'plots in the EU' }).regions).toHaveLength(27);
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
    expect(workableMonths(daily(24, 12), { tmaxMin: 14, tmaxMax: 31, tminMin: 5, rainMax: 200 })).toBe(12);
    expect(compare('price', 20000, [20100], 0.02).status).toBe('confirmed');
    expect(compare('price', 20000, [26000], 0.02).status).toBe('refuted');
    expect(compare('price', 20000, [], 0.02).status).toBe('unconfirmed');
  });
});

describe('external verifier: fail-closed verdicts', () => {
  const row = { url: 'https://imo.example/anuncio/terreno-1', price: 20000, currency: 'EUR', area: 1640, lat: 39.5368, lon: -9.0829, plan: { tier: 'fits' } };
  const listing = (price: number, area: number) => () => new Response(`<html><script type="application/ld+json">{"offers":{"price":"${price}","priceCurrency":"EUR"}}</script><p>${area} m²</p>"latitude": 39.5368, "longitude": -9.0829</html>`, { status: 200 });
  const world = (coastOffset: number | null, country = 'pt', tmax = 24) => ({
    'nominatim.openstreetmap.org/reverse': () => Response.json({ address: { country_code: country } }),
    'overpass-api.de': () => Response.json({ elements: coastOffset === null ? [] : [{ type: 'way', geometry: [{ lat: 39.5368 + coastOffset, lon: -9.0829 }] }] }),
    'archive-api.open-meteo.com': () => Response.json({ daily: daily(tmax, 12) }),
  });
  const verifier = (routes: Record<string, (init?: RequestInit) => Response>) => new Verifier({ fetchImpl: fakeFetch(routes) as never, sleep: async () => {}, now: () => 0 });

  it('confirms a row only when every obligation is confirmed from primary sources', async () => {
    const out = await verifier({ 'imo.example': listing(20000, 1640), ...world(0.02) }).verifyRow(row, obligationsOf(project));
    expect(out.verdict).toBe('confirmed');
    expect(out.checks.map((c: { check: string; status: string }) => `${c.check}:${c.status}`)).toEqual(['listing online:confirmed', 'price on the page:confirmed', 'price within the limit:confirmed', 'area on the page:confirmed', 'location source:confirmed', 'in the asked countries:confirmed', 'sea within 20 km:confirmed', '10+ workable months:confirmed']);
  });

  it('refutes a row whose page shows another price, another country, or no sea nearby', async () => {
    expect((await verifier({ 'imo.example': listing(26000, 1640), ...world(0.02) }).verifyRow(row, obligationsOf(project))).verdict).toBe('refuted');
    expect((await verifier({ 'imo.example': listing(20000, 1640), ...world(0.02, 'hr') }).verifyRow(row, obligationsOf(project))).verdict).toBe('refuted');
    expect((await verifier({ 'imo.example': listing(20000, 1640), ...world(null) }).verifyRow(row, obligationsOf(project))).verdict).toBe('refuted');
    expect((await verifier({ 'imo.example': listing(20000, 1640), ...world(0.02, 'pt', 36) }).verifyRow(row, obligationsOf(project))).verdict).toBe('refuted');
  });

  it('leaves a row unconfirmed, and so not accepted, when a source does not answer', async () => {
    const out = await verifier({ 'imo.example': listing(20000, 1640), 'nominatim.openstreetmap.org/reverse': () => new Response('busy', { status: 503 }), 'overpass-api.de': () => Response.json({ elements: [{ type: 'way', geometry: [{ lat: 39.55, lon: -9.08 }] }] }), 'archive-api.open-meteo.com': () => Response.json({ daily: daily(24, 12) }) }).verifyRow(row, obligationsOf(project));
    expect(out.verdict).toBe('unconfirmed');
  });

  it('refutes a listing the portal removed', async () => {
    const out = await verifier({ 'imo.example': () => new Response('gone', { status: 410 }), ...world(0.02) }).verifyRow(row, obligationsOf(project));
    expect(out.verdict).toBe('refuted');
  });

  it('checks only the rows the app calls fits and records what it saw', async () => {
    const record = await verifier({ 'imo.example': listing(20000, 1640), ...world(0.02) }).verify({ ...project, candidates: { kept: [row, { ...row, url: 'https://imo.example/anuncio/terreno-2', plan: { tier: 'trade-off' } }] } });
    expect(record.results).toHaveLength(1);
    expect(record.confirmed).toEqual([row.url]);
    expect(record.inputs).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tries the next Overpass instance when one refuses', async () => {
    const out = await verifier({ 'imo.example': listing(20000, 1640), 'nominatim.openstreetmap.org/reverse': () => Response.json({ address: { country_code: 'pt' } }), 'overpass-api.de': () => new Response('refused', { status: 503 }), 'maps.mail.ru': () => Response.json({ elements: [{ type: 'way', geometry: [{ lat: 39.55, lon: -9.08 }] }] }), 'archive-api.open-meteo.com': () => Response.json({ daily: daily(24, 12) }) }).verifyRow(row, obligationsOf(project));
    expect(out.checks.find((c: { check: string }) => c.check === 'sea within 20 km').status).toBe('confirmed');
  });

  it('remembers the instance that answered and writes its record after every plot', async () => {
    const asked: string[] = [];
    const routes = { 'imo.example': listing(20000, 1640), 'nominatim.openstreetmap.org/reverse': () => Response.json({ address: { country_code: 'pt' } }), 'overpass-api.de': () => { asked.push('main'); return new Response('busy', { status: 503 }); }, 'maps.mail.ru': () => { asked.push('mirror'); return Response.json({ elements: [{ type: 'way', geometry: [{ lat: 39.55, lon: -9.08 }] }] }); }, 'archive-api.open-meteo.com': () => Response.json({ daily: daily(24, 12) }) };
    const saved: number[] = [];
    const v = verifier(routes);
    const record = await v.verify({ ...project, candidates: { kept: [row, { ...row, url: 'https://imo.example/anuncio/terreno-2' }] } }, { onRow: async (r: { results: unknown[] }) => { saved.push(r.results.length); } });
    expect(asked).toEqual(['main', 'mirror', 'mirror']);
    expect(saved).toEqual([1, 2]);
    expect(record.complete).toBe(true);
  });
});
