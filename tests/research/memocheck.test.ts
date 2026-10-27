import { describe, expect, it } from 'vitest';
import { checkMemoClaims, claimNote, localNumber, memoClaims, textClaims, unitClass, verifiedFacts } from '../../src/research/memocheck.mjs';

const row = (value: number, coastKm: number, verdict: string, more = {}) => ({ value, countryCode: 'PT', site: { coastKm, beachKm: coastKm + 0.1, climate: { workable: 12, comfortable: 7 } }, plan: { tier: 'fits', entry: { total: value + 2647 } }, verified: { verdict }, ...more });
const candidates = {
  found: 1085,
  kept: [row(500, 2.6, 'confirmed'), row(1000, 19.83, 'confirmed'), row(4000, 1, 'unconfirmed'), row(300, 3, 'confirmed', { plan: { tier: 'weak', entry: { total: 2947 } } })],
  tiers: { fits: 3, 'trade-off': 50, unverified: 86, weak: 38, blocked: 8 },
  verification: { confirmed: 2, refuted: 0, unconfirmed: 1, pending: 0 },
  sites: { euHpi: 2.9, trends: { PT: { real: 15.1, change: 17.6, realCagr: 8 }, TR: { real: -4.2 } } },
};
const context = { valueRange: [0, 20000], rules: { ebikeKm: { value: 20 }, minWorkableMonths: { value: 10 } }, itemCount: 50 };

describe('memo claim check: every number the model wrote, against the verified record (DeepFact-style, claim level)', () => {
  it('reads numbers written the local way', () => {
    expect(['1.516,54', '1,516.54', '1.500', '2,5', '12.000.000', '20,000', 'abc'].map(localNumber)).toEqual([1516.54, 1516.54, 1500, 2.5, 12000000, 20000, null]);
    expect(['EUR', '€', 'km', '%', 'plots', 'months', 'm²'].map(unitClass)).toEqual(['eur', 'eur', 'km', 'pct', 'count', 'months', '']);
  });

  it('finds numbers with their unit in text, euros before or after, and skips "of the 50 asked"', () => {
    const claims = textClaims('Identified 16 verified plots under 20,000 EUR, from €3,147, sea within 19.8 km, 18 plots of the 50 asked, prices +15.1% a year', 'summary');
    expect(claims.map((c: { value: number; kind: string }) => [c.value, c.kind])).toEqual([[16, 'count'], [20000, 'eur'], [19.8, 'km'], [18, 'count'], [15.1, 'pct'], [3147, 'eur']]);
  });

  it('takes the facts only from listings that fit every check and that the external verifier confirmed', () => {
    const facts = verifiedFacts(candidates, context);
    expect(facts.rows).toBe(2);
    expect(facts.eur).toEqual([500, 1000, 3147, 3647, 20000]);
    expect(facts.km).toEqual([2.6, 2.7, 19.83, 19.93, 20]);
    expect(facts.pct).toEqual([15.1, 17.6, 8, 2.9]);
  });

  it('marks each memo number supported, contradicted, or not checkable when the record holds nothing of its kind', () => {
    const report = {
      keyNumbers: [{ label: 'Verified Plots Found', value: '16', unit: 'plots' }, { label: 'Lowest Plot Price', value: '500', unit: 'EUR' }, { label: 'Maximum Sea Distance', value: '19.8', unit: 'km' }, { label: 'Payback', value: '3', unit: 'years' }],
      modelVerdict: 'Identified 2 verified coastal plots under 20,000 EUR',
      summary: 'Entry from €3,147; occupancy 60% in season',
    };
    expect(memoClaims(report).map((c: { where: string }) => c.where)).toEqual(['key numbers', 'key numbers', 'key numbers', 'model verdict', 'model verdict', 'summary', 'summary']);
    const check = checkMemoClaims(report, candidates, context)!;
    const status = Object.fromEntries(check.claims.map((c: { text: string; status: string }) => [c.text, c.status]));
    expect(status['Verified Plots Found: 16 plots']).toBe('contradicted');
    expect(status['Lowest Plot Price: 500 EUR']).toBe('supported');
    expect(status['Maximum Sea Distance: 19.8 km']).toBe('supported');
    expect(status['Entry from €3,147']).toBe('supported');
    expect(check.contradicted.map((c: { text: string }) => c.text)).toEqual(['Verified Plots Found: 16 plots', 'Entry from €3,147; occupancy 60%']);
    expect(check.basis).toBe('2 listing(s) that fit every check and were confirmed by the external verifier');
    expect(claimNote(check)).toBe(' · memo numbers checked against the verified record: 5 of 7 match; 2 contradict it ("Verified Plots Found: 16 plots"; "Entry from €3,147; occupancy 60%")');
  });

  it('says nothing when there is no memo, no table or no number', () => {
    expect(checkMemoClaims(null, candidates)).toBeNull();
    expect(checkMemoClaims({ summary: 'x' }, null)).toBeNull();
    expect(claimNote(checkMemoClaims({ summary: 'no numbers here' }, candidates))).toBe('');
  });
});
