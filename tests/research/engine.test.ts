import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/llm/provider.mjs';
import { ScriptedProvider } from '../../src/llm/scripted-provider.mjs';
import { ModelRouter } from '../../src/llm/router.mjs';
import { TASK_MARKERS } from '../../src/research/prompts.mjs';
import { ResearchEngine } from '../../src/research/engine.mjs';
import { ProjectStore } from '../../src/store.mjs';

const fakeSearch = {
  enabled: true,
  lastErrors: [],
  async search(queries: string[]) {
    return [
      { kind: 'web', title: 'One', url: 'https://one.example/a', domain: 'one.example', snippet: 's', text: `about ${queries[0]}` },
      { kind: 'web', title: 'Two', url: 'https://two.example/b', domain: 'two.example', snippet: 's', text: 'more' },
    ];
  },
  describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
};

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-engine-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function engineWith(provider: ScriptedProvider | object, search: object = fakeSearch) {
  const router = new ModelRouter({ providers: [provider] });
  return { router, engine: new ResearchEngine({ router, search, store: new ProjectStore({ dir }) }) };
}

describe('ResearchEngine', () => {
  it('runs decompose → research → roll-up → memo and persists the project', async () => {
    const provider = new ScriptedProvider();
    const { engine } = engineWith(provider);
    const events: string[] = [];
    const project = await engine.createProject({ question: 'Is it profitable to buy used RAV4 hybrids in Germany and sell them in Poland?' });
    expect(project.templateId).toBe('car-arbitrage');
    engine.subscribe(project.id, (e: { type: string }) => events.push(e.type));
    const done = await engine.run(project.id);
    expect(done.phase).toBe('done');
    expect(done.nodes).toHaveLength(12);
    expect(done.nodes.every((n: { status: string }) => n.status === 'verified')).toBe(true);
    expect(done.nodes.find((n: { id: string }) => n.id === 'D2.2').finding.calculation.recomputed).toBe(300);
    expect(done.report.verdict).toMatch(/GO-IF/);
    expect(events).toEqual(expect.arrayContaining(['phase', 'tree', 'node', 'report']));
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, `${project.id}.json`), 'utf8'));
    expect(onDisk.report.verdict).toBe(done.report.verdict);
    const markers = provider.calls.map((c) => c.marker);
    expect(markers[0]).toBe(TASK_MARKERS.decompose);
    expect(markers.at(-1)).toBe(TASK_MARKERS.synthesize);
  });

  it('escalates a leaf to the deep tier when its first answer fails the checks', async () => {
    const scripted = new ScriptedProvider();
    let poisoned = false;
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => scripted.describe(),
      async chat(args: { messages: Array<{ role: string; content: string }>; tier: string }) {
        const prompt = args.messages.at(-1)!.content;
        if (!poisoned && prompt.includes(TASK_MARKERS.research)) {
          poisoned = true;
          return { content: JSON.stringify({ answer: 'made up', claims: [{ text: 'price 5', sourceIds: ['S99'] }], confidence: 'high' }), model: 'm', provider: 'demo', usage: {} };
        }
        return scripted.chat(args);
      },
    };
    const { engine } = engineWith(provider);
    const project = await engine.createProject({ question: 'Where should I build a glamping site in Czechia?' });
    const done = await engine.run(project.id);
    const escalated = done.nodes.filter((n: { attempts: number }) => n.attempts === 2);
    expect(escalated).toHaveLength(1);
    expect(escalated[0].status).toBe('verified');
    expect(done.log.some((l: { type: string }) => l.type === 'escalate')).toBe(true);
  });

  it('searches the gaps of a failed answer before the deep-tier retry', async () => {
    const scripted = new ScriptedProvider();
    let poisoned = false;
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => scripted.describe(),
      async chat(args: { messages: Array<{ role: string; content: string }>; tier: string }) {
        const prompt = args.messages.at(-1)!.content;
        if (!poisoned && prompt.includes(TASK_MARKERS.research)) {
          poisoned = true;
          return { content: JSON.stringify({ answer: 'unknown', claims: [{ text: 'price 5', sourceIds: ['S99'] }], confidence: 'low', gaps: ['median 2026 asking price RAV4 hybrid Germany'] }), model: 'm', provider: 'demo', usage: {} };
        }
        return scripted.chat(args);
      },
    };
    const calls: Array<{ queries: string[]; exclude: string[] }> = [];
    const recordingSearch = {
      ...fakeSearch,
      async search(queries: string[], options: { exclude?: string[] } = {}) {
        calls.push({ queries, exclude: options.exclude ?? [] });
        return calls.length === 1 || !options.exclude ? fakeSearch.search(queries) : [{ kind: 'web', title: 'Gap', url: 'https://gap.example/p', domain: 'gap.example', snippet: 's', text: 'RAV4 median 21,500 EUR' }];
      },
    };
    const { engine } = engineWith(provider, recordingSearch);
    const project = await engine.createProject({ question: 'Is buying used RAV4 hybrids in Germany to resell in Poland profitable?' });
    const done = await engine.run(project.id);
    const retried = done.nodes.find((n: { attempts: number }) => n.attempts === 2);
    const gapCall = calls.find((c) => c.exclude.length);
    expect(gapCall?.queries[0]).toBe('median 2026 asking price RAV4 hybrid Germany');
    expect(gapCall?.exclude).toEqual(['https://one.example/a', 'https://two.example/b']);
    expect(retried.followUpQueries).toContain('median 2026 asking price RAV4 hybrid Germany');
    expect(retried.sources.map((s: { id: string }) => s.id)).toEqual(['S1', 'S2', 'S3']);
  });

  it('resets all findings but keeps the tree for a fresh research run', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Where should I build a glamping site in Czechia?' });
    const done = await engine.run(project.id);
    const reset = await engine.resetResearch(project.id);
    expect(reset.nodes.map((n: { id: string }) => n.id)).toEqual(done.nodes.map((n: { id: string }) => n.id));
    expect(new Set(reset.nodes.map((n: { status: string }) => n.status))).toEqual(new Set(['pending']));
    expect([reset.report, reset.phase]).toEqual([null, 'tree-ready']);
    expect((await engine.run(project.id)).phase).toBe('done');
  });

  it('marks a node failed but finishes the run when one call breaks', async () => {
    const provider = new ScriptedProvider({ failures: { [TASK_MARKERS.rollup]: [new ProviderError('bad request', { status: 400 })] } });
    const { engine } = engineWith(provider);
    const project = await engine.createProject({ question: 'Should I open a bakery in Brno next year?' });
    const done = await engine.run(project.id);
    expect(done.phase).toBe('done');
    expect(done.nodes.filter((n: { status: string }) => n.status === 'failed')).toHaveLength(1);
  });

  it('cites uploaded CSV data as source D1', async () => {
    const { engine } = engineWith(new ScriptedProvider(), { enabled: false, lastErrors: [], search: async () => [], describe: () => ({}) });
    const project = await engine.createProject({ question: 'Which car specs have the best margin?', csvText: 'model,price\nRAV4,18000\nRAV4,19000\n', csvName: 'cars.csv' });
    expect(project.data.text).toMatch(/cars\.csv: 2 rows/);
    const done = await engine.run(project.id);
    const leaf = done.nodes.find((n: { id: string }) => n.id === 'D1.1');
    expect(leaf.sources.map((s: { id: string }) => s.id)).toEqual(['D1']);
    expect(leaf.status).toBe('verified');
  });

  it('edits, expands, adds and removes nodes, resetting only the affected branch', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Should I import e-bikes from Germany to Czechia?' });
    await engine.run(project.id);
    let p = await engine.editNode(project.id, 'D2.1', { question: 'What does an e-bike cost in Germany in 2026?' });
    const status = (id: string) => p.nodes.find((n: { id: string }) => n.id === id)?.status;
    expect([status('D2.1'), status('D2'), status('D2.2'), status('D1.1')]).toEqual(['pending', 'pending', 'pending', 'verified']);
    expect(p.report).toBeNull();
    p = await engine.expandNode(project.id, 'D3.1');
    expect(p.nodes.filter((n: { parentId: string }) => n.parentId === 'D3.1').map((n: { id: string }) => n.id)).toEqual(['D3.1.a', 'D3.1.b']);
    p = await engine.addNode(project.id, 'Q', { question: 'What do competitors charge?' });
    expect(p.nodes.at(-1)).toMatchObject({ id: 'D5', parentId: 'Q' });
    p = await engine.removeNode(project.id, 'D3');
    expect(p.nodes.some((n: { id: string }) => n.id.startsWith('D3'))).toBe(false);
    const rerun = await engine.run(project.id);
    expect(rerun.phase).toBe('done');
    expect(rerun.nodes.every((n: { status: string }) => n.status === 'verified')).toBe(true);
  });

  it('rejects a second concurrent run and too-short questions', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    await expect(engine.createProject({ question: 'hm?' })).rejects.toThrow(/full sentence/);
    const project = await engine.createProject({ question: 'Should I open a bakery in Brno next year?' });
    const first = engine.run(project.id);
    await expect(engine.run(project.id)).rejects.toThrow(/already running/);
    await first;
  });

  it('stops between nodes when cancelled', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Should I open a bakery in Brno next year?' });
    engine.subscribe(project.id, (e: { type: string }) => {
      if (e.type === 'tree') engine.cancel(project.id);
    });
    const stopped = await engine.run(project.id);
    expect(stopped.phase).toBe('cancelled');
    expect(stopped.report).toBeNull();
  });
});
