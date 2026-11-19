import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function runCanary(args) {
  return spawnSync(process.execPath, [join(ROOT, 'scripts', 'canary.mjs'), ...args], { cwd: ROOT, encoding: 'utf8' });
}

describe('canary: compare flags', () => {
  const writeSnap = async (obj, suffix) => {
    const file = join(tmpdir(), 'snap-' + suffix + '-' + Date.now() + '.json');
    await writeFile(file, JSON.stringify(obj));
    return file;
  };

  const beforeBase = {
    timestamp: '2026-01-01T00:00:00.000Z',
    failedCallShare: 5,
    projects: [{
      id: 'test-project',
      question: 'Test',
      decisionCriteria: 5,
      hardChecklistItems: 3,
      verdictTiers: { confirmed: 2, 'to-confirm': 1, rejected: 0, 'not-judged': 0 },
      verdictSummary: '2 of 3 confirmed',
      decisionModelFits: 2,
      confirmedFits: 2,
      candidateRowsKept: 2,
      loopState: { active: 1, trials: 2, kept: 2 }
    }]
  };

  it('flags criteria drop', async () => {
    const after = { ...beforeBase, timestamp: '2026-01-02T00:00:00.000Z', projects: [{ ...beforeBase.projects[0], decisionCriteria: 3 }] };
    const bf = await writeSnap(beforeBase, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('decision criteria dropped');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });

  it('flags hard checklist drop', async () => {
    const after = { ...beforeBase, timestamp: '2026-01-02T00:00:00.000Z', projects: [{ ...beforeBase.projects[0], hardChecklistItems: 1 }] };
    const bf = await writeSnap(beforeBase, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('hard checklist items dropped');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });

  it('flags confirmed drop', async () => {
    const after = { ...beforeBase, timestamp: '2026-01-02T00:00:00.000Z', projects: [{ ...beforeBase.projects[0], verdictTiers: { confirmed: 1, 'to-confirm': 2, rejected: 0, 'not-judged': 0 } }] };
    const bf = await writeSnap(beforeBase, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('confirmed dropped');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });

  it('flags confirmed fits drop', async () => {
    const after = { ...beforeBase, timestamp: '2026-01-02T00:00:00.000Z', projects: [{ ...beforeBase.projects[0], confirmedFits: 1 }] };
    const bf = await writeSnap(beforeBase, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('confirmed fits dropped');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });

  it('flags rejected rise >20% while confirmed does not rise', async () => {
    const before = { ...beforeBase, projects: [{ ...beforeBase.projects[0], verdictTiers: { confirmed: 2, 'to-confirm': 1, rejected: 2, 'not-judged': 0 } }] };
    const after = { ...beforeBase, timestamp: '2026-01-02T00:00:00.000Z', projects: [{ ...beforeBase.projects[0], verdictTiers: { confirmed: 2, 'to-confirm': 0, rejected: 4, 'not-judged': 0 } }] };
    const bf = await writeSnap(before, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('rejected rose');
    expect(result.stdout).toContain('while confirmed did not rise');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });

  it('does NOT flag rejected rise when confirmed also rises', async () => {
    const before = { ...beforeBase, projects: [{ ...beforeBase.projects[0], verdictTiers: { confirmed: 2, 'to-confirm': 1, rejected: 2, 'not-judged': 0 } }] };
    const after = { ...beforeBase, timestamp: '2026-01-02T00:00:00.000Z', projects: [{ ...beforeBase.projects[0], verdictTiers: { confirmed: 3, 'to-confirm': 0, rejected: 4, 'not-judged': 0 } }] };
    const bf = await writeSnap(before, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('rejected rose');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });

  it('flags failed-call share rise >15 points', async () => {
    const after = { ...beforeBase, timestamp: '2026-01-02T00:00:00.000Z', failedCallShare: 25 };
    const bf = await writeSnap(beforeBase, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('failed-call share rose');
    expect(result.stdout).toContain('20.0 points');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });

  it('passes when all metrics equal', async () => {
    const after = { ...beforeBase, timestamp: '2026-01-02T00:00:00.000Z' };
    const bf = await writeSnap(beforeBase, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No significant drops detected');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });

  it('passes when metrics improve', async () => {
    const before = { ...beforeBase, failedCallShare: 10, projects: [{ ...beforeBase.projects[0], decisionCriteria: 3, hardChecklistItems: 2, verdictTiers: { confirmed: 1, 'to-confirm': 2, rejected: 1, 'not-judged': 0 }, decisionModelFits: 1, confirmedFits: 1, candidateRowsKept: 1, loopState: { active: 1, trials: 2, kept: 1 } }] };
    const after = { ...beforeBase, timestamp: '2026-01-02T00:00:00.000Z', failedCallShare: 5, projects: [{ ...beforeBase.projects[0], decisionCriteria: 5, hardChecklistItems: 3, verdictTiers: { confirmed: 3, 'to-confirm': 0, rejected: 0, 'not-judged': 0 }, decisionModelFits: 3, confirmedFits: 3, candidateRowsKept: 3, loopState: { active: 1, trials: 3, kept: 3 } }] };
    const bf = await writeSnap(before, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No significant drops detected');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });
});

describe('canary: internal functions', () => {
  it('imports without error', async () => {
    const mod = await import('../../scripts/canary.mjs');
    expect(typeof mod.snapAll).toBe('function');
    expect(typeof mod.snapOne).toBe('function');
    expect(typeof mod.computeTiers).toBe('function');
    expect(typeof mod.checkFlags).toBe('function');
  });
});

describe('canary: data location options', () => {
  const writeSnap = async (obj, suffix) => {
    const file = join(tmpdir(), 'snap-' + suffix + '-' + Date.now() + '.json');
    await writeFile(file, JSON.stringify(obj));
    return file;
  };

  it('snap exits 2 with NOT MEASURED when no researches found at data dir', async () => {
    const emptyDir = join(tmpdir(), 'canary-empty-' + Date.now());
    await mkdir(emptyDir, { recursive: true });
    const outFile = join(tmpdir(), 'snap-empty-' + Date.now() + '.json');
    const result = runCanary(['snap', '--out', outFile, '--data', emptyDir]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('NOT MEASURED: no researches found at ' + emptyDir);
    await rm(emptyDir, { recursive: true, force: true });
    await rm(outFile, { force: true });
  });

  it('snap uses FRL_DATA_DIR env when --data not provided', async () => {
    const emptyDir = join(tmpdir(), 'canary-env-' + Date.now());
    await mkdir(emptyDir, { recursive: true });
    const outFile = join(tmpdir(), 'snap-env-' + Date.now() + '.json');
    const env = { ...process.env, FRL_DATA_DIR: emptyDir };
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'canary.mjs'), 'snap', '--out', outFile], { cwd: ROOT, encoding: 'utf8', env });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('NOT MEASURED: no researches found at ' + emptyDir);
    await rm(emptyDir, { recursive: true, force: true });
    await rm(outFile, { force: true });
  });

  it('snap defaults to ROOT/data when neither --data nor FRL_DATA_DIR set', async () => {
    const outFile = join(tmpdir(), 'snap-default-' + Date.now() + '.json');
    const result = runCanary(['snap', '--out', outFile]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('NOT MEASURED: no researches found at ' + join(ROOT, 'data'));
    await rm(outFile, { force: true });
  });
});

describe('canary: content comparison flags', () => {
  const writeSnap = async (obj, suffix) => {
    const file = join(tmpdir(), 'snap-' + suffix + '-' + Date.now() + '.json');
    await writeFile(file, JSON.stringify(obj));
    return file;
  };

  const contentBase = {
    timestamp: '2026-01-01T00:00:00.000Z',
    failedCallShare: 5,
    projects: [{
      id: 'content-test',
      question: 'Test content comparison',
      decisionCriteria: 3,
      decisionCriteriaList: [
        { id: 'priceEur', measure: 'priceEur', op: '<=', value: 20000, clause: 'price limit', source: 'question', quote: '20000EUR max' },
        { id: 'coastKm', measure: 'coastKm', op: '<=', value: 20, clause: 'nearby sea', source: 'guidance', quote: 'about 20 km' },
        { id: 'workableMonths', measure: 'workableMonths', op: '>=', value: 10, clause: '10 months', source: 'question', quote: '10 month a year' },
      ],
      hardChecklistItems: 4,
      hardChecklistClauses: [
        { clause: 'kind', question: 'Is this page a plot of land?', numeric: null },
        { clause: 'price', question: 'Does this plot cost 20000 EUR or less?', numeric: { measure: 'priceEur', op: '<=', value: 20000, unit: 'EUR' } },
        { clause: 'sea', question: 'Is this plot within 20 km of the sea?', numeric: { measure: 'coastKm', op: '<=', value: 20, unit: 'km' } },
        { clause: 'climate', question: 'Does this plot have 10+ workable months?', numeric: { measure: 'workableMonths', op: '>=', value: 10, unit: 'months' } },
      ],
      decisionModelVersion: 9,
      checklistVersion: 6,
      verdictTiers: { confirmed: 2, 'to-confirm': 1, rejected: 0, 'not-judged': 0 },
      verdictSummary: '2 of 3 confirmed',
      decisionModelFits: 2,
      confirmedFits: 2,
      candidateRowsKept: 2,
      loopState: { active: 1, trials: 2, kept: 2 }
    }]
  };

  it('flags hard checklist clause removed (exact text match)', async () => {
    const after = {
      ...contentBase,
      timestamp: '2026-01-02T00:00:00.000Z',
      projects: [{
        ...contentBase.projects[0],
        hardChecklistItems: 3,
        hardChecklistClauses: [
          { clause: 'kind', question: 'Is this page a plot of land?', numeric: null },
          { clause: 'sea', question: 'Is this plot within 20 km of the sea?', numeric: { measure: 'coastKm', op: '<=', value: 20, unit: 'km' } },
          { clause: 'climate', question: 'Does this plot have 10+ workable months?', numeric: { measure: 'workableMonths', op: '>=', value: 10, unit: 'months' } },
        ],
      }]
    };
    const bf = await writeSnap(contentBase, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('hard checklist clause removed');
    expect(result.stdout).toContain('price');
    expect(result.stdout).toContain('Does this plot cost 20000 EUR or less');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });

  it('flags hard checklist clause added', async () => {
    const after = {
      ...contentBase,
      timestamp: '2026-01-02T00:00:00.000Z',
      projects: [{
        ...contentBase.projects[0],
        hardChecklistItems: 5,
        hardChecklistClauses: [
          ...contentBase.projects[0].hardChecklistClauses,
          { clause: 'area', question: 'Is this plot at least 1000 m2?', numeric: { measure: 'areaM2', op: '>=', value: 1000, unit: 'm2' } },
        ],
      }]
    };
    const bf = await writeSnap(contentBase, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('hard checklist clause added');
    expect(result.stdout).toContain('area');
    expect(result.stdout).toContain('Is this plot at least 1000 m2');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });

  it('flags decision criterion removed (same measure/op/value)', async () => {
    const after = {
      ...contentBase,
      timestamp: '2026-01-02T00:00:00.000Z',
      projects: [{
        ...contentBase.projects[0],
        decisionCriteria: 2,
        decisionCriteriaList: [
          { id: 'coastKm', measure: 'coastKm', op: '<=', value: 20, clause: 'nearby sea', source: 'guidance', quote: 'about 20 km' },
          { id: 'workableMonths', measure: 'workableMonths', op: '>=', value: 10, clause: '10 months', source: 'question', quote: '10 month a year' },
        ],
      }]
    };
    const bf = await writeSnap(contentBase, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('decision criterion removed');
    expect(result.stdout).toContain('priceEur');
    expect(result.stdout).toContain('20000');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });

  it('flags decision criterion added', async () => {
    const after = {
      ...contentBase,
      timestamp: '2026-01-02T00:00:00.000Z',
      projects: [{
        ...contentBase.projects[0],
        decisionCriteria: 4,
        decisionCriteriaList: [
          ...contentBase.projects[0].decisionCriteriaList,
          { id: 'areaM2', measure: 'areaM2', op: '>=', value: 1000, clause: 'min area', source: 'question', quote: 'at least 1000 m2' },
        ],
      }]
    };
    const bf = await writeSnap(contentBase, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('decision criterion added');
    expect(result.stdout).toContain('areaM2');
    expect(result.stdout).toContain('1000');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });

  it('flags model rebuilt when decisionModel.version changes', async () => {
    const after = {
      ...contentBase,
      timestamp: '2026-01-02T00:00:00.000Z',
      projects: [{
        ...contentBase.projects[0],
        decisionModelVersion: 10,
      }]
    };
    const bf = await writeSnap(contentBase, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('model rebuilt');
    expect(result.stdout).toContain('decisionModel.version 9 → 10');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });

  it('flags model rebuilt when checklistVersion changes', async () => {
    const after = {
      ...contentBase,
      timestamp: '2026-01-02T00:00:00.000Z',
      projects: [{
        ...contentBase.projects[0],
        checklistVersion: 7,
      }]
    };
    const bf = await writeSnap(contentBase, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('model rebuilt');
    expect(result.stdout).toContain('checklistVersion 6 → 7');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });

  it('does not flag when clause numeric values match exactly', async () => {
    const after = {
      ...contentBase,
      timestamp: '2026-01-02T00:00:00.000Z',
      projects: [{
        ...contentBase.projects[0],
        hardChecklistClauses: [
          { clause: 'kind', question: 'Is this page a plot of land?', numeric: null },
          { clause: 'price', question: 'Does this plot cost 20000 EUR or less?', numeric: { measure: 'priceEur', op: '<=', value: 20000, unit: 'EUR' } },
          { clause: 'sea', question: 'Is this plot within 20 km of the sea?', numeric: { measure: 'coastKm', op: '<=', value: 20, unit: 'km' } },
          { clause: 'climate', question: 'Does this plot have 10+ workable months?', numeric: { measure: 'workableMonths', op: '>=', value: 10, unit: 'months' } },
        ],
      }]
    };
    const bf = await writeSnap(contentBase, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No significant drops detected');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });

  it('flags clause removed when numeric measure/op/value differs', async () => {
    const after = {
      ...contentBase,
      timestamp: '2026-01-02T00:00:00.000Z',
      projects: [{
        ...contentBase.projects[0],
        hardChecklistClauses: [
          { clause: 'kind', question: 'Is this page a plot of land?', numeric: null },
          { clause: 'price', question: 'Does this plot cost 20000 EUR or less?', numeric: { measure: 'priceEur', op: '<=', value: 15000, unit: 'EUR' } },
          { clause: 'sea', question: 'Is this plot within 20 km of the sea?', numeric: { measure: 'coastKm', op: '<=', value: 20, unit: 'km' } },
          { clause: 'climate', question: 'Does this plot have 10+ workable months?', numeric: { measure: 'workableMonths', op: '>=', value: 10, unit: 'months' } },
        ],
      }]
    };
    const bf = await writeSnap(contentBase, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('hard checklist clause removed');
    expect(result.stdout).toContain('price');
    expect(result.stdout).toContain('hard checklist clause added');
    expect(result.stdout).toContain('15000');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });
});

describe('canary: snap with --api flag (mock)', () => {
  const writeSnap = async (obj, suffix) => {
    const file = join(tmpdir(), 'snap-' + suffix + '-' + Date.now() + '.json');
    await writeFile(file, JSON.stringify(obj));
    return file;
  };

  it('compare --api uses provided after file when given (does not call API)', async () => {
    const before = {
      timestamp: '2026-01-01T00:00:00.000Z',
      failedCallShare: 5,
      projects: [{
        id: 'api-test',
        question: 'API test',
        decisionCriteria: 2,
        decisionCriteriaList: [],
        hardChecklistItems: 1,
        hardChecklistClauses: [],
        decisionModelVersion: 9,
        checklistVersion: 6,
        verdictTiers: { confirmed: 1, 'to-confirm': 0, rejected: 0, 'not-judged': 0 },
        verdictSummary: '1 of 1 confirmed',
        decisionModelFits: 1,
        confirmedFits: 1,
        candidateRowsKept: 1,
        loopState: { active: 0, trials: 1, kept: 1 }
      }]
    };
    const after = {
      ...before,
      timestamp: '2026-01-02T00:00:00.000Z',
      projects: [{
        ...before.projects[0],
        decisionCriteria: 1,
        decisionCriteriaList: [],
      }]
    };
    const bf = await writeSnap(before, 'before');
    const af = await writeSnap(after, 'after');
    const result = runCanary(['compare', bf, '--after', af, '--api']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('decision criteria dropped');
    await rm(bf, { force: true });
    await rm(af, { force: true });
  });
});
