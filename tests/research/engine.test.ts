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

function engineWith(provider: ScriptedProvider | object, search: object = fakeSearch, lanes = 2) {
  const router = new ModelRouter({ providers: [provider] });
  return { router, engine: new ResearchEngine({ router, search, store: new ProjectStore({ dir }), lanes }) };
}

describe('ResearchEngine', () => {
  it('runs decompose → research → roll-up → memo and persists the project', async () => {
    const provider = new ScriptedProvider();
    const { engine } = engineWith(provider);
    const events: string[] = [];
    const project = await engine.createProject({ question: 'Is it profitable to buy used RAV4 hybrids in Germany and sell them in Poland?' });
    expect(project.templateId).toBe('generic');
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
    let critiques = 0;
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
    let critiques = 0;
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
    const { engine } = engineWith(provider, recordingSearch, 1);
    const review = engine.critique.bind(engine);
    engine.critique = (async (...args: Parameters<typeof engine.critique>) => { critiques += 1; return review(...args); }) as typeof engine.critique;
    const project = await engine.createProject({ question: 'Is buying used RAV4 hybrids in Germany to resell in Poland profitable?' });
    const done = await engine.run(project.id);
    const retried = done.nodes.find((n: { attempts: number }) => n.attempts === 2);
    expect(retried.critique).toBeTruthy();
    const leaves = done.nodes.filter((n: { id: string }) => done.nodes.every((m: { parentId: string }) => m.parentId !== n.id));
    expect(critiques).toBe(leaves.length);
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
    const rebuilt = await engine.resetResearch(project.id, { tree: true });
    expect([rebuilt.nodes.length, rebuilt.phase]).toEqual([0, 'created']);
    expect((await engine.run(project.id)).nodes.length).toBeGreaterThan(0);
  });

  it('keeps checks the user set when the tree is rebuilt', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Which used cars resell best from Germany to Czechia?', expected: 'x' });
    await engine.updateProject(project.id, { expected: '5 links', acceptance: { itemCount: 5, urlsLive: true } });
    await engine.resetResearch(project.id, { tree: true });
    const built = await engine.buildTree(project.id);
    expect(built.acceptance).toMatchObject({ expected: '5 links', itemCount: 5, urlsLive: true, locked: true });
  });

  it('researches independent pieces in parallel lanes, adds a lane when a teammate joins, and gives the same result as one lane', async () => {
    const slow = new ScriptedProvider();
    let live = 0;
    let peak = 0;
    const provider = { id: 'demo', ready: true, describe: () => slow.describe(), async chat(args: { messages: Array<{ content: string }> }) {
      const research = args.messages.at(-1)!.content.includes(TASK_MARKERS.research);
      if (research) { live += 1; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 20)); live -= 1; }
      return slow.chat(args as never);
    } };
    const { engine } = engineWith(provider, fakeSearch, 2);
    const project = await engine.createProject({ question: 'Where should I build a glamping site in Czechia?' });
    const parallel = await engine.run(project.id);
    expect(peak).toBe(2);
    const { engine: single } = engineWith(new ScriptedProvider(), fakeSearch, 1);
    const p1 = await single.createProject({ question: 'Where should I build a glamping site in Czechia?' });
    const sequential = await single.run(p1.id);
    expect(parallel.nodes.map((n: { id: string; status: string }) => `${n.id}:${n.status}`).sort()).toEqual(sequential.nodes.map((n: { id: string; status: string }) => `${n.id}:${n.status}`).sort());
    expect(engine.lanesFor(project.id)).toBe(2);
    expect(engine.join(project.id)).toEqual({ joined: true, lanes: 3 });
    engine.join(project.id); engine.join(project.id);
    expect(engine.lanesFor(project.id)).toBe(4);
    engine.leave(project.id);
    expect(engine.lanesFor(project.id)).toBe(2);
  });

  it('re-grounds checks stored before the fix, keeps hand-set ones, and re-scores before a loop baseline', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Find plots for a glamping business, 20000EUR max', expected: '50 plots feasible for glamping' });
    const done = await engine.run(project.id);
    done.acceptance = { ...done.acceptance, itemCount: 50, mustMention: ['plot', 'glamping'] };
    done.nodes[0].specs = [{ id: 'R1', desired: 'a list of plots', request: 'more', mustMention: ['glamping'], needsNumber: false, valueRange: null, unit: '', itemCount: null, minGrade: 'supported', everPassed: false, last: null }];
    await engine.store.save(done);
    const fixed = await engine.regroundAndRescore(project.id);
    expect(fixed.acceptance).toMatchObject({ itemCount: 50, mustMention: [] });
    expect(fixed.nodes[0].specs[0].mustMention).toEqual([]);
    expect(fixed.log.some((l: { message: string }) => /stored checks not enforced/.test(l.message))).toBe(true);
    await engine.updateProject(project.id, { acceptance: { itemCount: 50, mustMention: ['glamping'] } });
    expect((await engine.regroundAndRescore(project.id)).acceptance.mustMention).toEqual(['glamping']);
  });

  it('does not enforce expected-result checks the model inferred but the user never asked for', async () => {
    const { engine, router } = engineWith(new ScriptedProvider());
    const original = router.complete.bind(router);
    router.complete = (async (request: { purpose: string }) => {
      const reply = await original(request as never);
      if (request.purpose === 'decompose') reply.data = { ...reply.data, acceptance: { itemCount: 50, valueRange: [0, 20000], unit: 'EUR', mustMention: ['plot', 'glamping'] } };
      return reply;
    }) as typeof router.complete;
    const project = await engine.createProject({ question: 'Find plots to buy for a glamping business, 20000EUR max', constraints: { budget: '20000' }, expected: '50 plots strongly feasible for a glamping business' });
    const built = await engine.buildTree(project.id);
    expect(built.acceptance).toMatchObject({ itemCount: 50, valueRange: [0, 20000], mustMention: [] });
  });

  it('attaches files to one piece as cited data sources and removes them again', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Where should I build a glamping site in Czechia?' });
    await engine.buildTree(project.id);
    const withCsv = await engine.addAttachment(project.id, 'D1.1', { name: 'prices.csv', text: 'model,price\nGolf,2500\nPolo,3100\n' });
    const withNote = await engine.addAttachment(project.id, 'D1.1', { name: 'notes.md', text: '# Notes\nTransport DE-CZ costs about 450 EUR.' });
    const node = withNote.nodes.find((n: { id: string }) => n.id === 'D1.1');
    expect(node.attachments.map((a: { id: string; kind: string }) => [a.id, a.kind])).toEqual([['U1', 'table'], ['U2', 'text']]);
    expect(withCsv.nodes.find((n: { id: string }) => n.id === 'D1.1').attachments[0].text).toMatch(/price/);
    const sources = await engine.gatherSources(withNote, node);
    expect(sources.filter((s: { provider: string }) => s.provider === 'upload').map((s: { id: string }) => s.id)).toEqual(['U1', 'U2']);
    await expect(engine.addAttachment(project.id, 'D1.1', { name: 'scan.pdf', text: 'x' })).rejects.toThrow(/text file/);
    await expect(engine.addAttachment(project.id, 'D1.1', { name: 'empty.txt', text: '   ' })).rejects.toThrow(/empty/);
    const removed = await engine.removeAttachment(project.id, 'D1.1', 'U1');
    expect(removed.nodes.find((n: { id: string }) => n.id === 'D1.1').attachments.map((a: { id: string }) => a.id)).toEqual(['U2']);
    await expect(engine.removeAttachment(project.id, 'D1.1', 'U9')).rejects.toThrow(/not found/);
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
    expect(p.report).not.toBeNull();
    expect(p.phase).toBe('tree-ready');
    const { resultModel } = await import('../../src/research/result.mjs');
    expect(resultModel(p).changedSince).toEqual(expect.arrayContaining(['D2', 'D2.1']));
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

  it('regrades finished pieces whose answers say the evidence does not settle them, and rewrites the memo from the current pieces on request', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Should I import e-bikes from Germany to Czechia?' });
    const done = await engine.run(project.id);
    const leaf = done.nodes.find((n: { id: string; status: string }) => n.id === 'D1.1');
    leaf.status = 'verified';
    leaf.finding.answer = 'The 2026 import volume is not established by the supplied evidence.';
    await engine.store.save(done);
    const changed = engine.regrade(done);
    expect(changed).toEqual(['D1.1']);
    expect(leaf.status).toBe('weak');
    expect(leaf.verification.checks.find((c: { id: string }) => c.id === 'concrete')).toMatchObject({ passed: false });
    expect(done.nodes.find((n: { id: string }) => n.id === 'D1').status).toBe('pending');
    await engine.store.save(done);
    const rewritten = await engine.resynthesize(project.id);
    expect(rewritten.report.basis['D1.1']).toBeTruthy();
    expect(rewritten.report.actionItems.length).toBeGreaterThan(0);
    expect(rewritten.report.kind).toBe('decision');
  });

  it('does not search the web for a private company\'s own figures and sends the piece to Clarify; other pieces get company-scoped queries', async () => {
    const asked: string[][] = [];
    const search = { enabled: true, lastErrors: [], search: async (queries: string[]) => { asked.push(queries); return [{ kind: 'web', title: 'Boltz pricing', url: 'https://boltz.com/pricing', domain: 'boltz.com', text: 'Boltz pricing per seat 100 EUR', query: queries[0] }]; } };
    const { engine } = engineWith(new ScriptedProvider(), search);
    const project = await engine.createProject({ question: 'Create an action plan for https://www.deepmedchem.com against https://boltz.com/' });
    const p = await engine.load(project.id);
    const own = { id: 'D9', parentId: 'Q', title: 'Cash burn', question: 'Monthly cash burn of DeepMedChem in 2026 (EUR)', searchQueries: ['DeepMedChem burn'], sourceUrls: [], dependsOn: [], status: 'pending' };
    const rival = { id: 'D8', parentId: 'Q', title: 'Boltz pricing', question: 'What does Boltz charge per seat?', searchQueries: ['Boltz price'], sourceUrls: [], dependsOn: [], status: 'pending' };
    await engine.researchLeaf(p, own);
    expect(own).toMatchObject({ status: 'weak', ownerOnly: 'deepmedchem' });
    expect(own.finding.answer).toContain('Only deepmedchem has this figure');
    expect(asked).toHaveLength(0);
    const { nodeAction } = await import('../../src/research/gaps.mjs');
    expect(nodeAction(own)).toMatchObject({ action: 'clarify' });
    await engine.researchLeaf(p, rival);
    expect(asked[0][0]).toBe('site:boltz.com boltz pricing');
  });

  it('re-asks for the tree once when the structural checks fail, keeps the better tree, and refuses a duplicate piece added later', async () => {
    const bad = { decision: 'd', successCriteria: 's', nodes: [
      { id: 'D1', parentId: null, title: 'D1: Prices', question: 'What do e-bikes cost in Germany?' },
      { id: 'D1.1', parentId: 'D1', title: 'Price list', question: 'List prices of e-bikes in Germany?', dependsOn: ['D1'] },
      { id: 'D2', parentId: null, title: 'Prices again', question: 'What do e-bikes cost in Germany today?' },
    ] };
    const good = { decision: 'd', successCriteria: 's', nodes: [
      { id: 'D1', parentId: null, title: 'Prices', question: 'What do e-bikes cost in Germany?' },
      { id: 'D1.1', parentId: 'D1', title: 'Shop prices', question: 'Shop prices of e-bikes in Berlin?' },
      { id: 'D1.2', parentId: 'D1', title: 'Used prices', question: 'Used e-bike prices on resale sites?' },
      { id: 'D2', parentId: null, title: 'Import duty', question: 'Which duties apply when importing to Czechia?' },
      { id: 'D2.1', parentId: 'D2', title: 'Customs', question: 'Customs duty rate for e-bikes?' },
      { id: 'D2.2', parentId: 'D2', title: 'VAT', question: 'Czech VAT on imported e-bikes?' },
    ] };
    const asked: string[] = [];
    const replies = [bad, good];
    const router = { complete: async ({ messages, purpose }: { messages: Array<{ content: string }>; purpose: string }) => { if (purpose === 'decompose') asked.push(messages[1].content); return { data: purpose === 'decompose' ? replies.shift() : {}, provider: 'p', model: 'm' }; } };
    const engine = new ResearchEngine({ router: router as never, search: fakeSearch, store: new ProjectStore({ dir }) });
    const project = await engine.createProject({ question: 'Should I import e-bikes from Germany to Czechia?' });
    const built = await engine.buildTree(project.id);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('The tree failed these structural checks');
    expect(built.nodes.map((n: { id: string }) => n.id)).toEqual(['D1', 'D1.1', 'D1.2', 'D2', 'D2.1', 'D2.2']);
    await expect(engine.addNode(project.id, 'Q', { question: 'What do e-bikes cost in Germany?', title: 'Prices' })).rejects.toThrow(/duplicates D1/);
  });
});
