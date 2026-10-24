import { describe, expect, it } from 'vitest';
import { AcceptanceChecker, MAX_ITEM_CHECKS, PAGE_CHECK_TTL_MS, PAGE_READS_AT_ONCE, collectDeliverables, hasCriteria, headlinePrice, inRange, looksLikeListing, normalizeAcceptance, parseAmounts, toAmount } from '../../src/research/acceptance.mjs';

describe('acceptance', () => {
  it('parses European and English price formats with currencies', () => {
    expect(parseAmounts('Preis 2.500 € VB, 3 999,- €, € 1,234.50, 8 000 PLN, 59 900 Kč')).toEqual([
      { value: 2500, currency: 'EUR', perUnit: false }, { value: 3999, currency: 'EUR', perUnit: false }, { value: 1234.5, currency: 'EUR', perUnit: false }, { value: 8000, currency: 'PLN', perUnit: false }, { value: 59900, currency: 'CZK', perUnit: false },
    ]);
    expect(toAmount('12.345,67')).toBe(12345.67);
  });

  it('normalizes a spec and knows when there is nothing to check', () => {
    const spec = normalizeAcceptance({ itemCount: '10', urlsLive: 1, valueRange: [4000, 2000], unit: 'EUR', mustMention: ['car'] }, '10 links');
    expect(spec).toEqual({ expected: '10 links', itemCount: 10, urlsLive: true, valueRange: [2000, 4000], unit: 'EUR', mustMention: ['car'] });
    expect(hasCriteria(normalizeAcceptance({}, 'memo'))).toBe(false);
  });

  it('collects items only from gated nodes, deduplicated by URL', () => {
    const nodes = [
      { id: 'A', status: 'verified', finding: { items: [{ url: 'https://m.example/1' }, { url: 'https://m.example/1' }] } },
      { id: 'B', status: 'weak', finding: { items: [{ url: 'https://m.example/2' }] } },
    ];
    expect(collectDeliverables(nodes)).toEqual([{ url: 'https://m.example/1', nodeId: 'A' }]);
  });

  it('checks count, live deep links and price range with currency conversion', async () => {
    const pages: Record<string, { text: string; status: number }> = {
      'https://m.example/car/1234567': { text: `${'Used car Golf '.repeat(20)} 9 000 zł`, status: 200 },
      'https://m.example/car/2234567': { text: `${'Used car Astra '.repeat(20)} 9 500 €`, status: 200 },
      'https://m.example/': { text: 'home '.repeat(100), status: 200 },
    };
    const checker = new AcceptanceChecker({ readPage: async (url: string) => pages[url] ?? { text: '', status: 404 }, convert: (v: number, from: string) => (from === 'PLN' ? v / 4 : v) });
    const spec = normalizeAcceptance({ itemCount: 4, urlsLive: true, valueRange: [2000, 4000], unit: 'EUR', mustMention: ['used'] });
    const result = await checker.evaluate(spec, [{ url: 'https://m.example/car/1234567' }, { url: 'https://m.example/car/2234567' }, { url: 'https://m.example/' }]);
    const value = Object.fromEntries(result.checks.map((c: { id: string; value: number }) => [c.id, c.value]));
    expect(value).toEqual({ count: 0.25, live: 0.5, range: 0.25, mentions: 0.5 });
    expect(result.items.map((i: { live: boolean; inRange: boolean }) => [i.live, i.inRange])).toEqual([[true, true], [true, false], [false, false]]);
    expect(result.score).toBe(0.375);
  });
});

describe('valid items only', () => {
  it('tells single listing pages from search, category and news pages (cases from the glamping research)', async () => {
    const { looksLikeListing } = await import('../../src/research/acceptance.mjs');
    for (const url of ['https://www.imovirtual.com/pt/anuncio/terreno-urbano-coimbra-20-000-ID1iZBr', 'https://properties.lefigaro.com/announces/other-real+estate-andalusia-spain/109197729/', 'https://www.olx.pt/d/anuncio/cede-se-jazigo-4-6-lugares-IDJEXGe.html', 'https://www.sahibinden.com/ilan/emlak-arsa-satilik-1234567890/detay', 'http://www.bestrealestateplanet.com/go/en/viewProperty--PropertyID--1672--location--Turkey--type--LotsLand--page.html', 'https://famalo.com/hr/hr/nekretnina/poljoprivredno-zemljiste-udaljeno-70-metara-od-mora-14405', 'https://site.example/property?id=A77231']) expect(looksLikeListing(url), url).toBe(true);
    for (const url of ['https://www.sahibinden.com/satilik-arsa', 'https://www.idealista.com/news/inmobiliario/blog-de-idealista', 'https://www.properstar.com/europe/buy/land-plot/sea-view', 'https://www.mondinion.com/Land_for_Development/country/Turkey/', 'https://homestra.com/list/houses-for-sale/?property-type=lot&maximum-price=50000', 'https://www.idealista.pt/geo/comprar-terrenos/praia-torres-vedras/com-tamanho-max_10000/?ordem=precos-asc', 'https://www.olx.pt/imoveis/terrenos-quintas/faro/q-2000-euros/', 'https://www.kyero.com/pt/norte-portugal-terrenos-para-vender-0l57087g5?max_price=100000', 'https://www.holprop.com/s/sale/pt62372644/?ctype=EUR', 'not a url']) expect(looksLikeListing(url), url).toBe(false);
  });

  it('counts toward "at least N items" only items that open, are single listings and are priced in range', async () => {
    const { AcceptanceChecker } = await import('../../src/research/acceptance.mjs');
    const pages: Record<string, string> = {
      'https://a.example/anuncio/plot-ID1iZBr': 'Rustic land for sale 18 000 EUR near the coast '.repeat(20),
      'https://a.example/anuncio/plot-ID9xYzQ': 'Seaside plot 400 000 EUR '.repeat(30),
      'https://a.example/search/land': 'Many plots 15 000 EUR '.repeat(30),
    };
    const checker = new AcceptanceChecker({ readPage: async (url: string) => ({ status: pages[url] ? 200 : 404, text: pages[url] ?? '' }) });
    const result = await checker.evaluate({ itemCount: 4, urlsLive: false, valueRange: [0, 20000], unit: 'EUR', mustMention: [] }, Object.keys(pages).map((url, i) => ({ url, value: [18000, 400000, 15000][i], unit: 'EUR' })));
    const count = result.checks.find((c: { id: string }) => c.id === 'count');
    expect(count).toMatchObject({ label: 'At least 4 valid items', value: 0.25 });
    expect(count.detail).toMatch(/^1 of 3 delivered pass every check/);
  });
});

describe('listing price on the page', () => {
  it('judges the headline price, not a price per m² or a monthly rent further down', () => {
    const spec = { valueRange: [0, 20000], unit: 'EUR' } as never;
    expect(headlinePrice(parseAmounts('Terreno em Faro\n 165 000 € 42,61 €/m² 8005-401'))).toEqual({ value: 165000, currency: 'EUR', perUnit: false });
    expect(inRange(parseAmounts('Terreno em Faro\n 165 000 € 42,61 €/m² 8005-401'), spec, null)).toBe(false);
    expect(inRange(parseAmounts('Terreno Urbano | Coimbra | 20.000 € 111,11 €/m²'), spec, null)).toBe(true);
    expect(parseAmounts('650 € / mês, 1 500 € por noite, 2 400 €/month').every((a) => a.perUnit)).toBe(true);
    expect(inRange(parseAmounts('no price shown'), spec, 15000)).toBe(true);
    expect(inRange([], spec, null)).toBe(false);
  });

  it('never treats chat, social, API or image links as listings, nor keyword searches like /q-20000/', () => {
    for (const url of ['https://wa.me/905312732069?text=hi', 'https://api.goswap.org/listing/123456', 'https://s3.vietnam-real.estate/p/x/3zg64igysq45/6ad6708821e4.jpg', 'https://www.olx.pt/imoveis/terrenos-quintas/aveiro/q-20000/', 'https://web.archive.org/web/20250101/https://x.example/ad/123456']) expect(looksLikeListing(url), url).toBe(false);
    expect(looksLikeListing('https://www.imovirtual.com/pt/anuncio/terreno-535-m-quinta-do-anjo-ID1iA1X')).toBe(true);
  });

  it('checks up to 75 items for 50 wanted, reads each page once within 6 hours, and at most 6 at a time', async () => {
    let open = 0;
    let peak = 0;
    const reads: string[] = [];
    const cache = new Map();
    const readPage = async (url: string) => { reads.push(url); open++; peak = Math.max(peak, open); await new Promise((r) => setTimeout(r, 2)); open--; return { status: 200, text: `Plot for sale ${'x'.repeat(200)} 15 000 €` }; };
    const items = Array.from({ length: 90 }, (_, i) => ({ url: `https://portal.example/ad/plot-${100000 + i}` }));
    const checker = new AcceptanceChecker({ readPage, cache });
    const result = await checker.evaluate({ itemCount: 50, valueRange: [0, 20000], unit: 'EUR', mustMention: [], urlsLive: false }, items);
    expect(MAX_ITEM_CHECKS).toBe(100);
    expect(result!.items).toHaveLength(75);
    expect(result!.checks[0]).toMatchObject({ value: 1, passed: true });
    expect(peak).toBeLessThanOrEqual(PAGE_READS_AT_ONCE);
    await new AcceptanceChecker({ readPage, cache }).evaluate({ itemCount: 50, valueRange: [0, 20000], unit: 'EUR', mustMention: [], urlsLive: false }, items);
    expect(reads).toHaveLength(75);
    expect(PAGE_CHECK_TTL_MS).toBe(6 * 3600 * 1000);
  });

  it('counts harvested listings from a weak piece, but not what a weak piece\'s model answer listed', () => {
    const nodes = [
      { id: 'D1', status: 'weak', finding: { items: [{ url: 'https://a.example/ad/1', harvested: true }, { url: 'https://a.example/ad/2' }] } },
      { id: 'D2', status: 'supported', finding: { items: [{ url: 'https://a.example/ad/3' }, { url: 'https://a.example/ad/1', harvested: true }] } },
    ];
    expect(collectDeliverables(nodes as never).map((i: { url: string; nodeId: string }) => `${i.nodeId} ${i.url}`)).toEqual(['D2 https://a.example/ad/3', 'D1 https://a.example/ad/1']);
    const mixed = [{ id: 'D1', status: 'weak', finding: { items: [{ url: 'u1', harvested: true }, { url: 'u2', harvested: true, value: 15000 }] } }, { id: 'D2', status: 'verified', finding: { items: [{ url: 'u3' }] } }];
    expect(collectDeliverables(mixed as never).map((i: { url: string }) => i.url)).toEqual(['u3', 'u2', 'u1']);
  });
});
