import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../src/llm/scripted-provider.mjs';
import { ModelRouter } from '../../src/llm/router.mjs';
import { ResearchEngine } from '../../src/research/engine.mjs';
import { ProjectImprover, applyVariant, distinctResearches, improvementTargets, projectScore } from '../../src/research/improve.mjs';
import { blankNode } from '../../src/research/tree.mjs';
import { ProjectStore } from '../../src/store.mjs';

function tree() {
  return {
    nodes: [
      blankNode({ id: 'D1', parentId: 'Q', question: 'demand?', status: 'supported' }),
      blankNode({ id: 'D1.1', parentId: 'D1', question: 'visitors?', status: 'weak', impact: 5, uncertainty: 5 }),
      blankNode({ id: 'D1.2', parentId: 'D1', question: 'price?', status: 'verified' }),
      blankNode({ id: 'D2', parentId: 'Q', question: 'costs?', status: 'unsupported' }),
    ],
  };
}

describe('improve helpers', () => {
  it('blends node grades with the expected-result score', () => {
    const project = { ...tree(), report: { verdict: 'GO' }, acceptanceResult: { score: 0.5 } };
    expect(projectScore(project).acceptance).toBe(0.5);
    expect(projectScore({ ...project, acceptanceResult: null }).score).toBe(projectScore({ ...project, acceptanceResult: null }).score);
    expect(projectScore(project).score).toBeCloseTo(0.6 * 0.5 + 0.4 * projectScore({ ...project, acceptanceResult: null }).score, 3);
  });

  it('targets the structure first, then the weakest, highest-priority leaves', () => {
    expect(improvementTargets(tree())).toEqual(['Q', 'D2', 'D1.1', 'D1.2']);
  });

  it('applies node edits and splits, and root adds/removes while keeping two top-level pieces', () => {
    const p = tree();
    expect(applyVariant(p, 'D1.1', { searchQueries: ['návštěvnost Brno'], sourceUrls: ['https://stat.example/t1', 'not a url'], method: 'data', instructions: 'use 2025', split: [{ question: 'summer?' }, { title: 'empty' }] })).toEqual(['D1.1', 'D1.1.1']);
    const leaf = p.nodes.find((n) => n.id === 'D1.1')!;
    expect([leaf.searchQueries, leaf.sourceUrls, leaf.method, leaf.instructions]).toEqual([['návštěvnost Brno'], ['https://stat.example/t1'], 'data', 'use 2025']);
    expect(applyVariant(p, 'Q', { add: [{ question: 'competition?' }], remove: ['D2'] })).toEqual(['D3', 'D2']);
    expect(p.nodes.map((n) => n.id)).not.toContain('D2');
    expect(applyVariant(p, 'Q', { remove: ['D1', 'D3'] })).toEqual([]);
  });
});

describe('ProjectImprover', () => {
  it('runs a baseline, tries variants, reverts non-improving ones and stops at the time limit', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-improve-'));
    const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({}) };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search, store: new ProjectStore({ dir }) });
    const project = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    let clock = 0;
    const improver = new ProjectImprover({ engine, now: () => (clock += 2000), sleep: async () => {} });
    improver.start(project.id, { hours: 0.05 });
    expect(() => improver.start(project.id)).toThrow(/already running/);
    for (let i = 0; i < 500 && improver.isActive(project.id); i++) await new Promise((r) => setTimeout(r, 10));
    const saved = await engine.load(project.id);
    expect(saved.improve.active).toBe(false);
    expect(saved.improve.stopReason).toBe('time limit reached');
    expect(saved.improve.baseline).toBeGreaterThan(0);
    expect(saved.improve.trials.length).toBeGreaterThan(0);
    expect(new Set(saved.improve.trials.map((t: { outcome: string }) => t.outcome))).toEqual(new Set(['no-change', 'reverted-whole']));
    expect(saved.improve.best).toBe(saved.improve.baseline);
    expect(saved.log.some((l: { type: string }) => l.type === 'improve-state')).toBe(true);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});

describe('distinctResearches', () => {
  it('keeps the newest non-demo project per question', () => {
    const list = [
      { id: 'old', question: 'Cars  DE→PL?', updatedAt: '2026-10-17' },
      { id: 'new', question: 'cars de→pl?', updatedAt: '2026-10-18' },
      { id: 'demo', question: 'x', demo: true, updatedAt: '2026-10-19' },
      { id: 'other', question: 'Glamping?', updatedAt: '2026-10-16' },
    ];
    expect(distinctResearches(list)).toEqual(['new', 'other']);
  });
});

describe('ProjectImprover.startAll', () => {
  it('cycles every non-demo research with a time slice each and stops at the overall limit', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-improve-all-'));
    const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({}) };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search, store: new ProjectStore({ dir }) });
    const a = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    const b = await engine.createProject({ question: 'Which e-bike rental size breaks even in Prague?' });
    let clock = 0;
    const improver = new ProjectImprover({ engine, now: () => (clock += 2000), sleep: async () => {} });
    improver.startAll({ hours: 0.2, sliceMinutes: 2 });
    expect(improver.allStatus().active).toBe(true);
    expect(() => improver.startAll()).toThrow(/already running/);
    for (let i = 0; i < 1000 && improver.allStatus().active; i++) await new Promise((r) => setTimeout(r, 10));
    for (const id of [a.id, b.id]) {
      const saved = await engine.load(id);
      expect(saved.improve.baseline).toBeGreaterThan(0);
      expect(saved.improve.trials.length).toBeGreaterThan(0);
      expect(saved.improve.active).toBe(false);
    }
    expect(improver.stopAll()).toEqual({ ok: false });
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});

