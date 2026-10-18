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

describe('verify: links and non-answers', () => {
  const sources = [{ id: 'S1', kind: 'web', url: 'https://cars.example/list', domain: 'cars.example', links: [{ url: 'https://cars.example/ad/123456', text: 'Golf 2.900 €' }] }];

  it('rejects an item link that was not on any fetched page', async () => {
    const { verifyFinding, sameUrl } = await import('../../src/research/verify.mjs');
    const ok = verifyFinding({ finding: { answer: 'Golf for 2,900 EUR', claims: [{ text: 'Golf 2900 EUR', sourceIds: ['S1'] }], items: [{ url: 'https://www.cars.example/ad/123456/' }] }, sources });
    expect(ok.checks.find((c) => c.id === 'item-links').passed).toBe(true);
    const bad = verifyFinding({ finding: { answer: 'Golf for 2,900 EUR', claims: [{ text: 'Golf 2900 EUR', sourceIds: ['S1'] }], items: [{ url: 'https://cars.example/ad/999' }] }, sources });
    expect(bad.grade).toBe('unsupported');
    expect(sameUrl('https://www.a.example/x/#top', 'http://a.example/x')).toBe(true);
  });

  it('fails the concrete-answer check for evasive answers', async () => {
    const { verifyFinding } = await import('../../src/research/verify.mjs');
    for (const answer of [
      'Based on the available evidence, we cannot determine the number.',
      'No verifiable marketplace listings are available in the provided evidence.',
      'The evidence does not contain prices.',
      'Average retail rent (EUR/m²) for 2025 is not available from the provided evidence for Brno, Ostrava, or Plzen.',
      'The provided sources do not contain explicit 2025 population figures for Brno, Ostrava, or Plzen; therefore the ranking is open.',
      'No evidence is available to determine the number of specialty coffee shops in Brno.',
      'Total rent cannot be assessed because the average retail rent per square metre is not available.',
      'There is no available evidence to determine how many specialty coffee shops operate in Brno.',
    ]) {
      expect(verifyFinding({ finding: { answer, claims: [] }, sources }).checks.find((c) => c.id === 'concrete').passed).toBe(false);
    }
    expect(verifyFinding({ finding: { answer: 'A standard kiosk occupies roughly 9 m² (3 m × 3 m).', claims: [] }, sources }).checks.find((c) => c.id === 'concrete')).toBeUndefined();
  });
});

describe('verify: code-read data', () => {
  it('accepts high confidence when the cited source is data read by code', async () => {
    const { verifyFinding } = await import('../../src/research/verify.mjs');
    const sources = [{ id: 'S1', kind: 'data', provider: 'marketplace', url: 'https://k.example/s', domain: 'k.example', links: [{ url: 'https://k.example/ad/1', text: 'a' }] }];
    const finding = { answer: 'Octavia for 3,790 EUR', confidence: 'high', claims: [{ text: 'price 3790 EUR', sourceIds: ['S1'] }], items: [{ url: 'https://k.example/ad/1' }] };
    const result = verifyFinding({ finding, sources });
    expect(result.checks.find((c) => c.id === 'independent-sources').passed).toBe(true);
    expect(result.grade).toBe('verified');
    const web = verifyFinding({ finding, sources: [{ ...sources[0], kind: 'web' }] });
    expect(web.grade).toBe('weak');
  });
});

