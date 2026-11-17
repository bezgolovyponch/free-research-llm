import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const built = vi.hoisted(() => ({ calls: 0, result: null as unknown }));

vi.mock('../../src/research/purpose.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/research/purpose.mjs')>();
  return { ...original, buildPurposeTree: async () => { built.calls += 1; return built.result; } };
});

const { ResearchEngine } = await import('../../src/research/engine.mjs');
const { TREE_VERSION } = await import('../../src/research/purpose.mjs');
const { ProjectStore } = await import('../../src/store.mjs');

let dir = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-purpose-'));
  built.calls = 0;
  built.result = null;
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

function engineWith() {
  const engine = new ResearchEngine({ router: { complete: async () => null } as never, search: { search: async () => [] } as never, store: new ProjectStore({ dir }) });
  const rebuilt: unknown[] = [];
  const scoped: unknown[] = [];
  Object.assign(engine, {
    rebuildDecisionModel: async (project: Record<string, unknown>) => { rebuilt.push(project.purposeTree); return null; },
    runScopingStage: async (project: Record<string, unknown>) => { scoped.push(project.id); project.scoping = { notes: [{ id: 'N1', quote: 'a note' }], sources: [] }; return project.scoping; },
  });
  return { engine, rebuilt, scoped };
}

const project = (extra: Record<string, unknown> = {}) => ({ id: 'find-twenty-things-a1b2c3', question: 'Find 20 things', guidance: 'a hint', acceptance: { itemCount: 20 }, log: [], ...extra });

describe('ensurePurposeTree', () => {
  it('scopes, builds the tree and rebuilds the decision model from it when the research has no tree', async () => {
    const { engine, rebuilt, scoped } = engineWith();
    built.result = { phase: 'tree', tree: { goals: [{ id: 'G1', goal: 'a goal', state: 'kept', questions: [] }] } };
    const p: Record<string, any> = project();
    await engine.ensurePurposeTree(p);
    expect(scoped).toEqual(['find-twenty-things-a1b2c3']);
    expect(built.calls).toBe(1);
    expect(p.purposeTree).toMatchObject({ question: 'Find 20 things', guidance: 'a hint', version: TREE_VERSION });
    expect(rebuilt).toEqual([p.purposeTree]);
  });

  it('reuses a tree built for the same question, hints and version without any model call', async () => {
    const { engine, rebuilt } = engineWith();
    const tree = { goals: [{ id: 'G1' }], question: 'Find 20 things', guidance: 'a hint', version: TREE_VERSION, at: 't' };
    const p: Record<string, any> = project({ purposeTree: tree });
    await engine.ensurePurposeTree(p);
    expect(built.calls).toBe(0);
    expect(rebuilt).toEqual([]);
    expect(p.purposeTree).toBe(tree);
  });

  it('builds a new tree when the hints change', async () => {
    const { engine } = engineWith();
    built.result = { phase: 'tree', tree: { goals: [{ id: 'G2', goal: 'b', state: 'kept', questions: [] }] } };
    const p: Record<string, any> = project({ guidance: 'new hint', purposeTree: { goals: [{ id: 'G1' }], question: 'Find 20 things', guidance: 'a hint', version: TREE_VERSION, at: 't' } });
    await engine.ensurePurposeTree(p);
    expect(built.calls).toBe(1);
    expect(p.purposeTree.goals[0].id).toBe('G2');
  });

  it('keeps the stored tree and checklist when a new tree comes back empty', async () => {
    const { engine, rebuilt } = engineWith();
    built.result = { phase: 'scoping thin', tree: { goals: [] } };
    const stored = { goals: [{ id: 'G1' }], question: 'old question', guidance: 'a hint', version: TREE_VERSION, at: 't' };
    const p: Record<string, any> = project({ purposeTree: stored });
    await engine.ensurePurposeTree(p);
    expect(p.purposeTree).toBe(stored);
    expect(rebuilt).toEqual([]);
    expect(p.log.some((l: { type: string; message: string }) => l.type === 'warn' && l.message.startsWith('purpose tree not built: scoping thin'))).toBe(true);
  });

  it('does not scope again when the research already has scoping notes', async () => {
    const { engine, scoped } = engineWith();
    built.result = { phase: 'tree', tree: { goals: [{ id: 'G1', goal: 'a', state: 'kept', questions: [] }] } };
    await engine.ensurePurposeTree(project({ scoping: { notes: [{ id: 'N1' }], sources: [] } }));
    expect(scoped).toEqual([]);
  });

  it('leaves a research with no item count alone', async () => {
    const { engine } = engineWith();
    await engine.ensurePurposeTree(project({ acceptance: {} }));
    expect(built.calls).toBe(0);
  });
});
