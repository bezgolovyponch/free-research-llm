import { describe, expect, it } from 'vitest';
import { checkRows, claimRows, exampleRows, plotRows, resultsSheets, resultsWorkbook, screenedRows, sourceRows, strategyRows, summaryRows, titleAreaM2 } from '../src/workbook.mjs';
import { unzip } from './helpers/unzip';

const site = { coastKm: 2.6, beachKm: 2.7, lakeKm: 6.2, lakesNamed: true, beaches: 10, viewpoints: 12, attractions: 8, reserves: 2, protectedAreas: 4, hikingRoutes: 6, campsites: 16, lodging: 126, climate: { workable: 12, comfortable: 7, hottest: 24, coldest: 8 } };
const checks = [{ id: 'sea', label: 'sea within 20 km by e-bike', ok: true, detail: 'sea 2.6 km' }, { id: 'noAc', label: 'no air conditioning needed', ok: null, detail: 'climate not measured yet' }];
const row = (more: object) => ({ title: 'Terreno rústico com 1.516,54 m² em Mira', url: 'https://imo.example/anuncio/ID1', price: 1700, currency: 'EUR', value: 1700, unit: 'EUR', area: 1100, areaUnit: 'm²', place: 'Mira', country: 'Portugal', countryCode: 'PT', sourceUrl: 'https://imo.example/r', via: ['embedded-json', 'cards'], site, fit: { zoning: 'agricultural' }, lat: 40.4, lon: -8.7, plan: { tier: 'fits', verdict: 'fits every criterion', checks, why: ['sea 2.6 km'], tradeoffs: [], risks: ['ask the Câmara'], units: 16, areaM2: 1100, share: 0.86, entry: { total: 4409 }, path: 'Rural camping park' }, ...more });
const project = {
  id: 'p1',
  question: 'Find plots for glamping',
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
});
