import { describe, expect, it } from 'vitest';
import { MARKETPLACES, MarketplaceService, extractListings, listingStats, listingsSource, trendLine, yearOf } from '../../src/search/marketplaces.mjs';
import { fakeFetch } from '../helpers/fake-fetch';

const market = (id: string) => MARKETPLACES.find((m) => m.id === id)!;
const KLEIN = '<ul><li><a href="/s-anzeige/vw-golf-5-1-6/3545266662-216-6326">14</a> Golf 5 1.6 EZ 2006 TÜV 06/2027 178.000 km 2.950 € VB</li><li><a href="/s-anzeige/vw-golf-4-variant/3545264968-216-2777">9</a> Golf 4 Variant 2003 6.500 €</li></ul>';
const AAA = '<script type="application/ld+json">{"@graph":[{"@type":["Product","Car"],"name":"Volkswagen Golf 1.4 TSI","url":"https://www.aaaauto.cz/detail/volkswagen/golf/34890979?utm_source=x","dateVehicleFirstRegistered":"2010","mileageFromOdometer":{"value":145444},"offers":{"@type":"Offer","price":70000,"priceCurrency":"CZK"}}]}</script><a href="/detail/volkswagen/golf/34890979#/ojete-vozy">x</a>';

describe('marketplace extraction', () => {
  it('reads listing cards: slug title, first price in the market currency, registration year, mileage', () => {
    const [golf5] = extractListings(KLEIN, 'https://www.kleinanzeigen.de/s-autos/golf/k0c216', market('kleinanzeigen'));
    expect(extractListings('<a href="/s-anzeige/a-b-c/1-216-1">x</a> 2013 104 999 km 3 500 €', 'https://www.kleinanzeigen.de/', market('kleinanzeigen'))[0].km).toBe(104999);
    expect(golf5).toMatchObject({ title: 'vw golf 5 1 6', url: 'https://www.kleinanzeigen.de/s-anzeige/vw-golf-5-1-6/3545266662-216-6326', price: 2950, currency: 'EUR', year: 2006, km: 178000, country: 'DE' });
  });

  it('prefers schema.org structured data over card text', () => {
    expect(extractListings(AAA, 'https://www.aaaauto.cz/ojete-vozy/volkswagen/golf/', market('aaaauto'))).toEqual([
      { title: 'Volkswagen Golf 1.4 TSI', url: 'https://www.aaaauto.cz/detail/volkswagen/golf/34890979', price: 70000, currency: 'CZK', year: 2010, km: 145444, marketplace: 'aaaauto', country: 'CZ', structured: true },
    ]);
  });

  it('ignores posting dates and inspection dates when reading the year', () => {
    expect(yearOf('Octavia [18.10. 2026] TÜV 06/2027 Baujahr 2011', 2026)).toBe(2011);
    expect(yearOf('no year here')).toBeNull();
  });

  it('searches only robots-allowed pages, converts to EUR, filters the range and model in code', async () => {
    const fetchImpl = fakeFetch([
      [/kleinanzeigen\.de\/robots/, () => new Response('User-agent: *\nDisallow: /*/preis:*')],
      [/kleinanzeigen\.de\/s-autos/, () => new Response(KLEIN, { headers: { 'content-type': 'text/html' } })],
      [/aaaauto\.cz\/robots/, () => new Response('', { status: 404 })],
      [/aaaauto\.cz\/ojete-vozy/, () => new Response(AAA, { headers: { 'content-type': 'text/html' } })],
      [/bazos\.cz\/robots/, () => new Response('User-agent: *\nDisallow: /')],
    ]);
    const robots = { allowed: async (url: string) => !/bazos/.test(url) };
    const rates = { converter: async () => (v: number, from: string, to: string) => (from === to ? v : from === 'CZK' ? v / 25 : v * 25) };
    const service = new MarketplaceService({ fetchImpl, robots, rates });
    const results = await service.search({ countries: [], minEur: 2000, maxEur: 4000, make: 'Volkswagen', model: 'Golf' });
    const byMarket = Object.fromEntries(results.map((r: { market: string }) => [r.market, r]));
    expect(byMarket.kleinanzeigen.listings.map((l: { price: number }) => l.price)).toEqual([2950]);
    expect(byMarket.aaaauto.listings[0].priceEur).toBe(2800);
    expect(byMarket.bazos.listings).toEqual([]);
    expect(service.lastErrors.join()).toMatch(/bazos: robots\.txt disallows/);
    expect(fetchImpl.calls.some((c) => /preis:/.test(c.url))).toBe(false);
  });

  it('builds a citable data source with stats, links and the price trend', () => {
    const listings = [{ title: 'a', url: 'https://k.example/1', price: 3000, currency: 'EUR', priceEur: 3000, year: 2008, km: 1 }, { title: 'b', url: 'https://k.example/2', price: 2000, currency: 'EUR', priceEur: 2000, year: 2007, km: 2 }];
    const stats = listingStats(listings);
    expect(stats).toEqual({ count: 2, priced: 2, medianEur: 2500, minEur: 2000, maxEur: 3000 });
    expect(trendLine([{ ts: '2026-10-01T00:00:00Z', medianEur: 2000, count: 5 }], stats)).toBe('trend: median 2000 EUR on 2026-10-01 → 2500 EUR now (+25.0%, 2 snapshots); listings 5 → 2');
    const source = listingsSource({ market: 'kleinanzeigen', country: 'DE', pages: ['https://k.example/s'], listings, stats }, 'S1');
    expect(source).toMatchObject({ kind: 'data', provider: 'marketplace', domain: 'k.example' });
    expect(source.links.map((l: { url: string }) => l.url)).toEqual(['https://k.example/1', 'https://k.example/2']);
    expect(source.text).toContain('a | 3000 EUR | 2008 | 1 km | https://k.example/1');
  });
});
