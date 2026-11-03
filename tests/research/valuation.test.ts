import { describe, expect, it } from 'vitest';
import { conditionOf, listingFacts, marketSample, theilSen, valueListing, valueTable } from '../../src/research/valuation.mjs';
import { verifiedGroupFacts } from '../../src/research/engine.mjs';

describe('facts a listing states', () => {
  it('reads year, mileage, power, engine and fuel from real titles and descriptions', () => {
    expect(listingFacts({ title: 'ŠKODA FABIA COMBI 1,9 TDi, 47kW, R.2006, PLATNÁ STK do 2028' })).toEqual({ year: 2006, km: null, kw: 47, engine: '1.9 tdi', fuel: 'diesel' });
    expect(listingFacts({ title: 'Škoda Fabia 1, 1.4mpi 55kw' })).toMatchObject({ kw: 55, engine: '1.4 mpi', fuel: 'petrol' });
    expect(listingFacts({ title: 'Toyota Yaris 1.0 VVTi, 250 tis km' })).toMatchObject({ km: 250000, engine: '1.0 vvti' });
    expect(listingFacts({ title: 'Kia Rio 1.4 - nová STK, 112 tkm, dobrý stav', attrs: { description: 'Spolehlivá Kia Rio 1.4 16V 74 kW, rok 2006 - najeto ověřených 112.000', date: '- TOP - [3.11. 2026]' } })).toMatchObject({ year: 2006, km: 112000, kw: 74 });
  });

  it('never takes an ad date or an inspection date for the model year', () => {
    expect(listingFacts({ title: 'Kia picanto 2010' }).year).toBe(2010);
    expect(listingFacts({ title: 'Honda Civic 1.6', attrs: { date: '[3.11. 2026]', description: 'STK do 08/2027' } }).year).toBeNull();
  });
});

describe('market value from comparable listings', () => {
  const ad = (title: string, value: number, i: number) => ({ title, value, unit: 'CZK', url: `https://auto.bazos.cz/inzerat/2259${i}0000/x.php` });
  const market = [
    ad('Dacia Sandero 2009 160000 km', 45000, 1), ad('Dacia Sandero 2009 170000 km', 47000, 2), ad('Dacia Sandero 2009 150000 km', 46000, 3),
    ad('Dacia Sandero 2013 90000 km', 85000, 4), ad('Dacia Sandero 2012 100000 km', 80000, 5), ad('Dacia Sandero 2008 200000 km', 38000, 6),
    ad('Dacia Sandero 2010 140000 km', 52000, 7), ad('Dacia Sandero 2015 60000 km', 120000, 8),
  ];

  it('estimates a robust per-year slope from the market (Theil–Sen)', () => {
    expect(theilSen([[1, 1], [2, 2], [3, 3], [4, 4], [5, 50]])).toBe(1);
    const sample = marketSample(market, ['dacia sandero']);
    expect(sample.get('dacia sandero')!.slopes.year).toBeGreaterThan(0.05);
  });

  it('values a listing from comparables adjusted to its own year and mileage, and highlights a confident bargain', () => {
    const sample = marketSample(market, ['dacia sandero']);
    const row = valueListing(ad('Dacia Sandero 2009 165000 km', 25000, 9), sample, { models: ['dacia sandero'] });
    expect(row.marketValue).toBeGreaterThan(40000);
    expect(row.marketValue).toBeLessThan(55000);
    expect(row.underpriced).toBeGreaterThan(1.6);
    expect(row.highlight).toMatch(/^underpriced: worth about/);
    expect(row.valueNotes[0]).toMatch(/adjusted to this listing's year and mileage/);
  });

  it('does not value a listing that states neither year nor mileage', () => {
    const sample = marketSample(market, ['dacia sandero']);
    const row = valueListing(ad('Dacia Sandero', 25000, 10), sample, { models: ['dacia sandero'] });
    expect(row.marketValue).toBeUndefined();
    expect(row.valueNotes).toEqual(['not enough facts stated to value: the listing gives neither the year nor the mileage']);
  });

  it('never highlights a listing whose own text states a bad condition, and ranks it last', () => {
    const rows = [ad('Dacia Sandero 2009 165000 km na doježdění', 15000, 11), ad('Dacia Sandero 2009 160000 km', 30000, 12)];
    expect(conditionOf(rows[0], ['na dojezdeni'])).toEqual(['na dojezdeni']);
    const table = valueTable(rows, market, { models: ['dacia sandero'], condition: ['na dojezdeni'] });
    expect(table.map((r) => r.value)).toEqual([30000, 15000]);
    expect(table[1].highlight).toBeUndefined();
    expect(table[1].valueNotes).toContain('condition stated in the listing: na dojezdeni — the price reflects it, so it is not shown as underpriced');
  });

  it('applies owner and expert facts for the listing engine with their source, as a labelled adjustment', () => {
    const sample = marketSample(market, ['dacia sandero']);
    const groupFacts = { 'dacia sandero': { at: '2026-11-03', facts: [{ engine: '1.4', verdict: 'reliable', note: 'simple MPI engine, long life', quote: 'The 1.4 MPI is a simple and long-lived engine.', source: 'https://forum.example/sandero' }] } };
    const plain = valueListing(ad('Dacia Sandero 1.4 MPI 2009 165000 km', 25000, 13), sample, { models: ['dacia sandero'] });
    const known = valueListing(ad('Dacia Sandero 1.4 MPI 2009 165000 km', 25000, 13), sample, { models: ['dacia sandero'], groupFacts });
    expect(known.marketValue).toBe(Math.round(plain.marketValue! * 1.1));
    expect(known.valueNotes.join(' ')).toContain('https://forum.example/sandero');
    expect(known.valueNotes.join(' ')).toContain('assumption');
  });
});

describe('owner and expert facts are kept only with a quote found on the page', () => {
  it('drops a fact whose quote is not on its page', () => {
    const sources = [{ id: 'G1', url: 'https://forum.example/fabia', text: 'Majitelé uvádějí: Motor 1.2 HTP má problémy s rozvodovým řetězem už kolem 100 tisíc km.' }];
    const facts = verifiedGroupFacts([
      { engine: '1.2 HTP', verdict: 'problematic', note: 'timing chain wear', quote: 'Motor 1.2 HTP má problémy s rozvodovým řetězem už kolem 100 tisíc km.', sourceId: 'G1' },
      { engine: '1.9 TDI', verdict: 'reliable', note: 'durable', quote: 'The 1.9 TDI lasts forever according to everyone.', sourceId: 'G1' },
    ], sources);
    expect(facts).toEqual([{ engine: '1.2 HTP', verdict: 'problematic', note: 'timing chain wear', quote: 'Motor 1.2 HTP má problémy s rozvodovým řetězem už kolem 100 tisíc km.', source: 'https://forum.example/fabia' }]);
  });
});
