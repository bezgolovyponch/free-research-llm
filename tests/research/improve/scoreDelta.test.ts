import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../../src/llm/scripted-provider.mjs';
import { ModelRouter } from '../../../src/llm/router.mjs';
import { ResearchEngine } from '../../../src/research/engine.mjs';
import { ProjectImprover, acceptsTrial } from '../../../src/research/improve.mjs';
import { ProjectStore } from '../../../src/store.mjs';

type Node = { id: string; status: string };

describe('acceptsTrial', () => {
  it('needs a gain above 0.01 to keep a removal and above 0.001 for any other change', () => {
    expect(acceptsTrial(0.5, 0.505)).toBe(true);
    expect(acceptsTrial(0.5, 0.505, ['D4'])).toBe(false);
    expect(acceptsTrial(0.5, 0.51, ['D4'])).toBe(false);
    expect(acceptsTrial(0.5, 0.511, ['D4'])).toBe(true);
    expect(acceptsTrial(0.5, 0.5)).toBe(false);
  });
});

async function removalLoop(verifyAfter: (nodes: Node[]) => void) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-improve-delta-'));
  const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({}) };
  const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search, store: new ProjectStore({ dir }), lanes: 1 });
  const created = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
  const done = await engine.run(created.id);
  for (const n of done.nodes as Node[]) if (n.id.startsWith('D1')) n.status = 'weak';
  await engine.store.save(done);
  const originalRun = engine.run.bind(engine);
  engine.run = async (id: string) => {
    const after = await originalRun(id);
    if (!after.nodes.some((n: Node) => n.id === 'D4')) verifyAfter(after.nodes);
    await engine.store.save(after);
    return after;
  };
  let clock = 0;
  const improver = new ProjectImprover({ engine, now: () => (clock += 1000), sleep: async () => {} });
  improver.propose = async (_p: unknown, nodeId: string) => (nodeId === 'Q' ? { change: 'drop D4', remove: ['D4'] } : {});
  improver.start(created.id, { hours: 0.004 });
  for (let i = 0; i < 500 && improver.isActive(created.id); i++) await new Promise((r) => setTimeout(r, 10));
  const saved = await engine.load(created.id);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  return saved;
}

describe('trial record', () => {
  it('keeps a removal that raises the coverage score by more than 0.01 and logs the removed piece and the delta', async () => {
    const saved = await removalLoop((nodes) => { for (const n of nodes) n.status = 'verified'; });
    const removal = saved.improve.trials.find((t: { nodeId: string }) => t.nodeId === 'Q');
    expect(removal).toMatchObject({ outcome: 'kept', removedPieceId: 'D4' });
    expect(removal.scoreDelta).toBeGreaterThan(0.01);
    expect(saved.nodes.some((n: Node) => n.id === 'D4')).toBe(false);
    expect(saved.improve.best).toBe(removal.score);
    for (const t of saved.improve.trials) expect(t.scoreDelta).toBe(Math.round((t.score - t.before) * 1000) / 1000);
  });

  it('reverts a removal whose only gain is the smaller denominator', async () => {
    const saved = await removalLoop(() => {});
    const removal = saved.improve.trials.find((t: { nodeId: string }) => t.nodeId === 'Q');
    expect(removal).toMatchObject({ outcome: 'reverted-whole', removedPieceId: 'D4' });
    expect(removal.scoreDelta).toBeLessThan(0);
    expect(saved.nodes.some((n: Node) => n.id === 'D4')).toBe(true);
  });
});
