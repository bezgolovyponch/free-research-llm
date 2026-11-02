import { describe, expect, it } from 'vitest';
import { TOOLTIP_MAX, blockerRates, confirmRisk, resultsNature, withConfirmRisk } from '../../src/research/blockers.mjs';

const row = (tier, checks, url = tier) => ({ url, plan: { tier, verdict: `${tier} verdict`, checks } });
const zoning = (ok) => ({ id: 'zoning', label: 'Zoning allows camping', ok, detail: '' });
const season = (ok) => ({ id: 'season', label: 'Camping season', ok, detail: '' });

function research() {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(row('blocked', [zoning(false), season(true)], `b${i}`));
  for (let i = 0; i < 2; i++) rows.push(row('fits', [zoning(true), season(true)], `f${i}`));
  return rows;
}

describe('blockerRates', () => {
  it('counts measured, failed and plot-ending results per check', () => {
    const z = blockerRates(research()).get('zoning');
    expect(z).toMatchObject({ resolved: 8, failed: 6, terminating: 6, rate: 0.75 });
    expect(blockerRates(research()).get('season')).toMatchObject({ resolved: 8, terminating: 0 });
  });

  it('does not count a failed check on a trade-off as plot-ending', () => {
    expect(blockerRates([row('trade-off', [season(false)])]).get('season')).toMatchObject({ failed: 1, terminating: 0 });
  });
});

describe('confirmRisk', () => {
  it('names the unmeasured check and says it is often a complete blocker', () => {
    const rows = research();
    const risk = confirmRisk(row('unverified', [zoning(null), season(true)]), blockerRates(rows));
    expect(risk.risk).toBe(0.75);
    expect(risk.cause.id).toBe('zoning');
    expect(risk.text).toContain('• Not measured yet: Zoning allows camping');
    expect(risk.text).toContain('ended 6 of 8 measured plots (75%): often a complete blocker');
    expect(risk.text.length).toBeLessThanOrEqual(TOOLTIP_MAX);
  });

  it('says when too few plots were measured to judge', () => {
    const rows = [row('blocked', [zoning(false)]), row('fits', [zoning(true)])];
    const risk = confirmRisk(row('unverified', [zoning(null)]), blockerRates(rows));
    expect(risk.risk).toBeNull();
    expect(risk.text).toContain('too few measured plots (2)');
  });

  it('falls back to the verdict when no check is unmeasured', () => {
    const r = { plan: { tier: 'unverified', verdict: 'to confirm: €3/m² is a low outlier', checks: [] } };
    expect(confirmRisk(r, new Map()).text).toBe('• €3/m² is a low outlier');
  });

  it('keeps long tooltips within the limit', () => {
    const long = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, label: `A very long check label number ${i}`, ok: null }));
    expect(confirmRisk(row('unverified', long), new Map()).text.length).toBeLessThanOrEqual(TOOLTIP_MAX);
  });

  it('is null for rows that are not to confirm', () => {
    expect(confirmRisk(row('fits', [zoning(true)]), new Map())).toBeNull();
  });
});

describe('withConfirmRisk', () => {
  it('orders to-confirm rows least likely blocked first and leaves other rows in place', () => {
    const base = research();
    const likely = row('unverified', [zoning(null)], 'likely-blocked');
    const unknown = row('unverified', [{ id: 'water', label: 'Water', ok: null }], 'no-data');
    const safe = row('unverified', [season(null)], 'season-only');
    const rows = [base[6], likely, unknown, safe, ...base.slice(0, 6), base[7]];
    const out = withConfirmRisk(rows);
    expect(out.map((r) => r.url)).toEqual(['f0', 'season-only', 'likely-blocked', 'no-data', 'b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'f1']);
    expect(out[1].plan.confirmRisk.risk).toBe(0);
    expect(out[3].plan.confirmRisk.risk).toBeNull();
  });
});

describe('resultsNature', () => {
  it('describes a provisional result with every detail it has', () => {
    const { asOf, lines } = resultsNature({
      candidates: { builtAt: '2026-11-02T18:00:00Z', found: 911, tiers: { fits: 40, 'trade-off': 5, unverified: 12, weak: 30, blocked: 2 }, verification: { at: '2026-11-02T19:00:00Z', confirmed: 30, refuted: 4, unconfirmed: 6, pending: 2 } },
      supportAudit: { toConfirm: 3, disagree: 1, stale: 7 },
      improve: { active: true, deadline: '2026-11-03T02:30:00Z' },
    });
    expect(asOf).toBe('2026-11-02T18:00:00Z');
    expect(lines[0]).toMatch(/^Fits are the current conclusion, not a final one/);
    expect(lines).toContain('40 fit every criterion, 5 trade-offs, 12 to confirm, 30 weak, 2 blocked, from 911 listings found.');
    expect(lines).toContain('Checked outside the app 2026-11-02: 30 confirmed, 4 refuted, 6 unconfirmed, 2 not checked yet.');
    expect(lines).toContain('3 claim(s) to confirm (1 where the two checking models disagree); 7 claim(s) were checked under older logic.');
    expect(lines).toContain('The self-improving loop is running until 02:30Z, so numbers can still move.');
  });

  it('alerts that to-confirm plots stay open while the loop is stopped', () => {
    const { lines } = resultsNature({ candidates: { found: 3, tiers: { fits: 1, unverified: 2 } } });
    expect(lines.at(-1)).toBe('The self-improving loop is stopped: the 2 plot(s) to confirm stay open until it runs again or they are measured.');
  });

  it('gives only the nature line when nothing is known yet', () => {
    expect(resultsNature({})).toEqual({ asOf: null, lines: [expect.stringMatching(/^Fits are the current conclusion/)] });
  });
});
