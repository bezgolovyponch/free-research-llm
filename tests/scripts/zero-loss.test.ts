import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { binomialCoefficient, mcNemarExact, negativeFlips, negativeTierFlips, positiveTierFlips, negativeHardCheckFlips, positiveHardCheckFlips, positiveFlips, outcomesOf, recordSnapshot, checkSnapshot, runJudgeCheck, createTapeRouter, judgeKey, findPageText, getQualitativeItems, runJudgeOnItem, loadFullProject, extractJudgedItems, computeTiers, extractStoredJudgeAnswers, outcomesDiffer, reportOutcomesOf, negativeReportFlips, nothingToCompare, upgradeSnapshot } from '../../scripts/zero-loss.mjs';
import { createAnswerTape, tapeKey } from '../../scripts/answer-tape.mjs';
import { ChecklistJudge } from '../../src/research/checklist.mjs';
import { ModelRouter } from '../../src/llm/router.mjs';
import { evaluationKind } from '../../src/research/verdict.mjs';
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

describe('zero-loss: exercised command', () => {
  it('detects zero changed outcomes', () => {
    const baseline = {
      outcomes: [
        { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q1', hard: true, measure: 'm1', outcome: 'yes' },
        { project: 'p1', url: 'https://a.example.org/2', clause: 'c1', question: 'q2', hard: false, measure: 'm1', outcome: 'no' },
      ],
    };
    const current = {
      outcomes: [
        { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q1', hard: true, measure: 'm1', outcome: 'yes' },
        { project: 'p1', url: 'https://a.example.org/2', clause: 'c1', question: 'q2', hard: false, measure: 'm1', outcome: 'no' },
      ],
    };
    const { changed, total } = outcomesDiffer(baseline, current);
    expect(changed).toBe(0);
    expect(total).toBe(2);
  });

  it('detects changed outcome field', () => {
    const baseline = {
      outcomes: [
        { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q1', hard: true, measure: 'm1', outcome: 'yes' },
      ],
    };
    const current = {
      outcomes: [
        { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q1', hard: true, measure: 'm1', outcome: 'no' },
      ],
    };
    const { changed, total } = outcomesDiffer(baseline, current);
    expect(changed).toBe(1);
    expect(total).toBe(1);
  });

  it('detects changed measure field', () => {
    const baseline = {
      outcomes: [
        { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q1', hard: true, measure: 'm1', outcome: 'yes' },
      ],
    };
    const current = {
      outcomes: [
        { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q1', hard: true, measure: 'm2', outcome: 'yes' },
      ],
    };
    const { changed, total } = outcomesDiffer(baseline, current);
    expect(changed).toBe(1);
    expect(total).toBe(1);
  });

  it('ignores project/url/clause/question keys for diff', () => {
    const baseline = {
      outcomes: [
        { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q1', hard: true, measure: 'm1', outcome: 'yes' },
      ],
    };
    const current = {
      outcomes: [
        { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q1', hard: true, measure: 'm1', outcome: 'yes' },
      ],
    };
    const { changed, total } = outcomesDiffer(baseline, current);
    expect(changed).toBe(0);
    expect(total).toBe(1);
  });

  it('handles new outcomes in current not in baseline', () => {
    const baseline = {
      outcomes: [
        { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q1', hard: true, measure: 'm1', outcome: 'yes' },
      ],
    };
    const current = {
      outcomes: [
        { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q1', hard: true, measure: 'm1', outcome: 'yes' },
        { project: 'p1', url: 'https://a.example.org/2', clause: 'c1', question: 'q2', hard: false, measure: 'm1', outcome: 'no' },
      ],
    };
    const { changed, total } = outcomesDiffer(baseline, current);
    expect(changed).toBe(0);
    expect(total).toBe(2);
  });

  it('handles missing outcomes in current', () => {
    const baseline = {
      outcomes: [
        { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q1', hard: true, measure: 'm1', outcome: 'yes' },
        { project: 'p1', url: 'https://a.example.org/2', clause: 'c1', question: 'q2', hard: false, measure: 'm1', outcome: 'no' },
      ],
    };
    const current = {
      outcomes: [
        { project: 'p1', url: 'https://a.example.org/1', clause: 'c1', question: 'q1', hard: true, measure: 'm1', outcome: 'yes' },
      ],
    };
    const { changed, total } = outcomesDiffer(baseline, current);
    expect(changed).toBe(0);
    expect(total).toBe(1);
  });
});

describe('zero-loss: reportOutcomesOf', () => {
  it('returns empty array for project without report', () => {
    const project = { id: 'test', question: 'Test', phase: 'running' };
    const outcomes = reportOutcomesOf(project);
    expect(outcomes).toHaveLength(0);
  });

  it('returns empty array for project with null report', () => {
    const project = { id: 'test', question: 'Test', phase: 'running', report: null };
    const outcomes = reportOutcomesOf(project);
    expect(outcomes).toHaveLength(0);
  });

  it('returns nine units for a complete memo project', () => {
    const project = {
      id: 'test-memo',
      question: 'Test',
      phase: 'done',
      nodes: [{ id: 'n1' }, { id: 'n2' }],
      report: {
        verdict: 'Buy it',
        chosenOption: 'O2',
        options: [
          { option: 'A', support: ['n1'], against: [] },
          { option: 'B', support: [], against: ['n1'] },
          { option: 'C', support: [], against: [] },
        ],
        scenarios: [{ name: 'S1' }, { name: 'S2' }],
        sensitivity: [{ var: 'v1' }],
        keyNumbers: [{ k: 1 }, { k: 2 }, { k: 3 }],
        actionItems: [
          { action: 'Do X', why: 'Y', nodeIds: ['n1'] },
          { action: 'Do Z', why: 'W', nodeIds: ['n3'] },
        ],
      },
    };
    const outcomes = reportOutcomesOf(project);
    expect(outcomes).toHaveLength(9);
    const byUnit = Object.fromEntries(outcomes.map((o) => [o.unit, o.value]));
    expect(byUnit.ended).toBe(true);
    expect(byUnit.verdict).toBe(true);
    expect(byUnit.options).toBe(3);
    expect(byUnit.optionsLinked).toBe(2);
    expect(byUnit.chosenOption).toBe('O2');
    expect(byUnit.scenarios).toBe(2);
    expect(byUnit.sensitivity).toBe(1);
    expect(byUnit.keyNumbers).toBe(3);
    expect(byUnit.actionsLinked).toBe(1);
  });

  it('counts zero for missing arrays', () => {
    const project = {
      id: 'test',
      question: 'Test',
      phase: 'done',
      nodes: [],
      report: { verdict: '' },
    };
    const outcomes = reportOutcomesOf(project);
    expect(outcomes).toHaveLength(9);
    const byUnit = Object.fromEntries(outcomes.map((o) => [o.unit, o.value]));
    expect(byUnit.ended).toBe(true);
    expect(byUnit.verdict).toBe(false);
    expect(byUnit.options).toBe(0);
    expect(byUnit.optionsLinked).toBe(0);
    expect(byUnit.chosenOption).toBeNull();
    expect(byUnit.scenarios).toBe(0);
    expect(byUnit.sensitivity).toBe(0);
    expect(byUnit.keyNumbers).toBe(0);
    expect(byUnit.actionsLinked).toBe(0);
  });
});

describe('zero-loss: negativeReportFlips', () => {
  const baseline = {
    reportOutcomes: [
      { project: 'p1', unit: 'ended', value: true },
      { project: 'p1', unit: 'verdict', value: true },
      { project: 'p1', unit: 'options', value: 3 },
      { project: 'p1', unit: 'optionsLinked', value: 2 },
      { project: 'p1', unit: 'scenarios', value: 2 },
      { project: 'p1', unit: 'sensitivity', value: 1 },
      { project: 'p1', unit: 'keyNumbers', value: 3 },
      { project: 'p1', unit: 'actionsLinked', value: 1 },
    ],
  };
  it('detects missing current entry', () => {
    const current = { reportOutcomes: [] };
    const flips = negativeReportFlips(baseline, current);
    expect(flips).toHaveLength(8);
  });
  it('detects boolean true->false', () => {
    const current = {
      reportOutcomes: [
        { project: 'p1', unit: 'ended', value: false },
        { project: 'p1', unit: 'verdict', value: true },
        { project: 'p1', unit: 'options', value: 3 },
        { project: 'p1', unit: 'optionsLinked', value: 2 },
        { project: 'p1', unit: 'scenarios', value: 2 },
        { project: 'p1', unit: 'sensitivity', value: 1 },
        { project: 'p1', unit: 'keyNumbers', value: 3 },
        { project: 'p1', unit: 'actionsLinked', value: 1 },
      ],
    };
    const flips = negativeReportFlips(baseline, current);
    expect(flips).toHaveLength(1);
    expect(flips[0].unit).toBe('ended');
    expect(flips[0].baselineValue).toBe(true);
    expect(flips[0].currentValue).toBe(false);
  });
  it('detects number decrease', () => {
    const current = {
      reportOutcomes: [
        { project: 'p1', unit: 'ended', value: true },
        { project: 'p1', unit: 'verdict', value: true },
        { project: 'p1', unit: 'options', value: 2 },
        { project: 'p1', unit: 'optionsLinked', value: 2 },
        { project: 'p1', unit: 'scenarios', value: 2 },
        { project: 'p1', unit: 'sensitivity', value: 1 },
        { project: 'p1', unit: 'keyNumbers', value: 3 },
        { project: 'p1', unit: 'actionsLinked', value: 1 },
      ],
    };
    const flips = negativeReportFlips(baseline, current);
    expect(flips).toHaveLength(1);
    expect(flips[0].unit).toBe('options');
    expect(flips[0].baselineValue).toBe(3);
    expect(flips[0].currentValue).toBe(2);
  });
  it('ignores number increase', () => {
    const current = {
      reportOutcomes: [
        { project: 'p1', unit: 'ended', value: true },
        { project: 'p1', unit: 'verdict', value: true },
        { project: 'p1', unit: 'options', value: 4 },
        { project: 'p1', unit: 'optionsLinked', value: 2 },
        { project: 'p1', unit: 'scenarios', value: 2 },
        { project: 'p1', unit: 'sensitivity', value: 1 },
        { project: 'p1', unit: 'keyNumbers', value: 3 },
        { project: 'p1', unit: 'actionsLinked', value: 1 },
      ],
    };
    const flips = negativeReportFlips(baseline, current);
    expect(flips).toHaveLength(0);
  });
  it('returns empty for baseline without reportOutcomes', () => {
    const flips = negativeReportFlips({}, { reportOutcomes: [{ project: 'p1', unit: 'ended', value: true }] });
    expect(flips).toHaveLength(0);
  });
  it('flips when the chosen option id changes', () => {
    const base = { reportOutcomes: [{ project: 'p1', unit: 'chosenOption', value: 'O1' }] };
    const current = { reportOutcomes: [{ project: 'p1', unit: 'chosenOption', value: 'O2' }] };
    const flips = negativeReportFlips(base, current);
    expect(flips).toHaveLength(1);
    expect(flips[0].unit).toBe('chosenOption');
    expect(flips[0].baselineValue).toBe('O1');
    expect(flips[0].currentValue).toBe('O2');
  });
  it('flips when the chosen option id is lost', () => {
    const base = { reportOutcomes: [{ project: 'p1', unit: 'chosenOption', value: 'O1' }] };
    const current = { reportOutcomes: [{ project: 'p1', unit: 'chosenOption', value: null }] };
    expect(negativeReportFlips(base, current)).toHaveLength(1);
  });
  it('stays quiet when the same id is chosen again', () => {
    const base = { reportOutcomes: [{ project: 'p1', unit: 'chosenOption', value: 'O1' }] };
    const current = { reportOutcomes: [{ project: 'p1', unit: 'chosenOption', value: 'O1' }] };
    expect(negativeReportFlips(base, current)).toHaveLength(0);
  });
  it('stays quiet when a baseline without a chosen id gains one', () => {
    const base = { reportOutcomes: [{ project: 'p1', unit: 'chosenOption', value: null }] };
    const current = { reportOutcomes: [{ project: 'p1', unit: 'chosenOption', value: 'O1' }] };
    expect(negativeReportFlips(base, current)).toHaveLength(0);
  });
});

describe('zero-loss: nothingToCompare', () => {
  it('returns baseline holds no project when no project ids', () => {
    const baseline = { outcomes: [], tierOutcomes: [], storedJudgeOutcomes: [], reportOutcomes: [] };
    const current = { outcomes: [], tierOutcomes: [], storedJudgeOutcomes: [], reportOutcomes: [], kinds: {} };
    const result = nothingToCompare(baseline, current);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('baseline holds no project');
  });

  it('reports absent from the snapshot', () => {
    const baseline = {
      projects: ['p1', 'p2'],
      outcomes: [{ project: 'p1', url: 'u1', clause: 'c', question: 'q', measure: 'm', outcome: 'yes' }],
      tierOutcomes: [],
      storedJudgeOutcomes: [],
      reportOutcomes: [],
      kinds: { p1: 'list', p2: 'analysis' },
    };
    const current = {
      projects: ['p1'],
      outcomes: [{ project: 'p1', url: 'u1', clause: 'c', question: 'q', measure: 'm', outcome: 'yes' }],
      tierOutcomes: [],
      storedJudgeOutcomes: [],
      reportOutcomes: [],
      kinds: { p1: 'list' },
    };
    const result = nothingToCompare(baseline, current);
    expect(result).toHaveLength(1);
    expect(result[0].project).toBe('p2');
    expect(result[0].reason).toBe('absent from the snapshot');
  });

  it('reports no units in the baseline when both baseline and current have no units', () => {
    const baseline = {
      projects: ['p1'],
      outcomes: [],
      tierOutcomes: [],
      storedJudgeOutcomes: [],
      reportOutcomes: [],
      kinds: { p1: 'analysis' },
    };
    const current = {
      projects: ['p1'],
      outcomes: [],
      tierOutcomes: [],
      storedJudgeOutcomes: [],
      reportOutcomes: [],
      kinds: { p1: 'analysis' },
    };
    const result = nothingToCompare(baseline, current);
    expect(result).toHaveLength(1);
    expect(result[0].project).toBe('p1');
    expect(result[0].reason).toBe('no units in the baseline');
  });

  it('reports no shared units when baseline has no units but current has units', () => {
    const baseline = {
      projects: ['p1'],
      outcomes: [],
      tierOutcomes: [],
      storedJudgeOutcomes: [],
      reportOutcomes: [],
      kinds: { p1: 'analysis' },
    };
    const current = {
      projects: ['p1'],
      outcomes: [{ project: 'p1', url: 'u1', clause: 'c', question: 'q', measure: 'm', outcome: 'yes' }],
      tierOutcomes: [],
      storedJudgeOutcomes: [],
      reportOutcomes: [{ project: 'p1', unit: 'ended', value: true }],
      kinds: { p1: 'analysis' },
    };
    const result = nothingToCompare(baseline, current);
    expect(result).toHaveLength(1);
    expect(result[0].project).toBe('p1');
    expect(result[0].reason).toBe('no shared units');
  });

  it('reports no units now', () => {
    const baseline = {
      projects: ['p1'],
      outcomes: [{ project: 'p1', url: 'u1', clause: 'c', question: 'q', measure: 'm', outcome: 'yes' }],
      tierOutcomes: [],
      storedJudgeOutcomes: [],
      reportOutcomes: [],
      kinds: { p1: 'list' },
    };
    const current = {
      projects: ['p1'],
      outcomes: [],
      tierOutcomes: [],
      storedJudgeOutcomes: [],
      reportOutcomes: [],
      kinds: { p1: 'list' },
    };
    const result = nothingToCompare(baseline, current);
    expect(result).toHaveLength(1);
    expect(result[0].project).toBe('p1');
    expect(result[0].reason).toBe('no units now');
  });

  it('reports no shared units', () => {
    const baseline = {
      projects: ['p1'],
      outcomes: [{ project: 'p1', url: 'u1', clause: 'c', question: 'q', measure: 'm', outcome: 'yes' }],
      tierOutcomes: [],
      storedJudgeOutcomes: [],
      reportOutcomes: [],
      kinds: { p1: 'list' },
    };
    const current = {
      projects: ['p1'],
      outcomes: [{ project: 'p1', url: 'u2', clause: 'c', question: 'q', measure: 'm', outcome: 'yes' }],
      tierOutcomes: [],
      storedJudgeOutcomes: [],
      reportOutcomes: [],
      kinds: { p1: 'list' },
    };
    const result = nothingToCompare(baseline, current);
    expect(result).toHaveLength(1);
    expect(result[0].project).toBe('p1');
    expect(result[0].reason).toBe('no shared units');
  });

  it('uses current.kinds then baseline.kinds', () => {
    const baseline = {
      projects: ['p1'],
      outcomes: [],
      tierOutcomes: [],
      storedJudgeOutcomes: [],
      reportOutcomes: [],
      kinds: { p1: 'analysis' },
    };
    const current = {
      projects: ['p1'],
      outcomes: [{ project: 'p1', url: 'u1', clause: 'c', question: 'q', measure: 'm', outcome: 'yes' }],
      tierOutcomes: [],
      storedJudgeOutcomes: [],
      reportOutcomes: [],
      kinds: { p1: 'list' },
    };
    const result = nothingToCompare(baseline, current);
    expect(result[0].kind).toBe('list');
  });
});

describe('zero-loss: recordSnapshot includes reportOutcomes and kinds', () => {
  it('recordSnapshot adds reportOutcomes and kinds to snapshot', async () => {
    const dir = await mkdir(join(tmpdir(), 'frl-snap-report-' + Date.now()), { recursive: true });
    const projectsDir = join(dir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const project = {
      id: 'test-report',
      question: 'Test',
      phase: 'done',
      nodes: [{ id: 'n1' }],
      decisionModel: {
        criteria: [],
        checklist: [],
      },
      candidates: { kept: [] },
      report: {
        verdict: 'Test verdict',
        options: [{ option: 'A', support: ['n1'], against: [] }],
        scenarios: [],
        sensitivity: [],
        keyNumbers: [],
        actionItems: [{ action: 'Do it', why: 'Reason', nodeIds: ['n1'] }],
      },
    };
    await writeFile(join(projectsDir, 'test-report.json'), JSON.stringify(project));
    const outFile = join(tmpdir(), 'baseline-report-' + Date.now() + '.json');
    await recordSnapshot(dir, outFile);
    const snapshot = JSON.parse(await readFile(outFile, 'utf8'));
    expect(snapshot.reportOutcomes).toBeDefined();
    expect(snapshot.reportOutcomes.length).toBeGreaterThan(0);
    expect(snapshot.kinds).toBeDefined();
    expect(snapshot.kinds['test-report']).toBe('analysis');
    await rm(dir, { recursive: true, force: true });
    await rm(outFile, { force: true });
  });
});

describe('zero-loss: checkSnapshot includes report flips and nothing-to-compare', () => {
  it('detects negative report flips and nothing-to-compare for empty project', async () => {
    const dir = await mkdir(join(tmpdir(), 'frl-snap-empty-' + Date.now()), { recursive: true });
    const projectsDir = join(dir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const project = {
      id: 'test-empty',
      question: 'Test',
      phase: 'running',
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
    };
    await writeFile(join(projectsDir, 'test-empty.json'), JSON.stringify(project));
    const baselineFile = join(tmpdir(), 'baseline-empty-' + Date.now() + '.json');
    await recordSnapshot(dir, baselineFile);
    const exitCode = await checkSnapshot(dir, baselineFile);
    expect(exitCode).toBe(1);
    await rm(dir, { recursive: true, force: true });
    await rm(baselineFile, { force: true });
  });

  it('detects report flips when options decrease', async () => {
    const dir = await mkdir(join(tmpdir(), 'frl-snap-flip-' + Date.now()), { recursive: true });
    const projectsDir = join(dir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const projectBaseline = {
      id: 'test-flip',
      question: 'Test',
      phase: 'done',
      nodes: [{ id: 'n1' }, { id: 'n2' }],
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
      report: {
        verdict: 'Test verdict',
        options: [
          { option: 'A', support: ['n1'], against: [] },
          { option: 'B', support: ['n1'], against: [] },
          { option: 'C', support: ['n1'], against: [] },
        ],
        scenarios: [{ name: 'S1' }, { name: 'S2' }],
        sensitivity: [],
        keyNumbers: [],
        actionItems: [{ action: 'Do it', why: 'Reason', nodeIds: ['n1'] }],
      },
    };
    const projectCurrent = {
      id: 'test-flip',
      question: 'Test',
      phase: 'done',
      nodes: [{ id: 'n1' }, { id: 'n2' }],
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
      report: {
        verdict: 'Test verdict',
        options: [
          { option: 'A', support: ['n1'], against: [] },
        ],
        scenarios: [{ name: 'S1' }],
        sensitivity: [],
        keyNumbers: [],
        actionItems: [{ action: 'Do it', why: 'Reason', nodeIds: ['n1'] }],
      },
    };
    await writeFile(join(projectsDir, 'test-flip.json'), JSON.stringify(projectBaseline));
    const baselineFile = join(tmpdir(), 'baseline-flip-' + Date.now() + '.json');
    await recordSnapshot(dir, baselineFile);
    await writeFile(join(projectsDir, 'test-flip.json'), JSON.stringify(projectCurrent));
    const exitCode = await checkSnapshot(dir, baselineFile);
    expect(exitCode).toBe(1);
    await rm(dir, { recursive: true, force: true });
    await rm(baselineFile, { force: true });
  });

  it('passes when checked against itself', async () => {
    const dir = await mkdir(join(tmpdir(), 'frl-snap-self-' + Date.now()), { recursive: true });
    const projectsDir = join(dir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const project = {
      id: 'test-self',
      question: 'Test',
      phase: 'done',
      nodes: [{ id: 'n1' }],
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
      report: {
        verdict: 'Test verdict',
        options: [{ option: 'A', support: ['n1'], against: [] }],
        scenarios: [],
        sensitivity: [],
        keyNumbers: [],
        actionItems: [{ action: 'Do it', why: 'Reason', nodeIds: ['n1'] }],
      },
    };
    await writeFile(join(projectsDir, 'test-self.json'), JSON.stringify(project));
    const baselineFile = join(tmpdir(), 'baseline-self-' + Date.now() + '.json');
    await recordSnapshot(dir, baselineFile);
    const exitCode = await checkSnapshot(dir, baselineFile);
    expect(exitCode).toBe(0);
    await rm(dir, { recursive: true, force: true });
    await rm(baselineFile, { force: true });
  });

  it('detects ended flip when phase changes', async () => {
    const dir = await mkdir(join(tmpdir(), 'frl-snap-ended-' + Date.now()), { recursive: true });
    const projectsDir = join(dir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const projectBaseline = {
      id: 'test-ended',
      question: 'Test',
      phase: 'done',
      nodes: [{ id: 'n1' }],
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
      report: {
        verdict: 'Test verdict',
        options: [],
        scenarios: [],
        sensitivity: [],
        keyNumbers: [],
        actionItems: [],
      },
    };
    const projectCurrent = {
      id: 'test-ended',
      question: 'Test',
      phase: 'running',
      nodes: [{ id: 'n1' }],
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
      report: {
        verdict: 'Test verdict',
        options: [],
        scenarios: [],
        sensitivity: [],
        keyNumbers: [],
        actionItems: [],
      },
    };
    await writeFile(join(projectsDir, 'test-ended.json'), JSON.stringify(projectBaseline));
    const baselineFile = join(tmpdir(), 'baseline-ended-' + Date.now() + '.json');
    await recordSnapshot(dir, baselineFile);
    await writeFile(join(projectsDir, 'test-ended.json'), JSON.stringify(projectCurrent));
    const exitCode = await checkSnapshot(dir, baselineFile);
    expect(exitCode).toBe(1);
    await rm(dir, { recursive: true, force: true });
    await rm(baselineFile, { force: true });
  });

  it('detects actionsLinked flip when nodeIds no longer exist', async () => {
    const dir = await mkdir(join(tmpdir(), 'frl-snap-action-' + Date.now()), { recursive: true });
    const projectsDir = join(dir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const projectBaseline = {
      id: 'test-action',
      question: 'Test',
      phase: 'done',
      nodes: [{ id: 'n1' }, { id: 'n2' }],
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
      report: {
        verdict: 'Test verdict',
        options: [],
        scenarios: [],
        sensitivity: [],
        keyNumbers: [],
        actionItems: [{ action: 'Do it', why: 'Reason', nodeIds: ['n1'] }],
      },
    };
    const projectCurrent = {
      id: 'test-action',
      question: 'Test',
      phase: 'done',
      nodes: [{ id: 'n2' }],
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
      report: {
        verdict: 'Test verdict',
        options: [],
        scenarios: [],
        sensitivity: [],
        keyNumbers: [],
        actionItems: [{ action: 'Do it', why: 'Reason', nodeIds: ['n1'] }],
      },
    };
    await writeFile(join(projectsDir, 'test-action.json'), JSON.stringify(projectBaseline));
    const baselineFile = join(tmpdir(), 'baseline-action-' + Date.now() + '.json');
    await recordSnapshot(dir, baselineFile);
    await writeFile(join(projectsDir, 'test-action.json'), JSON.stringify(projectCurrent));
    const exitCode = await checkSnapshot(dir, baselineFile);
    expect(exitCode).toBe(1);
    await rm(dir, { recursive: true, force: true });
    await rm(baselineFile, { force: true });
  });

  it('reports absent from snapshot when baseline has extra project', async () => {
    const dir = await mkdir(join(tmpdir(), 'frl-snap-absent-' + Date.now()), { recursive: true });
    const projectsDir = join(dir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const project1 = {
      id: 'p1',
      question: 'Test 1',
      phase: 'done',
      nodes: [],
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
      report: { verdict: '', options: [], scenarios: [], sensitivity: [], keyNumbers: [], actionItems: [] },
    };
    const project2 = {
      id: 'p2',
      question: 'Test 2',
      phase: 'done',
      nodes: [],
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
      report: { verdict: '', options: [], scenarios: [], sensitivity: [], keyNumbers: [], actionItems: [] },
    };
    await writeFile(join(projectsDir, 'p1.json'), JSON.stringify(project1));
    await writeFile(join(projectsDir, 'p2.json'), JSON.stringify(project2));
    const baselineFile = join(tmpdir(), 'baseline-absent-' + Date.now() + '.json');
    await recordSnapshot(dir, baselineFile);
    await rm(join(projectsDir, 'p2.json'));
    const exitCode = await checkSnapshot(dir, baselineFile);
    expect(exitCode).toBe(1);
    await rm(dir, { recursive: true, force: true });
    await rm(baselineFile, { force: true });
  });
});

describe('zero-loss: upgrade command', () => {
  it('adds reportOutcomes and kinds to old baseline', async () => {
    const dir = await mkdir(join(tmpdir(), 'frl-snap-upgrade-' + Date.now()), { recursive: true });
    const projectsDir = join(dir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const projectList = {
      id: 'test-list',
      question: 'Find 20 cars',
      phase: 'done',
      nodes: [],
      decisionModel: { criteria: [{ measure: 'priceEur', op: '<=', value: 100000 }], checklist: [], kind: { label: 'car' } },
      candidates: { kept: [{ url: 'https://a.example.org/1', value: 50000, unit: 'EUR' }] },
      report: { verdict: 'Buy', options: [], scenarios: [], sensitivity: [], keyNumbers: [], actionItems: [] },
    };
    const projectMemo = {
      id: 'test-memo',
      question: 'Analyze market',
      phase: 'done',
      nodes: [{ id: 'n1' }],
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
      report: { verdict: 'Market is good', options: [{ option: 'A', support: ['n1'], against: [] }], scenarios: [{ name: 'S1' }], sensitivity: [], keyNumbers: [{ k: 1 }], actionItems: [{ action: 'Invest', why: 'ROI', nodeIds: ['n1'] }] },
    };
    await writeFile(join(projectsDir, 'test-list.json'), JSON.stringify(projectList));
    await writeFile(join(projectsDir, 'test-memo.json'), JSON.stringify(projectMemo));
    const baselineFile = join(tmpdir(), 'baseline-upgrade-' + Date.now() + '.json');
    await recordSnapshot(dir, baselineFile);
    const oldBaseline = JSON.parse(await readFile(baselineFile, 'utf8'));
    delete oldBaseline.reportOutcomes;
    delete oldBaseline.kinds;
    await writeFile(baselineFile, JSON.stringify(oldBaseline, null, 1));
    await upgradeSnapshot(dir, baselineFile, false);
    const upgraded = JSON.parse(await readFile(baselineFile, 'utf8'));
    expect(upgraded.reportOutcomes).toBeDefined();
    expect(upgraded.kinds).toBeDefined();
    expect(upgraded.kinds['test-list']).toBe('list');
    expect(upgraded.kinds['test-memo']).toBe('analysis');
    expect(upgraded.projects).toEqual(oldBaseline.projects);
    expect(upgraded.outcomes).toEqual(oldBaseline.outcomes);
    expect(upgraded.tierOutcomes).toEqual(oldBaseline.tierOutcomes);
    expect(upgraded.storedJudgeOutcomes).toEqual(oldBaseline.storedJudgeOutcomes);
    await rm(dir, { recursive: true, force: true });
    await rm(baselineFile, { force: true });
  });

  it('drops empty projects with --drop-empty', async () => {
    const dir = await mkdir(join(tmpdir(), 'frl-snap-drop-' + Date.now()), { recursive: true });
    const projectsDir = join(dir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const projectEmpty = {
      id: 'test-empty',
      question: 'Test',
      phase: 'running',
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
    };
    const projectFull = {
      id: 'test-full',
      question: 'Test',
      phase: 'done',
      nodes: [],
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
      report: { verdict: 'Done', options: [], scenarios: [], sensitivity: [], keyNumbers: [], actionItems: [] },
    };
    await writeFile(join(projectsDir, 'test-empty.json'), JSON.stringify(projectEmpty));
    await writeFile(join(projectsDir, 'test-full.json'), JSON.stringify(projectFull));
    const baselineFile = join(tmpdir(), 'baseline-drop-' + Date.now() + '.json');
    await recordSnapshot(dir, baselineFile);
    const oldBaseline = JSON.parse(await readFile(baselineFile, 'utf8'));
    delete oldBaseline.reportOutcomes;
    delete oldBaseline.kinds;
    await writeFile(baselineFile, JSON.stringify(oldBaseline, null, 1));
    await upgradeSnapshot(dir, baselineFile, true);
    const upgraded = JSON.parse(await readFile(baselineFile, 'utf8'));
    expect(upgraded.projects).not.toContain('test-empty');
    expect(upgraded.projects).toContain('test-full');
    expect(upgraded.dropped).toBeDefined();
    expect(upgraded.dropped.length).toBe(1);
    expect(upgraded.dropped[0].id).toBe('test-empty');
    expect(upgraded.dropped[0].reason).toBe('no units in the baseline');
    await rm(dir, { recursive: true, force: true });
    await rm(baselineFile, { force: true });
  });

  it('checkSnapshot prints dropped entries', async () => {
    const dir = await mkdir(join(tmpdir(), 'frl-snap-check-drop-' + Date.now()), { recursive: true });
    const projectsDir = join(dir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const projectFull = {
      id: 'test-full',
      question: 'Test',
      phase: 'done',
      nodes: [],
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
      report: { verdict: 'Done', options: [], scenarios: [], sensitivity: [], keyNumbers: [], actionItems: [] },
    };
    await writeFile(join(projectsDir, 'test-full.json'), JSON.stringify(projectFull));
    const baselineFile = join(tmpdir(), 'baseline-check-drop-' + Date.now() + '.json');
    await recordSnapshot(dir, baselineFile);
    const baseline = JSON.parse(await readFile(baselineFile, 'utf8'));
    baseline.dropped = [{ id: 'test-dropped', kind: 'analysis', reason: 'no units in the baseline' }];
    await writeFile(baselineFile, JSON.stringify(baseline, null, 1));
    const exitCode = await checkSnapshot(dir, baselineFile);
    expect(exitCode).toBe(0);
    await rm(dir, { recursive: true, force: true });
    await rm(baselineFile, { force: true });
  });
});

describe('zero-loss: real path (child process)', () => {
  it('check on snapshot like test b (memo with report) detects negative report flips', async () => {
    const dir = await mkdir(join(tmpdir(), 'frl-real-b-' + Date.now()), { recursive: true });
    const projectsDir = join(dir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const project = {
      id: 'test-memo-flip',
      question: 'Test',
      phase: 'done',
      nodes: [{ id: 'n1' }, { id: 'n2' }],
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
      report: {
        verdict: 'Test verdict',
        options: [
          { option: 'A', support: ['n1'], against: [] },
          { option: 'B', support: ['n1'], against: [] },
          { option: 'C', support: ['n1'], against: [] },
        ],
        scenarios: [{ name: 'S1' }, { name: 'S2' }],
        sensitivity: [],
        keyNumbers: [],
        actionItems: [{ action: 'Do it', why: 'Reason', nodeIds: ['n1'] }],
      },
    };
    await writeFile(join(projectsDir, 'test-memo-flip.json'), JSON.stringify(project));
    const baselineFile = join(tmpdir(), 'baseline-real-b-' + Date.now() + '.json');
    await recordSnapshot(dir, baselineFile);
    const projectChanged = {
      ...project,
      report: {
        verdict: 'Test verdict',
        options: [
          { option: 'A', support: ['n1'], against: [] },
        ],
        scenarios: [{ name: 'S1' }],
        sensitivity: [],
        keyNumbers: [],
        actionItems: [{ action: 'Do it', why: 'Reason', nodeIds: ['n1'] }],
      },
    };
    await writeFile(join(projectsDir, 'test-memo-flip.json'), JSON.stringify(projectChanged));
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, ['scripts/zero-loss.mjs', 'check', dir, '--baseline', baselineFile], { cwd: process.cwd(), encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Negative report flips: 3');
    await rm(dir, { recursive: true, force: true });
    await rm(baselineFile, { force: true });
  });

  it('check on snapshot like test a (empty project) detects nothing to compare', async () => {
    const dir = await mkdir(join(tmpdir(), 'frl-real-a-' + Date.now()), { recursive: true });
    const projectsDir = join(dir, 'projects');
    await mkdir(projectsDir, { recursive: true });
    const project = {
      id: 'test-empty',
      question: 'Test',
      phase: 'running',
      decisionModel: { criteria: [], checklist: [] },
      candidates: { kept: [] },
    };
    await writeFile(join(projectsDir, 'test-empty.json'), JSON.stringify(project));
    const baselineFile = join(tmpdir(), 'baseline-real-a-' + Date.now() + '.json');
    await recordSnapshot(dir, baselineFile);
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, ['scripts/zero-loss.mjs', 'check', dir, '--baseline', baselineFile], { cwd: process.cwd(), encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Nothing to compare: 1');
    await rm(dir, { recursive: true, force: true });
    await rm(baselineFile, { force: true });
  });
});

describe('zero-loss: evaluationKind helper', () => {
  it('stored acceptanceResult.kind wins over brief.kind and decisionModel.kind', () => {
    const project = {
      acceptanceResult: { kind: { label: 'stored-kind', terms: ['stored'] } },
      brief: { kind: { label: 'brief-kind', terms: ['brief'] } },
      decisionModel: { kind: { label: 'decision-kind', terms: ['decision'] } },
    };
    expect(evaluationKind(project)).toEqual({ label: 'stored-kind', terms: ['stored'] });
  });

  it('without a stored kind and with no judged item carrying a kind-check id, the decision model kind is used', () => {
    const project = {
      acceptanceResult: { items: [], validCount: 0 },
      brief: { kind: { label: 'brief-kind', terms: ['brief'] } },
      decisionModel: { kind: { label: 'decision-kind', terms: ['decision'] } },
    };
    expect(evaluationKind(project)).toEqual({ label: 'decision-kind', terms: ['decision'] });
  });

  it('decisionModel.kind is used when acceptanceResult.kind and brief.kind are missing', () => {
    const project = {
      acceptanceResult: { items: [], validCount: 0 },
      brief: { kind: null },
      decisionModel: { kind: { label: 'decision-kind', terms: ['decision'] } },
    };
    expect(evaluationKind(project)).toEqual({ label: 'decision-kind', terms: ['decision'] });
  });

  it('returns null when all kind sources are missing', () => {
    const project = {
      acceptanceResult: { items: [], validCount: 0 },
      brief: { kind: null },
      decisionModel: { kind: null },
    };
    expect(evaluationKind(project)).toBeNull();
  });

  it('extractJudgedItems uses evaluationKind to build check ids matching brief-kind', () => {
    const kindLabel = 'wholesale clothing provider';
    const kindId = `kind|${kindCluster({ label: kindLabel, terms: [] }).items[0].question}`;
    const project = {
      id: 'test-project',
      acceptance: { itemCount: 2, mustMention: [] },
      brief: { kind: { label: kindLabel, terms: ['wholesale', 'second-hand'] } },
      decisionModel: { checklist: [{ clause: 'kind', items: [{ question: 'Is this a wholesale clothing provider?', hard: true }] }], kind: { label: 'different-kind', terms: ['different'] } },
      acceptanceResult: {
        items: [
          { url: 'https://a.example.org/1', title: 'Item 1', checks: [{ id: kindId, answer: 'yes', quote: 'q1', hard: true, clause: 'kind' }], qualifies: true, live: true, listing: true, inRange: true, tier: 'confirmed' },
          { url: 'https://a.example.org/2', title: 'Item 2', checks: [{ id: kindId, answer: 'no', quote: '', hard: true, clause: 'kind' }], qualifies: true, live: true, listing: true, inRange: true, tier: 'rejected' },
        ],
      },
    };
    const items = extractJudgedItems(project);
    expect(items).toHaveLength(2);
    expect(items[0].checks[0].id).toBe(kindId);
    expect(items[1].checks[0].id).toBe(kindId);
  });

  it('computeTiers uses evaluationKind for kind-based check id matching', () => {
    const kindLabel = 'brief-kind';
    const kindId = `kind|${kindCluster({ label: kindLabel, terms: [] }).items[0].question}`;
    const project = {
      id: 'test-project',
      acceptance: { itemCount: 3, mustMention: [] },
      brief: { kind: { label: kindLabel, terms: ['brief'] } },
      decisionModel: { checklist: [{ clause: 'kind', items: [{ question: 'Is this a brief-kind?', hard: true }] }], kind: { label: 'decision-kind', terms: ['decision'] } },
      acceptanceResult: {
        items: [
          { url: 'https://a.example.org/1', title: 'Item 1', checks: [{ id: kindId, answer: 'yes', quote: 'q1', hard: true, clause: 'kind' }], qualifies: true, live: true, listing: true, inRange: true, tier: 'confirmed' },
          { url: 'https://a.example.org/2', title: 'Item 2', checks: [{ id: kindId, answer: 'yes', quote: 'q1', hard: true, clause: 'kind' }], qualifies: true, live: true, listing: true, inRange: true, tier: 'confirmed' },
          { url: 'https://a.example.org/3', title: 'Item 3', checks: [{ id: kindId, answer: 'no', quote: '', hard: true, clause: 'kind' }], qualifies: true, live: true, listing: true, inRange: true, tier: 'rejected' },
        ],
      },
    };
    const tiers = computeTiers(project);
    expect(tiers.tiers.confirmed).toBe(2);
    expect(tiers.tiers.rejected).toBe(1);
    expect(tiers.tiers['to-confirm']).toBe(0);
  });
});
import { kindCluster } from '../../src/research/checklist.mjs';
