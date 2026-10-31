import { describe, expect, it } from 'vitest';
import {
  captureBaseline,
  championChallenger,
  driftCheck,
  driftScore,
  findingBasis,
  findingQuality,
  ksTest,
  lineageFor,
  numericSignature,
  recordSample,
  regradeSettled,
  slidingWindows,
  summaryStats,
} from '../../src/research/monitor.mjs';

describe('summaryStats', () => {
  it('computes min, max, mean, median, variance and quantiles', () => {
    const s = summaryStats([1, 2, 3, 4, 5]);
    expect(s.n).toBe(5);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.mean).toBe(3);
    expect(s.median).toBe(3);
    expect(s.variance).toBeCloseTo(2.5);
    expect(s.q5).toBeLessThanOrEqual(s.q25);
    expect(s.q25).toBeLessThanOrEqual(s.q75);
    expect(s.q75).toBeLessThanOrEqual(s.q95);
  });

  it('returns null for empty input', () => {
    expect(summaryStats([])).toBeNull();
  });
});

describe('ksTest', () => {
  it('detects identical distributions as not significant', () => {
    const same = [1, 2, 3, 4, 5, 6, 7, 8];
    const r = ksTest(same, [...same]);
    expect(r.significant).toBe(false);
    expect(r.D).toBe(0);
  });

  it('detects shifted distributions as significant', () => {
    const low = Array(40).fill(0).map((_, i) => i);
    const high = Array(40).fill(0).map((_, i) => i + 50);
    const r = ksTest(low, high);
    expect(r.significant).toBe(true);
    expect(r.D).toBeGreaterThan(0.5);
  });

  it('handles empty input gracefully', () => {
    expect(ksTest([], [1, 2])).toMatchObject({ D: 0, p: 1, significant: false });
  });
});

describe('slidingWindows', () => {
  it('splits time-ordered observations into overlapping windows', () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8];
    const w = slidingWindows(samples, { windowSize: 4, step: 1 });
    expect(w.length).toBe(5);
    expect(w[0]).toEqual([1, 2, 3, 4]);
    expect(w[4]).toEqual([5, 6, 7, 8]);
  });

  it('returns empty when window is larger than the sample', () => {
    expect(slidingWindows([1, 2], { windowSize: 5 })).toEqual([]);
  });
});

describe('driftScore', () => {
  it('is zero for identical distributions', () => {
    const same = [10, 12, 11, 13, 12];
    expect(driftScore(same, same)).toBeCloseTo(0, 1);
  });

  it('rises when the current distribution shifts away from baseline', () => {
    const baseline = Array(40).fill(0).map(() => 100 + Math.random() * 2);
    const shifted = Array(40).fill(0).map(() => 200 + Math.random() * 2);
    expect(driftScore(baseline, shifted)).toBeGreaterThan(0.3);
  });

  it('is zero when either side is empty', () => {
    expect(driftScore([], [1, 2])).toBe(0);
    expect(driftScore([1, 2], [])).toBe(0);
  });
});

describe('numericSignature', () => {
  it('collects numbers from claim values and calculation results', () => {
    const node = {
      finding: {
        claims: [
          { text: 'median price 3300 EUR', value: 3300 },
          { text: 'premium +23.3%', value: null },
        ],
        calculation: { formula: 'a/b', result: 1.15 },
        items: [{ value: 4 }, { value: 7 }],
      },
    };
    const sig = numericSignature(node);
    expect(sig).toContain(3300);
    expect(sig).toContain(1.15);
    expect(sig).toContain(4);
    expect(sig).toContain(7);
  });
});

describe('captureBaseline / recordSample / driftCheck', () => {
  it('captures a baseline, records a shifted sample, and reports drift', () => {
    const node: any = {
      finding: { claims: [{ text: 'price is 100', value: 100 }], items: [] },
    };
    captureBaseline(node);
    expect(node.drift.baseline).toBeDefined();
    expect(node.drift.baseline.values).toContain(100);

    // strong shift: single outlier drives KS D well above threshold
    recordSample(node, { values: [100, 100, 1000] });
    const d = driftCheck(node);
    expect(d).toBeDefined();
    expect(d.score).toBeGreaterThanOrEqual(0);
    expect(d.summary).toBeDefined();
    expect(d.test.significant).toBeDefined();
  });

  it('returns null when there is no baseline or samples', () => {
    expect(driftCheck({})).toBeNull();
  });
});

describe('championChallenger', () => {
  const champion = {
    finding: { answer: 'old', claims: [] },
    verification: { grade: 'supported', score: 60 },
  };

  it('accepts a challenger that beats the champion above the noise floor', () => {
    const challenger = { finding: { answer: 'new', claims: [] }, verification: { grade: 'verified', score: 80 } };
    const r = championChallenger(champion, challenger, { noiseFloor: 0.05 });
    expect(r.accept).toBe(true);
    expect(r.after).toBeGreaterThan(r.before);
  });

  it('rejects a challenger below the noise floor', () => {
    const challenger = { finding: { answer: 'new', claims: [] }, verification: { grade: 'supported', score: 60 } };
    const r = championChallenger(champion, challenger, { noiseFloor: 0.5 });
    expect(r.accept).toBe(false);
    expect(r.reason).toContain('champion kept');
  });

  it('rejects a weaker challenger', () => {
    const challenger = { finding: { answer: 'new', claims: [] }, verification: { grade: 'weak', score: 30 } };
    const r = championChallenger(champion, challenger);
    expect(r.accept).toBe(false);
    expect(r.gain).toBeLessThan(0);
  });
});

describe('findingQuality', () => {
  it('maps verified to a high quality and unsupported to a low one', () => {
    const good = findingQuality({ answer: 'x', claims: [] }, { grade: 'verified', score: 100 });
    const bad = findingQuality({ answer: 'x', claims: [] }, { grade: 'unsupported', score: 0 });
    expect(good).toBeGreaterThan(bad);
    expect(good).toBeCloseTo(1);
    expect(bad).toBeCloseTo(0);
  });
});

describe('findingBasis / lineageFor', () => {
  it('produces a stable short hash for a finding', () => {
    const f = { answer: 'hello', claims: [{ text: 'c' }] };
    const b1 = findingBasis(f);
    const b2 = findingBasis(f);
    expect(b1).toBe(b2);
    expect(b1.length).toBe(12);
    expect(findingBasis({ answer: 'different', claims: [] })).not.toBe(b1);
  });

  it('records lineage with parent link on replacement', () => {
    const node: any = { id: 'D1', finding: { answer: 'v1', claims: [] } };
    const first = lineageFor(node);
    expect(first.id).toContain('D1');
    expect(first.parentId).toBeUndefined();

    const oldLineage = first;
    node.finding = { answer: 'v2', claims: [] };
    const second = lineageFor(node, { previous: oldLineage });
    expect(second.parentId).toBe(oldLineage.id);
    expect(second.basis).not.toBe(first.basis);
  });
});

describe('regradeSettled', () => {
  it('stops re-researching a leaf after the drift re-research limit', () => {
    const drifted = () => ({
      id: 'D1',
      parentId: 'Q',
      status: 'verified',
      finding: { answer: 'x', claims: [{ text: '100', value: 100 }] },
      drift: {
        baseline: { at: 't0', values: [100], stats: summaryStats([100]) },
        samples: [{ at: 't1', values: [100, 100, 1000], stats: summaryStats([100, 100, 1000]), test: { D: 0.33, p: 0.01, significant: true }, score: 0.48 }],
      },
    });
    const node = drifted();
    const opts = { isLeaf: () => true, isSettled: (n: { status: string }) => n.status === 'verified', downgradeTo: 'pending' };
    for (let run = 1; run <= 2; run++) {
      expect(regradeSettled([node], opts).length).toBe(1);
      node.status = 'verified';
    }
    expect(node.driftResearches).toBe(2);
    expect(regradeSettled([node], opts)).toEqual([]);
    expect(node.status).toBe('verified');
  });

  it('downgrades a settled leaf with significant drift to weak', () => {
    const makeNode = (status: string) => ({
      id: 'D1',
      parentId: 'Q',
      status,
      finding: { answer: 'x', claims: [{ text: '100', value: 100 }] },
      drift: {
        baseline: { at: 't0', values: [100], stats: summaryStats([100]) },
        samples: [{ at: 't1', values: [100, 100, 1000], stats: summaryStats([100, 100, 1000]), test: { D: 0.33, p: 0.01, significant: true }, score: 0.48 }],
      },
    });
    const settled = makeNode('verified');
    const notLeaf = { id: 'D2', parentId: 'Q', status: 'verified', finding: { answer: 'x', claims: [] } };
    const result = regradeSettled([settled, notLeaf], {
      isLeaf: (nodes, n) => nodes.every((x) => x.parentId !== n.id),
      isSettled: (n) => n.status === 'verified',
    });
    expect(result.length).toBe(1);
    expect(result[0].nodeId).toBe('D1');
    expect(settled.status).toBe('weak');
  });

  it('leaves settled leaves without drift untouched', () => {
    const settled = {
      id: 'D1', parentId: 'Q', status: 'supported',
      finding: { answer: 'x', claims: [{ text: '100', value: 100 }] },
      drift: { baseline: { at: 't0', values: [100], stats: summaryStats([100]) }, samples: [] },
    };
    const result = regradeSettled([settled], {
      isLeaf: () => true,
      isSettled: (n) => n.status === 'supported',
    });
    expect(result).toEqual([]);
    expect(settled.status).toBe('supported');
  });
});
