import { describe, expect, it, beforeAll } from 'vitest';
import { AcceptanceChecker, MAX_ITEM_CHECKS, PAGE_READS_AT_ONCE, collectDeliverables, currencyOf, entityDeliverables, hasCriteria, headlinePrice, inRange, isExcludedSurfaceUrl, itemCountFromWords, looksLikeListing, normalizeAcceptance, parseAmounts, purposeChecks, toAmount } from '../../src/research/acceptance.mjs';

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
    for (const url of ['https://terrenos.es/en/contactar/propietario/422967', 'https://www.sahibinden.com/satilik-arsa', 'https://www.idealista.com/news/inmobiliario/blog-de-idealista', 'https://www.properstar.com/europe/buy/land-plot/sea-view', 'https://www.mondinion.com/Land_for_Development/country/Turkey/', 'https://homestra.com/list/houses-for-sale/?property-type=lot&maximum-price=50000', 'https://www.idealista.pt/geo/comprar-terrenos/praia-torres-vedras/com-tamanho-max_10000/?ordem=precos-asc', 'https://www.olx.pt/imoveis/terrenos-quintas/faro/q-2000-euros/', 'https://www.kyero.com/pt/norte-portugal-terrenos-para-vender-0l57087g5?max_price=100000', 'https://www.holprop.com/s/sale/pt62372644/?ctype=EUR', 'not a url']) expect(looksLikeListing(url), url).toBe(false);
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

  it('counts a supplier site as a valid item when its evidence page is live, though its root is blocked', async () => {
    const text = 'Ralph Lauren and Barbour second hand clothing wholesale in bales. '.repeat(10);
    const pages: Record<string, { status: number; text: string }> = { 'https://zagumi.com/': { status: 403, text: '' }, 'https://zagumi.com/wholesale': { status: 200, text } };
    const checker = new AcceptanceChecker({ readPage: async (url: string) => pages[url] ?? { text: '', status: 404 } });
    const supplier = { url: 'https://zagumi.com/', evidence: 'https://zagumi.com/wholesale', title: 'Zagumi' };
    const result = await checker.evaluate({ itemCount: 1, urlsLive: true, mustMention: [] }, [supplier], { located: false });
    expect(result.checks.find((c: { id: string }) => c.id === 'count')).toMatchObject({ value: 1 });
    expect(result.items[0].live).toBe(true);
    const listing = await checker.evaluate({ itemCount: 1, urlsLive: true, mustMention: [] }, [{ url: 'https://zagumi.com/wholesale', title: 'x' }], { located: true });
    expect(listing.checks.find((c: { id: string }) => c.id === 'count')).toMatchObject({ value: 0 });
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

  it('inRange converts the item value when the page shows no amount', () => {
    const rates: Record<string, number> = { EUR: 1, CZK: 24.3, TRY: 55.9 };
    const convert = (value: number, from: string, to: string) => (rates[from] && rates[to] ? (value / rates[from]) * rates[to] : null);
    const cars = { valueRange: [0, 65000], unit: 'CZK' } as never;
    const plots = { valueRange: [0, 20000], unit: 'EUR' } as never;
    expect(inRange([], cars, 23990, convert, 'EUR')).toBe(false);
    expect(inRange([], cars, 1700, convert, 'EUR')).toBe(true);
    expect(inRange([], cars, 25000, convert, 'CZK')).toBe(true);
    expect(inRange([], plots, 290000, convert, 'TRY')).toBe(true);
    expect(inRange([], plots, 1455000, convert, 'TRY')).toBe(false);
    expect(inRange([], plots, 15000, convert)).toBe(true);
    expect(inRange([], plots, 8200000000, convert, 'VND')).toBe(false);
  });

  it('reads the unit of a delivered row when its page shows no amount', async () => {
    const url = 'https://www.autobazar.eu/detail/skoda-kodiaq-20-tdi-scr-rs-dsg-4x4/AmOs2PRdaeH/';
    const convert = (value: number, from: string, to: string) => (from === 'EUR' && to === 'CZK' ? value * 24.3 : null);
    const checker = new AcceptanceChecker({ readPage: async () => ({ text: 'Škoda Kodiaq 2.0 TDI SCR RS DSG 4x4, 2020, Automat, Diesel, 180 500 km, 176 kW, SUV, 4x4. '.repeat(4), status: 200 }), convert });
    const result = await checker.evaluate(normalizeAcceptance({ expected: '1 car', itemCount: 1, valueRange: [0, 65000], unit: 'CZK' }), [{ title: 'Škoda Kodiaq 2.0 TDI SCR RS DSG 4x4', url, value: 23990, unit: 'EUR' }], { located: true });
    expect(result!.items[0]).toMatchObject({ live: true, inRange: false });
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

  it('delivers one supplier website per host for a kind no portal lists', async () => {
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
    const deliverables = await entityDeliverables(nodes as never, { terms: ['branded vintage clothing wholesale', 'graded A'], not: ['spare parts'] });
    expect(deliverables).toHaveLength(2);
    expect(deliverables.map((d: { url: string }) => d.url)).toEqual(['https://supplier-one.com/', 'https://supplier-two.com/']);
    expect(deliverables[0]).toEqual({ title: 'Vintage clothing wholesale', url: 'https://supplier-one.com/', value: null, unit: '', nodeId: 'A', evidence: 'https://www.supplier-one.com/about-us' });
    expect(deliverables[1]).toMatchObject({ title: 'Graded A vintage stock', nodeId: 'A', evidence: 'https://supplier-two.com/contact' });
  });

  it('needs a multi-word term or two different terms, so a dairy page with one word is not a supplier', async () => {
    const dairy = [
      {
        id: 'A',
        sources: [
          { url: 'https://www.fda.gov/food/food-ingredients/cream', title: 'Cream in food', text: 'Cream, milk and butter for food manufacturers. Cream is a dairy product.' },
        ],
      },
    ];
    expect(await entityDeliverables(dairy as never, { terms: ['branded vintage clothing wholesale', 'cream'] })).toEqual([]);
    const grader = [{ id: 'A', sources: [{ url: 'https://msgroup-secondhandclothes.com/how-sorting-grading/', title: 'How Sorting & Grading Define the Quality of Second-Hand Clothes', text: 'High-quality second-hand clothes, graded and sorted by professionals. Wholesale second-hand clothing by the container.' }] }];
    expect((await entityDeliverables(grader as never, { terms: ['second hand clothes'], kindLabel: 'wholesale clothing provider' })).map((d) => d.url)).toEqual(['https://msgroup-secondhandclothes.com/']);
    const twoWords = [
      {
        id: 'A',
        sources: [
          { url: 'https://supplier-three.com/', title: 'Cream and clothing wholesale', text: 'Cream and clothing wholesale by the lot for graders.' },
        ],
      },
    ];
    expect((await entityDeliverables(twoWords as never, { terms: ['cream', 'clothing'] })).map((d: { url: string }) => d.url)).toEqual(['https://supplier-three.com/']);
  });

  it('anchors a matched term to the kind label, so a dairy page is not a clothing supplier', async () => {
    const dairy = [
      {
        id: 'A',
        sources: [
          { url: 'https://www.fda.gov/food/food-ingredients/cream', title: 'Cream in food', text: 'Grade A cream, milk and butter for food manufacturers.' },
        ],
      },
    ];
    expect(await entityDeliverables(dairy as never, { terms: ['graded A', 'cream'], kindLabel: 'wholesale clothing provider' })).toEqual([]);
    const clothing = [
      {
        id: 'A',
        sources: [
          { url: 'https://supplier-four.com/', title: 'Vintage clothing wholesale', text: 'Branded vintage clothing wholesale by the lot, graded A.' },
        ],
      },
    ];
    expect((await entityDeliverables(clothing as never, { terms: ['graded A', 'branded vintage clothing wholesale'], kindLabel: 'wholesale clothing provider' })).map((d: { url: string }) => d.url)).toEqual(['https://supplier-four.com/']);
  });

  it('keeps a marketplace with twelve parsed listings out of the deliverables', async () => {
    const nodes = [
      {
        id: 'A',
        sources: [
          { url: 'https://www.made-in-china.com/product-search.html', title: 'Branded vintage clothing wholesale', text: 'Branded vintage clothing wholesale, graded A, from many factories.', listings: Array.from({ length: 12 }, (_, i) => ({ url: `https://www.made-in-china.com/product/vintage-${1000 + i}.html` })) },
        ],
      },
    ];
    expect(await entityDeliverables(nodes as never, { terms: ['branded vintage clothing wholesale', 'graded A'] })).toEqual([]);
  });

  it('keeps a directory host with five different product paths out of the deliverables', async () => {
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
    expect(await entityDeliverables(nodes as never, { terms: ['branded vintage clothing wholesale', 'graded A'] })).toEqual([]);
  });

  it('excludes blog and guide pages even when they carry the asked terms', async () => {
    const nodes = [
      {
        id: 'A',
        sources: [
          { url: 'https://www.excellent-vintage.com/en/blog/complete-guide-vintage-wholesale-clothing-netherlands-2026', title: 'Vintage Wholesale Clothing Netherlands: Complete Guide 2026', text: 'A vintage wholesale clothing supplier in the Netherlands sells secondhand clothing in bulk to resellers, by the bale. Think a hundred Ralph Lauren shorts.' },
          { url: 'https://www.usfripe.com/blogs/news/where-to-buy-vintage-clothing-wholesale-in-europe-2026-guide', title: 'Where to Buy Vintage Clothing Wholesale in Europe (2026 Guide)', text: 'The best vintage clothing wholesale suppliers in Europe for 2026, branded second-hand fashion.' },
          { url: 'https://www.supplier-one.com/', title: 'Vintage clothing wholesale', text: 'Branded vintage clothing wholesale, graded A, cream garments by the lot.' },
        ],
      },
    ];
    const deliverables = await entityDeliverables(nodes as never, { terms: ['branded vintage clothing wholesale', 'secondhand clothing'], kindLabel: 'wholesale clothing provider' });
    expect(deliverables).toHaveLength(1);
    expect(deliverables.map((d: { url: string }) => d.url)).toEqual(['https://supplier-one.com/']);
  });

  it('a wholesaler page naming retailers as customers is not dropped by the not phrase retail', async () => {
    const terms = ['branded vintage clothing wholesale', 'graded A', 'cream', 'suppliers in NL', 'wholesale used clothing', 'second hand clothes', 'used clothing wholesale'];
    const not = ['retail', 'maloobchod', 'donation', 'consignment'];
    const kindLabel = 'wholesale clothing provider';
    const brasco = [{
      id: 'hubs',
      sources: [{
        url: 'https://brasco.nl/',
        title: 'Brasco Wholesale Vintage Clothing | Footwear | Accessories',
        text: 'Brasco Wholesale Vintage Clothing | Footwear | Accessories \n New from Brasco \n New: BrascoBox \n Meet BrascoBox — vintage wholesale in smaller quantities \n Vintage wholesale in smaller quantities \n Discover BrascoBox \n high quality collections\n worldwide delivery\n realtime stock\n Slide 1_3 Clothing Accessories footwear Get Inspired\n Slide 1_3 Clothing Accessories footwear Get Inspired\n check out our assortment\n Hand-inspected clothing, delivered in bulk for unbeatable value\n Accessories (69) \n Clothing (489) \n Footwear (50) \n your vintage adventure starts here\n Bulk up your stock with our carefully sourced European and American clothing.\n Our story of wholesale vintage clothing\n Welcome to our online vintage clothing wholesale company! Brasco is your go-to distributor for wholesale vintage, second-hand and used clothing. \n We are passionate about vintage wholesale fashion and offer a shop-ready product for retailers and wholesalers who share our enthusiasm for used items.',
      }],
    }];
    expect(await entityDeliverables(brasco as never, { terms, not, kindLabel })).toEqual([
      { title: 'Brasco Wholesale Vintage Clothing | Footwear | Accessories', url: 'https://brasco.nl/', value: null, unit: '', nodeId: 'hubs', evidence: 'https://brasco.nl/' },
    ]);
    const dustFactory = [{
      id: 'hubs',
      sources: [{
        url: 'https://dustfactoryvintage.com/vintage-clothing-wholesale/',
        title: 'Wholesale Vintage Clothing 101',
        text: 'Vintage Clothing Wholesalers and Suppliers work hand in hand with the rag houses that process vintage clothing, teaching their workers and buyers what is valuable for resale as Vintage. These mixes are then processed and sold to the Vintage Wholesaler so that they can begin processing the mixes for retail buyers.\n\nAt Dust Factory we then process the clothing even more breaking down each grade into a specific style and quality. The graders in the Dust Factory processing plants are more advanced when it comes to Vintage Clothing retail, then the graders at the Rag Houses. This is because each grader has had a minimum of three years experience working Vintage Retail before they can start grading for Dust Factory. We have found over the years that this ensures a quality mix for our buyers. What is damaged or stained is then sold to vintage refurbished companies so that the items can be re-constructed into a new garment. What is considered modern or undesirable for vintage buyers is donated to local charities or disaster relief organizations.\n\nThe clothing that is used for our mixes is then broken down into size and style runs. This gives our buyers the opportunity to get the same high quality mixes each time. Because we are a bulk wholesaler we do not pull out rare or desirable items for buyers with a limited market, but instead leave these items in our mixes to ensure the quality of our mixes for our bulk buyers. Over the years we have found that it is better not to let buyers hand pick mixes from our grades, this is so that we can keep the quality of our grades up.',
      }],
    }];
    expect((await entityDeliverables(dustFactory as never, { terms, kindLabel })).map((d: { url: string }) => d.url)).toEqual(['https://dustfactoryvintage.com/']);
    expect(await entityDeliverables(dustFactory as never, { terms, not, kindLabel })).toEqual([]);
  });

  it('marks each delivered supplier with its region verdict for an entity list and delivers the same rows', async () => {
    const nodes = [
      {
        id: 'D6.2',
        sources: [
          { kind: 'web', title: 'US Fripe Wholesale: Wholesale Vintage Clothing | France & Europe ...', url: 'https://www.usfripe.com/', domain: 'usfripe.com', locale: 'en', snippet: 'US Fripe sources wholesale vintage and second-hand branded clothing from France, shipped fast across Europe. Grade A stock, built for resale.', text: 'Wholesale Vintage Clothing | France & Europe Supplier\n &ndash; US Fripe Wholesale \n Skip to content\n FREE SHIPPING ON ORDERS 2000€ | NEXT DAY DISPATCH \nItem added to your cart\n View cart \n Check out\n Continue shopping \n BRANDED VINTAGE, READY TO RESELL WORLDWIDE\n Discover Premium Vintage Clothing \n Explore Our Products \n FRESH FINDS. BIG DEALS. EVERY TIME.\n Discover fresh arrivals, trusted brands and great wholesale value.' },
        ],
      },
      {
        id: 'hubs',
        sources: [
          { kind: 'web', title: 'Groothandel gebruikte kleding in balen - Zagumi', url: 'https://www.zagumi.com/nl/used-clothing/', domain: 'zagumi.com', locale: 'en_US', snippet: 'Zagumi levert gebruikte kleding van topkwaliteit voor uw tweedehandskledingbedrijf. Neem contact met ons op voor meer informatie over de import en export ...', text: 'Groothandel gebruikte kleding in balen - Zagumi Facebook YouTube Home \n Leverancier van gebruikte kledingbalen \n Crème kwaliteit\n Kleding van crèmekwaliteit, geschikt voor de hogere markt.\n Room + Extra Mix\n Gemengde Cream grade en Extra grade, wat resulteert in nog betere kwaliteit tweedehands balen. ["title"]=> string(21) "Top 2nd Hand Clothing" ["title"]=> string(16) "Top Supply Chain" ["style_normal_color"]=> string(27) "globals/colors?id=secondary"' },
          { kind: 'web', title: 'Second-Hand Clothing Importer - Wiltex Wholesale', url: 'https://wiltex.eu/second-hand-clothing/', domain: 'wiltex.eu', locale: '', snippet: 'The reason for this is that the clothes offered are sorted and carefully selected. Cream (Class A) is the highest possible quality, among which there are brand- ...', text: 'The reason for this is that the clothes offered are sorted and carefully selected. Cream (Class A) is the highest possible quality, among which there are brand- ...' },
        ],
      },
    ];
    const asked = { terms: ['branded vintage clothing wholesale', 'graded A', 'cream', 'suppliers in NL', 'wholesale used clothing', 'second hand clothes', 'used clothing wholesale'], not: ['retail', 'maloobchod', 'donation', 'consignment'], kindLabel: 'wholesale clothing provider' };
    const unmarked = await entityDeliverables(nodes as never, asked);
    expect(unmarked.map((d: { url: string }) => d.url).sort()).toEqual(['https://usfripe.com/', 'https://wiltex.eu/', 'https://zagumi.com/']);
    expect(unmarked.every((d: Record<string, unknown>) => !('region' in d))).toBe(true);
    const marked = await entityDeliverables(nodes as never, { ...asked, regions: ['CZ'] });
    expect(marked.map((d: { url: string }) => d.url)).toEqual(unmarked.map((d: { url: string }) => d.url));
    expect(marked.map((d: { region: string }) => d.region)).toEqual(['outside CZ', 'outside CZ', 'outside CZ']);
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

  it('fails a swept listing of a portal when the page lacks the kind word', async () => {
    const pages: Record<string, { text: string; status: number }> = {
      'https://auto.bazos.cz/inzerat/225881782/citroen-c3.php': { text: 'Citroen C3 1.4i 1.6MPI 75kw, 54 kW, 180 000 km, benzín, cena 15 000 Kč. '.repeat(4), status: 200 },
    };
    const checker = new AcceptanceChecker({ readPage: async (url: string) => pages[url] ?? { text: '', status: 404 } });
    const items = [{ title: 'Citroen C3 1.4i', url: Object.keys(pages)[0], value: 15000, unit: 'CZK', nodeId: 'sweep', harvested: true }];
    const result = await checker.evaluate(normalizeAcceptance(CAR.acceptance), items, { located: true, kind: CAR.decisionModel.kind, purpose: purposeChecks(CAR) });
    const purpose = result!.checks.find((c: { id: string }) => c.id === 'purpose-kind');
    expect(purpose).toMatchObject({ label: 'Page shows the asked hatchback (your words)', value: 0, passed: false });
    expect(result!.items.map((i: { purpose: { passed: boolean }[] }) => i.purpose[0].passed)).toEqual([false]);
  });

  it('keeps the asked kind word check for a listing that was not harvested from a portal sweep', async () => {
    const pages: Record<string, { text: string; status: number }> = {
      'https://auto.bazos.cz/inzerat/225881782/citroen-c3.php': { text: 'Citroen C3 1.4i 1.6MPI 75kw, 54 kW, 180 000 km, benzín, cena 15 000 Kč. '.repeat(4), status: 200 },
    };
    const checker = new AcceptanceChecker({ readPage: async (url: string) => pages[url] ?? { text: '', status: 404 } });
    const items = [{ title: 'Citroen C3 1.4i', url: Object.keys(pages)[0], value: 15000, unit: 'CZK', nodeId: 'D1', harvested: true }];
    const result = await checker.evaluate(normalizeAcceptance(CAR.acceptance), items, { located: true, kind: CAR.decisionModel.kind, purpose: purposeChecks(CAR) });
    const purpose = result!.checks.find((c: { id: string }) => c.id === 'purpose-kind');
    expect(purpose).toMatchObject({ label: 'Page shows the asked hatchback (your words)', value: 0, passed: false });
    expect(result!.items.map((i: { purpose: { passed: boolean }[] }) => i.purpose[0].passed)).toEqual([false]);
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

describe('isExcludedSurfaceUrl', () => {
  it('flags the audited blog, guide and supplier-directory pages and nothing else', () => {
    const excluded = [
      'https://www.usfripe.com/blogs/news/where-to-buy-vintage-clothing-wholesale-in-europe-2026-guide',
      'https://www.excellent-vintage.com/en/blog/complete-guide-vintage-wholesale-clothing-netherlands-2026',
      'https://recyclingitaly.com/blog/wholesale-second-hand-clothes-in-germany-for-b2b',
      'https://accio.com/',
      'https://www.accio.com/supplier/germany-wholesaler-used-clothes',
      'https://apparelsearch.com/wholesale_clothing/wholesale_used_clothing.htm',
    ];
    for (const url of excluded) expect(isExcludedSurfaceUrl(url), url).toBe(true);
    const kept = [
      'https://zagumi.com/nl/used-clothing/',
      'https://wiltex.eu/second-hand-clothing/',
      'https://auto.bazos.cz/inzerat/225881782/citroen-c3.php',
      'https://www.imovirtual.com/pt/anuncio/terreno-urbano-coimbra-20-000-ID1iZBr',
      'not a url',
    ];
    for (const url of kept) expect(isExcludedSurfaceUrl(url), url).toBe(false);
  });

  it('keeps accio.com and apparelsearch.com out of entityDeliverables', async () => {
    const nodes = [
      {
        id: 'A',
        sources: [
          { url: 'https://accio.com/', title: 'Germany Wholesaler Used Clothes: Top Suppliers & Bulk Deals', text: 'Results from 138900+ products and 3500+ suppliers. Wholesale second hand clothing in bulk bales by the container.' },
          { url: 'https://apparelsearch.com/wholesale_clothing/wholesale_used_clothing.htm', title: 'Wholesale Used Clothing', text: 'Used Clothing Wholesaler Directory: processors collect, sort, bale and ship secondhand clothing by the container. Wholesale second hand clothing.' },
          { url: 'https://zagumi.com/nl/used-clothing/', title: 'Groothandel gebruikte kleding in balen - Zagumi', text: 'Groothandel gebruikte kleding in balen, wholesale second hand clothing per kg by the container.' },
        ],
      },
    ];
    const deliverables = await entityDeliverables(nodes as never, { terms: ['wholesale second hand clothing'], kindLabel: 'wholesale clothing provider' });
    expect(deliverables).toHaveLength(1);
    expect(deliverables.map((d: { url: string }) => d.url)).toEqual(['https://zagumi.com/']);
  });
});

describe('entityDeliverables with directory pages', () => {
  const EUROPAGES_URL = 'https://www.europages.nl/ondernemingen/balen-gebruikte-kleding.html';
  let europagesHtml: string;
  let singleOrgHtml: string;
  beforeAll(async () => {
    const fs = await import('node:fs/promises');
    europagesHtml = await fs.readFile(new URL('../fixtures/europages-balen-gebruikte-kleding.html', import.meta.url), 'utf8');
    singleOrgHtml = await fs.readFile(new URL('../fixtures/single-org-page.html', import.meta.url), 'utf8');
  });

  it('extracts entities from a directory page and creates deliverables per entity', async () => {
    const nodes = [
      {
        id: 'D1',
        sources: [
          { url: EUROPAGES_URL, title: 'Balen gebruikte kleding', text: 'wholesale second hand clothing bales graded A ' + europagesHtml, listings: Array.from({ length: 10 }, (_, i) => ({ url: `https://www.europages.nl/nl/company/entity-${i}` })) },
        ],
      },
    ];
    const deliverables = await entityDeliverables(nodes as never, {
      terms: ['wholesale second hand clothing', 'bales'],
      kindLabel: 'wholesale clothing provider',
      readPage: async () => ({ text: '', status: 404 }),
    });
    expect(deliverables.length).toBeGreaterThanOrEqual(3);
    const titles = deliverables.map((d: { title: string }) => d.title);
    expect(titles).toContain('UK CLOTHING CARAVAN');
    expect(titles).toContain('Wakted BV');
    expect(titles).toContain('LIBERTY GLOBAL EXPORTS Ltd.');
    const evidenceUrls = deliverables.map((d: { evidence: string }) => d.evidence);
    expect(evidenceUrls[0]).toBe(EUROPAGES_URL);
  });

  it('uses entity website URL directly when available in directory entry', async () => {
    const nodes = [
      {
        id: 'D1',
        sources: [
          { url: EUROPAGES_URL, title: 'Balen gebruikte kleding', text: 'wholesale second hand clothing bales graded A ' + europagesHtml, listings: Array.from({ length: 10 }, (_, i) => ({ url: `https://www.europages.nl/nl/company/entity-${i}` })) },
        ],
      },
    ];
    let profileRead = false;
    const readPage = async (url: string) => {
      profileRead = true;
      return { text: '', status: 404 };
    };
    const deliverables = await entityDeliverables(nodes as never, {
      terms: ['wholesale second hand clothing', 'bales'],
      kindLabel: 'wholesale clothing provider',
      readPage,
    });
    expect(profileRead).toBe(false);
    const ukEntity = deliverables.find((d: { title: string }) => d.title.includes('UK CLOTHING CARAVAN'));
    expect(ukEntity).toBeTruthy();
    expect(ukEntity!.url).toBe('https://www.ukclothingcaravan.co.uk/');
    expect(ukEntity!.evidence).toBe(EUROPAGES_URL);
  });

  it('falls back to directory profile URL when entity has no website', async () => {
    const customHtml = `<html><body>wholesale second hand clothing bales graded A <script type="application/ld+json">{ "@context":"https://schema.org","@graph":[{"@type":"WebSite","@id":"https://www.europages.nl/#website","url":"https://www.europages.nl","name":"europages.nl"},{"@type":"ItemList","@id":"https://www.europages.nl/ondernemingen/balen-gebruikte-kleding.html#itemlist","name":"balen gebruikte kleding","itemListOrder":"https://schema.org/ItemListOrderAscending","numberOfItems":1,"itemListElement":[{"@type":"ListItem","position":1,"item":{"@type":"Organization","@id":"https://www.europages.nl/nl/company/no-website-123#organization","name":"NO WEBSITE ENTITY","url":"https://www.europages.nl/nl/company/no-website-123","address":{"@type":"PostalAddress","streetAddress":"Test Street","postalCode":"12345","addressLocality":"TestCity","addressCountry":"DE"}}}]}]}</script></body></html>`;
    const nodes = [
      {
        id: 'D1',
        sources: [
          { url: EUROPAGES_URL, title: 'Balen gebruikte kleding', text: customHtml, listings: Array.from({ length: 10 }, (_, i) => ({ url: `https://www.europages.nl/nl/company/entity-${i}` })) },
        ],
      },
    ];
    const deliverables = await entityDeliverables(nodes as never, {
      terms: ['wholesale second hand clothing', 'bales'],
      kindLabel: 'wholesale clothing provider',
      readPage: async () => ({ text: '', status: 404 }),
    });
    const noWebsiteEntity = deliverables.find((d: { title: string }) => d.title.includes('NO WEBSITE ENTITY'));
    expect(noWebsiteEntity).toBeTruthy();
    expect(noWebsiteEntity!.url).toContain('europages.nl/nl/company/no-website-123');
    expect(noWebsiteEntity!.evidence).toBe(EUROPAGES_URL);
  });

  it('delivers the matched deep page as evidence, not the site root', async () => {
    const nodes = [
      {
        id: 'D1',
        sources: [
          { url: 'https://supplier.example/deep/page/about-bales', title: 'About Bales', text: 'We sell wholesale second hand clothing bales graded A.' },
        ],
      },
    ];
    const deliverables = await entityDeliverables(nodes as never, {
      terms: ['wholesale second hand clothing', 'bales'],
      kindLabel: 'wholesale clothing provider',
      readPage: async () => ({ text: '', status: 404 }),
    });
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0].url).toBe('https://supplier.example/');
    expect(deliverables[0].evidence).toBe('https://supplier.example/deep/page/about-bales');
  });

  it('does not treat a page with a single Organization node as a directory', async () => {
    const nodes = [
      {
        id: 'D1',
        sources: [
          { url: 'https://single.example/', title: 'Single Company', text: singleOrgHtml },
        ],
      },
    ];
    const deliverables = await entityDeliverables(nodes as never, {
      terms: ['single company'],
      kindLabel: 'single company',
      readPage: async () => ({ text: '', status: 404 }),
    });
    expect(deliverables).toHaveLength(1);
    expect(deliverables[0].url).toBe('https://single.example/');
    expect(deliverables[0].evidence).toBe('https://single.example/');
  });

  it('falls back to parsed listings when directory page has no JSON-LD', async () => {
    const noJsonLdHtml = '<html><body>wholesale second hand clothing bales graded A <div class="listing">Company 1</div></body></html>';
    const listings = Array.from({ length: 10 }, (_, i) => ({
      url: `https://www.example-dir.com/company/entity-${i}/products/product-a`,
      title: `Entity ${i + 1} - Product A`,
    }));
    // Add second product for each entity to satisfy the ≥2 links rule
    for (let i = 0; i < 5; i++) {
      listings.push({
        url: `https://www.example-dir.com/company/entity-${i}/products/product-b`,
        title: `Entity ${i + 1} - Product B`,
      });
    }
    const nodes = [
      {
        id: 'D1',
        sources: [
          {
            url: 'https://www.example-dir.com/wholesale-clothing',
            title: 'Wholesale Clothing Directory',
            text: noJsonLdHtml,
            listings,
          },
        ],
      },
    ];
    const deliverables = await entityDeliverables(nodes as never, {
      terms: ['wholesale second hand clothing', 'bales'],
      kindLabel: 'wholesale clothing provider',
      readPage: async () => ({ text: '', status: 404 }),
    });
    expect(deliverables).toHaveLength(5);
    const titles = deliverables.map((d: { title: string }) => d.title).sort();
    const expectedTitles = Array.from({ length: 5 }, (_, i) => `Entity ${i + 1} - Product A`).sort();
    expect(titles).toEqual(expectedTitles);
    const urls = deliverables.map((d: { url: string }) => d.url).sort();
    expect(urls).toEqual([
      'https://www.example-dir.com/company/entity-0/products/product-a',
      'https://www.example-dir.com/company/entity-1/products/product-a',
      'https://www.example-dir.com/company/entity-2/products/product-a',
      'https://www.example-dir.com/company/entity-3/products/product-a',
      'https://www.example-dir.com/company/entity-4/products/product-a',
    ].sort());
    for (const d of deliverables) {
      expect(d.evidence).toBe('https://www.example-dir.com/wholesale-clothing');
      expect(d.nodeId).toBe('D1');
    }
  });
});
