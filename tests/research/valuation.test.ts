import { describe, expect, it } from 'vitest';
import { MIN_CALIBRATION, MIN_SLOPE_POINTS, adText, calibrate, conditionOf, listingFacts, marketSample, pooledSlopes, theilSen, valueListing, valueTable } from '../../src/research/valuation.mjs';
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
  const priced = (year: number, km: number) => Math.round(100000 * 1.1 ** (year - 2012) * (km / 100000) ** -0.3);
  const market = Array.from({ length: 36 }, (_, i) => {
    const year = 2006 + (i % 7);
    const km = 90000 + ((i * 37) % 11) * 15000;
    return ad(`Dacia Sandero ${year} ${km} km`, priced(year, km) + ((i % 3) - 1) * 500, 100 + i);
  });

  it('measures age and mileage effects within each model only from enough dated listings (Theil–Sen)', () => {
    expect(theilSen([[1, 1], [2, 2], [3, 3], [4, 4], [5, 50]])).toBe(1);
    const sample = marketSample(market, ['dacia sandero']);
    expect(Math.exp(sample.slopes.year!) - 1).toBeGreaterThan(0.08);
    expect(Math.exp(sample.slopes.year!) - 1).toBeLessThan(0.12);
    expect(sample.slopes.km!).toBeLessThan(-0.2);
    expect(sample.slopes.km!).toBeGreaterThan(-0.4);
    const thin = pooledSlopes(marketSample(market.slice(0, MIN_SLOPE_POINTS - 1), ['dacia sandero']).values());
    expect(thin.year).toBeNull();
    expect(thin.km).toBeNull();
  });

  it('values a listing from other listings of nearby years and flags it only below an interval calibrated on the method\'s own errors (jackknife)', () => {
    const sample = marketSample(market, ['dacia sandero']);
    const calibration = calibrate(sample);
    expect(calibration.n).toBeGreaterThanOrEqual(MIN_CALIBRATION);
    const row = valueListing(ad('Dacia Sandero 2009 165000 km', 25000, 9), sample, { models: ['dacia sandero'], calibration });
    expect(row.marketValue! % 1000).toBe(0);
    expect(row.marketRange![0]).toBeLessThanOrEqual(row.marketValue!);
    expect(row.marketRange![1]).toBeGreaterThanOrEqual(row.marketValue!);
    expect(Math.abs(row.marketValue! - priced(2009, 165000))).toBeLessThan(5000);
    expect(row.valueConfidence).toBe('high');
    expect(row.highlight).toMatch(/^asks below the 80% interval of comparable asking prices/);
    expect(row.valueNotes.join(' ')).toContain('Annals of Statistics 49(1), 2021');
    expect(row.valueNotes.join(' ')).toContain('lemons penalty');
    const fair = valueListing(ad('Dacia Sandero 2009 165000 km', priced(2009, 165000), 8), sample, { models: ['dacia sandero'], calibration });
    expect(fair.highlight).toBeUndefined();
  });

  it('flags nothing when the market\'s own errors are as wide as the gap, or when too few listings calibrate the interval', () => {
    const noisy = market.map((r, i) => ({ ...r, value: Math.round(r.value * (i % 2 ? 1.8 : 0.55)) }));
    const sample = marketSample(noisy, ['dacia sandero']);
    const row = valueListing(ad('Dacia Sandero 2009 165000 km', Math.round(priced(2009, 165000) * 0.6), 9), sample, { models: ['dacia sandero'], calibration: calibrate(sample) });
    expect(row.highlight).toBeUndefined();
    const thin = marketSample(market.slice(0, 20), ['dacia sandero']);
    const few = calibrate(thin);
    expect(few.low).toBeNull();
    const unflagged = valueListing(ad('Dacia Sandero 2009 165000 km', 5000, 9), thin, { models: ['dacia sandero'], calibration: few });
    expect(unflagged.highlight).toBeUndefined();
    expect(unflagged.marketRange).toBeUndefined();
  });

  it('never counts a listing as its own comparable, even when the market holds copies of it', () => {
    const row = ad('Dacia Sandero 2009 165000 km', 25000, 9);
    const clean = valueListing(row, marketSample(market, ['dacia sandero']), { models: ['dacia sandero'] });
    const copies = valueListing(row, marketSample([...market, row, row, { ...row, url: `${row.url}?ref=list` }], ['dacia sandero']), { models: ['dacia sandero'] });
    expect(copies.marketValue).toBe(clean.marketValue);
    expect(copies.underpriced).toEqual(clean.underpriced);
  });

  it('gives no value without the listing year or without five dated comparables of nearby years', () => {
    const sample = marketSample(market, ['dacia sandero']);
    expect(valueListing(ad('Dacia Sandero', 25000, 10), sample, { models: ['dacia sandero'] })).toMatchObject({ valueNotes: ['no value: the listing does not state its year, and age drives the price'] });
    const few = marketSample(market.slice(0, 8), ['dacia sandero']);
    const row = valueListing(ad('Dacia Sandero 2009 165000 km', 25000, 9), few, { models: ['dacia sandero'] });
    expect(row.marketValue).toBeUndefined();
    expect(row.valueNotes[0]).toMatch(/^no value: \d other dacia sandero listing\(s\) state a year within ±1 of 2009; 5 are needed$/);
  });

  it('reads year and mileage from the ad text after its title and stops at its price, not from the seller\'s other ads', () => {
    const page = 'Škoda Fabia 2 facelift 2013 | bazos.cz menu auto ... Škoda Fabia 2 facelift 2013 - [3.11. 2026] prodám pěknou fabii, najeto 165000km, technická do 5/27. Cena: 49 990 Kč další inzeráty uživatele BMW 3 E90 325i 2005 najeto 300 000 km';
    expect(adText(page, 'Škoda Fabia 2 facelift 2013', 49990)).not.toContain('bmw');
    expect(listingFacts({ title: '', attrs: { description: adText(page, 'Škoda Fabia 2 facelift 2013', 49990) } })).toMatchObject({ year: 2013, km: 165000 });
    expect(adText(page, 'Toyota Yaris', 30000)).toBe('');
  });

  it('reads the year and mileage forms real ads use, and never an inspection date', () => {
    const facts = (d: string) => listingFacts({ title: '', attrs: { description: d } });
    for (const [d, year] of [['uvedení do provozu 04/2009', 2009], ['vyrobenou v roce 2009', 2009], ['rok výroby 7/2012', 2012], ['modelový rok 2007', 2007], ['r.v.3-06', 2006], ['r.v. 11/05', 2005], ['m.2011', 2011], ['Erstzulassung 05/2010', 2010], ['rok produkcji 2009', 2009]] as const) expect(facts(d).year).toBe(year);
    for (const [d, km] of [['najeto 164.000km', 164000], ['Stav tachometru: 262 000 km', 262000], ['107xxx km', 107000], ['naj 170tis', 170000], ['142 tis. km', 142000], ['przebieg 185 000 km', 185000], ['najeto 240-tis', 240000]] as const) expect(facts(d).km).toBe(km);
    expect(facts('STK do 04/2027').year).toBeNull();
    expect(facts('1198 cm³ 67ps 44kw').kw).toBe(44);
    expect(facts('rok 2004, najeto 2000 km').km).toBeNull();
  });

  it('never highlights a listing whose own text states a bad condition, and ranks it last', () => {
    const rows = [ad('Dacia Sandero 2009 165000 km na doježdění', 15000, 11), ad('Dacia Sandero 2009 160000 km', 30000, 12)];
    expect(conditionOf(rows[0], ['na dojezdeni'])).toEqual(['na dojezdeni']);
    const table = valueTable(rows, market, { models: ['dacia sandero'], condition: ['na dojezdeni'] });
    expect(table.map((r) => r.value)).toEqual([30000, 15000]);
    expect(table[1].highlight).toBeUndefined();
    expect(table[1].valueNotes).toContain('condition stated in the listing: na dojezdeni — the price reflects it, so it is not flagged');
  });

  it('shows quoted owner and expert facts with their source but never changes the value with them', () => {
    const sample = marketSample(market, ['dacia sandero']);
    const groupFacts = { 'dacia sandero': { at: '2026-11-03', facts: [{ engine: '1.4', verdict: 'reliable', note: 'simple MPI engine, long life', quote: 'The 1.4 MPI is a simple and long-lived engine.', source: 'https://forum.example/sandero' }] } };
    const plain = valueListing(ad('Dacia Sandero 1.4 MPI 2009 165000 km', 25000, 13), sample, { models: ['dacia sandero'] });
    const known = valueListing(ad('Dacia Sandero 1.4 MPI 2009 165000 km', 25000, 13), sample, { models: ['dacia sandero'], groupFacts });
    expect(known.marketValue).toBe(plain.marketValue);
    expect(known.valueNotes.join(' ')).toContain('https://forum.example/sandero');
    expect(known.valueNotes.join(' ')).toContain('not used in the value');
  });
});

describe('owner and expert facts are kept only with a quote found on the page', () => {
  it('drops a fact whose quote is not on its page', () => {
    const sources = [{ id: 'G1', url: 'https://forum.example/fabia', text: 'Majitelé uvádějí: Motor 1.2 HTP má problémy s rozvodovým řetězem už kolem 100 tisíc km.' }];
    const facts = verifiedGroupFacts([
      { engine: '1.2 HTP', verdict: 'problematic', note: 'timing chain wear', quote: 'Motor 1.2 HTP má problémy s rozvodovým řetězem už kolem 100 tisíc km.', sourceId: 'G1' },
      { engine: '1.9 TDI', verdict: 'reliable', note: 'durable', quote: 'The 1.9 TDI lasts forever according to everyone.', sourceId: 'G1' },
    ], sources);
    expect(facts).toEqual([{ aspect: 'reliability', engine: '1.2 HTP', verdict: 'problematic', note: 'timing chain wear', quote: 'Motor 1.2 HTP má problémy s rozvodovým řetězem už kolem 100 tisíc km.', source: 'https://forum.example/fabia' }]);
  });
});

describe('resale potential', () => {
  const ad = (title: string, value: number, i: number) => ({ title, value, unit: 'CZK', url: `https://auto.bazos.cz/inzerat/3359${i}0000/x.php` });
  it('tags liquidity and rarity from market depth and lists unmeasurable steps honestly', async () => {
    const { resaleOf, LIQUID_FROM, RARE_UNDER } = await import('../../src/research/valuation.mjs');
    const row = { title: 'Dacia Sandero 2009 165000 km', value: 25000, unit: 'CZK', url: 'u', group: 'dacia sandero', marketValue: 45000 };
    const deep = resaleOf(row, LIQUID_FROM + 14, [{ word: 'nova stk', with: 6, without: 47, uplift: null }]);
    expect(deep.resaleTags[0]).toBe('easy to resell: 34 comparable listings on the market');
    expect(deep.valueSteps).toEqual([{ step: 'nova stk', uplift: null, measuredOn: 'not measurable on this market (6 with, 47 without; 10 each needed)' }]);
    expect(deep.resaleValue).toBe(45000);
    expect(deep.resaleScore).toBe(Math.round(20000 * (34 / 44)));
    expect(resaleOf(row, RARE_UNDER - 1, []).resaleTags[0]).toMatch(/^rare: only 5 comparable listings/);
  });

  it('adds a measured step uplift to the resale value and skips steps the listing already states', async () => {
    const { resaleOf } = await import('../../src/research/valuation.mjs');
    const row = { title: 'Dacia Sandero 2009 klima', value: 25000, unit: 'CZK', url: 'u', group: 'dacia sandero', marketValue: 40000 };
    const out = resaleOf(row, 30, [{ word: 'nova stk', with: 12, without: 40, uplift: 0.08 }, { word: 'klima', with: 18, without: 35, uplift: 0.05 }]);
    expect(out.valueSteps.map((s: { step: string }) => s.step)).toEqual(['nova stk']);
    expect(out.resaleValue).toBe(43200);
    expect(out.resaleGain).toBe(18200);
  });

  it('shows repair-cost facts as tags but never adjusts the value with them', async () => {
    const { resaleOf, factsFor } = await import('../../src/research/valuation.mjs');
    const groupFacts = { 'dacia sandero': { facts: [{ aspect: 'repair', engine: '1.4', verdict: 'cheap', note: 'cheap common parts', quote: 'q', source: 'https://forum.example/s' }] } };
    expect(factsFor('dacia sandero', { engine: '1.4 mpi' }, groupFacts)).toEqual([]);
    expect(resaleOf({ title: 'Dacia Sandero 1.4', value: 1, url: 'u', group: 'dacia sandero', engine: '1.4 mpi' }, 10, [], groupFacts).resaleTags).toEqual(['cheap to repair (1.4): cheap common parts — https://forum.example/s']);
  });
});
