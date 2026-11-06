import { describe, expect, it } from 'vitest';
import { checkRows, claimRows, exampleRows, plotRows, proposalRows, resultsSheets, resultsWorkbook, screenedRows, sourceRows, strategyRows, summaryRows, titleAreaM2, withoutOwningRows } from '../src/workbook.mjs';
import { unzip } from './helpers/unzip';

const site = { coastKm: 2.6, beachKm: 2.7, lakeKm: 6.2, lakesNamed: true, beaches: 10, viewpoints: 12, attractions: 8, reserves: 2, protectedAreas: 4, hikingRoutes: 6, campsites: 16, lodging: 126, climate: { workable: 12, comfortable: 7, hottest: 24, coldest: 8 } };
const checks = [{ id: 'sea', label: 'sea within 20 km by e-bike', ok: true, detail: 'sea 2.6 km' }, { id: 'noAc', label: 'no air conditioning needed', ok: null, detail: 'climate not measured yet' }];
const row = (more: object) => ({ title: 'Terreno rústico com 1.516,54 m² em Mira', url: 'https://imo.example/anuncio/ID1', price: 1700, currency: 'EUR', value: 1700, unit: 'EUR', area: 1100, areaUnit: 'm²', place: 'Mira', country: 'Portugal', countryCode: 'PT', sourceUrl: 'https://imo.example/r', via: ['embedded-json', 'cards'], site, fit: { zoning: 'agricultural' }, lat: 40.4, lon: -8.7, plan: { tier: 'fits', verdict: 'fits every criterion', checks, why: ['sea 2.6 km'], tradeoffs: [], risks: ['ask the Câmara'], units: 16, areaM2: 1100, share: 0.86, entry: { total: 4409 }, path: 'Rural camping park' }, ...more });
const project = {
  id: 'p1',
  question: 'Find plots for glamping',
  brief: { asksSea: true },
  acceptance: { expected: '50 plots', unit: 'EUR' },
  acceptanceResult: { score: 0.32, checks: [{ label: 'At least 50 valid items', value: 0.32 }], items: [{ title: 'Model pick', url: 'https://other.example/1', value: 5000, currency: 'EUR', nodeId: 'D1' }] },
  report: { verdict: 'GO-IF' },
  nodes: [{ id: 'Q', parentId: null, title: 'Q', question: 'q', status: 'verified', sources: [] }, { id: 'D1', parentId: 'Q', title: 'Prices', question: 'q', status: 'verified', finding: { answer: 'a' }, sources: [{ id: 'S1', title: 'Portal', url: 'https://imo.example/r', domain: 'imo.example' }] }],
  sweep: { pages: [{ id: 'P1', title: 'imo listings', url: 'https://imo.example/r?page=2', domain: 'imo.example' }] },
  candidates: {
    found: 3,
    kept: [row({ verified: { verdict: 'confirmed', failed: [] } }), row({ url: 'https://imo.example/anuncio/ID2', title: 'Terreno 500 m²', area: 500, plan: { ...row({}).plan, areaM2: 500 }, verified: { verdict: 'unconfirmed', failed: ['sea distance: unconfirmed (2 km band)'] } }), row({ url: 'https://imo.example/anuncio/ID3', title: 'Terreno longe', site: { ...site, coastKm: null }, plan: { ...row({}).plan, tier: 'weak', share: 0.43 } })],
    toCheck: [{ title: 'No price', url: 'https://imo.example/b', toCheck: 'price not shown' }],
    outside: [],
    screened: { 'not a plot of land': 547, 'price outside 0–20000 EUR': 1530 },
    screenedCount: 2077,
    examples: [{ title: 'Moradia', url: 'https://imo.example/m', reasons: ['not a plot of land'] }],
    tiers: { fits: 2, 'trade-off': 0, unverified: 0, weak: 1, blocked: 0 },
    verification: { at: '2026-10-27T00:45:58.331Z', fits: 2, confirmed: 1, refuted: 0, unconfirmed: 1, pending: 0 },
    strategy: { label: 'Low-entry glamping', rules: { maxHottest: { value: 31, source: 'assumption' }, tent: { value: 729, currency: 'GBP', source: 'tent' } }, sources: [{ id: 'pt-rural', title: 'AC Arquitetos', url: 'https://www.ac-arquitetos.com/post/x', quotes: 4, confirmed: 4, status: 200 }] },
  },
};

describe('results workbook: every table, exact links, typed numbers', () => {
  it('reads the area a listing title states', () => {
    expect(titleAreaM2('Terreno rústico com 1.516,54 m² em Leitões')).toBe(1517);
    expect(titleAreaM2('2 ha of land')).toBe(20000);
    expect(titleAreaM2('Tarla 3 dönüm')).toBe(3000);
    expect(titleAreaM2('Terreno com contentor')).toBeNull();
  });

  it('counts a listing only when it fits every check and the external verifier confirmed it', () => {
    const [header, ...rows] = plotRows(project);
    const col = (name: string) => header.indexOf(name);
    expect(rows.map((r: unknown[]) => r[col('counted in the result')])).toEqual(['yes', 'no', 'no', 'no']);
    expect(rows.map((r: unknown[]) => r[col('list')])).toEqual(['your countries', 'your countries', 'your countries', 'to check (price or country not shown)']);
    expect(rows[1][col('external check notes')]).toBe('sea distance: unconfirmed (2 km band)');
    expect(rows[0][col('url')]).toBe('https://imo.example/anuncio/ID1');
  });

  it('does not count a confirmed listing whose tier dropped below fits', () => {
    const stale = { ...project, candidates: { ...project.candidates, kept: [row({ plan: { ...row({}).plan, tier: 'trade-off' }, verified: { verdict: 'confirmed', failed: [] } })] } };
    const [header, ...rows] = plotRows(stale);
    expect(rows[0][header.indexOf('counted in the result')]).toBe('no');
  });

  it('flags an area that disagrees with the listing title and keeps numbers as numbers', () => {
    const [header, ...rows] = plotRows(project);
    const col = (name: string) => header.indexOf(name);
    expect(rows[0][col('area in title m²')]).toBe(1517);
    expect(rows[0][col('area matches title')]).toBe('NO: check the listing');
    expect(rows[1][col('area matches title')]).toBe('yes');
    expect(rows[0][col('price')]).toBe(1700);
    expect(rows[0][col('longitude')]).toBe(-8.7);
    expect(rows[2][col('sea km')]).toBe('>25');
  });

  it('drops the sea columns when the research does not ask for the sea', () => {
    const inland = { ...project, brief: { asksSea: false } };
    const [header, ...rows] = plotRows(inland);
    const col = (name: string) => header.indexOf(name);
    expect(header).not.toContain('sea km');
    expect(header).not.toContain('beach km');
    expect(header).toContain('named lake km');
    expect(rows[0].length).toBe(header.length);
    expect(rows[0][col('named lake km')]).toBe(6.2);
  });

  it('shows lodging and campsites apart, and one column per decision-model check', () => {
    const [header, ...rows] = plotRows(project);
    const col = (name: string) => header.indexOf(name);
    expect([rows[0][col('lodging within 15 km')], rows[0][col('campsites within 15 km')]]).toEqual([126, 16]);
    expect(rows[0][col('sea within 20 km by e-bike')]).toBe('yes');
    expect(rows[0][col('no air conditioning needed')]).toBe('not measured');
    expect(rows[0][col('checks met %')]).toBe(86);
  });

  it('lists every check measured, every screening reason, every source link and the strategy sources', () => {
    expect(checkRows(project)).toHaveLength(1 + 3 * 2);
    expect(screenedRows(project)[1]).toEqual(['price outside 0–20000 EUR', 1530]);
    expect(exampleRows(project)[1]).toEqual(['Moradia', 'https://imo.example/m', 'not a plot of land']);
    expect(sourceRows(project).slice(1).map((r: unknown[]) => r[4])).toEqual(['https://imo.example/r', 'https://imo.example/r?page=2']);
    expect(strategyRows(project)[1]).toEqual(['pt-rural', 'AC Arquitetos', 'https://www.ac-arquitetos.com/post/x', 4, 4, 200]);
  });

  it('summarises the verdict, the expected result, external sign-off and every rule with its source', () => {
    const summary = Object.fromEntries(summaryRows(project, new Date(Date.UTC(2026, 9, 27, 8))));
    expect(summary).toMatchObject({ 'exported at (UTC)': '2026-10-27T08:00:00.000Z', 'expected result score': 0.32, 'confirmed by the external verifier': 1, 'unconfirmed by the external verifier': 1, '  rule maxHottest': '31 (source: assumption)', '  rule tent': '729 GBP (source: tent)' });
  });

  it('packs all tables into one workbook, leaving out listing sheets for a memo research', () => {
    expect(resultsSheets(project).map((s: { name: string }) => s.name)).toEqual(['Summary', 'Listings', 'Decision checks', 'Screened out', 'Screened examples', 'Pieces', 'Sources', 'Strategy sources', 'Delivered items']);
    const checked = { ...project, report: { ...project.report, claimCheck: { checked: 2, supported: 1, contradicted: [{}], unverifiable: [], claims: [{ where: 'key numbers', text: 'Verified Plots Found: 16 plots', value: 16, kind: 'count', status: 'contradicted' }, { where: 'summary', text: '€1,700', value: 1700, kind: 'eur', status: 'supported' }] } } };
    expect(resultsSheets(checked).map((s: { name: string }) => s.name)).toContain('Memo claims');
    expect(claimRows(checked)[1]).toEqual(['key numbers', 'Verified Plots Found: 16 plots', 16, 'count', 'contradicted']);
    expect(Object.fromEntries(summaryRows(checked))['memo numbers matching the verified record']).toBe('1 of 2 (1 contradicted, 0 not checkable)');
    expect(resultsSheets({ ...project, candidates: null }).map((s: { name: string }) => s.name)).toEqual(['Summary', 'Pieces', 'Sources', 'Delivered items']);
    const files = unzip(resultsWorkbook(project, new Date(Date.UTC(2026, 9, 27))));
    expect(files['xl/worksheets/_rels/sheet2.xml.rels']).toContain('https://imo.example/anuncio/ID1');
    expect(files['xl/workbook.xml']).toContain('<sheet name="Delivered items" sheetId="9" r:id="rId9"/>');
  });

  it('adds a Proposals sheet with the primary and secondary results, why each is proposed and how sure it is', async () => {
    const { withProposals } = await import('../src/research/proposal.mjs');
    const proposed = { ...project, candidates: withProposals(project.candidates) };
    expect(resultsSheets(proposed).map((s: { name: string }) => s.name).slice(0, 3)).toEqual(['Summary', 'Proposals', 'Listings']);
    const rows = proposalRows(proposed);
    expect(rows[0]).toEqual(['opportunity', 'why this opportunity', 'rank', 'Pareto layer', 'title', 'url', 'country', 'entry cost EUR', 'why it is proposed', 'where it stands out', 'evidence (measured)', 'misses', 'to confirm', 'risks', 'confidence']);
    expect(rows[1].slice(0, 6)).toEqual(['Fits every criterion', expect.stringContaining('every criterion you set'), 1, 1, 'Terreno rústico com 1.516,54 m² em Mira', 'https://imo.example/anuncio/ID1']);
    expect(rows[1][8]).toBe('Fits all 2 criteria you set, confirmed outside the app');
    expect(rows[1][12]).toBe('no air conditioning needed: climate not measured yet');
    expect(rows.map((r: unknown[]) => r[4])).not.toContain('https://imo.example/anuncio/ID3');
  });
});

describe('Without ownership sheet', () => {
  it('lists the plots a foreign buyer cannot own with their first-season numbers, never as counted', () => {
    const w = { group: 'Value without ownership (lease or partnership)', path: 'operate without owning', units: 3, months: 12, setupEur: 5265, revenueEur: 39000, paybackMonths: 2, landShareMax: 0.87, paysBackInYear: true, missing: [], inputs: ['rate', 'occupancy'], risks: ['licence'] };
    const project = { candidates: { kept: [{ url: 'https://vn.example/1', title: 'Đất Phú Quốc', place: 'Phú Quốc', plan: { tier: 'blocked', withoutOwning: w } }, { url: 'https://pt.example/2', title: 'PT', plan: { tier: 'fits' } }], withoutOwning: { label: w.group, urls: ['https://vn.example/1'], paysBack: 1 } } };
    const [header, ...rows] = withoutOwningRows(project);
    expect(header.slice(0, 4)).toEqual(['group', 'counted in the result', 'title', 'url']);
    expect(rows).toHaveLength(1);
    expect(rows[0].slice(0, 12)).toEqual([w.group, 'no', 'Đất Phú Quốc', 'https://vn.example/1', 'Phú Quốc', 3, 12, 5265, 39000, 2, 0.87, 'yes']);
    expect(resultsSheets({ ...project, question: 'q', nodes: [], log: [] } as never).map((s: { name: string }) => s.name)).toContain('Without ownership');
  });
});

describe('listing columns follow the data', () => {
  it('drops empty plot columns for a car table and adds the facts each listing states', async () => {
    const { plotRows } = await import('../src/workbook.mjs');
    const car = (title: string, value: number, fuel?: string) => ({ title, url: `https://auto.bazos.cz/inzerat/${value}/x.php`, price: value, currency: 'CZK', value, unit: 'CZK', year: 2008, km: 139000, kw: 50, valueIndex: 0.82, peers: 7, ...(fuel ? { attrs: { 'vehicle.fuel': fuel, 'vehicle.mileage': '139 000 km', 'vehicle.mileage#n': 139000 } } : {}) });
    const project = { acceptance: { unit: 'CZK' }, candidates: { kept: [car('Škoda Fabia 1.4 MPI 50kw', 39000, 'Diesel'), car('Kia Rio 1.4', 29500, 'Benzin'), car('Honda Jazz 1,3', 49000, 'Benzin'), car('Ford Fiesta', 26000)], toCheck: [], outside: [] } };
    const [header] = plotRows(project);
    expect(header).not.toContain('sea km');
    expect(header).not.toContain('glamping units');
    expect(header).not.toContain('entry cost EUR');
    expect(header).toEqual(expect.arrayContaining(['title', 'url', 'price in CZK', 'year', 'mileage km', 'power kW', 'value vs peers', 'fact: vehicle.fuel', 'fact: vehicle.mileage']));
    expect(header).not.toContain('fact: vehicle.mileage#n');
  });
});

describe('valuation columns in the export', () => {
  it('exports market value, underpricing, confidence, engine and the value notes with sources', async () => {
    const { plotRows } = await import('../src/workbook.mjs');
    const row = { title: 'Dacia Sandero 1.4 MPI 2009 165000 km', url: 'https://auto.bazos.cz/inzerat/1/x.php', price: 25000, currency: 'CZK', value: 25000, unit: 'CZK', year: 2009, km: 165000, engine: '1.4 mpi', fuel: 'petrol', marketValue: 45272, underpriced: 1.81, valueConfidence: 'medium', highlight: 'underpriced: worth about 45,272 CZK', valueNotes: ['market value from 7 comparable dacia sandero listings', 'reliable (1.4): simple engine — "quote" (https://forum.example/sandero)'] };
    const [header, first] = plotRows({ acceptance: { unit: 'CZK' }, candidates: { kept: [row], toCheck: [], outside: [] } });
    const at = (name: string) => first[header.indexOf(name)];
    expect([at('underpriced'), at('market value'), at('value confidence'), at('engine'), at('fuel')]).toEqual([1.81, 45272, 'medium', '1.4 mpi', 'petrol']);
    expect(String(at('value notes'))).toContain('https://forum.example/sandero');
  });
});
