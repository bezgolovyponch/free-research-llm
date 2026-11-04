import { describe, expect, it } from 'vitest';
import { CASE_OBJECTIVES, applyValueFacts, consensusOf, factEffects, mergeValueFacts, rankCases, valueCase, valueFactsPrompt } from '../../src/research/valuecase.mjs';

const peer = (year: number, km: number, text: string, value = 40000, group = 'skoda fabia') => ({ group, value, facts: { year, km, kw: null, engine: null, fuel: null }, text });

describe('value facts calibrated on real ad texts', () => {
  it('keeps a phrase only when most proposals name it and at least two ads state it', () => {
    const merged = mergeValueFacts([
      { data: { for: ['servisní kniha', '1. majitel', 'nové rozvody'], against: ['koroze'] } },
      { data: { for: ['servisni kniha', 'nové rozvody', 'tazne'], against: ['koroze', 'na dily'] } },
      { data: { for: ['1. majitel'], against: [] } },
    ]);
    expect(merged.for.sort()).toEqual(['1. majitel', 'nove rozvody', 'servisni kniha']);
    expect(merged.against).toEqual(['koroze']);
    const applied = applyValueFacts(merged, ['Servisní kniha, 1. majitel', 'servisni kniha doložena', 'nové rozvody', 'koroze na prazích', 'mírná koroze']);
    expect(applied).toEqual({ for: ['servisni kniha'], against: ['koroze'], calibratedOn: 5 });
  });

  it('finds phrases in real Czech ads whatever shape the proposals return them in', () => {
    const ads = [
      'Škoda Fabia 1.4 16V, r. v. 2007, najeto 168 000 km. Servisní kniha, nové rozvody, 1. majitel, bez koroze.',
      'Prodám Škodu Fabii 1.2 HTP, r.v. 2008. Servisní kniha doložena, 1. majitel, koroze na prazích.',
      'Škoda Fabia Combi 1.6, 2009, 132 000 km, nové rozvody ve 120 tkm, servisní kniha.',
      'Škoda Fabia 1.2, 2008. Koroze na prazích, jinak bez koroze, 1. majitel.',
      'Škoda Fabia 1.4, 2007, servisní kniha, nové rozvody, bez koroze.',
    ];
    const merged = mergeValueFacts([
      { data: { for: ['„Servisní kniha“', '1. majitel.', 'Nové rozvody', 'bez koroze'], against: ['koroze na prazích'] } },
      { data: { analysis: { phrases: { for: ['servisni kniha,', '1. majitel', { phrase: 'nové rozvody' }], against: [{ phrase: 'Koroze na prazích' }] } } } },
      { data: { result: { for: [{ phrase: 'Servisní kniha' }, 'nové rozvody', '1. majitel'], against: ['koroze na prazích.'] } } },
    ]);
    expect(merged.for.sort()).toEqual(['1. majitel', 'nove rozvody', 'servisni kniha']);
    expect(merged.against).toEqual(['koroze na prazich']);
    expect(applyValueFacts(merged, ads)).toEqual({ for: ['1. majitel', 'nove rozvody', 'servisni kniha'], against: ['koroze na prazich'], calibratedOn: 5 });
  });

  it('compares quoted, capitalised or punctuated phrases after plain() on both sides', () => {
    const ads = ['Servisní kniha, 1. majitel.', 'servisni kniha doložena, 1. majitel, nové rozvody', 'nové rozvody', 'koroze na prazích', 'mírná koroze na prazích'];
    const applied = applyValueFacts({ for: ['"Servisní kniha"', 'Nové rozvody!', '"1. majitel"'], against: ['Koroze na prazích.'] }, ads);
    expect(applied).toEqual({ for: ['servisni kniha', 'nove rozvody', '1. majitel'], against: ['koroze na prazich'], calibratedOn: 5 });
  });

  it('asks for phrases copied from the ads, for and against value', () => {
    const [system, user] = valueFactsPrompt({ question: 'Which used cars are worth buying?', texts: ['prodám fabii, servisní kniha'] });
    expect(system.content).toContain('"for"');
    expect(system.content).toContain('"against"');
    expect(user.content).toContain('[1] prodám fabii, servisní kniha');
  });
});

describe('effect of a stated fact measured on the market', () => {
  it('measures the price effect against same-model, nearby-year ads and says when it cannot', () => {
    const entries = [
      ...Array.from({ length: 12 }, (_, i) => peer(2008 + (i % 2), 150000, 'servisni kniha', 50000 + i * 100)),
      ...Array.from({ length: 12 }, (_, i) => peer(2008 + (i % 2), 150000, 'bez zminky', 40000 + i * 100)),
    ];
    const [book, rust] = factEffects(entries, ['servisni kniha', 'koroze']);
    expect(book.effect).toBeGreaterThan(0.15);
    expect(book.with).toBe(12);
    expect(rust).toMatchObject({ with: 0, effect: null });
  });
});

describe('why a car stands out from comparable cars of its year', () => {
  const phrases = { for: ['servisni kniha', 'nove rozvody'], against: ['koroze'] };
  const peers = [peer(2008, 200000, 'servisni kniha'), peer(2008, 220000, 'bez zminky'), peer(2009, 180000, 'bez zminky'), peer(2007, 240000, 'koroze'), peer(2008, 210000, 'servisni kniha'), peer(2009, 190000, 'servisni kniha')];
  const fact = (host: string, extra: Record<string, unknown> = {}) => ({ engine: '1.2 htp', aspect: 'reliability', verdict: 'problematic', note: 'timing chain stretches early', quote: `Owners on ${host} report the 1.2 HTP chain stretching.`, source: `https://${host}/fabia`, host, fixedBy: ['novy retez', 'nove rozvody'], ...extra });

  it('counts a stated fact only when its price effect is measured on the market, and low use with the measured mileage effect', () => {
    const row = { title: 'Škoda Fabia 1.4', value: 35000, marketValue: 42000, year: 2008, km: 90000, adText: 'servisní kniha, nové rozvody' };
    const effects = [{ phrase: 'servisni kniha', with: 14, without: 60, effect: 0.08 }, { phrase: 'nove rozvody', with: 3, without: 40, effect: null }];
    const out = valueCase(row, peers, { phrases, effects, kmSlope: -0.3 });
    expect(out.reasons[0]).toMatch(/^low use: 5,000 km a year against a median of \d{2},\d{3} for 6 comparable cars; by the mileage effect measured on this market that is worth about \+\d+%$/);
    expect(out.reasons).toContain('states "servisni kniha": ads that state it ask 8% more than comparable ads of the same model and year (14 with it, 60 without)');
    expect(out.unproven).toEqual(['"nove rozvody" (effect not measurable: 3 ads state it, 10 needed)']);
    expect(out.measures.advantages).toBe(1);
  });

  it('uses owner and expert reports only when two independent sites agree, and credits a known problem the ad says is fixed', () => {
    const row = { title: 'Škoda Fabia 1.2 HTP', value: 30000, marketValue: 38000, year: 2008, km: 215000, engine: '1.2 htp', adText: 'nový řetěz rozvodů' };
    const single = valueCase(row, peers, { phrases, reputation: [fact('forum-a.cz')] });
    expect(single.reasons).toEqual([]);
    const agreed = valueCase(row, peers, { phrases, reputation: [fact('forum-a.cz'), fact('club-b.cz')] });
    expect(agreed.reasons[0]).toMatch(/^a known 1\.2 htp problem \(timing chain stretches early\) the ad says is fixed: "novy retez"; the problem is reported by 2 independent sites/);
    expect(agreed.measures.advantages).toBe(1);
    expect(consensusOf([fact('forum-a.cz'), fact('forum-a.cz')])[0].hosts).toEqual(['forum-a.cz']);
  });

  it('says plainly when nothing evidenced sets a car apart, and lists stated faults and agreed problems as cautions', () => {
    const row = { title: 'Škoda Fabia 1.2 HTP', value: 30000, marketValue: 41000, year: 2008, km: 230000, engine: '1.2 htp', adText: 'koroze na prazích' };
    const out = valueCase(row, peers, { phrases, reputation: [fact('forum-a.cz'), fact('club-b.cz')] });
    expect(out.ordinary).toBe(true);
    expect(out.summary).toBe('nothing evidenced distinguishes it from comparable cars of its year');
    expect(out.cautions).toContain('states "koroze"');
    expect(out.cautions.join(' ')).toContain('problematic 1.2 htp: timing chain stretches early; 2 independent sites');
  });

  it('orders cars by Pareto layers over the measured value case, with no weights', () => {
    const better = { valueCase: { measures: { priceRatio: 0.8, kmRank: 0.1, advantages: 2, against: 0, reputation: 1 } } };
    const worse = { valueCase: { measures: { priceRatio: 0.9, kmRank: 0.5, advantages: 1, against: 1, reputation: 0 } } };
    const other = { valueCase: { measures: { priceRatio: 0.7, kmRank: 0.9, advantages: 0, against: 0, reputation: 0 } } };
    const ranked = rankCases([worse, other, better, { title: 'no case' }]);
    expect(ranked.map((r: { caseLayer?: number }) => r.caseLayer)).toEqual([2, 1, 1, undefined]);
    expect(CASE_OBJECTIVES.map((o) => o.id)).toEqual(['priceRatio', 'kmRank', 'advantages', 'against', 'reputation']);
  });
});
