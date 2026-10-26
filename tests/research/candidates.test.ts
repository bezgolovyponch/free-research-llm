import { describe, expect, it } from 'vitest';
import { buildBrief } from '../../src/research/brief.mjs';
import { buildCandidates, candidateDeliverables, tableVerdict, shortlistText } from '../../src/research/candidates.mjs';

const kind = { label: 'plot of land', terms: ['land', 'terreno', 'zemljiste'] };
const brief = buildBrief({ question: 'Plots near the sea, 20000EUR max', acceptance: { expected: '50 plots in EU, Vietnam and Turkey', itemCount: 50, valueRange: [0, 20000], unit: 'EUR' }, template: { itemKind: kind } });
const rates: Record<string, number> = { EUR: 1, VND: 30000, USD: 1.1 };
const convert = (v: number, from: string, to: string) => (rates[from] && rates[to] ? (v / rates[from]) * rates[to] : null);

const portal = { id: 'S1', url: 'https://imo.example/pt/resultados', locale: 'pt', text: '', listings: [
  { title: 'Terreno rústico junto à praia', url: 'https://imo.example/pt/anuncio/terreno-praia-ID1aaaa', value: 14000, unit: 'EUR', area: 2500, place: 'Aljezur' },
  { title: 'Terreno Coimbra', url: 'https://imo.example/pt/anuncio/terreno-coimbra-ID1bbbb', value: 9000, unit: 'EUR', area: 800, place: 'Coimbra' },
  { title: 'Terreno Loulé', url: 'https://imo.example/pt/anuncio/terreno-loule-ID1cccc', value: 360000, unit: 'EUR' },
  { title: 'Arrendo terreno', url: 'https://imo.example/pt/anuncio/arrendo-terreno-ID1dddd', value: 300, unit: 'EUR' },
  { title: 'Apartamento T2', url: 'https://imo.example/pt/anuncio/apartamento-ID1eeee', value: 15000, unit: 'EUR' },
  { title: 'Terreno sem preço', url: 'https://imo.example/pt/anuncio/terreno-x-ID1ffff', value: null, unit: '' },
] };
const vietnam = { id: 'S2', url: 'https://land.example.vn/land-for-sale', text: '', listings: [
  { title: 'Land in Binh Thuan', url: 'https://land.example.vn/land-for-sale-in-binh-thuan-u2000001', value: 450_000_000, unit: 'VND', area: 300 },
  { title: 'Land in Da Nang', url: 'https://land.example.vn/land-for-sale-in-da-nang-u2000002', value: 18, unit: 'VND' },
] };
const node = { id: 'D1.1', sources: [portal, vietnam], finding: { items: [
  { title: 'Terreno Coimbra', url: 'https://www.imo.example/pt/comprar/terreno-coimbra-ID1bbbb', value: null, sourceId: 'S1' },
  { title: 'Ranch in New Mexico', url: 'https://swap.example/listing/land-ranch-las-vegas-nm-1407200', value: 15000, unit: 'USD', sourceId: 'S9' },
] } };

describe('candidate table', () => {
  const table = buildCandidates([node], brief, { convert });

  it('screens every listing against the hard limits in code and counts why each one left', () => {
    expect(table).toMatchObject({ found: 9, keptCount: 3, toCheckCount: 2, screenedCount: 4 });
    expect(table.screened).toEqual({ 'price outside 0–20000 EUR': 1, 'offered for rent, not for sale': 1, 'not a plot of land': 1, 'offered as a swap, not for sale': 1, 'outside the asked regions': 1 });
  });

  it('keeps price, area, place, country, sea and the page each listing came from; sea-side first, then cheapest', () => {
    expect(table.kept.map((r: { title: string; value: number }) => [r.title, r.value])).toEqual([['Terreno rústico junto à praia', 14000], ['Terreno Coimbra', 9000], ['Land in Binh Thuan', 15000]]);
    expect(table.kept[0]).toMatchObject({ price: 14000, currency: 'EUR', area: 2500, areaUnit: 'm²', place: 'Aljezur', country: 'Portugal', countryBy: 'source page', coast: true, sourceUrl: 'https://imo.example/pt/resultados', nodeId: 'D1.1' });
    expect(table.kept[2]).toMatchObject({ price: 450_000_000, currency: 'VND', value: 15000, country: 'Vietnam', countryBy: 'site address' });
  });

  it('merges a priced copy of the same listing over an unpriced one, and sends unreadable prices to "to check"', () => {
    expect(table.kept.filter((r: { url: string }) => r.url.includes('ID1bbbb'))).toHaveLength(1);
    expect(table.toCheck.map((r: { title: string; toCheck: string }) => [r.title, r.toCheck])).toEqual([
      ['Terreno sem preço', 'price not shown'],
      ['Land in Da Nang', 'price read as 18 VND, too low to be the asking price'],
    ]);
  });

  it('keeps listings that fail only on the country for a separate outside table, never among the kept', () => {
    const b = buildBrief({ question: 'plots near the sea', acceptance: { expected: '2 plots in Portugal', itemCount: 2, valueRange: [0, 20000], unit: 'EUR' }, template: { itemKind: { label: 'plot of land', terms: ['zemljiste', 'terreno'] } } });
    const nodes = [{ id: 'D1', sources: [{ url: 'https://p.example/r', listings: [
      { title: 'Zemljiste Vir', url: 'https://famalo.hr/zemljiste-1-14501', value: 12000, unit: 'EUR' },
      { title: 'Zemljiste Pag', url: 'https://famalo.hr/zemljiste-2-14502', value: 90000, unit: 'EUR' },
      { title: 'Terreno Mira', url: 'https://imo.pt/anuncio/terreno-ID1abcd', value: 5000, unit: 'EUR' },
    ] }] }];
    const out = buildCandidates(nodes, b, {});
    expect(out.kept.map((r: { url: string }) => r.url)).toEqual(['https://imo.pt/anuncio/terreno-ID1abcd']);
    expect(out.outside.map((r: { url: string }) => r.url)).toEqual(['https://famalo.hr/zemljiste-1-14501']);
    expect(out.outsideCount).toBe(1);
    const priced = [1, 2, 3, 4, 5].map((n) => ({ title: `Terreno urbano ${n}`, url: `https://imo.pt/anuncio/terreno-urbano-ID1u${n}xy`, value: 40000 + n * 1000, unit: 'EUR', area: 400 }));
    const withMarket = buildCandidates([{ id: 'D1', sources: [{ url: 'https://p.example/r', listings: [...priced, { title: 'Terreno urbano Estoril', url: 'https://imo.pt/anuncio/terreno-urbano-estoril-ID1e1xy', value: 1000, unit: 'EUR', area: 400 }] }] }], b, {});
    expect(withMarket.priceMedians['PT|buildable']).toBe(106.25);
    expect(withMarket.kept.map((r: { url: string }) => r.url)).toEqual(['https://imo.pt/anuncio/terreno-urbano-estoril-ID1e1xy']);
  });

  it('hands the kept rows to the expected-result check and a short table to the memo', () => {
    expect(candidateDeliverables(table)[0]).toEqual({ title: 'Terreno rústico junto à praia', url: 'https://imo.example/pt/anuncio/terreno-praia-ID1aaaa', value: 14000, unit: 'EUR', nodeId: 'D1.1', harvested: true, candidate: true });
    const text = shortlistText(table, 1);
    expect(text.split('\n')).toEqual(['found 9, kept 3, to check 2, screened out 4 (price outside 0–20000 EUR 1, offered for rent, not for sale 1, not a plot of land 1, offered as a swap, not for sale 1, outside the asked regions 1)', '- Terreno rústico junto à praia | 14000 EUR | 2500 m² | Aljezur | coast stated']);
    expect(shortlistText(null)).toBe('');
    expect(tableVerdict({ tiers: { fits: 3, 'trade-off': 44, unverified: 24, blocked: 34 } }, 50)).toBe('Decision model: 3 plots of the 50 asked fit every check; 44 trade-offs with their potential; 24 to confirm; 0 weak; 34 blocked by law');
    expect(tableVerdict({ tiers: { fits: 1, 'trade-off': 1, unverified: 0, blocked: 0 } })).toBe('Decision model: 1 plot fit every check; 1 trade-off with their potential; 0 to confirm; 0 weak; 0 blocked by law');
    expect(tableVerdict({})).toBe('');
    const tiered = { ...table, kept: [{ ...table.kept[0], plan: { tier: 'fits', verdict: 'fits every criterion', why: ['sea 2.5 km'], risks: ['ask the Câmara'] } }, { ...table.kept[0], url: 'https://imo.example/far', plan: { tier: 'trade-off', verdict: 'trade-off', why: [], risks: [] } }] };
    expect(candidateDeliverables(tiered).map((d: { url: string }) => d.url)).toEqual([table.kept[0].url]);
    expect(shortlistText(tiered, 1).split('\n')[1]).toContain('| fits: fits every criterion | why: sea 2.5 km | risks: ask the Câmara');
    expect(table.kept[0]).toMatchObject({ countryCode: 'PT' });
    const measured = { ...table, sites: { assessed: 1 }, kept: [{ ...table.kept[0], site: { coastKm: 2.5, beachKm: 3, beaches: 4, viewpoints: 6, attractions: 2, reserves: 1, protectedAreas: 1, hikingRoutes: 2, lodging: 30, campsites: 2, climate: { workable: 9, comfortable: 6, hottest: 27.5, coldest: 7 } }, fit: { score: 0.71, zoning: 'agricultural', pitches: 30 } }] };
    const lines = shortlistText(measured, 1).split('\n');
    expect(lines[0]).toContain('kept 3, ranked by code-measured fit');
    expect(lines[1]).toBe('- Terreno rústico junto à praia | 14000 EUR | 2500 m² | Aljezur | coast stated | fit 0.71 | sea 2.5 km, beach 3 km | 9 workable months (6 comfortable), hottest month max 27.5°C | 16 beaches, viewpoints, sights, reserves and trails within 15 km | zoning agricultural | about 30 pitches');
  });
});
