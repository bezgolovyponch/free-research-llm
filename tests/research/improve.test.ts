import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../src/llm/scripted-provider.mjs';
import { ModelRouter } from '../../src/llm/router.mjs';
import { ResearchEngine } from '../../src/research/engine.mjs';
import { ProjectImprover, REPEAT_SIMILARITY, REST_AFTER_FUTILE, STALL_TRIALS, structuralIssues, REST_HOURS, applyVariant, cannotGain, distinctResearches, improvementTargets, inScope, projectScore, repeatOf, restRotation, restingPieces, scopeScore, similarChange, stallCheck, stallMessage } from '../../src/research/improve.mjs';
import { addSpec, normalizeSpec } from '../../src/research/specs.mjs';
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
    expect(improvementTargets(tree())).toEqual(['Q', 'D2', 'D1.1']);
  });

  it('limits the loop to the focus of the ticked pieces minus what the user excluded, and scores only that', () => {
    const p = tree();
    expect([...inScope(p.nodes, ['D1'])]).toEqual(['D1', 'D2', 'D1.1', 'D1.2']);
    expect(improvementTargets(p, ['D1'], ['Q'])).toEqual(['D2', 'D1.1']);
    expect(improvementTargets(p, ['D1'])[0]).toBe('Q');
    expect(improvementTargets(p, ['ghost'], ['Q'])).toEqual([]);
    const only = ['Q', 'D1', 'D2', 'D1.1'];
    expect(scopeScore(p, ['D1.2'], [], only)).toMatchObject({ score: 1, nodes: 1, specs: null });
    addSpec(p, 'D1.2', normalizeSpec({ mustMention: ['Brno'] }, { request: 'r', desired: 'price in Brno' }));
    expect(scopeScore(p, ['D1.2'], [], only)).toMatchObject({ grades: 1, specs: 0, score: 0.5 });
    expect(improvementTargets(p, ['D1'], ['Q'])).toEqual(['D2', 'D1.1', 'D1.2']);
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

describe('improvementTargets', () => {
  it('skips verified pieces that cannot gain, keeps verified pieces that deliver items while the expected result is unmet', () => {
    const leaf = (id: string, status: string, items = 0) => ({ id, parentId: 'D1', status, impact: 3, uncertainty: 3, dependsOn: [], finding: { items: Array.from({ length: items }, (_, i) => ({ url: `https://x.example/${id}/${i}` })) } });
    const project = { nodes: [{ id: 'D1', parentId: 'Q', status: 'supported', dependsOn: [] }, leaf('D1.1', 'weak'), leaf('D1.2', 'verified'), leaf('D1.3', 'verified', 4), leaf('D1.4', 'supported')], acceptanceResult: { score: 0.13 } };
    expect(improvementTargets(project as never)).toEqual(['Q', 'D1.1', 'D1.4', 'D1.3']);
    expect(improvementTargets({ ...project, acceptanceResult: { score: 1 } } as never)).toEqual(['Q', 'D1.1', 'D1.4']);
    expect(improvementTargets({ ...project, acceptanceResult: null } as never)).toEqual(['Q', 'D1.1', 'D1.4']);
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
    const checkpoints: Array<{ loopHoursLeft: number }> = [];
    improver.checkpoint = async (_id: string, resume: { loopHoursLeft: number }) => { checkpoints.push(resume); };
    improver.start(project.id, { hours: 0.05 });
    expect(() => improver.start(project.id)).toThrow(/already running/);
    for (let i = 0; i < 500 && improver.isActive(project.id); i++) await new Promise((r) => setTimeout(r, 10));
    const saved = await engine.load(project.id);
    expect(saved.improve.active).toBe(false);
    expect(saved.improve.stopReason).toBe('time limit reached');
    expect(saved.improve.baseline).toBeGreaterThan(0);
    expect(saved.improve.trials.length).toBeGreaterThan(0);
    expect(new Set(saved.improve.trials.map((t: { outcome: string }) => t.outcome))).toEqual(new Set(['no-change', 'no-gain', 'repeat']));
    expect(saved.improve.best).toBe(saved.improve.baseline);
    expect(saved.log.some((l: { type: string }) => l.type === 'improve-state')).toBe(true);
    expect(checkpoints.length).toBeGreaterThan(1);
    expect(checkpoints[0].loopHoursLeft).toBeGreaterThan(0);
    expect(checkpoints[0].loopHoursLeft).toBeLessThanOrEqual(0.05);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});

describe('structural gate', () => {
  it('lists blocking tree problems so a trial that adds one is refused, and caps top-level pieces at 7', () => {
    const d = (id: string, q: string) => ({ id, parentId: 'Q', title: q, question: q, status: 'verified', dependsOn: [], searchQueries: [], sourceUrls: [] });
    const base = { question: 'Find plots for glamping', nodes: [d('D1', 'How many months are mild enough for glamping in Algarve?'), d('D2', 'Which coastal parcels in Portugal are listed for sale under 20,000 EUR?')] };
    expect(structuralIssues(base)).toEqual([]);
    const trial = structuredClone(base);
    applyVariant(trial, 'Q', { add: [{ question: 'Which coastal parcels in Portugal are listed for sale under 20,000 EUR now?' }] });
    expect(structuralIssues(trial)).toEqual([]);
    const forced = structuredClone(base);
    forced.nodes.push(d('D3', 'Which coastal parcels in Portugal are listed for sale under 20,000 EUR today?'));
    expect(structuralIssues(forced).some((i: string) => i.startsWith('duplicate:'))).toBe(true);
    const full = { question: 'q', nodes: Array.from({ length: 7 }, (_, i) => d(`D${i + 1}`, `Distinct driver number ${i + 1} about topic ${'abcdefg'[i]}`)) };
    expect(applyVariant(full, 'Q', { add: [{ question: 'A brand new eighth topic' }] })).toEqual([]);
    expect(full.nodes.filter((n) => n.parentId === 'Q')).toHaveLength(7);
  });
});

describe('cannotGain', () => {
  const node = (status: string, items: Array<{ url: string; value?: number }> = [], specs: Array<{ last: { passed: boolean } | null }> = []) => ({ status, finding: { items }, specs });
  it('is true only when the piece kept its grade, found no new link or value, and has no failing check', () => {
    expect(cannotGain(node('supported', [{ url: 'a', value: 1 }]), node('supported', [{ url: 'a', value: 1 }]))).toBe(true);
    expect(cannotGain(node('supported'), node('supported'))).toBe(true);
    expect(cannotGain(node('supported'), node('verified'))).toBe(false);
    expect(cannotGain(node('supported', [{ url: 'a' }]), node('supported', [{ url: 'a' }, { url: 'b' }]))).toBe(false);
    expect(cannotGain(node('supported', [{ url: 'a', value: 30000 }]), node('supported', [{ url: 'a', value: 18000 }]))).toBe(false);
    expect(cannotGain(node('supported', [], [{ last: { passed: false } }]), node('supported'))).toBe(false);
    expect(cannotGain(node('weak'), node('unsupported'))).toBe(true);
  });
});

describe('restingPieces', () => {
  it('rests a piece after 3 futile trials in a row for 6 hours; a kept trial or time brings it back', () => {
    const t0 = Date.parse('2026-10-23T10:00:00Z');
    const at = (min: number) => new Date(t0 + min * 60000).toISOString();
    const trials = [
      { nodeId: 'D4.1', outcome: 'reverted-whole', at: at(0) },
      { nodeId: 'D4.1', outcome: 'conflict', at: at(1) },
      { nodeId: 'D4.1', outcome: 'reverted-piece', at: at(2) },
      { nodeId: 'D4.1', outcome: 'no-gain', at: at(3) },
      { nodeId: 'D8.1', outcome: 'reverted-whole', at: at(4) },
      { nodeId: 'D8.1', outcome: 'reverted-whole', at: at(5) },
      { nodeId: 'D8.1', outcome: 'kept', at: at(6) },
      { nodeId: 'D8.1', outcome: 'reverted-whole', at: at(7) },
      { nodeId: 'Q', outcome: 'error', at: at(8) },
      { nodeId: 'Q', outcome: 'error', at: at(9) },
      { nodeId: 'Q', outcome: 'error', at: at(10) },
    ];
    expect(REST_AFTER_FUTILE).toBe(3);
    expect([...restingPieces(trials, t0 + 60 * 60000)]).toEqual(['D4.1']);
    expect([...restingPieces(trials, t0 + (REST_HOURS * 60 + 4) * 60000)]).toEqual([]);
  });
});

describe('ProjectImprover in parallel lanes', () => {
  it('runs trials side by side, commits them one at a time, and adds a lane when a teammate joins', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-improve-lanes-'));
    const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({}) };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search, store: new ProjectStore({ dir }), lanes: 2 });
    const project = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    const done = await engine.run(project.id);
    const nodeCount = done.nodes.length;
    let proposing = 0;
    let proposePeak = 0;
    let runs = 0;
    let runPeak = 0;
    const originalRun = engine.run.bind(engine);
    engine.run = async (id: string, options?: object) => {
      runs += 1;
      runPeak = Math.max(runPeak, runs);
      try { return await originalRun(id, options as never); } finally { runs -= 1; }
    };
    let clock = 0;
    const improver = new ProjectImprover({ engine, now: () => (clock += 200), sleep: async () => {} });
    improver.propose = async (_p: unknown, nodeId: string) => {
      proposing += 1;
      proposePeak = Math.max(proposePeak, proposing);
      await new Promise((r) => setTimeout(r, 15));
      proposing -= 1;
      return nodeId === 'Q' ? {} : { change: `sharper queries for ${nodeId}`, searchQueries: [`${nodeId} kiosk rent Brno 2026`] };
    };
    improver.start(project.id, { hours: 0.05 });
    await new Promise((r) => setTimeout(r, 5));
    expect(improver.join(project.id, 'pc')).toMatchObject({ joined: true, lanes: 3, mine: true });
    for (let i = 0; i < 800 && improver.isActive(project.id); i++) await new Promise((r) => setTimeout(r, 10));
    const saved = await engine.load(project.id);
    expect(proposePeak).toBeGreaterThanOrEqual(2);
    expect(proposePeak).toBeLessThanOrEqual(3);
    expect(runPeak).toBeLessThanOrEqual(1);
    expect(saved.improve.active).toBe(false);
    expect(saved.nodes.length).toBe(nodeCount);
    const outcomes = new Set(saved.improve.trials.map((t: { outcome: string }) => t.outcome));
    for (const o of outcomes) expect(['kept', 'reverted-whole', 'reverted-piece', 'reverted-regression', 'no-change', 'no-gain', 'repeat', 'conflict']).toContain(o);
    expect(saved.improve.best).toBeGreaterThanOrEqual(saved.improve.baseline);
    expect(engine.lanesFor(project.id)).toBe(2);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});

describe('ProjectImprover through provider outages', () => {
  it('pauses instead of ending when every provider fails, then carries on', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-improve-outage-'));
    const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({}) };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search, store: new ProjectStore({ dir }), lanes: 1 });
    const project = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    await engine.run(project.id);
    const original = engine.regroundAndRescore.bind(engine);
    let failures = 0;
    engine.regroundAndRescore = async (id: string) => {
      if (failures < 2) { failures += 1; throw new Error('every provider failed for synthesize: gemini HTTP 503: This model is currently experiencing high demand'); }
      return original(id);
    };
    let clock = 0;
    const sleeps: number[] = [];
    const improver = new ProjectImprover({ engine, now: () => (clock += 1000), sleep: async (ms: number) => { sleeps.push(ms); clock += ms; } });
    improver.start(project.id, { hours: 0.3 });
    for (let i = 0; i < 500 && improver.isActive(project.id); i++) await new Promise((r) => setTimeout(r, 10));
    const saved = await engine.load(project.id);
    expect(failures).toBe(2);
    expect(sleeps.slice(0, 2)).toEqual([300000, 300000]);
    expect(saved.improve.error ?? null).toBeNull();
    expect(saved.improve.stopReason).toBe('time limit reached');
    expect(saved.improve.lastPause.reason).toMatch(/every provider failed for synthesize/);
    expect(saved.log.some((l: { message: string }) => /loop paused 5 min/.test(l.message))).toBe(true);
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

describe('ProjectImprover handoffs', () => {
  it('writes a handoff when the loop ends and, on shutdown, saves the remaining hours without a half-applied change', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-improve-handoff-'));
    const stops: Array<{ reason: string; resume?: { loopHoursLeft?: number } }> = [];
    const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({}) };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search, store: new ProjectStore({ dir }), onStop: async (_p: unknown, options: { reason: string }) => { stops.push(options); } });
    const project = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    let clock = 0;
    const improver = new ProjectImprover({ engine, now: () => (clock += 2000), sleep: async () => {} });
    improver.start(project.id, { hours: 0.05 });
    for (let i = 0; i < 500 && improver.isActive(project.id); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    expect(stops.map((s) => s.reason)).toEqual(['loop ended']);

    clock = 0;
    const second = new ProjectImprover({ engine, now: () => clock, sleep: async () => {} });
    second.start(project.id, { hours: 4 });
    await new Promise((r) => setTimeout(r, 30));
    await second.shutdown();
    expect(stops.at(-1)).toMatchObject({ reason: 'app stopped', resume: { loopHoursLeft: 4 } });
    for (let i = 0; i < 500 && second.isActive(project.id); i++) await new Promise((r) => setTimeout(r, 10));
    expect(stops.filter((s) => s.reason === 'loop stopped by user')).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('reverts a change that breaks a regression check that used to pass, and runs only on the selected pieces', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-improve-scope-'));
    const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({}) };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search, store: new ProjectStore({ dir }) });
    const created = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    const done = await engine.run(created.id);
    addSpec(done, 'D2.1', normalizeSpec({ mustMention: ['DEMO answer'] }, { request: 'baseline', desired: 'the demo answer' }));
    await engine.store.save(done);
    let clock = 0;
    const improver = new ProjectImprover({ engine, now: () => (clock += 1000), sleep: async () => {} });
    improver.propose = async () => ({ change: 'rewrite the question', question: 'Completely different question?' });
    const originalLeaf = engine.researchLeaf.bind(engine);
    engine.researchLeaf = async (project: { nodes: unknown[] }, node: { id: string; finding: { answer: string } }) => {
      await originalLeaf(project, node);
      node.finding.answer = 'changed';
    };
    const tree = (await engine.load(created.id)).nodes.map((n: { id: string }) => n.id);
    const others = tree.filter((n: string) => n !== 'D2.1');
    improver.start(created.id, { hours: 0.004, nodes: ['D2.1'], exclude: ['Q', ...others] });
    expect(improver.scopeOf(created.id)).toEqual(['D2.1']);
    expect(improver.excludeOf(created.id)).toEqual(['Q', ...others]);
    for (let i = 0; i < 500 && improver.isActive(created.id); i++) await new Promise((r) => setTimeout(r, 10));
    const saved = await engine.load(created.id);
    expect(saved.improve.scope).toEqual(['D2.1']);
    expect(saved.improve.exclude).toEqual(['Q', ...others]);
    expect(saved.improve.trials.length).toBeGreaterThan(0);
    expect(saved.improve.trials.every((x: { nodeId: string }) => x.nodeId === 'D2.1')).toBe(true);
    expect(saved.improve.trials[0]).toMatchObject({ outcome: 'reverted-regression', detail: expect.stringContaining('D2.1/R1') });
    expect(saved.nodes.find((n: { id: string }) => n.id === 'D2.1').question).not.toBe('Completely different question?');
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});

describe('loop focus for selected pieces', () => {
  const nodes = [
    { id: 'D1', parentId: 'Q' }, { id: 'D1.1', parentId: 'D1' }, { id: 'D1.2', parentId: 'D1' }, { id: 'D1.2.1', parentId: 'D1.2' }, { id: 'D1.3', parentId: 'D1' },
    { id: 'D2', parentId: 'Q' }, { id: 'D2.1', parentId: 'D2' }, { id: 'D3', parentId: 'Q' },
  ];

  it('covers the request, the primary level and the chosen piece with its siblings, never the children of other branches', () => {
    expect([...inScope(nodes, ['D1.2'])].sort()).toEqual(['D1', 'D1.1', 'D1.2', 'D1.2.1', 'D1.3', 'D2', 'D3']);
    expect([...inScope(nodes, ['D2'])].sort()).toEqual(['D1', 'D2', 'D2.1', 'D3']);
    expect(inScope(nodes, []).size).toBe(nodes.length);
  });

  it('drops the pieces the user excluded from the highlighted path, including the request', () => {
    expect([...inScope(nodes, ['D1.2'], ['D2', 'D1.3'])].sort()).toEqual(['D1', 'D1.1', 'D1.2', 'D1.2.1', 'D3']);
    const project = { nodes: nodes.map((n) => ({ ...n, status: 'weak', impact: 1, uncertainty: 1 })) };
    expect(improvementTargets(project, ['D1.2'])[0]).toBe('Q');
    expect(improvementTargets(project, ['D1.2'], ['Q', 'D3'])).not.toContain('Q');
    expect(improvementTargets(project, ['D1.2'], ['Q', 'D3']).sort()).toEqual(['D1.1', 'D1.2.1', 'D1.3']);
  });
});

describe('tree gate in the loop', () => {
  it('never keeps a new top-level driver that restates the question or duplicates a driver, and strips ids from titles', () => {
    const p = { question: 'Find affordable coastal plots under 20000 EUR for a glamping business with a mild climate', nodes: [
      { id: 'D1', parentId: 'Q', title: 'Land cost', question: 'Average land price per m² in Spain coastal zones?', dependsOn: [], status: 'weak' },
      { id: 'D2', parentId: 'Q', title: 'Climate', question: 'Months per year with mild weather in each region?', dependsOn: [], status: 'weak' },
    ] };
    expect(applyVariant(p, 'Q', { add: [{ title: 'D3: Affordable coastal plots', question: 'Which affordable coastal plots under 20000 EUR suit a glamping business with a mild climate?' }] })).toEqual([]);
    expect(applyVariant(p, 'Q', { add: [{ title: 'Land prices', question: 'Average land price per m² in Spain coastal zones 2026?' }] })).toEqual([]);
    expect(applyVariant(p, 'Q', { add: [{ title: 'D3: Permits', question: 'Which permits does a glamping site need in Spain?' }] })).toEqual(['D3']);
    expect(p.nodes.find((n) => n.id === 'D3')!.title).toBe('Permits');
  });
});

describe('a loop that cannot get stuck', () => {
  const t0 = Date.parse('2026-10-24T10:00:00Z');
  const at = (min: number) => new Date(t0 + min * 60000).toISOString();

  it('rotates to the piece whose rest ends first instead of always the question', () => {
    const trials = ['D2', 'D2', 'D2', 'Q', 'Q', 'Q', 'D1.1', 'D1.1', 'D1.1'].map((nodeId, i) => ({ nodeId, outcome: 'reverted-whole', at: at(i) }));
    expect(restRotation(['Q', 'D2', 'D1.1'], trials)).toBe('D2');
    expect(restRotation(['Q', 'D2', 'D1.1'], [...trials, { nodeId: 'D2', outcome: 'reverted-whole', at: at(20) }])).toBe('Q');
  });

  it('treats the same removal or a near-identical change on the same piece as a repeat, but not a new region', () => {
    const trials = [
      { nodeId: 'Q', removedPieceId: 'D4', change: 'Remove duplicate zoning node D4', outcome: 'reverted-whole', at: at(0) },
      { nodeId: 'D1.1', change: 'Split the task into two focused sub-tasks: one for Portuguese coastal plots under 20 000 EUR and another for Spain', outcome: 'reverted-whole', at: at(1) },
      { nodeId: 'D1.2', change: 'Add a dedicated node to search for Vietnamese coastal plots under 20,000 EUR', outcome: 'reverted-whole', at: at(2) },
      { nodeId: 'D3', change: 'Use local-language queries for Turkish parcels', outcome: 'kept', at: at(3) },
    ];
    expect(repeatOf(trials, { nodeId: 'Q', removedPieceId: 'D4', change: 'Merge D4 into D18 and drop D4' })).toMatchObject({ at: at(0) });
    expect(repeatOf(trials, { nodeId: 'D1.1', change: 'Split the task into two focused sub‑tasks: one for Portuguese coastal plots under 20 000 EUR and another for Spain.' })).toMatchObject({ at: at(1) });
    expect(repeatOf(trials, { nodeId: 'D1.2', change: 'Add a dedicated node to search for Turkish coastal plots under 20,000 EUR suitable for glamping' })).toBeNull();
    expect(repeatOf(trials, { nodeId: 'D3', change: 'Use local-language queries for Turkish parcels' })).toBeNull();
    expect(similarChange('Add node D7 to search coastal plots', 'Add node D6 to search coastal plots')).toBe(1);
    expect(REPEAT_SIMILARITY).toBe(0.85);
  });

  it('reports a stall after 20 trials without a kept change, with the weakest check and the refused removals', () => {
    const futile = Array.from({ length: STALL_TRIALS }, (_, i) => ({ nodeId: 'Q', removedPieceId: i % 2 ? 'D4' : 'D1, D18', change: `try ${i}`, outcome: 'reverted-whole', at: at(30 + i) }));
    const project = { improve: { startedAt: at(0), trials: [{ nodeId: 'D2', outcome: 'kept', change: 'k', at: at(10) }, ...futile] }, acceptanceResult: { checks: [{ label: 'Value in range', value: 0.6 }, { label: 'At least 50 valid items', value: 0.1 }] } };
    const stall = stallCheck(project, t0 + 130 * 60000);
    expect(stall).toEqual({ stalled: true, trialsSinceKept: 20, hoursSinceKept: 2, weakest: { label: 'At least 50 valid items', value: 0.1 }, refusedRemovals: ['D1', 'D18', 'D4'] });
    expect(stallMessage(stall)).toMatch(/stalled: 20 trials in 2 h .*"At least 50 valid items" at 10%.*D1, D18, D4/);
    expect(stallCheck({ ...project, improve: { ...project.improve, trials: futile.slice(1) } }, t0 + 130 * 60000)).toMatchObject({ stalled: false, trialsSinceKept: 19, hoursSinceKept: 2.2 });
  });

  it('posts the stall to the research chat once, when it starts', async () => {
    const saved: { improve?: { stall?: { stalled: boolean } }; chats?: unknown } = {};
    const engine = { load: async () => structuredClone(saved), store: { save: async (p: object) => Object.assign(saved, p) }, emit: () => {} };
    const improver = new ProjectImprover({ engine: engine as never });
    const stall = { stalled: true, trialsSinceKept: 20, hoursSinceKept: 1, weakest: null, refusedRemovals: [] };
    await improver.record('p', { stall });
    await improver.record('p', { stall });
    expect(JSON.stringify(saved.chats).match(/loop is stalled/g)).toHaveLength(1);
  });

  it('refuses a repeated change without re-researching or re-rolling the research', async () => {
    const project = { id: 'p', question: 'q', nodes: [...tree().nodes, blankNode({ id: 'D3', parentId: 'Q', question: 'permits?', status: 'weak' })], improve: { trials: [{ nodeId: 'Q', removedPieceId: 'D2', change: 'Remove D2', outcome: 'reverted-whole', at: at(0) }] } };
    let runs = 0;
    let saved = structuredClone(project);
    const engine = { load: async () => structuredClone(saved), store: { save: async (p: typeof project) => { saved = p; } }, emit: () => {}, run: async () => { runs += 1; }, researchLeaf: async () => { runs += 1; }, resetWithAncestors: () => {} };
    const improver = new ProjectImprover({ engine: engine as never });
    improver.propose = async () => ({ change: 'Drop the costs driver D2 again', remove: ['D2'] });
    const state = { best: { score: 0.3 }, deadline: Date.now() + 60000, lock: { run: (f: () => unknown) => f() } };
    expect(await improver.trial('p', 'Q', state)).toEqual({ kept: false });
    expect(runs).toBe(0);
    expect(saved.improve.trials.at(-1)).toMatchObject({ outcome: 'repeat', removedPieceId: 'D2' });
  });
});
