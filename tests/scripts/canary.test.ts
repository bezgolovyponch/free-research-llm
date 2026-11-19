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
