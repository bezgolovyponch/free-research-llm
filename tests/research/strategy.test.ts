import { describe, expect, it } from 'vitest';
import { applyStrategy, areaM2, entryCost, GLAMPING_LOW_ENTRY, planFor, quoteFound, StrategyRetriever, strategyFor, unitsFor } from '../../src/research/strategy.mjs';

const rules = GLAMPING_LOW_ENTRY.rules;
const toEur = (value: number, from: string) => (from === 'GBP' ? value * 1.2 : value);
const climate = (workable: number, hottest: number) => ({ workable, comfortable: workable - 3, hottest, coldest: 8, cci: { annual: 6.5, optimalDays: 120, hotDays: hottest > 34 ? 6 : 0, optimalTrend: 1.5, perYear: [], years: 5 } });
const site = (coastKm: number | null, more = {}) => ({ coastKm, beachKm: coastKm, beaches: 5, viewpoints: 10, attractions: 5, reserves: 1, protectedAreas: 1, hikingRoutes: 2, campsites: 3, lodging: 40, climate: climate(12, 24), ...more });
const nazare = { title: 'Rustic land 1,640 m² Nazaré', countryCode: 'PT', country: 'Portugal', value: 20000, area: 1640, areaUnit: 'm²', site: site(2.7), fit: { score: 0.88, hpi: 17.6 } };

describe('low-entry glamping strategy', () => {
  it('is chosen by the research template and every rule names a retrieved source or the user', () => {
    expect(strategyFor('glamping-location')).toBe(GLAMPING_LOW_ENTRY);
    expect(strategyFor('taxes')).toBeNull();
    const ids = new Set(GLAMPING_LOW_ENTRY.sources.map((s) => s.id));
    for (const rule of Object.values(rules)) expect(ids.has(rule.source) || ['question', 'guidance', 'assumption'].includes(rule.source)).toBe(true);
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
    expect(plan.why.join(' | ')).toContain('12 camping months a year by the Camping Climate Index');
    expect(plan.why.join(' | ')).toContain('hottest month average high 24 °C: tents work without air conditioning');
    const hot = planFor({ ...nazare, site: site(2.7, { climate: climate(10, 34.6) }) }, GLAMPING_LOW_ENTRY, { convert: toEur, euHpi: 5.5 });
    expect(hot.why.join(' ')).not.toContain('without air conditioning');
    expect(hot.tradeoffs.join(' ')).toContain('hottest month average high 34.6 °C (limit 32.2 °C); 6 day(s) a year above 34 °C');
    expect(hot.risks.join(' ')).toContain('about 6 day(s) a year above 34 °C');
    expect(plan.why.join(' | ')).toContain('holds 24 units');
    expect(plan.why.join(' | ')).toContain('entry ≈ €23,785');
    expect(plan.why.join(' | ')).toContain('Rural camping park');
    expect(plan.risks.join(' ')).toContain('RAN/REN');
  });

  it('keeps a plot far from the sea as a trade-off and defends its potential', () => {
    const inland = { ...nazare, site: site(32, { lakeKm: 1.2, lakesNamed: true, viewpoints: 30 }) };
    const plan = planFor(inland, GLAMPING_LOW_ENTRY, { convert: toEur });
    expect(plan.tier).toBe('trade-off');
    expect(plan.tradeoffs[0]).toContain('sea 32 km');
    expect(plan.potential).toEqual(expect.arrayContaining(['named lake or reservoir 1.2 km away', '12-month camping season']));
    expect(plan.verdict).toMatch(/^trade-off with potential/);
  });

  it('marks an inland plot with nothing nearby to draw guests as weak, not a trade-off', () => {
    const bare = site(60, { lakeKm: null, beaches: 0, viewpoints: 2, attractions: 1, reserves: 0, protectedAreas: 0, hikingRoutes: 0, campsites: 1, climate: climate(6, 30.9) });
    const plan = planFor({ ...nazare, site: bare }, GLAMPING_LOW_ENTRY, { convert: toEur, euHpi: 5.5 });
    expect(plan.tier).toBe('weak');
    expect(plan.verdict).toMatch(/^does not fit: sea within 20 km by e-bike: no \(sea 60 km\); 10\+ camping months \(Camping Climate Index above 3: acceptable or better, Ma 2021 Table 4\): no .*; nothing nearby draws guests to make up for it$/);
    expect(plan.potential).toEqual(['1 campsites nearby prove camping demand']);
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
    expect(plan.verdict.match(/climate not measured with the Camping Climate Index yet/g)).toHaveLength(1);
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
    expect(out.tiers).toEqual({ fits: 1, 'trade-off': 1, unverified: 0, weak: 0, blocked: 1 });
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
    expect(foundationText(f)).toContain('at least 10 camping months (Camping Climate Index above 3, acceptable or better, Ma 2021 Table 4)');
    expect(foundationText(f)).toContain('at most 32.2 °C, days above 34 °C shown as exceptions (no air conditioning; the perceived maximum from Fisichelli et al. 2015, cited by Ma 2021)');
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

  it('flags a low price per m² by the robust rule median − 2.5 MAD on log prices (Leys et al. 2013)', async () => {
    const { implausiblyCheap, pricePerM2Medians } = await import('../../src/research/strategy.mjs');
    const rows = [10, 12, 14, 16, 18].map((eurPerM2) => ({ countryCode: 'VN', country: 'Vietnam', value: eurPerM2 * 250, area: 250, areaUnit: 'm²' }));
    const medians = pricePerM2Medians(rows);
    expect(medians['VN|not stated']).toMatchObject({ n: 5 });
    expect(medians['VN|not stated'].median).toBeCloseTo(14, 5);
    expect(implausiblyCheap({ countryCode: 'VN', country: 'Vietnam', value: 250, area: 250, areaUnit: 'm²' }, medians)).toMatch(/^€1\.00\/m² is a low outlier for land in Vietnam among the 5 listings found \(median €14\.00\/m²; outliers below €\d+\.\d\d\/m² by median − 2\.5 MAD\): check the price and area on the listing$/);
    expect(implausiblyCheap(rows[0], medians)).toBeNull();
    expect(pricePerM2Medians(rows.slice(0, 4))).toEqual({});
  });

  it('also compares a plot with the priced plots within 30 km when the country group is too mixed to flag it', async () => {
    const { implausiblyCheap, localPriceStats, pricePerM2Medians } = await import('../../src/research/strategy.mjs');
    const near = [4, 5, 5, 6, 7].map((eurPerM2, i) => ({ url: `https://imo.example/${i}`, countryCode: 'PT', country: 'Portugal', value: eurPerM2 * 1000, area: 1000, areaUnit: 'm²', lat: 38.8 + i * 0.01, lon: -9.4 }));
    const far = [0.2, 0.3, 50, 80, 120].map((eurPerM2, i) => ({ url: `https://imo.example/far${i}`, countryCode: 'PT', country: 'Portugal', value: eurPerM2 * 1000, area: 1000, areaUnit: 'm²', lat: 41 + i * 0.01, lon: -8.6 }));
    const sintra = { url: 'https://imo.example/sintra', countryCode: 'PT', country: 'Portugal', value: 450, area: 950, areaUnit: 'm²', lat: 38.86, lon: -9.42 };
    const rows = [...near, ...far, sintra];
    const medians = pricePerM2Medians(rows);
    expect(localPriceStats(sintra, rows)).toMatchObject({ n: 5 });
    expect(localPriceStats({ ...sintra, lat: undefined }, rows)).toBeNull();
    expect(implausiblyCheap(sintra, medians)).toBeNull();
    expect(implausiblyCheap(sintra, medians, rows)).toMatch(/^€0\.47\/m² is a low outlier among the 5 priced plots within 30 km \(median €5\.00\/m²; outliers below €\d+\.\d\d\/m² by median − 2\.5 MAD\): the price may be a deposit, a share or a placeholder; check it on the listing$/);
    expect(implausiblyCheap(near[2], medians, rows)).toBeNull();
  });

  it('never lets anything make up for too little land, and never lets an unnamed pond count as a lake', () => {
    const tiny = planFor({ ...nazare, area: 6, site: site(2, { lakeKm: 0.9, lakesNamed: true, viewpoints: 300 }) }, GLAMPING_LOW_ENTRY, { convert: toEur, euHpi: 5.5 });
    expect(tiny.tier).toBe('weak');
    expect(tiny.verdict).toContain('too little land for a glamping site');
    const pond = planFor({ ...nazare, site: site(40, { lakeKm: 0.3, beaches: 0, viewpoints: 1, attractions: 0, hikingRoutes: 0 }) }, GLAMPING_LOW_ENTRY, { convert: toEur, euHpi: 5.5 });
    expect(pond.tier).toBe('weak');
  });

  it('asks to confirm a listing whose title names a place far from its map point', () => {
    const plan = planFor({ ...nazare, placeConflict: 'the title names Vieira de Leiria, 117 km from where the listing\'s map puts it' }, GLAMPING_LOW_ENTRY, { convert: toEur, euHpi: 5.5 });
    expect(plan.tier).toBe('unverified');
    expect(plan.verdict).toBe("to confirm: the title names Vieira de Leiria, 117 km from where the listing's map puts it");
  });

  it('turns a would-be fit with an implausible price into one to confirm, comparing land of the same zoning', () => {
    const rural = [3, 4, 5, 6, 7].map((p, i) => ({ ...nazare, url: `r${i}`, title: 'Terreno rústico', value: p * 1000, area: 1000 }));
    const urban = [30, 35, 40, 45, 50].map((p, i) => ({ ...nazare, url: `u${i}`, title: 'Terreno urbano', value: p * 400, area: 400 }));
    const estoril = { ...nazare, url: 'estoril', title: 'Terreno urbano Estoril', value: 1000, area: 400 };
    const out = applyStrategy({ sites: { euHpi: 5.5 }, kept: [...rural, ...urban, estoril], screened: {}, screenedCount: 0 }, GLAMPING_LOW_ENTRY, { convert: toEur });
    const row = out.kept.find((r: { url: string }) => r.url === 'estoril');
    expect(row.plan.tier).toBe('unverified');
    expect(row.plan.verdict).toMatch(/^to confirm: €2\.50\/m² is a low outlier for buildable land in Portugal among the 6 listings found/);
    expect(out.kept.find((r: { url: string }) => r.url === 'r0').plan.tier).toBe('fits');
  });

  it('ranks plots outside the asked countries by opportunity: site checks, real trend and its continuation, scenic places with few campsites', async () => {
    const { opportunityOf } = await import('../../src/research/strategy.mjs');
    const vir = { ...nazare, countryCode: 'HR', country: 'Croatia', site: site(0.3, { viewpoints: 40, campsites: 1, climate: climate(7, 30.2) }) };
    const plan = planFor(vir, GLAMPING_LOW_ENTRY, { convert: toEur, euHpi: 2.9 });
    const opp = opportunityOf(vir, plan, { trends: { HR: { realCagr: 6.2, since: '2020', year: '2025' } }, euTrend: { realCagr: 2.1 } });
    expect(opp.score).toBe(3 + 2 + 2);
    expect(opp.reasons.join(' | ')).toContain('Croatia house prices +6.2% a year after inflation 2020–2025 (EU +2.1%); if that continues, about +35% in 5 years (a trend continuation for housing, not a land forecast)');
    expect(opp.reasons.join(' | ')).toContain('scenic and still open: 54 beaches, viewpoints, sights, reserves and trails within 15 km, only 1 campsite');
    const out = applyStrategy({ sites: { euHpi: 2.9, trends: { HR: { realCagr: 6.2, since: '2020', year: '2025' }, EU27_2020: { realCagr: 2.1 } } }, kept: [], outside: [{ ...vir, url: 'low', site: site(40, { viewpoints: 0, beaches: 0, attractions: 0, campsites: 9 }) }, { ...vir, url: 'high' }], screened: {}, screenedCount: 0 }, GLAMPING_LOW_ENTRY, { convert: toEur });
    expect(out.outside.map((r: { url: string }) => r.url)).toEqual(['high', 'low']);
    expect(out.keptCount).toBe(0);
  });
});
