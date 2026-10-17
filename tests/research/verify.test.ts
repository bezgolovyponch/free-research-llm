import { describe, expect, it } from 'vitest';
import { needsEscalation, verifyFinding } from '../../src/research/verify.mjs';

const sources = [
  { id: 'S1', url: 'https://a.example/x', domain: 'a.example' },
  { id: 'S2', url: 'https://b.example/y', domain: 'b.example' },
];

const good = {
  answer: 'Net margin is 1,800 EUR per car.',
  claims: [
    { text: 'DE price 18,000 EUR', sourceIds: ['S1'], assumption: false },
    { text: 'PL price 21,000 EUR', sourceIds: ['S2'], assumption: false },
    { text: 'Transport 1,200 EUR', sourceIds: [], assumption: true },
  ],
  calculation: { formula: 'sell - buy - transport', inputs: { sell: { value: 21000 }, buy: 18000, transport: 1200 }, result: 1800 },
  confidence: 'high',
};

describe('verifyFinding', () => {
  it('grades a cited, recomputable, multi-source finding as verified', () => {
    const v = verifyFinding({ finding: good, sources, critique: { agree: true, severity: 'none', issues: [] } });
    expect(v.grade).toBe('verified');
    expect(needsEscalation(v)).toBe(false);
  });

  it('marks invented source ids as unsupported', () => {
    const v = verifyFinding({ finding: { ...good, claims: [{ text: 'x 5', sourceIds: ['S9'] }] }, sources });
    expect(v.grade).toBe('unsupported');
    expect(v.failures.join()).toMatch(/S9/);
  });

  it('catches arithmetic that does not recompute', () => {
    const v = verifyFinding({ finding: { ...good, calculation: { ...good.calculation, result: 2500 } }, sources });
    expect(v.grade).toBe('unsupported');
    expect(needsEscalation(v)).toBe(true);
  });

  it('downgrades uncited numbers and high confidence without independent sources to weak', () => {
    const v = verifyFinding({ finding: { answer: 'about 40%', claims: [{ text: 'occupancy 40%', sourceIds: [] }], confidence: 'high' }, sources });
    expect(v.grade).toBe('weak');
    expect(v.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(['numbers-sourced', 'independent-sources']);
  });

  it('treats a major reviewer objection as weak', () => {
    const v = verifyFinding({ finding: good, sources, critique: { agree: false, severity: 'major', issues: ['uses 2019 prices'] } });
    expect(v.grade).toBe('weak');
  });

  it('accepts user data as a verifying source', () => {
    const v = verifyFinding({ finding: { answer: 'median 12k', claims: [{ text: 'median 12,000', sourceIds: ['D1'] }], confidence: 'medium' }, sources: [{ id: 'D1', kind: 'data', url: '' }] });
    expect(v.grade).toBe('verified');
  });
});

describe('concrete answers', () => {
  it('downgrades an answer that says the evidence cannot settle it', () => {
    const v = verifyFinding({ finding: { answer: 'Based on the evidence it is not possible to determine the median price.', claims: [], confidence: 'low' }, sources, node: { method: 'lookup', unit: 'EUR', metric: 'median price' } });
    expect(v.grade).toBe('weak');
    expect(v.checks.find((c) => c.id === 'concrete')!.passed).toBe(false);
  });

  it('requires a number when the node expects one, and not otherwise', () => {
    const vague = verifyFinding({ finding: { answer: 'Prices are higher in Poland.', claims: [], confidence: 'low' }, sources, node: { method: 'comparison', unit: '', metric: 'price gap' } });
    expect(vague.grade).toBe('weak');
    const qualitative = verifyFinding({ finding: { answer: 'A dealer licence is required above 5 cars a year.', claims: [], confidence: 'low' }, sources, node: { method: 'lookup', unit: '' } });
    expect(qualitative.checks.some((c) => c.id === 'concrete')).toBe(false);
  });
});
