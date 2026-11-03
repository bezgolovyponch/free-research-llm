import { describe, expect, it } from 'vitest';
import { coordsOf, extractListings, pagePlace, fromCards, fromEmbeddedJson, fromJsonLd, listingKey, nextPageUrl, pagedNext, pathTemplate } from '../../src/search/listings.mjs';

const BASE = 'https://portal.example/land-for-sale';
const CZ_BASE = 'https://www.sreality.cz/hledani/prodej/pozemky';
const DE_BASE = 'https://www.autoscout24.de/lst?pricefrom=2000&priceto=4000';

function embedded(records: unknown[]) {
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { listings: records } } })}</script>`;
}

function card(id: number, title: string, price: string, area = '') {
  return `<div class="card"><a href="/listing/plot-${id}-u${id}000000"><img src="/i/${id}.jpg"></a><a href="/listing/plot-${id}-u${id}000000">${title}</a><p>${price}</p>${area ? `<span>${area}</span>` : ''}<a href="/agent/7">Agent</a></div>`;
}

describe('listing extraction', () => {
  it('reads listing cards: one row per repeated listing link, price and area from the card text, never the reference code', () => {
    const html = `<nav><a href="/about">About</a></nav>${card(1, 'Sea view plot', 'Ref: PTFS10000 €18.500', '640 m²')}${card(2, 'Rustic land', '₫ 1.5 billion', '2 ha')}${card(3, 'Olive grove', '9 500 €')}<a href="/land-for-sale?page=2">2</a>`;
    const { items, template } = fromCards(html, BASE);
    expect(template).toBe('portal.example/listing/*');
    expect(items.map((i: { title: string; value: number; unit: string; area: number; areaUnit: string }) => [i.title, i.value, i.unit, i.area, i.areaUnit])).toEqual([
      ['Sea view plot', 18500, 'EUR', 640, 'm²'],
      ['Rustic land', 1_500_000_000, 'VND', 2, 'ha'],
      ['Olive grove', 9500, 'EUR', null, ''],
    ]);
  });

  it('ignores link groups smaller than three, so a page with one ad is not a portal', () => {
    expect(fromCards(card(1, 'Plot', '€1'), BASE).items).toEqual([]);
  });

  it('reads markdown from the reader the same way', () => {
    const md = ['[Plot A](https://portal.example/listing/a-u1000000) 12 000 €', '[Plot B](https://portal.example/listing/b-u2000000) 15 000 €', '[Plot C](https://portal.example/listing/c-u3000000) 19 000 €', '[Next](https://portal.example/land-for-sale?page=2)'].join('\n');
    const result = extractListings(md, BASE, { isHtml: false });
    expect(result.items.map((i: { value: number }) => i.value)).toEqual([12000, 15000, 19000]);
    expect(result.next).toBe('https://portal.example/land-for-sale?page=2');
  });

  it('reads schema.org JSON-LD offers with currency, skipping site and agent records', () => {
    const ld = { '@graph': [
      { '@type': 'Organization', name: 'Portal', url: 'https://portal.example/' },
      { '@type': 'RealEstateAgent', name: 'Portal', url: 'https://portal.example' },
      { '@type': 'Product', offers: { '@type': 'AggregateOffer', offers: [
        { '@type': 'Offer', name: 'Plot by the bay', url: 'https://portal.example/listing/bay-ID1abcd', price: 14000, priceCurrency: 'EUR' },
        { '@type': 'Offer', name: 'Hill plot', url: 'https://portal.example/listing/hill-ID1efgh', price: '9.500', priceCurrency: 'EUR' },
      ] } },
      { '@type': 'SingleFamilyResidence', name: 'Field', url: 'https://portal.example/listing/field-u5555555', floorSize: { value: 4000 } },
    ] };
    const html = `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
    expect(fromJsonLd(html, BASE)).toEqual([
      { title: 'Plot by the bay', url: 'https://portal.example/listing/bay-ID1abcd', value: 14000, unit: 'EUR', area: null, place: '' },
      { title: 'Hill plot', url: 'https://portal.example/listing/hill-ID1efgh', value: 9500, unit: 'EUR', area: null, place: '' },
      { title: 'Field', url: 'https://portal.example/listing/field-u5555555', value: null, unit: '', area: 4000, place: '' },
    ]);
  });

  it('keeps the coordinates a listing record states', () => {
    const ld = { '@type': 'Product', name: 'Plot by the bay', url: 'https://portal.example/listing/bay-ID1abcd', offers: { price: 14000, priceCurrency: 'EUR' }, geo: { '@type': 'GeoCoordinates', latitude: '44.3012', longitude: '15.0912' } };
    expect(fromJsonLd(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`, BASE)[0]).toMatchObject({ lat: 44.3012, lon: 15.0912 });
    expect(coordsOf({ location: { lat: 0, lng: 0 } })).toBeNull();
    expect(coordsOf({ address: { geo: { lat: 38.2, lng: -7.68 } } })).toEqual({ lat: 38.2, lon: -7.68 });
  });

  it('finds the place a listing page states, in its address data or its title', () => {
    expect(pagePlace('<title>Land in Thuan Giao, Binh Duong ₫ 480,000,000 | Dot Property</title>')).toBe('Thuan Giao, Binh Duong');
    expect(pagePlace('<title>Plot of land for sale in Porto Santo, Madeira, Portugal | Mer et Demeures</title>')).toBe('Porto Santo, Madeira, Portugal');
    expect(pagePlace('<script type="application/ld+json">{"@type":"Product","address":{"@type":"PostalAddress","addressLocality":"Vir","addressRegion":"Zadarska"}}</script><title>x</title>')).toBe('Vir, Zadarska');
    expect(pagePlace('<title>Terreno para venda</title>')).toBe('');
    expect(pagePlace('Title: Sea view plot for sale in Porto Santo, Madeira | Agency\n\nURL Source: https://agency.example/1')).toBe('Porto Santo, Madeira');
  });

  it('reads the records a site embeds for its own app and finds each record link among the page anchors', () => {
    const records = [1, 2, 3].map((n) => ({ id: n, title: `Terreno ${n}`, href: `[lang]/ad/terreno-${n}-ID1x${n}yz`, totalPrice: { value: n * 5000, currency: 'EUR' }, areaInSquareMeters: n * 1000, location: { reverseGeocoding: { locations: [{ fullName: 'Faro' }, { fullName: `Faro, Loulé ${n}` }] } } }));
    const next = { props: { pageProps: { data: { searchAds: { items: records, pagination: { currentPage: 1, totalPages: 9 } } } } } };
    const anchors = [1, 2, 3].map((n) => `<a href="/pt/anuncio/terreno-${n}-ID1x${n}yz">Terreno ${n}</a>`).join('');
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>${anchors}`;
    expect(fromEmbeddedJson(html, 'https://imo.example/pt/resultados')).toEqual([1, 2, 3].map((n) => ({ title: `Terreno ${n}`, url: `https://imo.example/pt/anuncio/terreno-${n}-ID1x${n}yz`, value: n * 5000, unit: 'EUR', area: n * 1000, place: `Faro, Loulé ${n}` })));
    expect(pagedNext(html, 'https://imo.example/pt/resultados')).toBe('https://imo.example/pt/resultados?page=2');
    expect(pagedNext(html.replace('"currentPage":1', '"currentPage":9'), 'https://imo.example/pt/resultados')).toBe('');
  });

  it('merges the same listing found by several methods into one row that keeps every field', () => {
    const ld = { '@type': 'ItemList', itemListElement: [1, 2, 3].map((n) => ({ '@type': 'ListItem', item: { '@type': 'Residence', name: `Land ${n}`, url: `https://portal.example/en/real_estate/${n}00000-gpt` } })) };
    const cards = [1, 2, 3].map((n) => `<div><a href="/real_estate/${n}00000-farm-land-${n}">Farm land ${n}</a><p>$${n}0.000</p></div>`).join('');
    const { items, methods } = extractListings(`<script type="application/ld+json">${JSON.stringify(ld)}</script>${cards}`, BASE);
    expect(methods).toEqual(['json-ld', 'cards']);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ title: 'Land 1', url: 'https://portal.example/real_estate/100000-farm-land-1', value: 10000, unit: 'USD', via: ['json-ld', 'cards'] });
  });

  it('finds the next page from rel=next, a "next" link or the page number', () => {
    expect(nextPageUrl('<link rel="next" href="/land?page=2">', BASE)).toBe('https://portal.example/land?page=2');
    expect(nextPageUrl('<a href="/land/p/2">Siguiente</a>', BASE)).toBe('https://portal.example/land/p/2');
    expect(nextPageUrl('<a href="/land?pagina=3">3</a><a href="/land?pagina=2">2</a>', BASE)).toBe('https://portal.example/land?pagina=2');
    expect(nextPageUrl('<a href="/land?page=4">4</a>', 'https://portal.example/land?page=3')).toBe('https://portal.example/land?page=4');
    expect(nextPageUrl('<a href="/other">x</a>', BASE)).toBe('');
  });

  it('keys a listing by its site id, so the same ad under two paths counts once', () => {
    expect(listingKey('https://www.imo.example/pt/comprar/terreno-x-ID1hlDh')).toBe(listingKey('https://imo.example/pt/anuncio/terreno-x-ID1hlDh'));
    expect(listingKey('https://a.example/real_estate/125161-gpt')).toBe(listingKey('https://a.example/real_estate/125161-orange-grove'));
    expect(pathTemplate('https://a.example/announces/other-real+estate-catalonia-spain/107193361/')).toBe('a.example/announces/~/*');
  });

  it('reads the largest stated area of a page in square metres, hectares included', async () => {
    const { areaFromText } = await import('../../src/search/listings.mjs');
    expect(areaFromText('Área bruta 120 m² · Área do terreno: 2 500 m²')).toBe(2500);
    expect(areaFromText('Muğla Menteşe Göktepede 2.521,95 M² Satılık Tarla')).toBe(2522);
    expect(areaFromText('Satılık 1.401 M2 Tarla')).toBe(1401);
    expect(areaFromText('Terreno rústico com 2 ha')).toBe(20000);
    expect(areaFromText('no area here')).toBeNull();
  });

  it('reads sreality.cz embedded JSON with priceCzk, coordinates and strips site suffix from title', () => {
    const records = [1, 2, 3].map((n) => ({
      priceCzk: 460000 + n * 1000,
      latitude: 50.371607 + n * 0.001,
      longitude: 13.866084 + n * 0.001,
      name: `Prodej zahrady ${463 + n} m², Obora`,
      href: `/detail/prodej/pozemek/zahrada/obora-obora-/227442695${n}`,
    }));
    const nextData = { props: { pageProps: { data: { searchAds: { items: records } } } } };
    const anchors = records.map((r) => `<a href="${r.href}">${r.name} • Sreality.cz</a>`).join('');
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>${anchors}`;
    const items = fromEmbeddedJson(html, CZ_BASE);
    expect(items.length).toBe(3);
    expect(items[0]).toMatchObject({
      title: 'Prodej zahrady 464 m², Obora',
      url: 'https://www.sreality.cz/detail/prodej/pozemek/zahrada/obora-obora-/2274426951',
      value: 461000,
      unit: 'CZK',
      lon: 13.867084,
    });
    expect(items[0].lat).toBeCloseTo(50.372607, 5);
  });

  it('reads autoscout24 listing prices from priceRaw and infers the currency from priceFormatted', () => {
    const listing = (id: string, slug: string, priceRaw: number, priceFormatted: string) => ({
      url: `/angebote/${slug}-${id}`,
      id,
      price: { priceFormatted, priceEvaluation: 1, priceRaw, isConditionalPrice: false },
      tracking: { price: String(priceRaw) },
      vehicle: { make: 'Peugeot', model: '208' },
    });
    const records = [
      listing('d0b6741d-3dd5-47ce-804b-718ffdbb7507', 'peugeot-208-tuev-7-27-2-zonen-leder-tempo-pdc-diesel-silber-cat_ma55gr201150ge1074va3624mt3255tr480648', 2999, '€ 2.999'),
      listing('5f1c2a9e-1b0d-4a3c-9e2f-7d6b8c0a1e23', 'seat-leon-1-5-tsi-xcellence-led-shz-kamera-tempomat-silber-cat_ma55gr201150ge1074va3624mt3255tr480649', 3499, '€ 3.499'),
      listing('8a7b6c5d-4e3f-2a1b-9c8d-7e6f5a4b3c2d', 'ford-focus-1-0-ecoboost-st-line-navi-pdc-blau-cat_ma55gr201150ge1074va3624mt3255tr480650', 3899, '€ 3.899'),
    ];
    const items = fromEmbeddedJson(embedded(records), DE_BASE);
    expect(items.map((i) => i.value)).toEqual([2999, 3499, 3899]);
    expect(items.map((i) => i.unit)).toEqual(['EUR', 'EUR', 'EUR']);
    expect(items.map((i) => i.url)).toEqual(records.map((r) => `https://www.autoscout24.de${r.url}`));
    expect(items.every((i) => new URL(i.url).hostname === 'www.autoscout24.de')).toBe(true);
  });

  it('reads a złoty price from priceFormatted when the record states no currency field', () => {
    const records = [1, 2, 3].map((n) => ({
      url: `/angebote/skoda-octavia-1-5-tsi-${n}-0b6741d-3dd5-47ce-804b-718ffdbb750${n}`,
      price: { priceFormatted: 'zł 12 500', priceRaw: 12500, isConditionalPrice: false },
    }));
    const items = fromEmbeddedJson(embedded(records), 'https://www.autoscout24.pl/lst?pricefrom=10000&priceto=20000');
    expect(items.map((i) => [i.value, i.unit])).toEqual([[12500, 'PLN'], [12500, 'PLN'], [12500, 'PLN']]);
  });

  it('keeps the listing anchor titles when the page title is script code', () => {
    const html = `
      <meta property="og:title" content="Prodej pozemku 500 m², Praha">
      <title>slide.classList.remove('is-transition-from', 'is-transition-to')); },</title>
      <h1>Prodej pozemku 500 m², Praha</h1>
      <a href="/listing/plot-1-u1000000">Prodej pozemku 500 m², Praha</a>
      <a href="/listing/plot-2-u2000000">Prodej pozemku 600 m², Brno</a>
      <a href="/listing/plot-3-u3000000">Prodej pozemku 700 m², Ostrava</a>
    `;
    const { items } = fromCards(html, BASE);
    expect(items.length).toBe(3);
    expect(items[0].title).toBe('Prodej pozemku 500 m², Praha');
    expect(items[0].title).not.toContain('classList');
  });

  it('starts a card at its data-lnk-href container, so a price shown before the title link stays with its own listing', () => {
    const card = (n: number, price: string) => `<div class="ad-preview" data-lnk-href="/listing/plot-${n}-u${n}000000"><span class="price">${price} €</span><a href="/listing/plot-${n}-u${n}000000">Terreno ${n}</a><p>${n}00 m²</p></div>`;
    const { items } = fromCards(card(1, '20.000') + card(2, '9.500') + card(3, '12.000'), BASE);
    expect(items.map((i) => [i.title, i.value])).toEqual([['Terreno 1', 20000], ['Terreno 2', 9500], ['Terreno 3', 12000]]);
  });

  it('rejects titles with arrow functions and brace pairs', () => {
    const html = `<a href="/listing/plot-1-u1000000">() => { return x; }</a><a href="/listing/plot-2-u2000000">() => { return x; }</a><a href="/listing/plot-3-u3000000">() => { return x; }</a>`;
    const { items } = fromCards(html, BASE);
    expect(items.length).toBe(3);
    expect(items.every((i) => i.title === i.url)).toBe(true);
  });

  it('rejects titles containing function keyword', () => {
    const html = `<a href="/listing/plot-1-u1000000">function foo() {}</a><a href="/listing/plot-2-u2000000">function foo() {}</a><a href="/listing/plot-3-u3000000">function foo() {}</a>`;
    const { items } = fromCards(html, BASE);
    expect(items.length).toBe(3);
    expect(items.every((i) => i.title === i.url)).toBe(true);
  });

  it('strips Sreality.cz suffix from titles in JSON-LD', () => {
    const ld = { '@type': 'Product', name: 'Prodej pozemku 500 m² • Sreality.cz', url: 'https://www.sreality.cz/detail/prodej/pozemek/123456', offers: { price: 100000, priceCurrency: 'CZK' } };
    const html = `<a href="https://www.sreality.cz/detail/prodej/pozemek/123456">Prodej pozemku 500 m² • Sreality.cz</a><script type="application/ld+json">${JSON.stringify(ld)}</script>`;
    const items = fromJsonLd(html, CZ_BASE);
    expect(items.length).toBe(1);
    expect(items[0].title).toBe('Prodej pozemku 500 m²');
  });
});
