import { describe, expect, it } from 'vitest';
import { applyStrategy, areaM2, entryCost, GLAMPING_LOW_ENTRY, planFor, quoteFound, StrategyRetriever, strategyFor, unitsFor } from '../../src/research/strategy.mjs';

const rules = GLAMPING_LOW_ENTRY.rules;
const toEur = (value: number, from: string) => (from === 'GBP' ? value * 1.2 : value);
const climate = (workable: number, hottest: number) => ({ workable, comfortable: workable - 3, hottest, coldest: 8 });
const site = (coastKm: number | null, more = {}) => ({ coastKm, beachKm: coastKm, beaches: 5, viewpoints: 10, attractions: 5, reserves: 1, protectedAreas: 1, hikingRoutes: 2, campsites: 3, lodging: 40, climate: climate(12, 24), ...more });
const nazare = { title: 'Rustic land 1,640 m² Nazaré', countryCode: 'PT', country: 'Portugal', value: 20000, area: 1640, areaUnit: 'm²', site: site(2.7), fit: { score: 0.88, hpi: 17.6 } };

describe('low-entry glamping strategy', () => {
  it('is chosen by the research template and every rule names a retrieved source or the user', () => {
    expect(strategyFor('glamping-location')).toBe(GLAMPING_LOW_ENTRY);
    expect(strategyFor('taxes')).toBeNull();
    const ids = new Set(GLAMPING_LOW_ENTRY.sources.map((s) => s.id));
    for (const rule of Object.values(rules)) expect(ids.has(rule.source) || ['question', 'guidance'].includes(rule.source)).toBe(true);
    for (const country of Object.values(GLAMPING_LOW_ENTRY.countries)) for (const id of country.sources) expect(ids.has(id)).toBe(true);
  });

  it('reads hectares, acres and dönüm as square metres and counts units by the Portuguese rural park rule', () => {
    expect(areaM2({ area: 2, areaUnit: 'ha' })).toBe(20000);
    expect(areaM2({ area: 2, areaUnit: 'hectares' })).toBe(20000);
    expect(areaM2({ area: 1, areaUnit: 'acres' })).toBe(4047);
    expect(areaM2({ area: 5, areaUnit: 'dönüm' })).toBe(5000);
    expect(areaM2({ area: 0 })).toBeNull();
    expect(unitsFor(1640, rules)).toBe(24);
    expect(unitsFor(20000, rules)).toBe(30);
    expect(unitsFor(100, rules)).toBe(1);
  });

  it('prices the entry: purchase, the country transfer tax by zoning, and three bell tents', () => {
    const cost = entryCost(nazare, GLAMPING_LOW_ENTRY.countries.PT, 24, rules, toEur);
    expect(cost).toMatchObject({ price: 20000, tax: 1160, tents: 2625, units: 3, total: 23785 });
    expect(entryCost({ ...nazare, title: 'Terreno urbano' }, GLAMPING_LOW_ENTRY.countries.PT, 24, rules, toEur)?.tax).toBe(1460);
    expect(entryCost(nazare, GLAMPING_LOW_ENTRY.countries.VN, 24, rules, toEur)).toBeNull();
  });

  it('says why a plot fits when every criterion is measured and met', () => {
    const plan = planFor(nazare, GLAMPING_LOW_ENTRY, { convert: toEur, euHpi: 5.5 });
    expect(plan.tier).toBe('fits');
    expect(plan.why.join(' | ')).toContain('sea 2.7 km');
    expect(plan.why.join(' | ')).toContain('12 workable months');
    expect(plan.why.join(' | ')).toContain('hottest month average high 24 °C: tents work without air conditioning');
    const hot = planFor({ ...nazare, site: site(2.7, { climate: climate(10, 34.6) }) }, GLAMPING_LOW_ENTRY, { convert: toEur, euHpi: 5.5 });
    expect(hot.why.join(' ')).not.toContain('without air conditioning');
    expect(hot.tradeoffs.join(' ')).toContain('hottest month average max 34.6 °C');
    expect(plan.why.join(' | ')).toContain('holds 24 units');
    expect(plan.why.join(' | ')).toContain('entry ≈ €23,785');
    expect(plan.why.join(' | ')).toContain('Rural camping park');
    expect(plan.risks.join(' ')).toContain('RAN/REN');
  });

  it('keeps a plot far from the sea as a trade-off and defends its potential', () => {
    const inland = { ...nazare, site: site(32, { lakeKm: 1.2, viewpoints: 30 }) };
    const plan = planFor(inland, GLAMPING_LOW_ENTRY, { convert: toEur });
    expect(plan.tier).toBe('trade-off');
    expect(plan.tradeoffs[0]).toContain('sea 32 km');
    expect(plan.potential).toEqual(expect.arrayContaining(['lake or reservoir 1.2 km away', '12-month season']));
    expect(plan.verdict).toMatch(/^trade-off with potential/);
  });

  it('keeps a short-season seaside plot as a strong location, not a reject', () => {
    const plan = planFor({ ...nazare, site: site(0.3, { climate: climate(7, 30.2) }) }, GLAMPING_LOW_ENTRY, { convert: toEur });
    expect(plan.tier).toBe('trade-off');
    expect(plan.potential).toContain('sea 0.3 km: a strong short-season location');
  });

  it('blocks Vietnam for a foreign buyer and industrial sites by the 1,000 m rule', () => {
    expect(planFor({ ...nazare, countryCode: 'VN', country: 'Vietnam' }, GLAMPING_LOW_ENTRY).verdict).toMatch(/^blocked: a foreign individual cannot hold land/);
    expect(planFor({ ...nazare, title: 'Terreno Rústico em Zona Industrial' }, GLAMPING_LOW_ENTRY).tier).toBe('blocked');
  });

  it('asks to confirm what is not measured instead of calling it a fit', () => {
    const plan = planFor({ ...nazare, site: null, area: null }, GLAMPING_LOW_ENTRY);
    expect(plan.tier).toBe('unverified');
    expect(plan.verdict).toContain('area not shown');
    expect(plan.verdict.match(/climate not measured yet/g)).toHaveLength(1);
  });

  it('flags a Turkish shared title and the foreign-buyer project duty', () => {
    const plan = planFor({ ...nazare, countryCode: 'TR', country: 'Turkey', title: 'Hisseli tarla 5 dönüm', area: 5, areaUnit: 'dönüm' }, GLAMPING_LOW_ENTRY, { convert: toEur });
    expect(plan.risks.join(' ')).toContain('shared title');
    expect(plan.risks.join(' ')).toContain('within two years');
    expect(plan.areaM2).toBe(5000);
  });

  it('merges far rows back, counts only full fits as kept and moves them out of the screened count', () => {
    const far = { ...nazare, url: 'f', site: site(40) };
    const table = { sites: { euHpi: 5.5 }, found: 3, kept: [{ ...nazare, url: 'a' }, { ...nazare, url: 'b', countryCode: 'VN' }], far: [far], farReason: 'farther than 25 km from the sea', screened: { 'farther than 25 km from the sea': 1, 'price outside': 4 }, screenedCount: 5, examples: [{ url: 'f', reasons: [] }] };
    const out = applyStrategy(table, GLAMPING_LOW_ENTRY, { convert: toEur, retrieved: { at: '2026-10-26T09:00:00Z', 'pt-park': { status: 200, confirmed: 3, quotes: 3 } } });
    expect(out.kept.map((r: { url: string }) => r.url)).toEqual(['a', 'f', 'b']);
    expect(out.tiers).toEqual({ fits: 1, 'trade-off': 1, unverified: 0, blocked: 1 });
    expect(out.keptCount).toBe(1);
    expect(out.screened).toEqual({ 'price outside': 4 });
    expect(out.screenedCount).toBe(4);
    expect(out.examples).toEqual([]);
    expect(out.far).toBeUndefined();
    expect(out.strategy.sources.find((s: { id: string }) => s.id === 'pt-park')).toMatchObject({ confirmed: 3 });
    expect(out.strategy.sources.find((s: { id: string }) => s.id === 'eurostat')).toMatchObject({ quoted: false });
  });
});

describe('strategy retrieval', () => {
  it('finds quotes across spacing, case and accents', () => {
    expect(quoteFound('<p>A  área máxima do terreno: 5 000 m²</p>', 'Área máxima do terreno: 5 000 m²')).toBe(true);
    expect(quoteFound('nothing here', '£729')).toBe(false);
  });

  it('re-reads every source online, records the quotes found, and reuses a check younger than a week', async () => {
    const read: string[] = [];
    const retriever = new StrategyRetriever({ now: () => Date.parse('2026-10-26T09:00:00Z'), readPage: async (url: string) => {
      read.push(url);
      if (url.includes('cms.law')) throw new Error('timeout');
      return { status: 200, text: url.includes('ac-arquitetos') ? 'não pode exceder 60% da área total do parque' : '' };
    } });
    const out = await retriever.retrieve(GLAMPING_LOW_ENTRY);
    expect(read).toHaveLength(GLAMPING_LOW_ENTRY.sources.filter((s) => s.quotes.length).length);
    expect(out.eurostat).toBeUndefined();
    expect(out['pt-park']).toMatchObject({ status: 200, confirmed: 1, quotes: 3 });
    expect(out['pt-tax']).toMatchObject({ status: 0, confirmed: 0, error: 'timeout' });
    expect(await retriever.retrieve(GLAMPING_LOW_ENTRY, { at: '2026-10-25T09:00:00Z' })).toEqual({ at: '2026-10-25T09:00:00Z' });
  });
});

describe('decision model from the user words', () => {
  const project = {
    question: 'Find appropriate plots to buy for glamping business, but also with the strong price increase trend, very low enterance investments, 20000EUR max, 10 month a year, mild climate to have Glampings so no air condition, nearby sea or the ocean accessible by ebike',
    guidance: '"Accessible by e-bike" means the sea is within e-bike distance (about 20 km on ordinary roads)',
  };

  it('maps every clause of the question to a code check and takes thresholds from the user', async () => {
    const { foundationOf, foundationText } = await import('../../src/research/strategy.mjs');
    const f = foundationOf(GLAMPING_LOW_ENTRY, project);
    expect(f.complete).toBe(true);
    expect(f.clauses.find((c: { text: string }) => c.text === '10 month a year')?.criteria).toEqual(['season']);
    expect(f.clauses.find((c: { text: string }) => c.text.startsWith('with the strong price'))?.criteria).toEqual(['trend']);
    expect(f.rules.minWorkableMonths).toEqual({ value: 10, source: 'question' });
    expect(f.rules.ebikeKm).toEqual({ value: 20, source: 'guidance' });
    expect(foundationText(f)).toContain('at least 10 workable months');
  });

  it('names the clauses it cannot check yet instead of pretending they are covered', async () => {
    const { foundationOf, foundationText } = await import('../../src/research/strategy.mjs');
    const f = foundationOf(GLAMPING_LOW_ENTRY, { question: 'Find plots near the sea, with a vineyard view' });
    expect(f.complete).toBe(false);
    expect(f.missing).toEqual(['with a vineyard view']);
    expect(foundationText(f)).toContain('Not modelled yet (no code check): with a vineyard view');
  });

  it('checks the trend against the EU average and leaves it to confirm where no official series exists', () => {
    expect(planFor({ ...nazare, fit: { hpi: 4 } }, GLAMPING_LOW_ENTRY, { convert: toEur, euHpi: 5.5 }).tier).toBe('trade-off');
    const tr = planFor({ ...nazare, countryCode: 'TR', country: 'Turkey', fit: { hpi: null } }, GLAMPING_LOW_ENTRY, { convert: toEur, euHpi: 5.5 });
    expect(tr.tier).toBe('unverified');
    expect(tr.verdict).toContain('no official price series for Turkey');
    expect(planFor(nazare, GLAMPING_LOW_ENTRY, { convert: toEur, euHpi: 5.5 }).why.join(' ')).toContain('vs EU +5.5%');
    const trends = { TR: { change: 41.5, inflation: 34.9, real: 4.9, year: '2025' } };
    const turkey = planFor({ ...nazare, countryCode: 'TR', country: 'Turkey', fit: { hpi: null } }, GLAMPING_LOW_ENTRY, { convert: toEur, euHpi: 2.9, trends });
    expect(turkey.checks.find((c: { id: string }) => c.id === 'trend')).toMatchObject({ ok: true, detail: 'Turkey +4.9% a year after inflation vs EU +2.9% (Eurostat, housing)' });
    expect(turkey.why.join(' ')).toContain('(nominal +41.5%, inflation 34.9%, 2025)');
    expect(planFor({ ...nazare, site: null }, GLAMPING_LOW_ENTRY, { euHpi: 2.9, trends: { PT: { change: 17.6, inflation: 2.2, real: 15.1, year: '2025' } } }).verdict).not.toContain('price series');
  });
});
