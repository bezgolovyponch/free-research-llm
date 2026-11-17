import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_RESAMPLES, LABELS, MIN_KAPPA_ITEMS, accuracy, bootstrapDifference, cohenKappa, confusion, excludesZero, labelOf, mulberry32, pairRuns, rateOf, spreadOf, unknownRate, wilson, wrongNo } from '../../src/research/agreement.mjs';

const pairs = (reference: string, answer: string, count: number) => Array.from({ length: count }, () => ({ reference, answer }));

describe('labels', () => {
  it('reads unknown as not stated and refuses anything outside the three labels', () => {
    expect(LABELS).toEqual(['yes', 'no', 'not stated']);
    expect(['yes', ' No ', 'unknown', 'Not stated', 'not-stated', 'maybe', null].map(labelOf)).toEqual(['yes', 'no', 'not stated', 'not stated', 'not stated', null, null]);
  });
});

describe("Cohen's kappa", () => {
  it('gives 0.4 on the worked example: 50 items, 20 both yes, 15 both no, 5 and 10 apart', () => {
    const example = [...pairs('yes', 'yes', 20), ...pairs('no', 'no', 15), ...pairs('yes', 'no', 5), ...pairs('no', 'yes', 10)];
    const result = cohenKappa(example);
    expect(result.n).toBe(50);
    expect(result.observed).toBeCloseTo(0.7, 12);
    expect(result.expected).toBeCloseTo(0.5, 12);
    expect(result.kappa).toBeCloseTo(0.4, 12);
    expect(confusion(example).matrix).toEqual([[20, 5, 0], [10, 15, 0], [0, 0, 0]]);
  });

  it('is 1 on full agreement over two labels, 0 at chance, and has no value when only one label occurs or nothing was judged', () => {
    expect(cohenKappa([...pairs('yes', 'yes', 4), ...pairs('no', 'no', 6)]).kappa).toBeCloseTo(1, 12);
    expect(cohenKappa([...pairs('yes', 'yes', 25), ...pairs('yes', 'no', 25), ...pairs('no', 'yes', 25), ...pairs('no', 'no', 25)]).kappa).toBeCloseTo(0, 12);
    expect(cohenKappa(pairs('yes', 'yes', 9))).toMatchObject({ kappa: null, n: 9 });
    expect(cohenKappa([])).toEqual({ kappa: null, n: 0, observed: null, expected: null });
    expect(cohenKappa([{ reference: 'yes', answer: 'other' }]).n).toBe(0);
    expect(MIN_KAPPA_ITEMS).toBe(30);
  });

  it('shows why percent agreement misleads: 90% agreement with kappa near 0 when one label dominates', () => {
    const skewed = [...pairs('yes', 'yes', 90), ...pairs('yes', 'no', 5), ...pairs('no', 'yes', 5)];
    expect(accuracy(skewed).rate).toBe(0.9);
    expect(cohenKappa(skewed).kappa).toBeCloseTo(-0.0526, 3);
  });
});

describe('rates', () => {
  it('counts a wrong no only where the reference says yes or not stated', () => {
    const judged = [...pairs('yes', 'no', 3), ...pairs('not stated', 'no', 2), ...pairs('yes', 'yes', 10), ...pairs('not stated', 'not stated', 5), ...pairs('no', 'no', 7), ...pairs('no', 'yes', 1)];
    expect(wrongNo(judged)).toMatchObject({ part: 5, total: 20, rate: 0.25 });
    expect(unknownRate(judged)).toMatchObject({ part: 5, total: 28 });
    expect(wrongNo(pairs('no', 'no', 4))).toMatchObject({ part: 0, total: 0, rate: null, low: null, high: null });
  });

  it('gives the Wilson interval with every rate', () => {
    const interval = wilson(5, 20);
    expect(interval.low).toBeCloseTo(0.1119, 3);
    expect(interval.high).toBeCloseTo(0.4687, 3);
    expect(wilson(0, 10).low).toBe(0);
    expect(wilson(10, 10).high).toBeCloseTo(1, 12);
    expect(rateOf(5, 20)).toMatchObject({ part: 5, total: 20, rate: 0.25 });
    expect(wilson(0, 0)).toEqual({ low: null, high: null });
  });
});

describe('paired comparison', () => {
  it('pairs two runs on the items both answered, once each, with the research as the cluster', () => {
    const a = [{ id: 'J1', research: 'r1', value: 1 }, { id: 'J2', research: 'r1', value: 0 }, { id: 'J3', research: 'r2', value: 1 }, { id: 'J1', research: 'r1', value: 0 }, { id: 'J5', research: 'r2', value: Number.NaN }];
    const b = [{ id: 'J2', research: 'r1', value: 1 }, { id: 'J1', research: 'r1', value: 1 }, { id: 'J4', research: 'r2', value: 1 }, { id: 'J5', research: 'r2', value: 1 }];
    expect(pairRuns(a, b)).toEqual([{ key: 'J1', cluster: 'r1', a: 1, b: 1 }, { key: 'J2', cluster: 'r1', a: 0, b: 1 }]);
    expect(pairRuns([], b)).toEqual([]);
  });

  it('draws the same seeded numbers every time', () => {
    const first = mulberry32(7);
    const second = mulberry32(7);
    const drawn = [first(), first(), first()];
    expect([second(), second(), second()]).toEqual(drawn);
    expect(drawn.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(mulberry32(8)()).not.toBe(drawn[0]);
  });

  it('gives the mean paired difference with a seeded bootstrap interval, resampled by research', () => {
    const cluster = (name: string, gains: number[]) => gains.map((gain, at) => ({ key: `${name}-${at}`, cluster: name, a: 0, b: gain }));
    const better = [...cluster('r1', [1, 1, 1, 0]), ...cluster('r2', [1, 1, 0, 1]), ...cluster('r3', [1, 0, 1, 1]), ...cluster('r4', [1, 1, 1, 1])];
    const result = bootstrapDifference(better, { seed: 3 });
    expect(result).toMatchObject({ n: 16, clusters: 4, resamples: BOOTSTRAP_RESAMPLES });
    expect(result.difference).toBeCloseTo(13 / 16, 12);
    expect(result.low).toBeGreaterThanOrEqual(0.75);
    expect(result.high).toBeLessThanOrEqual(1);
    expect(result.low).toBeLessThan(result.difference);
    expect(excludesZero(result)).toBe(true);
    expect(bootstrapDifference(better, { seed: 3 })).toEqual(result);
    expect(bootstrapDifference(better, { seed: 4, resamples: 200 }).resamples).toBe(200);
  });

  it('keeps an interval that includes 0 when the researches disagree, where resampling items alone would hide it', () => {
    const cluster = (name: string, gain: number, count: number) => Array.from({ length: count }, (_, at) => ({ key: `${name}-${at}`, cluster: name, a: 0, b: gain }));
    const mixed = [...cluster('r1', 1, 30), ...cluster('r2', -1, 20), ...cluster('r3', 1, 5), ...cluster('r4', -1, 5)];
    const result = bootstrapDifference(mixed, { seed: 1 });
    expect(result.difference).toBeCloseTo(10 / 60, 12);
    expect(result.low).toBeLessThan(0);
    expect(result.high).toBeGreaterThan(0);
    expect(excludesZero(result)).toBe(false);
    expect(bootstrapDifference([])).toEqual({ difference: null, low: null, high: null, n: 0, clusters: 0, resamples: 0 });
    expect(excludesZero(bootstrapDifference([]))).toBe(false);
  });
});

describe('spread over runs', () => {
  it('gives the count, mean, lowest, highest and sample deviation', () => {
    expect(spreadOf([0.2, 0.4, 0.6])).toMatchObject({ n: 3, min: 0.2, max: 0.6 });
    expect(spreadOf([0.2, 0.4, 0.6]).mean).toBeCloseTo(0.4, 12);
    expect(spreadOf([0.2, 0.4, 0.6]).sd).toBeCloseTo(0.2, 12);
    expect(spreadOf([0.5])).toEqual({ n: 1, mean: 0.5, min: 0.5, max: 0.5, sd: 0 });
    expect(spreadOf([null, undefined])).toEqual({ n: 0, mean: null, min: null, max: null, sd: null });
  });
});
