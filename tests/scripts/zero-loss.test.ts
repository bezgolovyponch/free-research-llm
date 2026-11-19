import { describe, expect, it } from 'vitest';
import { binomialCoefficient, mcNemarExact, negativeFlips, outcomesOf, recordSnapshot, checkSnapshot } from '../../scripts/zero-loss.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, writeFile, rm } from 'node:fs/promises';

describe('zero-loss: McNemar exact', () => {
  it('b=1, c=8 -> 0.0390625', () => {
    expect(mcNemarExact(1, 8)).toBeCloseTo(0.0390625, 10);
  });
  it('b=0, c=0 -> 1', () => {
    expect(mcNemarExact(0, 0)).toBe(1);
  });
  it('b=5, c=5 -> 1', () => {
    expect(mcNemarExact(5, 5)).toBe(1);
  });
});

describe('zero-loss: binomial coefficient', () => {
  it('C(9,0)=1, C(9,1)=9, C(9,2)=36', () => {
    expect(binomialCoefficient(9, 0)).toBe(1);
    expect(binomialCoefficient(9, 1)).toBe(9);
    expect(binomialCoefficient(9, 2)).toBe(36);
  });
  it('C(10,5)=252', () => {
    expect(binomialCoefficient(10, 5)).toBe(252);
  });
});

describe('zero-loss: negative flips', () => {
  const baseline = {
    outcomes: [
      { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q1', measure: 'm1', outcome: 'yes' },
      { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q2', measure: 'm1', outcome: 'yes' },
      { project: 'p1', url: 'https://a.example.org/2', clause: 'c1', question: 'q1', measure: 'm1', outcome: 'no' },
    ],
  };
  const current = {
    outcomes: [
      { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q1', measure: 'm1', outcome: 'no' },
      { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q2', measure: 'm1', outcome: 'yes' },
      { project: 'p1', url: 'https://a.example.org/2', clause: 'c1', question: 'q1', measure: 'm1', outcome: 'yes' },
    ],
  };
  it('detects yes->no flips only', () => {
    const flips = negativeFlips(baseline, current);
    expect(flips).toHaveLength(1);
    expect(flips[0]).toMatchObject({ url: 'https://a.example.org/1', clause: 'c1', question: 'q1' });
  });
  it('ignores no->yes and unknown transitions', () => {
    const flips = negativeFlips(baseline, current);
    expect(flips.every(f => f.question !== 'q1' || f.url !== 'https://a.example.org/2')).toBe(true);
  });
});

describe('zero-loss: outcomesOf', () => {
  it('returns empty for project without numeric checklist items', async () => {
    const dir = await mkdir(join(tmpdir(), 'frl-test-' + Date.now()), { recursive: true });
    const project = {
      id: 'test-empty',
      question: 'Test',
      decisionModel: { checklist: [{ clause: 'c1', items: [{ question: 'Q?', hard: true }] }] },
      candidates: { kept: [] },
    };
    const file = join(dir, 'test-empty.json');
    await writeFile(file, JSON.stringify(project));
    const result = await outcomesOf(file, '/tmp');
    expect(result.outcomes).toHaveLength(0);
    expect(result.criteriaCount).toBe(0);
    expect(result.hardCount).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('zero-loss: record and check roundtrip', () => {
  it('records and checks same snapshot -> PASS, 0 flips', async () => {
    const dir = await mkdir(join(tmpdir(), 'frl-snap-' + Date.now()), { recursive: true });
    const projectsDir = join(dir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const project = {
      id: 'test-roundtrip',
      question: 'Test',
      decisionModel: {
        criteria: [{ measure: 'priceEur', op: '<=', value: 100000 }],
        checklist: [{ clause: 'price', items: [{ question: 'Under 100k?', hard: true, numeric: { measure: 'priceEur', op: '<=', value: 100000 } }] }],
      },
      candidates: { kept: [{ url: 'https://a.example.org/1', value: 50000, unit: 'EUR' }] },
    };
    await writeFile(join(projectsDir, 'test-roundtrip.json'), JSON.stringify(project));
    const baselineFile = join(tmpdir(), 'baseline-' + Date.now() + '.json');
    await recordSnapshot(dir, baselineFile);
    const exitCode = await checkSnapshot(dir, baselineFile);
    expect(exitCode).toBe(0);
    await rm(dir, { recursive: true, force: true });
    await rm(baselineFile, { force: true });
  });
});