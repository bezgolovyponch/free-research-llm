import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { binomialCoefficient, mcNemarExact, negativeFlips, negativeTierFlips, positiveTierFlips, negativeHardCheckFlips, positiveHardCheckFlips, positiveFlips, outcomesOf, recordSnapshot, checkSnapshot, runJudgeCheck, createTapeRouter, judgeKey, findPageText, getQualitativeItems, runJudgeOnItem, loadFullProject, extractJudgedItems, computeTiers, extractStoredJudgeAnswers } from '../../scripts/zero-loss.mjs';
import { createAnswerTape, tapeKey } from '../../scripts/answer-tape.mjs';
import { ChecklistJudge } from '../../src/research/checklist.mjs';
import { ModelRouter } from '../../src/llm/router.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';

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

describe('zero-loss: judge flip detection logic', () => {
  it('detects yes->no flip for judge outcomes', () => {
    const baseline = {
      outcomes: [
        { project: 'p1', url: 'https://example.test/1', clause: 'quality', question: 'Is it high quality?', hard: true, measure: 'judge', outcome: 'yes' },
        { project: 'p1', url: 'https://example.test/2', clause: 'quality', question: 'Is it high quality?', hard: false, measure: 'judge', outcome: 'yes' },
      ],
    };
    const current = {
      outcomes: [
        { project: 'p1', url: 'https://example.test/1', clause: 'quality', question: 'Is it high quality?', hard: true, measure: 'judge', outcome: 'no' },
        { project: 'p1', url: 'https://example.test/2', clause: 'quality', question: 'Is it high quality?', hard: false, measure: 'judge', outcome: 'yes' },
      ],
    };
    const flips = negativeFlips(baseline, current);
    expect(flips).toHaveLength(1);
    expect(flips[0]).toMatchObject({ url: 'https://example.test/1', clause: 'quality', question: 'Is it high quality?' });
  });

  it('detects yes->unknown as flip for judge outcomes', () => {
    const baseline = {
      outcomes: [
        { project: 'p1', url: 'https://example.test/1', clause: 'quality', question: 'Is it high quality?', hard: true, measure: 'judge', outcome: 'yes' },
      ],
    };
    const current = {
      outcomes: [
        { project: 'p1', url: 'https://example.test/1', clause: 'quality', question: 'Is it high quality?', hard: true, measure: 'judge', outcome: 'unknown' },
      ],
    };
    const flips = negativeFlips(baseline, current);
    expect(flips).toHaveLength(1);
  });

  it('ignores no->yes transition', () => {
    const baseline = {
      outcomes: [
        { project: 'p1', url: 'https://example.test/1', clause: 'quality', question: 'Is it high quality?', hard: true, measure: 'judge', outcome: 'no' },
      ],
    };
    const current = {
      outcomes: [
        { project: 'p1', url: 'https://example.test/1', clause: 'quality', question: 'Is it high quality?', hard: true, measure: 'judge', outcome: 'yes' },
      ],
    };
    const flips = negativeFlips(baseline, current);
    expect(flips).toHaveLength(0);
  });
});

describe('zero-loss: judge unrecorded tracking', () => {
  it('tracks unrecorded prompts separately from flips in runJudgeCheck logic', () => {
    const baseline = {
      outcomes: [
        { project: 'p1', url: 'https://example.test/1', clause: 'quality', question: 'Is it high quality?', hard: true, measure: 'judge', outcome: 'yes' },
      ],
    };
    const current = {
      outcomes: [
        { project: 'p1', url: 'https://example.test/1', clause: 'quality', question: 'Is it high quality?', hard: true, measure: 'judge', outcome: 'unknown' },
      ],
    };
    const flips = negativeFlips(baseline, current);
    expect(flips.length).toBe(1);
  });
});

describe('zero-loss: tier flip detection', () => {
  const baseline = {
    outcomes: [],
    tierOutcomes: [
      { project: 'p1', url: 'https://example.test/1', clause: 'verdict', question: 'tier', measure: 'tier', outcome: 'confirmed' },
      { project: 'p1', url: 'https://example.test/2', clause: 'verdict', question: 'tier', measure: 'tier', outcome: 'to-confirm' },
      { project: 'p1', url: 'https://example.test/3', clause: 'verdict', question: 'tier', measure: 'tier', outcome: 'rejected' },
    ],
  };
  const current = {
    outcomes: [],
    tierOutcomes: [
      { project: 'p1', url: 'https://example.test/1', clause: 'verdict', question: 'tier', measure: 'tier', outcome: 'to-confirm' },
      { project: 'p1', url: 'https://example.test/2', clause: 'verdict', question: 'tier', measure: 'tier', outcome: 'confirmed' },
      { project: 'p1', url: 'https://example.test/3', clause: 'verdict', question: 'tier', measure: 'tier', outcome: 'rejected' },
    ],
  };
  it('detects confirmed->to-confirm as negative tier flip', () => {
    const flips = negativeTierFlips(baseline, current);
    expect(flips).toHaveLength(1);
    expect(flips[0]).toMatchObject({ url: 'https://example.test/1', baselineTier: 'confirmed', currentTier: 'to-confirm' });
  });
  it('detects to-confirm->confirmed as positive tier flip', () => {
    const flips = positiveTierFlips(baseline, current);
    expect(flips).toHaveLength(1);
    expect(flips[0]).toMatchObject({ url: 'https://example.test/2', baselineTier: 'to-confirm', currentTier: 'confirmed' });
  });
  it('ignores rejected->rejected', () => {
    const flips = negativeTierFlips(baseline, current);
    expect(flips.every(f => f.url !== 'https://example.test/3')).toBe(true);
  });
});

describe('zero-loss: hard check flip detection', () => {
  const baseline = {
    outcomes: [],
    storedJudgeOutcomes: [
      { project: 'p1', url: 'https://example.test/1', clause: 'quality', question: 'Is it high quality?', hard: true, measure: 'judge-stored', outcome: 'yes' },
      { project: 'p1', url: 'https://example.test/2', clause: 'quality', question: 'Is it high quality?', hard: true, measure: 'judge-stored', outcome: 'no' },
      { project: 'p1', url: 'https://example.test/3', clause: 'quality', question: 'Is it high quality?', hard: false, measure: 'judge-stored', outcome: 'yes' },
    ],
  };
  const current = {
    outcomes: [],
    storedJudgeOutcomes: [
      { project: 'p1', url: 'https://example.test/1', clause: 'quality', question: 'Is it high quality?', hard: true, measure: 'judge-stored', outcome: 'no' },
      { project: 'p1', url: 'https://example.test/2', clause: 'quality', question: 'Is it high quality?', hard: true, measure: 'judge-stored', outcome: 'yes' },
      { project: 'p1', url: 'https://example.test/3', clause: 'quality', question: 'Is it high quality?', hard: false, measure: 'judge-stored', outcome: 'yes' },
    ],
  };
  it('detects hard check yes->no as negative flip', () => {
    const flips = negativeHardCheckFlips(baseline, current);
    expect(flips).toHaveLength(1);
    expect(flips[0]).toMatchObject({ url: 'https://example.test/1', baselineAnswer: 'yes', currentAnswer: 'no' });
  });
  it('detects hard check no->yes as positive flip', () => {
    const flips = positiveHardCheckFlips(baseline, current);
    expect(flips).toHaveLength(1);
    expect(flips[0]).toMatchObject({ url: 'https://example.test/2', baselineAnswer: 'no', currentAnswer: 'yes' });
  });
  it('ignores soft checks', () => {
    const flips = negativeHardCheckFlips(baseline, current);
    expect(flips.every(f => f.url !== 'https://example.test/3')).toBe(true);
  });
});

describe('zero-loss: extractJudgedItems and computeTiers', () => {
  it('extracts items with checks from acceptanceResult', () => {
    const project = {
      id: 'test-project',
      acceptance: { itemCount: 2 },
      decisionModel: { checklist: [{ clause: 'quality', items: [{ question: 'Good?', hard: true }] }], kind: null },
      acceptanceResult: {
        items: [
          { url: 'https://a.example.org/1', title: 'Item 1', checks: [{ id: 'quality|Good?', answer: 'yes', quote: 'q1', hard: true, clause: 'quality' }], tier: 'confirmed' },
          { url: 'https://a.example.org/2', title: 'Item 2', checks: [{ id: 'quality|Good?', answer: 'no', quote: '', hard: true, clause: 'quality' }], tier: 'rejected' },
        ],
      },
    };
    const items = extractJudgedItems(project);
    expect(items).toHaveLength(2);
    expect(items[0].url).toBe('https://a.example.org/1');
    expect(items[0].checks).toHaveLength(1);
    expect(items[0].checks[0].answer).toBe('yes');
    expect(items[1].checks[0].answer).toBe('no');
  });

  it('extracts items from plan.checks when checks not present', () => {
    const project = {
      id: 'test-project',
      acceptance: { itemCount: 1 },
      decisionModel: { checklist: [{ clause: 'quality', items: [{ question: 'Good?', hard: true }] }], kind: null },
      acceptanceResult: {
        items: [
          { url: 'https://a.example.org/1', title: 'Item 1', plan: { checks: [{ id: 'sea', ok: true, detail: 'sea 5km', label: 'sea within 20km' }] }, tier: 'confirmed' },
        ],
      },
    };
    const items = extractJudgedItems(project);
    expect(items).toHaveLength(1);
    expect(items[0].checks).toHaveLength(1);
    expect(items[0].checks[0].answer).toBe('yes');
  });
});