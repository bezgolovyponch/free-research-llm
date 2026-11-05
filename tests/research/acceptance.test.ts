import { describe, expect, it } from 'vitest';
import { AcceptanceChecker, MAX_ITEM_CHECKS, PAGE_READS_AT_ONCE, collectDeliverables, currencyOf, entityDeliverables, hasCriteria, headlinePrice, inRange, itemCountFromWords, looksLikeListing, normalizeAcceptance, parseAmounts, purposeChecks, toAmount } from '../../src/research/acceptance.mjs';

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

  it('reads the item count from the words the user wrote, before any tree exists', () => {
    expect(itemCountFromWords(
      'The list of 20 highest possible price/value ratio to buy, working links, a short why per car and the total cost',
      'Find accurate and verified car listings on available marketplaces for at least 20 cars as fit and up to 80 as a trade off on price, mileage and distance',
    )).toBe(20);
    expect(itemCountFromWords(
      '10 links to real, working marketplace listings of used cars priced 2000-4000 EUR',
      'Which trendy used cars priced 2000-4000 EUR are for sale right now in Germany, Poland or Czechia?',
    )).toBe(10);
    expect(itemCountFromWords('', 'Should I open a specialty coffee kiosk in Brno?')).toBeNull();
    expect(itemCountFromWords('a car priced up to 65000CZK')).toBeNull();
    expect(itemCountFromWords('a plot within 300km of the coast')).toBeNull();
    expect(itemCountFromWords('top 5 offers', 'at least 120 results')).toBe(5);
    expect(itemCountFromWords('at least 2000 EUR per car')).toBeNull();
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
    expect(count.detail).toMatch(/^1 of 3 delivered pass every check; first 3 inspected/);
  });

  it('says how many of the delivered items it inspected when the list is longer than the check needs', async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://a.example/anuncio/plot-ID1iZBr${i}`);
    const checker = new AcceptanceChecker({ readPage: async () => ({ status: 200, text: 'Rustic plot for sale 18 000 EUR near the coast '.repeat(20) }) });
    const result = await checker.evaluate({ itemCount: 1, urlsLive: false, valueRange: null, mustMention: [] }, urls.map((url) => ({ url, value: 18000, unit: 'EUR' })));
    const count = result.checks.find((c: { id: string }) => c.id === 'count');
    expect(count.value).toBe(1);
    expect(count.detail).toMatch(/^2 of 10 delivered pass every check; first 2 inspected/);
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

  it('checks up to 75 items for 50 wanted, at most 6 pages at a time', async () => {
    let open = 0;
    let peak = 0;
    const reads: string[] = [];
    const readPage = async (url: string) => { reads.push(url); open++; peak = Math.max(peak, open); await new Promise((r) => setTimeout(r, 2)); open--; return { status: 200, text: `Plot for sale ${'x'.repeat(200)} 15 000 €` }; };
    const items = Array.from({ length: 90 }, (_, i) => ({ url: `https://portal.example/ad/plot-${100000 + i}` }));
    const checker = new AcceptanceChecker({ readPage });
    const result = await checker.evaluate({ itemCount: 50, valueRange: [0, 20000], unit: 'EUR', mustMention: [], urlsLive: false }, items);
    expect(MAX_ITEM_CHECKS).toBe(100);
    expect(result!.items).toHaveLength(75);
    expect(result!.checks[0]).toMatchObject({ value: 1, passed: true });
    expect(peak).toBeLessThanOrEqual(PAGE_READS_AT_ONCE);
    expect(reads).toHaveLength(75);
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

  it('delivers one supplier website per host for a kind no portal lists', () => {
    const nodes = [
      {
        id: 'A',
        sources: [
          { url: 'https://www.tradewheel.com/product/fish-dryer-steam-valve-12345.html', title: 'Fish dryer with steam valve', text: 'Fish dryer, steam valve and lighters in bulk. Trade tools and spare parts sold here.' },
          { url: 'https://www.supplier-one.com/about-us', title: 'Vintage clothing wholesale', text: 'We trade branded vintage clothing wholesale, graded A quality, cream and white stock.' },
          { url: 'https://supplier-two.com/contact', title: 'Graded A vintage stock', text: 'Supplier of branded vintage clothing wholesale, graded A, cream garments by the lot.' },
        ],
      },
    ];
    const deliverables = entityDeliverables(nodes as never, { terms: ['branded vintage clothing wholesale', 'graded A'], not: ['spare parts'] });
    expect(deliverables).toHaveLength(2);
    expect(deliverables.map((d: { url: string }) => d.url)).toEqual(['https://supplier-one.com/', 'https://supplier-two.com/']);
    expect(deliverables[0]).toEqual({ title: 'Vintage clothing wholesale', url: 'https://supplier-one.com/', value: null, unit: '', nodeId: 'A', evidence: 'https://www.supplier-one.com/about-us' });
    expect(deliverables[1]).toMatchObject({ title: 'Graded A vintage stock', nodeId: 'A', evidence: 'https://supplier-two.com/contact' });
  });

  it('needs a multi-word term or two different terms, so a dairy page with one word is not a supplier', () => {
    const dairy = [
      {
        id: 'A',
        sources: [
          { url: 'https://www.fda.gov/food/food-ingredients/cream', title: 'Cream in food', text: 'Cream, milk and butter for food manufacturers. Cream is a dairy product.' },
        ],
      },
    ];
    expect(entityDeliverables(dairy as never, { terms: ['branded vintage clothing wholesale', 'cream'] })).toEqual([]);
    const grader = [{ id: 'A', sources: [{ url: 'https://msgroup-secondhandclothes.com/how-sorting-grading/', title: 'How Sorting & Grading Define the Quality of Second-Hand Clothes', text: 'High-quality second-hand clothes, graded and sorted by professionals. Wholesale second-hand clothing by the container.' }] }];
    expect(entityDeliverables(grader as never, { terms: ['second hand clothes'], kindLabel: 'wholesale clothing provider' }).map((d) => d.url)).toEqual(['https://msgroup-secondhandclothes.com/']);
    const twoWords = [
      {
        id: 'A',
        sources: [
          { url: 'https://supplier-three.com/', title: 'Cream and clothing wholesale', text: 'Cream and clothing wholesale by the lot for graders.' },
        ],
      },
    ];
    expect(entityDeliverables(twoWords as never, { terms: ['cream', 'clothing'] }).map((d: { url: string }) => d.url)).toEqual(['https://supplier-three.com/']);
  });

  it('anchors a matched term to the kind label, so a dairy page is not a clothing supplier', () => {
    const dairy = [
      {
        id: 'A',
        sources: [
          { url: 'https://www.fda.gov/food/food-ingredients/cream', title: 'Cream in food', text: 'Grade A cream, milk and butter for food manufacturers.' },
        ],
      },
    ];
    expect(entityDeliverables(dairy as never, { terms: ['graded A', 'cream'], kindLabel: 'wholesale clothing provider' })).toEqual([]);
    const clothing = [
      {
        id: 'A',
        sources: [
          { url: 'https://supplier-four.com/', title: 'Vintage clothing wholesale', text: 'Branded vintage clothing wholesale by the lot, graded A.' },
        ],
      },
    ];
    expect(entityDeliverables(clothing as never, { terms: ['graded A', 'branded vintage clothing wholesale'], kindLabel: 'wholesale clothing provider' }).map((d: { url: string }) => d.url)).toEqual(['https://supplier-four.com/']);
  });

  it('keeps a marketplace with twelve parsed listings out of the deliverables', () => {
    const nodes = [
      {
        id: 'A',
        sources: [
          { url: 'https://www.made-in-china.com/product-search.html', title: 'Branded vintage clothing wholesale', text: 'Branded vintage clothing wholesale, graded A, from many factories.', listings: Array.from({ length: 12 }, (_, i) => ({ url: `https://www.made-in-china.com/product/vintage-${1000 + i}.html` })) },
        ],
      },
    ];
    expect(entityDeliverables(nodes as never, { terms: ['branded vintage clothing wholesale', 'graded A'] })).toEqual([]);
  });

  it('keeps a directory host with five different product paths out of the deliverables', () => {
    const nodes = [
      {
        id: 'A',
        sources: Array.from({ length: 5 }, (_, i) => ({
          url: `https://www.firmy.cz/firmy/vintage-clothing-${i}`,
          title: 'Vintage clothing wholesale',
          text: 'Branded vintage clothing wholesale, graded A, cream and white stock.',
        })),
      },
    ];
    expect(entityDeliverables(nodes as never, { terms: ['branded vintage clothing wholesale', 'graded A'] })).toEqual([]);
  });

  it('keeps only real supplier websites for a wholesale kind, excluding marketplace stores, listicles, news and non-wholesale shops', () => {
    const nodes = [
      {
        id: 'A',
        sources: [
          { url: 'https://wuhanhaisen.en.made-in-china.com/product/1', title: 'Wuhanhaisen second-hand clothing', text: 'Branded second-hand clothing wholesale, graded A, bales of cream garments.' },
          { url: 'https://usedshoe.en.made-in-china.com/product/2', title: 'Used shoes wholesale', text: 'Used shoes and second-hand clothing wholesale in bulk.' },
          { url: 'https://www.yelp.com/biz/five-best-second-hand-shops-prague', title: 'Five Best Second-Hand Shops in Prague', text: 'Best second-hand shops in Prague for vintage clothing.' },
          { url: 'https://www.praguemorning.cz/five-best-second-hand-shops/', title: 'Five Best Second-Hand Shops in Prague', text: 'A list of the five best second-hand shops in Prague.' },
          { url: 'https://www.newsanyway.com/article/123', title: 'Second-hand clothing market news', text: 'Second-hand clothing market grows in Central Europe.' },
          { url: 'https://www.lulavintageprague.cz/', title: 'Lula Vintage', text: 'vintage fashion store in Prague' },
          { url: 'https://www.secondhandbales.com/', title: 'Secondhand Bales', text: 'Branded second-hand clothing wholesale, graded A, bales of cream garments by the container.' },
          { url: 'https://www.msgroup-secondhandclothes.com/how-sorting-grading/', title: 'How Sorting & Grading Define the Quality of Second-Hand Clothes', text: 'High-quality second-hand clothes, graded and sorted by professionals. We export full containers of graded second-hand clothing wholesale.' },
        ],
      },
    ];
    const deliverables = entityDeliverables(nodes as never, { terms: ['branded second-hand clothing wholesale', 'second-hand clothing'], kindLabel: 'wholesale branded second-hand clothing' });
    expect(deliverables).toHaveLength(2);
    const uk = ["a", "b", "c"].map((name) => ({ url: `https://${name}-bales.co.uk/`, title: `${name} bales`, text: "Branded second-hand clothing wholesale in bales." }));
    expect(entityDeliverables([{ id: "U", sources: uk }] as never, { terms: ["branded second-hand clothing wholesale"], kindLabel: "wholesale clothing provider" })).toHaveLength(3);
    expect(deliverables.map((d: { url: string }) => d.url).sort()).toEqual(['https://msgroup-secondhandclothes.com/', 'https://secondhandbales.com/'].sort());
  });
});

describe('prices in more currencies and scales', () => {
  it('reads the currency of a compound unit such as "€ EUR"', () => {
    expect(currencyOf('€ EUR')).toBe('EUR');
    expect(currencyOf('Kč (CZK)')).toBe('CZK');
    expect(currencyOf('m²')).toBe('');
  });

  it('reads lira, dong, scale words, and never a reference code or a number on another line', () => {
    expect(parseAmounts('450.000 TL · 2,150,000,000 ₫ · ₫ 75.6 billion · Giá 1,1 tỷ · € 20 k · € 1.2 million')).toEqual([
      { value: 450000, currency: 'TRY', perUnit: false },
      { value: 2150000000, currency: 'VND', perUnit: false },
      { value: 75600000000, currency: 'VND', perUnit: false },
      { value: 1100000000, currency: 'VND', perUnit: false },
      { value: 20000, currency: 'EUR', perUnit: false },
      { value: 1200000, currency: 'EUR', perUnit: false },
    ]);
    expect(parseAmounts('Ref: PTFS125161 $840.000')).toEqual([{ value: 840000, currency: 'USD', perUnit: false }]);
    expect(parseAmounts('Farm land 1\n$10.000')).toEqual([{ value: 10000, currency: 'USD', perUnit: false }]);
    expect(parseAmounts('Tlaxcala 5 and title 7')).toEqual([]);
  });
});

describe('item count with describing words', () => {
  it('reads a count when up to two words describe the noun, and the noun can be a company kind', () => {
    expect(itemCountFromWords('20 direct links to the providers with proposal and proof')).toBe(20);
    expect(itemCountFromWords('12 verified wholesale suppliers')).toBe(12);
    expect(itemCountFromWords('a list of 8 clothing companies')).toBe(8);
    expect(itemCountFromWords('5 year old cars under 3000 EUR')).toBeNull();
    expect(itemCountFromWords('cars within 300 km of Prague')).toBeNull();
  });
});

describe('acceptance for items no listing portal sells', () => {
  it('counts a provider home page that opens, and keeps the listing-page rule for listed kinds', async () => {
    const readPage = async () => ({ status: 200, text: 'Branded second-hand clothing wholesale. '.repeat(20) });
    const checker = new AcceptanceChecker({ readPage });
    const spec = normalizeAcceptance({ itemCount: 1, urlsLive: true }, '1 direct link to a provider');
    const items = [{ title: 'Vintage wholesale', url: 'https://vintage-wholesale.example.de/' }];
    const unlisted = await checker.evaluate(spec, items, { located: false });
    expect(unlisted.checks.find((c: { id: string }) => c.id === 'count')).toMatchObject({ value: 1 });
    expect(unlisted.checks.find((c: { id: string }) => c.id === 'count').detail).toContain('a page that opens and describes the asked kind');
    const listed = await checker.evaluate(spec, items);
    expect(listed.checks.find((c: { id: string }) => c.id === 'count')).toMatchObject({ value: 0 });
  });
});

const CAR = {
  question: 'Find accurate and verified car listings on available marketplaces for at least 20 cars as fit and up to 80 as a trade off to purchase within 300km from prague, hatchback, with highest price/value ratio, considering the engines informations, usage trends and empirical data and all important details of the particular car, considering the professional and car enthusiast trustful sources and communities, with all the crucial metrics considered, price up to 65000CZK or equivalent',
  acceptance: { expected: 'The list of 20 highest possible price/value ratio to buy, working links, no broken links, verified with the research logic, recently posted, 80 trade offs to confirm and review', itemCount: 20, urlsLive: true, valueRange: [0, 65000], unit: 'CZK', mustMention: [] },
  decisionModel: { kind: { label: 'used car', terms: ['hatchback'], not: ['parts', 'accessories'] } },
};

const WHOLESALE = {
  question: 'Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren, Monclair, North face, Barbour with highest price/value ratio , proven good quality, assortiment for the appropriate retail second hand shop business in Czech Republic',
  acceptance: { expected: '20 direct links to the providers with proposal and proof that those particular companies do have highest proce/value ratio, quality, assortiment and appropriate setup for local Prague branded second hand shop retail', itemCount: 20, urlsLive: true, valueRange: null, unit: 'EUR', mustMention: [] },
  decisionModel: { kind: { label: 'wholesale clothing provider', terms: ['wholesale second‑hand clothing', 'used clothing wholesale', 'second‑hand apparel wholesale'] } },
};

describe('purpose checks from the user\'s words', () => {
  it('turns the sub-type the user named in the car research into a per-row check', () => {
    const checks = purposeChecks(CAR);
    expect(checks).toEqual([{ id: 'purpose-kind', type: 'kind', terms: ['hatchback'], label: 'Page shows the asked hatchback (your words)' }]);
  });

  it('turns the brand list of the wholesale research into one per-row check, not five', () => {
    const checks = purposeChecks(WHOLESALE);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ id: 'purpose-names-1', type: 'any', names: ['Ralph Lauren', 'Monclair', 'North face', 'Barbour'] });
    expect(checks[0].label).toBe('Page mentions one of: "Ralph Lauren", "Monclair", "North face", "Barbour" (your words)');
  });

  it('invents nothing from descriptions, counts, distances or prices the question also states', () => {
    expect(purposeChecks({ question: CAR.question })).toEqual([]);
    expect(purposeChecks({ question: 'Find at least 20 cars within 300km from prague, price up to 65000CZK or equivalent' })).toEqual([]);
    expect(purposeChecks({})).toEqual([]);
  });

  it('keeps a kind the user did not name out of the purpose checks', () => {
    expect(purposeChecks({ question: CAR.question, decisionModel: { kind: { label: 'used car', terms: ['estate', 'suv'] } } })).toEqual([]);
  });

  it('counts a car row toward the result only when its own page shows a hatchback', async () => {
    const pages: Record<string, { text: string; status: number }> = {
      'https://auto.bazos.cz/inzerat/225881782/citroen-c3.php': { text: 'Citroen C3 1.4i hatchback, 54 kW, 180 000 km, benzín, STK 2026, cena 15 000 Kč. '.repeat(4), status: 200 },
      'https://auto.bazos.cz/inzerat/225944880/peugeot-207.php': { text: 'Peugeot 207 SW kombi, 1.4 benzín, 65 kW, 210 000 km, cena 20 000 Kč. '.repeat(4), status: 200 },
    };
    const checker = new AcceptanceChecker({ readPage: async (url: string) => pages[url] ?? { text: '', status: 404 } });
    const spec = normalizeAcceptance(CAR.acceptance);
    const items = [{ title: 'Citroen c3 1.4i', url: Object.keys(pages)[0], value: 15000, unit: 'CZK' }, { title: 'Peugeot 207', url: Object.keys(pages)[1], value: 20000, unit: 'CZK' }];
    const result = await checker.evaluate(spec, items, { located: true, kind: CAR.decisionModel.kind, purpose: purposeChecks(CAR) });
    const purpose = result!.checks.find((c: { id: string }) => c.id === 'purpose-kind');
    expect(purpose).toMatchObject({ label: 'Page shows the asked hatchback (your words)', value: 0.5, passed: false });
    expect(purpose!.detail).toBe('1 of 2 delivered pages show it');
    expect(result!.checks.find((c: { id: string }) => c.id === 'count')).toMatchObject({ value: 0.05 });
    expect(result!.items.map((i: { purpose: { passed: boolean }[] }) => i.purpose[0].passed)).toEqual([true, false]);
  });

  it('counts a car row toward the result when its title names a model built as that sub-type', async () => {
    const project = { ...CAR, decisionModel: { ...CAR.decisionModel, subtype: { label: 'hatchback', models: ['skoda fabia'], variants: ['combi'] } } };
    const pages: Record<string, { text: string; status: number }> = {
      'https://auto.bazos.cz/inzerat/225881782/skoda-fabia.php': { text: 'Škoda Fabia 1.2 HTP, 51 kW, 160 000 km, benzín, cena 25 000 Kč. '.repeat(4), status: 200 },
      'https://auto.bazos.cz/inzerat/225944880/skoda-fabia-combi.php': { text: 'Škoda Fabia Combi 1.4, 55 kW, 210 000 km, cena 30 000 Kč. '.repeat(4), status: 200 },
    };
    const checker = new AcceptanceChecker({ readPage: async (url: string) => pages[url] ?? { text: '', status: 404 } });
    const spec = normalizeAcceptance(CAR.acceptance);
    const items = [{ title: 'Škoda Fabia 1.2 HTP', url: Object.keys(pages)[0], value: 25000, unit: 'CZK' }, { title: 'Škoda Fabia Combi', url: Object.keys(pages)[1], value: 30000, unit: 'CZK' }];
    const result = await checker.evaluate(spec, items, { located: true, kind: project.decisionModel.kind, purpose: purposeChecks(project) });
    const purpose = result!.checks.find((c: { id: string }) => c.id === 'purpose-kind');
    expect(purpose).toMatchObject({ value: 0.5, passed: false });
    expect(result!.items.map((i: { purpose: { passed: boolean }[] }) => i.purpose[0].passed)).toEqual([true, false]);
  });

  it('passes a car row whose page says hatchback, with no sub-type models known', async () => {
    const pages = { 'https://auto.bazos.cz/inzerat/225881782/citroen-c3.php': { text: 'Citroen C3 1.4i hatchback, 54 kW, 180 000 km, cena 15 000 Kč. '.repeat(4), status: 200 } };
    const checker = new AcceptanceChecker({ readPage: async (url: string) => pages[url] ?? { text: '', status: 404 } });
    const result = await checker.evaluate(normalizeAcceptance(CAR.acceptance), [{ title: 'Citroen c3 1.4i', url: Object.keys(pages)[0], value: 15000, unit: 'CZK' }], { located: true, kind: CAR.decisionModel.kind, purpose: purposeChecks(CAR) });
    expect(result!.checks.find((c: { id: string }) => c.id === 'purpose-kind')).toMatchObject({ value: 1, passed: true });
  });

  it('counts a wholesale row only when its own page names one of the asked brands', async () => {
    const pages: Record<string, { text: string; status: number }> = {
      'https://wuhanhaisen.en.made-in-china.com/product/BZdTfAtPJDGu/China-Wholesale-Thrift-Clothing-Bundle.html': { text: 'Wholesale second hand clothing bales, used clothing wholesale lots, Ralph Lauren and Barbour mix, 45 kg bales. '.repeat(4), status: 200 },
      'https://www.tradeindia.com/products/bale-of-mustang-used-cloth-korean-second-hand-c8797405.html': { text: 'Wholesale second hand clothing bale, used clothing wholesale, mixed Korean used clothes, 45 kg bales, woolen and long sleeve. '.repeat(4), status: 200 },
    };
    const checker = new AcceptanceChecker({ readPage: async (url: string) => pages[url] ?? { text: '', status: 404 } });
    const spec = normalizeAcceptance(WHOLESALE.acceptance);
    const items = [{ title: 'Wholesale Thrift Clothing Bundle', url: Object.keys(pages)[0], value: 1.5, unit: 'USD/kg' }, { title: 'Bale Of Mustang Used Cloths', url: Object.keys(pages)[1], value: null, unit: 'n/a' }];
    const result = await checker.evaluate(spec, items, { located: false, kind: WHOLESALE.decisionModel.kind, purpose: purposeChecks(WHOLESALE) });
    const purpose = result!.checks.find((c: { id: string }) => c.id === 'purpose-names-1');
    expect(purpose).toMatchObject({ value: 0.5, passed: false });
    expect(purpose!.label).toBe('Page mentions one of: "Ralph Lauren", "Monclair", "North face", "Barbour" (your words)');
    expect(result!.checks.find((c: { id: string }) => c.id === 'count')).toMatchObject({ value: 0.05 });
  });

  it('matches the user\'s misspelt brand name to the page spelling within Levenshtein distance 2', async () => {
    const pages: Record<string, { text: string; status: number }> = {
      'https://moncler-wholesale.example/en/lots': { text: 'Wholesale Moncler down jackets, second hand clothing bales, used clothing wholesale. '.repeat(6), status: 200 },
      'https://barbour-wholesale.example/en/lots': { text: 'Barbour wax jackets wholesale lots, used clothing wholesale bales. '.repeat(6), status: 200 },
      'https://north-face.example/en/lots': { text: 'The North Face jackets wholesale, used clothing bales. '.repeat(6), status: 200 },
      'https://mixed-bales.example/en/lots': { text: 'Mixed second hand clothing bales, used clothing wholesale, 45 kg lots. '.repeat(6), status: 200 },
    };
    const checker = new AcceptanceChecker({ readPage: async (url: string) => pages[url] ?? { text: '', status: 404 } });
    const items = Object.keys(pages).map((url) => ({ title: 'clothing lot', url, value: null, unit: 'n/a' }));
    const result = await checker.evaluate(normalizeAcceptance({ itemCount: 4 }, '4 lots'), items, { located: false, purpose: purposeChecks(WHOLESALE) });
    expect(result!.items.map((i: { purpose: { passed: boolean }[] }) => i.purpose[0].passed)).toEqual([true, true, true, false]);
    expect(result!.checks.find((c: { id: string }) => c.id === 'purpose-names-1')).toMatchObject({ value: 0.75, passed: false, label: 'Page mentions one of: "Ralph Lauren", "Monclair", "North face", "Barbour" (your words)' });
  });

  it('does not stretch the misspelling rule to short names or to distant words', async () => {
    const pages: Record<string, { text: string; status: number }> = {
      'https://a.example/lots': { text: 'Monte carlo wholesale bales, second hand clothing wholesale. '.repeat(6), status: 200 },
      'https://b.example/lots': { text: 'Ralphie coats wholesale bales, second hand clothing wholesale. '.repeat(6), status: 200 },
    };
    const checker = new AcceptanceChecker({ readPage: async (url: string) => pages[url] ?? { text: '', status: 404 } });
    const items = Object.keys(pages).map((url) => ({ title: 'clothing lot', url, value: null, unit: 'n/a' }));
    const result = await checker.evaluate(normalizeAcceptance({ itemCount: 2 }, '2 lots'), items, { located: false, purpose: purposeChecks(WHOLESALE) });
    expect(result!.items.map((i: { purpose: { passed: boolean }[] }) => i.purpose[0].passed)).toEqual([false, false]);
  });

  it('still reports nothing to check when neither the spec nor the words ask for anything', async () => {
    const checker = new AcceptanceChecker({ readPage: async () => ({ text: '', status: 404 }) });
    expect(await checker.evaluate(normalizeAcceptance({}, 'a memo'), [])).toBeNull();
  });
});

describe('kindOnPage', () => {
  it('finds the asked kind on a page by word stems, and not on a brand site or a press release', async () => {
    const { kindOnPage } = await import('../../src/research/acceptance.mjs');
    const kind = { terms: ['wholesale second\u2011hand clothing', 'used clothing wholesale'] };
    expect(kindOnPage('China Wholesale Second Hand Supplier Bale Used Clothes', kind)).toBe(true);
    expect(kindOnPage('The North Face jackets, shop the new collection', kind)).toBe(false);
    expect(kindOnPage('eBay launches pre-loved fashion on Love Island', kind)).toBe(false);
  });
});
