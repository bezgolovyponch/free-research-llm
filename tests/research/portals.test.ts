import { describe, expect, it } from 'vitest';
import { listedKind, roundRobin, SEED_PORTALS, seedPortals } from '../../src/research/portals.mjs';

const kind = { label: 'plot of land', terms: ['terreno'] };

describe('seed portals', () => {
  it('offers only verified coastal land portals of the countries the brief names, within the price limit', () => {
    const seeds = seedPortals({ kind, regions: ['ES', 'TR'], coastal: true, valueRange: [0, 20000] });
    expect(new Set(seeds.map((s) => s.country))).toEqual(new Set(['ES', 'TR']));
    expect(seeds.every((s) => s.seed && /^https:\/\//.test(s.url))).toBe(true);
    expect(seeds.some((s) => s.url === 'https://www.pisos.com/venta/terrenos-galicia/hasta-20000/')).toBe(true);
    expect(seedPortals({ kind, regions: ['ES'], coastal: true, valueRange: [0, 50000] }).filter((s) => s.country === 'ES')).toEqual([]);
    expect(seedPortals({ kind: { label: 'used car' }, regions: ['ES'] })).toEqual([]);
    expect(seedPortals(null)).toEqual([]);
    expect(SEED_PORTALS.filter((s) => s.country === 'PT')).toHaveLength(10);
  });

  it('includes Czech seed portals for plot of land with URL builders and no maxPrice filter', () => {
    const czSeeds = seedPortals({ kind, regions: ['CZ'], coastal: false, valueRange: [0, 5000000], unit: 'CZK' });
    expect(czSeeds.length).toBe(2);
    expect(new Set(czSeeds.map((s) => s.url))).toEqual(new Set([
      'https://www.sreality.cz/hledani/prodej/pozemky?cena-do=5000000',
      'https://www.bezrealitky.cz/vypis/nabidka-prodej/pozemek?priceTo=5000000',
    ]));
    expect(czSeeds.every((s) => s.country === 'CZ' && s.seed === true)).toBe(true);
  });

  it('omits price cap from Czech URLs when unit is not CZK', () => {
    const czSeeds = seedPortals({ kind, regions: ['CZ'], coastal: false, valueRange: [0, 20000], unit: 'EUR' });
    expect(new Set(czSeeds.map((s) => s.url))).toEqual(new Set([
      'https://www.sreality.cz/hledani/prodej/pozemky',
      'https://www.bezrealitky.cz/vypis/nabidka-prodej/pozemek',
    ]));
  });

  it('matches car seeds through kind words and filters only the portal whose currency is the brief unit', () => {
    const carKind = { label: 'used car', terms: ['car', 'auto', 'samochod'] };
    const seeds = seedPortals({ kind: carKind, regions: ['DE', 'PL', 'CZ'], valueRange: [2000, 4000], unit: 'EUR' });
    expect(new Set(seeds.map((s) => s.country))).toEqual(new Set(['DE', 'PL', 'CZ']));
    expect(seeds.filter((s) => s.country === 'DE').map((s) => s.url)).toEqual(['https://www.autoscout24.de/lst?pricefrom=2000&priceto=4000&atype=C']);
    expect(seeds.filter((s) => s.country === 'PL').map((s) => s.url)).toEqual(['https://www.otomoto.pl/osobowe']);
    const czech = seeds.filter((s) => s.country === 'CZ').map((s) => s.url);
    expect(czech).toContain('https://auto.bazos.cz/skoda/');
    expect(czech).toContain('https://auto.bazos.cz/volkswagen/');
    expect(czech.every((url) => /^https:\/\/auto\.bazos\.cz\/[a-z]+\/$/.test(url))).toBe(true);
    expect(czech.some((url) => /nahradnidily|pneumatiky|prislusenstvi/.test(url))).toBe(false);
    expect(seeds.every((s) => s.seed === true)).toBe(true);
    expect(seeds.some((s) => /pozemk|terreno|pisos/.test(s.url))).toBe(false);
  });

  it('offers Slovak and Austrian car seed portals priced in euro', () => {
    const carKind = { label: 'used car', terms: ['car', 'auto', 'samochod'] };
    const seeds = seedPortals({ kind: carKind, regions: ['SK', 'AT'], valueRange: [0, 2600], unit: 'EUR' });
    expect(new Set(seeds.map((s) => s.country))).toEqual(new Set(['SK', 'AT']));
    expect(seeds.find((s) => s.country === 'SK')?.url).toBe('https://www.autobazar.eu/vysledky/osobne-vozidla/?price-to=2600');
    expect(seeds.find((s) => s.country === 'AT')?.url).toBe('https://www.willhaben.at/iad/gebrauchtwagen/auto/gebrauchtwagenboerse?PRICE_TO=2600');
    expect(seeds.every((s) => s.seed === true)).toBe(true);
    const plain = seedPortals({ kind: carKind, regions: ['SK', 'AT'], valueRange: [0, 2600], unit: 'CZK' });
    expect(plain.find((s) => s.country === 'SK')?.url).toBe('https://www.autobazar.eu/vysledky/osobne-vozidla/');
    expect(plain.find((s) => s.country === 'AT')?.url).toBe('https://www.willhaben.at/iad/gebrauchtwagen/auto/gebrauchtwagenboerse');
  });

  it('converts the asked range into each seed portal own currency before building its URL', () => {
    const carKind = { label: 'used car', terms: ['car', 'auto', 'samochod'] };
    const convert = (v: number, from: string, to: string) => (from === 'EUR' && to === 'CZK' ? v * 25 : from === 'EUR' && to === 'PLN' ? v * 4.3 : null);
    const seeds = seedPortals({ kind: carKind, regions: ['DE', 'PL', 'CZ'], valueRange: [2000, 4000], unit: 'EUR' }, convert);
    const urlOf = (country: string) => seeds.find((s) => s.country === country)?.url ?? '';
    expect(urlOf('CZ')).toBe('https://auto.bazos.cz/skoda/?hledat=&cenaod=50000&cenado=100000');
    expect(urlOf('DE')).toBe('https://www.autoscout24.de/lst?pricefrom=2000&priceto=4000&atype=C');
    const otomoto = new URL(urlOf('PL'));
    expect(otomoto.searchParams.get('search[filter_float_price:from]')).toBe('8600');
    expect(otomoto.searchParams.get('search[filter_float_price:to]')).toBe('17200');
  });

  it('keeps a seed portal URL unfiltered when no converter is given or the seed currency already matches', () => {
    const carKind = { label: 'used car', terms: ['car', 'auto', 'samochod'] };
    const carBrief = { kind: carKind, regions: ['DE', 'PL', 'CZ'], valueRange: [2000, 4000], unit: 'EUR' };
    const plain = seedPortals(carBrief);
    expect(plain.find((s) => s.country === 'CZ')?.url).toBe('https://auto.bazos.cz/skoda/');
    expect(plain.find((s) => s.country === 'PL')?.url).toBe('https://www.otomoto.pl/osobowe');
    const convert = () => 1;
    const czSeeds = seedPortals({ kind, regions: ['CZ'], coastal: false, valueRange: [0, 5000000], unit: 'CZK' }, convert);
    expect(new Set(czSeeds.map((s) => s.url))).toEqual(new Set([
      'https://www.sreality.cz/hledani/prodej/pozemky?cena-do=5000000',
      'https://www.bezrealitky.cz/vypis/nabidka-prodej/pozemek?priceTo=5000000',
    ]));
  });

  it('keeps Czech plot seeds for a plot brief and offers no car seed', () => {
    const seeds = seedPortals({ kind: { label: 'plot of land', terms: ['land', 'pozemek'] }, regions: ['CZ'] });
    expect(new Set(seeds.map((s) => s.url))).toEqual(new Set([
      'https://www.sreality.cz/hledani/prodej/pozemky',
      'https://www.bezrealitky.cz/vypis/nabidka-prodej/pozemek',
    ]));
    expect(seeds.every((s) => s.country === 'CZ')).toBe(true);
    expect(seeds.some((s) => /bazos|autoscout|otomoto/.test(s.url))).toBe(false);
  });

  it('reaches pisos seeds through a term even when the label words do not match', () => {
    const seeds = seedPortals({ kind: { label: 'parcel', terms: ['terreno'] }, regions: ['ES'] });
    expect(seeds).toHaveLength(8);
    expect(seeds.every((s) => s.country === 'ES' && s.url.includes('pisos.com'))).toBe(true);
  });

  it('interleaves pages by country so no named country waits behind another', () => {
    const pages = [{ c: 'PT', n: 1 }, { c: 'PT', n: 2 }, { c: 'PT', n: 3 }, { c: 'ES', n: 1 }, { c: 'TR', n: 1 }, { c: 'TR', n: 2 }];
    expect(roundRobin(pages, (p) => p.c).map((p) => `${p.c}${p.n}`)).toEqual(['PT1', 'ES1', 'TR1', 'PT2', 'TR2', 'PT3']);
  });
});

describe('listedKind', () => {
  it('knows a kind sold on listing portals from the seed portals, in any country', () => {
    expect(listedKind({ label: 'used car', terms: ['car', 'hatchback'] })).toBe(true);
    expect(listedKind({ label: 'plot of land', terms: ['plot'] })).toBe(true);
    expect(listedKind({ label: 'wholesale clothing provider', terms: ['wholesale second-hand clothing', 'used clothing wholesale'] })).toBe(false);
    expect(listedKind(null)).toBe(false);
  });
});
