import { describe, expect, it } from 'vitest';
import { OBJECTIVES, PROPOSAL_METHOD, SECONDARY_SHOWN, activeObjectives, dominates, paretoLayers, standsOut, withProposals } from '../../src/research/proposal.mjs';

const check = (id: string, ok: boolean | null, detail = id) => ({ id, label: id, ok, detail });
const row = (url: string, tier: string, { entry = 5000, sea = 5, months = 11, checks = [check('sea', true), check('season', true)], share = 1, verified = undefined as undefined | { verdict: string; failed?: string[] }, potential = [] as string[] } = {}) => ({
  url,
  title: url,
  value: entry,
  site: { coastKm: sea, climate: { workable: months, cci: { optimalDays: months * 10 } }, beaches: 1 },
  plan: { tier, checks, share, potential, entry: { total: entry }, why: [], tradeoffs: [], risks: [] },
  ...(verified ? { verified } : {}),
});

describe('proposals: primary and secondary results ranked by Pareto layers on measured values', () => {
  it('finds the non-dominated layers without any weights', () => {
    const objectives = OBJECTIVES.filter((o) => ['entry', 'sea'].includes(o.id));
    const a = row('a', 'fits', { entry: 3000, sea: 10 });
    const b = row('b', 'fits', { entry: 8000, sea: 2 });
    const c = row('c', 'fits', { entry: 9000, sea: 12 });
    expect(dominates(a, c, objectives)).toBe(true);
    expect(dominates(a, b, objectives)).toBe(false);
    const layers = paretoLayers([a, b, c], objectives);
    expect([layers.get(a), layers.get(b), layers.get(c)]).toEqual([1, 1, 2]);
    expect(standsOut(a, [a, b, c], objectives)).toEqual(['lowest entry cost of the 3']);
  });

  it('uses only measures that at least two results have', () => {
    const rows = [row('a', 'fits'), { ...row('b', 'fits'), site: null }];
    expect(activeObjectives(rows).map((o: { id: string }) => o.id)).toEqual(['share', 'entry']);
  });

  it('ranks confirmed fits first, offers trade-offs and plots to confirm as secondary results, never refuted ones, and explains each result', () => {
    const fits = row('fit', 'fits', { entry: 4000, sea: 3 });
    const confirmed = row('confirmed', 'fits', { entry: 9000, sea: 15, verified: { verdict: 'confirmed' } });
    const refuted = row('refuted', 'fits', { verified: { verdict: 'refuted', failed: ['price: refuted (page shows €45,000)'] } });
    const trade = row('trade', 'trade-off', { share: 0.71, checks: [check('sea', true), check('season', false, '8 camping months')], potential: ['sea 2 km: a strong short-season location'] });
    const open = row('open', 'unverified', { share: 0.5, checks: [check('sea', true), check('season', null, 'climate not measured yet')] });
    const weak = row('weak', 'weak', { share: 0.2, checks: [check('sea', false), check('season', false)] });
    const out = withProposals({ kept: [fits, confirmed, refuted, trade, open, weak], tiers: {} });
    expect(out.proposals).toMatchObject({ method: PROPOSAL_METHOD, primary: ['confirmed', 'fit'] });
    expect(out.proposals.secondary).toEqual(['trade', 'open']);
    const by = Object.fromEntries(out.kept.map((r: { url: string; plan: { proposal: unknown } }) => [r.url, r.plan.proposal]));
    expect(by.confirmed).toMatchObject({ role: 'primary', rank: 1, confidence: 'confirmed', headline: 'Fits all 2 criteria you set, confirmed outside the app' });
    expect(by.fit).toMatchObject({ role: 'primary', rank: 2, layer: 1, confidence: 'measured', standsOut: expect.arrayContaining(['lowest entry cost of the 2', 'closest to the sea of the 2']) });
    expect(by.refuted).toMatchObject({ role: null, confidence: 'refuted', headline: 'Measured as a fit, but the external verifier refuted it', confidenceText: expect.stringContaining('page shows €45,000') });
    expect(by.trade).toMatchObject({ role: 'secondary', rank: 1 });
    expect(by.trade.headline).toBe('Meets 1 of 2; misses season, made up for by sea 2 km: a strong short-season location');
    expect(by.open).toMatchObject({ headline: 'Meets 1 of 2; still to confirm: season', confirm: ['season: climate not measured yet'] });
    expect(by.weak).toMatchObject({ role: null, rank: null });
  });

  it('caps the secondary list and leaves tables without plans untouched', () => {
    const many = Array.from({ length: SECONDARY_SHOWN + 5 }, (_, i) => row(`t${i}`, 'trade-off', { entry: 1000 + i, sea: 30 - i, share: 0.7 }));
    expect(withProposals({ kept: many }).proposals.secondary.length).toBe(SECONDARY_SHOWN);
    const plain = { kept: [{ url: 'x', value: 1 }] };
    expect(withProposals(plain)).toBe(plain);
    expect(withProposals(null)).toBeNull();
  });
});
