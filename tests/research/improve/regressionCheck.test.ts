import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../../src/llm/scripted-provider.mjs';
import { ModelRouter } from '../../../src/llm/router.mjs';
import { ResearchEngine } from '../../../src/research/engine.mjs';
import { ProjectImprover, allChecksPass } from '../../../src/research/improve.mjs';
import { addSpec, normalizeSpec } from '../../../src/research/specs.mjs';
import { blankNode } from '../../../src/research/tree.mjs';
import { ProjectStore } from '../../../src/store.mjs';

type Node = { id: string; status: string };

function project(answer: string) {
  const p = { nodes: [blankNode({ id: 'D1', parentId: 'Q', question: 'q?', status: 'supported' })] };
  p.nodes[0].finding = { answer };
  return p;
}

describe('allChecksPass', () => {
  it('passes only when every check from before and after passes on the new tree', () => {
    const before = project('Brno has 400k people');
    addSpec(before, 'D1', normalizeSpec({ mustMention: ['Brno'] }, { request: 'r', desired: 'Brno' }));
    expect(allChecksPass(before, structuredClone(before))).toBe(true);
    expect(allChecksPass(before, { ...before, nodes: [] })).toBe(false);
    const failing = structuredClone(before);
    addSpec(failing, 'D1', normalizeSpec({ mustMention: ['Prague'] }, { request: 'r', desired: 'Prague' }));
    expect(allChecksPass(before, failing)).toBe(false);
  });
});

describe('removal trials', () => {
  it('reverts a piece removal when a regression check fails, even though the score would rise', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-improve-removal-'));
    const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({}) };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search, store: new ProjectStore({ dir }) });
    const created = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    const done = await engine.run(created.id);
    for (const n of done.nodes as Node[]) if (n.id.startsWith('D1')) n.status = 'weak';
    addSpec(done, 'Q', normalizeSpec({ mustMention: ['never-present-word'] }, { request: 'r', desired: 'unreachable' }));
    await engine.store.save(done);
    const originalRun = engine.run.bind(engine);
    engine.run = async (id: string) => {
      const after = await originalRun(id);
      if (!after.nodes.some((n: Node) => n.id === 'D4')) for (const n of after.nodes as Node[]) n.status = 'verified';
      await engine.store.save(after);
      return after;
    };
    let clock = 0;
    const improver = new ProjectImprover({ engine, now: () => (clock += 1000), sleep: async () => {} });
    improver.propose = async (_p: unknown, nodeId: string) => (nodeId === 'Q' ? { change: 'drop D4', remove: ['D4'] } : {});
    improver.start(created.id, { hours: 0.004 });
    for (let i = 0; i < 500 && improver.isActive(created.id); i++) await new Promise((r) => setTimeout(r, 10));
    const saved = await engine.load(created.id);
    const removal = saved.improve.trials.find((t: { nodeId: string }) => t.nodeId === 'Q');
    expect(removal).toMatchObject({ outcome: 'reverted-regression', removedPieceId: 'D4', scoreDelta: 0 });
    expect(saved.nodes.some((n: Node) => n.id === 'D4')).toBe(true);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});
