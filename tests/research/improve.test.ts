import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../src/llm/scripted-provider.mjs';
import { ModelRouter } from '../../src/llm/router.mjs';
import { ResearchEngine } from '../../src/research/engine.mjs';
import { NOISE_MIN_SAMPLES, PLATEAU_TRIALS, ProjectImprover, REPEAT_SIMILARITY, acceptsTrial, dataGain, failingPieces, GAIN_OUTCOMES, mergeDataRows, newListingRows, noiseFloor, nothingLeftToGain, passingHardRows, plateauCheck, purposeScore, resultsRubric, REST_AFTER_FUTILE, sameQueriesAgain, STALL_TRIALS, structuralIssues, REST_HOURS, applyVariant, cannotGain, distinctResearches, improvementTargets, inScope, loopCanImprove, projectScore, repeatOf, restRotation, restingPieces, scopeScore, similarChange, stallCheck, stallMessage, trimProposalRegions, trialVerdict, usedQueries } from '../../src/research/improve.mjs';
import { addSpec, normalizeSpec } from '../../src/research/specs.mjs';
import { blankNode } from '../../src/research/tree.mjs';
import { countriesIn } from '../../src/research/treeaudit.mjs';
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

  it('targets the weakest, highest-priority pieces first, and the whole question last (a root trial re-rolls the whole research)', () => {
    expect(improvementTargets(tree())).toEqual(['D2', 'D1.1', 'Q']);
  });

  it('limits the loop to the focus of the ticked pieces minus what the user excluded, and scores only that', () => {
    const p = tree();
    expect([...inScope(p.nodes, ['D1'])]).toEqual(['D1', 'D2', 'D1.1', 'D1.2']);
    expect(improvementTargets(p, ['D1'], ['Q'])).toEqual(['D2', 'D1.1']);
    expect(improvementTargets(p, ['D1']).at(-1)).toBe('Q');
    expect(improvementTargets(p, ['D1']).filter((id) => id === 'Q')).toHaveLength(1);
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

describe('loopCanImprove', () => {
  const row = { plan: { checks: [{}] }, share: 1 };
  const met = { ...tree(), acceptance: { itemCount: 2 }, acceptanceResult: { score: 1 }, candidates: { kept: [row] } };
  const reason = 'the expected result is already met and nothing else measures the purpose; improve the purpose checks first';

  it('refuses a loop when the expected result is already met and nothing else measures the purpose', () => {
    const empty = { ...met, candidates: { kept: [] } };
    expect(loopCanImprove(empty)).toEqual({ ok: false, reason });
    expect(loopCanImprove({ ...empty, acceptanceResult: { score: 0.999 } })).toEqual({ ok: false, reason });
    expect(loopCanImprove({ ...empty, acceptanceResult: { score: 0.998 } }).ok).toBe(true);
    expect(loopCanImprove({ ...empty, acceptanceResult: null }).ok).toBe(true);
    expect(loopCanImprove(met).ok).toBe(true);
    expect(loopCanImprove(tree()).ok).toBe(true);
  });
});

describe('purpose per delivered row', () => {
  const delivered = (passed: boolean[]) => ({ url: 'https://auto.bazos.cz/inzerat/225881782/citroen-c3.php', purpose: [{ id: 'purpose-kind', passed: passed[0] }, ...(passed.length > 1 ? [{ id: 'purpose-names-1', passed: passed[1] }] : [])] });

  it('scores the share of delivered rows that pass every purpose check', () => {
    expect(purposeScore({ acceptanceResult: { items: [delivered([true]), delivered([true]), delivered([false])] } })).toBe(0.667);
    expect(purposeScore({ acceptanceResult: { items: [delivered([true, false]), delivered([true, true])] } })).toBe(0.5);
    expect(purposeScore({ acceptanceResult: { items: [{ url: 'https://www.tradeindia.com/products/bale-of-mustang-used-cloth-korean-second-hand-c8797405.html' }] } })).toBeNull();
    expect(purposeScore({ acceptanceResult: { items: [] } })).toBeNull();
    expect(purposeScore({})).toBeNull();
  });

  it('blends the purpose share into the project score and still reports it', () => {
    const project = { ...tree(), acceptanceResult: { score: 1, items: [delivered([true]), delivered([false])] } };
    const scored = projectScore(project);
    expect(scored).toMatchObject({ acceptance: 1, purpose: 0.5, results: null });
    const base = projectScore({ ...project, acceptanceResult: null }).score;
    expect(scored.score).toBeCloseTo(0.6 * ((1 + 0.5) / 2) + 0.4 * base, 3);
  });

  it('refuses a loop when every delivered row meets the purpose, and allows it while the share is below 1', () => {
    const rows = (n: number, passing: number) => Array.from({ length: n }, (_, i) => delivered([i < passing]));
    const met = { ...tree(), acceptance: { itemCount: 20 }, acceptanceResult: { score: 1, items: rows(20, 20) }, candidates: { kept: [] } };
    expect(loopCanImprove(met)).toEqual({ ok: false, reason: 'every delivered row already meets the purpose checks and nothing else measures the purpose' });
    expect(loopCanImprove({ ...met, acceptanceResult: { score: 1, items: rows(20, 19) } }).ok).toBe(true);
    expect(loopCanImprove({ ...met, acceptanceResult: { score: 0.725, items: rows(20, 20) } }).ok).toBe(true);
  });
});

describe('improvementTargets', () => {
  it('skips verified pieces that cannot gain, keeps verified pieces that deliver items while the expected result is unmet', () => {
    const leaf = (id: string, status: string, items = 0) => ({ id, parentId: 'D1', status, impact: 3, uncertainty: 3, dependsOn: [], finding: { items: Array.from({ length: items }, (_, i) => ({ url: `https://x.example/${id}/${i}` })) } });
    const project = { nodes: [{ id: 'D1', parentId: 'Q', status: 'supported', dependsOn: [] }, leaf('D1.1', 'weak'), leaf('D1.2', 'verified'), leaf('D1.3', 'verified', 4), leaf('D1.4', 'supported')], acceptanceResult: { score: 0.13 } };
    expect(improvementTargets(project as never)).toEqual(['D1.1', 'D1.4', 'D1.3', 'Q']);
    expect(improvementTargets({ ...project, acceptanceResult: { score: 1 } } as never)).toEqual(['D1.1', 'D1.4', 'Q']);
    expect(improvementTargets({ ...project, acceptanceResult: null } as never)).toEqual(['D1.1', 'D1.4', 'Q']);
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

describe('ProjectImprover refusal', () => {
  it('does not start when the expected result is already met and nothing else measures the purpose', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-improve-met-'));
    const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({}) };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search, store: new ProjectStore({ dir }) });
    const created = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    const done = await engine.run(created.id);
    done.acceptanceResult = { score: 1, checks: [] };
    done.acceptance = { itemCount: 4 };
    done.candidates = { kept: [] };
    await engine.store.save(done);
    let clock = 0;
    const improver = new ProjectImprover({ engine, now: () => (clock += 2000), sleep: async () => {} });
    const reason = 'the expected result is already met and nothing else measures the purpose; improve the purpose checks first';
    expect(improver.start(created.id, { hours: 0.05 })).toEqual({ ok: false, reason });
    expect(improver.isActive(created.id)).toBe(false);
    const saved = await engine.load(created.id);
    expect(saved.log.at(-1)).toMatchObject({ type: 'improve-state', message: `loop not started: ${reason}` });
    expect(saved.improve?.active).not.toBe(true);
    expect(saved.improve?.startedAt).toBeUndefined();
    await engine.store.writes.get(created.id);
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
      return nodeId === 'Q' ? {} : { change: `sharper queries for ${nodeId}`, searchQueries: [`${nodeId} kiosk rent Brno 2026`], diagnosis: `${nodeId} has no local-language query`, guided: true, type: 'sub-question|lookup|fact' };
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
    const tested = saved.improve.trials.filter((t: { nodeId: string; outcome: string }) => t.nodeId !== 'Q' && !['no-change', 'repeat'].includes(t.outcome));
    expect(tested.length).toBeGreaterThan(0);
    expect(tested.every((t: { diagnosis: string; guided: boolean; type: string }) => t.diagnosis.endsWith('has no local-language query') && t.guided && t.type === 'sub-question|lookup|fact')).toBe(true);
    expect(saved.improve.byType['sub-question|lookup|fact'].guided.tested).toBeGreaterThan(0);
    expect(engine.lanesFor(project.id)).toBe(2);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});

describe('ProjectImprover baseline', () => {
  it('sweeps the portals once at loop start, never in its trials, and brings remembered teammates back', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-improve-sweep-'));
    const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({}) };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search, store: new ProjectStore({ dir }), lanes: 1 });
    const project = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    await engine.run(project.id);
    const sweeps: boolean[] = [];
    const rejoined: string[] = [];
    engine.store.cache.get(project.id).team = { 'pc-browser': new Date().toISOString() };
    const join = engine.join.bind(engine);
    engine.join = (id: string, clientId: string) => { rejoined.push(clientId); return join(id, clientId); };
    const collect = engine.collectCandidates.bind(engine);
    engine.collectCandidates = async (p: never, options: { sweep?: boolean } = {}) => { sweeps.push(Boolean(options.sweep)); return collect(p, options); };
    let clock = 0;
    const improver = new ProjectImprover({ engine, now: () => (clock += 1000), sleep: async (ms: number) => { clock += ms; } });
    improver.start(project.id, { hours: 0.05 });
    for (let i = 0; i < 500 && improver.isActive(project.id); i++) await new Promise((r) => setTimeout(r, 10));
    expect(sweeps[0]).toBe(true);
    expect(rejoined).toEqual(['pc-browser']);
    expect(sweeps.slice(1).every((s) => !s)).toBe(true);
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
    second.pass = async () => false;
    const resumed = await engine.load(project.id);
    resumed.improve = { ...resumed.improve, trials: [] };
    await engine.store.save(resumed);
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
    const search = { enabled: true, lastErrors: [], search: async () => [
      { kind: 'web', title: 'Top 5 Vintage Clothes Suppliers in Europe', url: 'https://vintagesupplier.com/top-5-vintage-clothes-suppliers-in-europe', domain: 'vintagesupplier.com', snippet: 's', text: 'Choosing among vintage clothing suppliers in Europe starts with a practical question about buying format' },
      { kind: 'web', title: 'Zagumi used clothing wholesale', url: 'https://www.zagumi.com/nl/used-clothing/', domain: 'zagumi.com', snippet: 's', text: 'Groothandel gebruikte kleding in balen with merkkleding and Cream quality grade' },
    ], describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }) };
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
    expect(improvementTargets(project, ['D1.2']).at(-1)).toBe('Q');
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

  it('reports a stall after 20 trials without a kept change, with the lowest check below 100% and the refused removals', () => {
    const futile = Array.from({ length: STALL_TRIALS }, (_, i) => ({ nodeId: 'Q', removedPieceId: i % 2 ? 'D4' : 'D1, D18', change: `try ${i}`, outcome: 'reverted-whole', at: at(30 + i) }));
    const project = { improve: { startedAt: at(0), trials: [{ nodeId: 'D2', outcome: 'kept', change: 'k', at: at(10) }, ...futile] }, acceptanceResult: { checks: [{ label: 'Value in range', value: 0.6 }, { label: 'At least 50 valid items', value: 0.1 }] } };
    const stall = stallCheck(project, t0 + 130 * 60000);
    expect(stall).toEqual({ stalled: true, trialsSinceKept: 20, hoursSinceKept: 2, weakest: { label: 'At least 50 valid items', value: 0.1 }, failingPieces: [], refusedRemovals: ['D1', 'D18', 'D4'] });
    expect(stallMessage(stall)).toMatch(/stalled: 20 trials in 2 h .*"At least 50 valid items" at 10%.*D1, D18, D4/);
    expect(stallCheck({ ...project, improve: { ...project.improve, trials: futile.slice(1) } }, t0 + 130 * 60000)).toMatchObject({ stalled: false, trialsSinceKept: 19, hoursSinceKept: 2.2 });
  });

  it('never steers at a check already at 100%, and targets the failing pieces when every check is at 100%', () => {
    const t0b = Date.parse('2026-10-24T10:00:00Z');
    const atb = (min: number) => new Date(t0b + min * 60000).toISOString();
    const futile = Array.from({ length: STALL_TRIALS }, (_, i) => ({ nodeId: 'Q', change: `try ${i}`, outcome: 'reverted-whole', at: atb(30 + i) }));
    const nodes = [
      { id: 'D1', parentId: 'Q', status: 'verified', specs: [], dependsOn: [] },
      { id: 'D2', parentId: 'Q', status: 'weak', specs: [], dependsOn: [] },
      { id: 'D3', parentId: 'Q', status: 'supported', specs: [{ id: 'R1', minGrade: 'supported', mustMention: ['sea view'], needsNumber: false, valueRange: null, itemCount: null, last: { passed: false } }], dependsOn: [] },
    ];
    const base = { improve: { startedAt: atb(0), trials: futile }, nodes, acceptanceResult: { score: 0.807, checks: [
      { id: 'count', label: 'At least 50 valid items', value: 1 },
      { id: 'live', label: 'Links open a real page', value: 0.47 },
      { id: 'range', label: 'Value within 0–20000 EUR', value: 1 },
    ] } };
    const stall = stallCheck(base, t0b + 130 * 60000);
    expect(stall.weakest).toEqual({ label: 'Links open a real page', value: 0.47 });
    expect(stall.failingPieces).toEqual([]);
    const allFull = { ...base, acceptanceResult: { score: 1, checks: [
      { id: 'count', label: 'At least 50 valid items', value: 1 },
      { id: 'live', label: 'Links open a real page', value: 1 },
    ] } };
    const stallPieces = stallCheck(allFull, t0b + 130 * 60000);
    expect(stallPieces.weakest).toBeNull();
    expect(stallPieces.failingPieces).toEqual(['D2', 'D3']);
    expect(stallMessage(stallPieces)).toMatch(/stalled: 20 trials in 2\.2 h .*every expected-result check is at 100% but these pieces do not pass: D2, D3/);
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

  it('states a resumed loop length rounded to a tenth of an hour', async () => {
    const saved: { improve?: object } = {};
    const events: string[] = [];
    const engine = { load: async () => structuredClone(saved), store: { save: async (p: object) => Object.assign(saved, p) }, emit: (_p: unknown, _t: string, message: string) => events.push(message) };
    await new ProjectImprover({ engine: engine as never }).record('p', { active: true, hours: 19.09954888888889 });
    expect(events).toContain('self-improving loop started for 19.1 h');
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

  it('does not blame a change when the re-roll hits a provider outage, and pauses before the next trial', async () => {
    const project = { id: 'p', question: 'q', nodes: [...tree().nodes, blankNode({ id: 'D3', parentId: 'Q', question: 'permits?', status: 'weak' })], improve: { trials: [] } };
    let saved = structuredClone(project);
    const sleeps: number[] = [];
    const engine = {
      load: async () => structuredClone(saved),
      store: { save: async (p: typeof project) => { saved = structuredClone(p); } },
      emit: () => {},
      resetWithAncestors: () => {},
      run: async () => ({ ...structuredClone(saved), phase: 'done', nodes: saved.nodes.map((n) => (n.id === 'D3' ? { ...n, status: 'failed', error: 'every provider failed for research: sambanova HTTP 402' } : n)) }),
    };
    const improver = new ProjectImprover({ engine: engine as never, sleep: async (ms: number) => { sleeps.push(ms); } });
    const trialProject = structuredClone(project);
    trialProject.nodes.find((n) => n.id === 'D3')!.question = 'which permits apply to tents?';
    const state = { best: { score: 0.3 }, deadline: Date.now() + 3600000, lock: { run: (f: () => unknown) => f() } };
    const base = { at: at(0), nodeId: 'D3', before: 0.3 };
    expect(await improver.commit('p', { snapshot: project, project: trialProject, touched: ['D3'], removed: [], researched: false, nodeId: 'D3', base, change: 'sharper permit question' }, state)).toEqual({ kept: false });
    expect(saved.improve.trials.at(-1)).toMatchObject({ outcome: 'provider-outage', detail: expect.stringMatching(/^D3: every provider failed.*not counted against the change$/) });
    expect(saved.nodes.find((n) => n.id === 'D3')!.question).toBe('permits?');
    expect(sleeps).toEqual([300000]);
    expect(restingPieces([1, 2, 3].map((i) => ({ nodeId: 'D3', outcome: 'provider-outage', at: at(i) })), t0 + 10 * 60000).size).toBe(0);
  });

  it('researches the changed pieces once and re-measures from the cached pages, refusing to keep anything before the noise is measured', async () => {
    const project = { id: 'p', question: 'q', nodes: [...tree().nodes, blankNode({ id: 'D3', parentId: 'Q', question: 'permits?', status: 'weak' })], improve: { trials: [] } };
    let saved = structuredClone(project);
    const scores = [0.5, 0.29];
    const runs: Array<{ pieces?: string[]; reuse?: boolean; pages?: Map<string, unknown>; memo?: boolean }> = [];
    const engine = {
      load: async () => structuredClone(saved),
      store: { save: async (p: typeof project) => { saved = structuredClone(p); } },
      emit: () => {},
      resetWithAncestors: (p: typeof project, id: string) => { p.nodes.find((n) => n.id === id)!.status = 'pending'; },
      run: async (_id: string, options: { pieces?: string[]; reuse?: boolean; pages?: Map<string, unknown> }) => {
        runs.push(options);
        saved.nodes.find((n) => n.id === 'D3')!.sources = [{ url: 'https://permit.example/praha' }];
        return { ...structuredClone(saved), phase: 'done' };
      },
      remeasure: async () => structuredClone(saved),
      resynthesize: async () => {},
    };
    const state = { best: { score: 0.3 }, deadline: Date.now() + 3600000, lock: { run: (f: () => unknown) => f() }, measure: () => ({ score: scores.shift() }) };
    const improver = new ProjectImprover({ engine: engine as never });
    const trialProject = structuredClone(project);
    trialProject.nodes.find((n) => n.id === 'D3')!.question = 'which permits apply to tents?';
    const base = { at: at(0), nodeId: 'D3', before: 0.3 };
    expect(await improver.commit('p', { snapshot: project, project: trialProject, touched: ['D3'], removed: [], researched: false, nodeId: 'D3', base, change: 'sharper permit question' }, state)).toEqual({ kept: false });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ memo: false, reuse: true, pieces: ['D3'] });
    expect(runs[0].pages).toBeInstanceOf(Map);
    expect(state.pages).toBe(runs[0].pages);
    expect(saved.improve.trials.at(-1)).toMatchObject({ outcome: 'reverted-noise', score: 0.29, detail: expect.stringMatching(/^measured 0\.5, re-measured 0\.29 from the cached pages; noise not yet measured/) });
    expect(saved.improve.remeasureNoise).toEqual([-0.21]);
    expect(saved.nodes.find((n) => n.id === 'D3')!.question).toBe('permits?');
  });

  it('keeps a change once the noise is measured and the gain clears the largest noise sample, recording the second score as the new best', async () => {
    const project = { id: 'p', question: 'q', nodes: [...tree().nodes, blankNode({ id: 'D3', parentId: 'Q', question: 'permits?', status: 'weak' })], improve: { trials: [], remeasureNoise: [0, 0, 0, 0, 0] } };
    let saved = structuredClone(project);
    const scores = [0.4, 0.395];
    const runs: string[] = [];
    const engine = {
      load: async () => structuredClone(saved),
      store: { save: async (p: typeof project) => { saved = structuredClone(p); } },
      emit: () => {},
      resetWithAncestors: (p: typeof project, id: string) => { p.nodes.find((n) => n.id === id)!.status = 'pending'; },
      run: async () => {
        runs.push('run');
        saved.nodes.find((n) => n.id === 'D3')!.sources = [{ url: 'https://permits.example/brno' }];
        return { ...structuredClone(saved), phase: 'done' };
      },
      remeasure: async () => structuredClone(saved),
      resynthesize: async () => {},
    };
    const state = { best: { score: 0.3 }, deadline: Date.now() + 3600000, lock: { run: (f: () => unknown) => f() }, measure: () => ({ score: scores.shift() }) };
    const improver = new ProjectImprover({ engine: engine as never });
    const trialProject = structuredClone(project);
    trialProject.nodes.find((n) => n.id === 'D3')!.question = 'which permits apply to tents?';
    const base = { at: at(0), nodeId: 'D3', before: 0.3 };
    expect(await improver.commit('p', { snapshot: project, project: trialProject, touched: ['D3'], removed: [], researched: false, nodeId: 'D3', base, change: 'sharper permit question' }, state)).toMatchObject({ kept: true, score: { score: 0.395 } });
    expect(runs).toEqual(['run']);
    expect(saved.improve.trials.at(-1)).toMatchObject({ outcome: 'kept', score: 0.395, remeasured: 0.395 });
    expect(state.best.score).toBe(0.395);
    expect(saved.improve.remeasureNoise).toEqual([0, 0, 0, 0, 0, -0.005]);
  });

  it('refuses to keep a change that cites no source URL the tree did not already have', async () => {
    const project = { id: 'p', question: 'q', nodes: [...tree().nodes, blankNode({ id: 'D3', parentId: 'Q', question: 'permits?', status: 'weak' })], improve: { trials: [], remeasureNoise: [0, 0, 0, 0, 0] } };
    let saved = structuredClone(project);
    const engine = {
      load: async () => structuredClone(saved),
      store: { save: async (p: typeof project) => { saved = structuredClone(p); } },
      emit: () => {},
      resetWithAncestors: (p: typeof project, id: string) => { p.nodes.find((n) => n.id === id)!.status = 'pending'; },
      run: async () => ({ ...structuredClone(saved), phase: 'done' }),
      resynthesize: async () => {},
    };
    const state = { best: { score: 0.3 }, deadline: Date.now() + 3600000, lock: { run: (f: () => unknown) => f() }, measure: () => ({ score: 0.9 }) };
    const improver = new ProjectImprover({ engine: engine as never });
    const trialProject = structuredClone(project);
    trialProject.nodes.find((n) => n.id === 'D3')!.question = 'which permits apply to tents?';
    const base = { at: at(0), nodeId: 'D3', before: 0.3 };
    expect(await improver.commit('p', { snapshot: project, project: trialProject, touched: ['D3'], removed: [], researched: false, nodeId: 'D3', base, change: 'sharper permit question' }, state)).toEqual({ kept: false });
    expect(saved.improve.trials.at(-1)).toMatchObject({ outcome: 'no-new-evidence', detail: 'the trial cites no source URL the tree did not already have; a kept change has to bring new evidence' });
    expect(saved.improve.best).toBeUndefined();
  });

  it('keeps nothing until the noise is measured, then demands a gain above both the noise floor and the largest noise sample', () => {
    expect(noiseFloor([0.01, -0.01])).toBe(0.001);
    const samples = Array.from({ length: NOISE_MIN_SAMPLES }, (_, i) => (i % 2 ? 0.006 : -0.006));
    expect(noiseFloor(samples)).toBeCloseTo(0.013, 3);
    expect(trialVerdict(0.4, 0.42, [], samples.slice(0, NOISE_MIN_SAMPLES - 1))).toEqual({ ok: false, reason: 'noise not yet measured' });
    expect(acceptsTrial(0.4, 0.42, [], samples.slice(0, NOISE_MIN_SAMPLES - 1))).toBe(false);
    expect(acceptsTrial(0.4, 0.405, [], samples)).toBe(false);
    expect(acceptsTrial(0.4, 0.42, [], samples)).toBe(true);
    const spiky = [0.03, 0, 0, 0, 0];
    expect(acceptsTrial(0.4, 0.42, [], spiky)).toBe(false);
    expect(acceptsTrial(0.4, 0.431, [], spiky)).toBe(true);
    expect(acceptsTrial(0.5, 0.505, ['D4'], samples)).toBe(false);
  });

  it('scores the results by the share of criteria the best items meet, counting refuted ones as zero', () => {
    const row = (share: number, verdict?: string) => ({ plan: { checks: [{}], share }, ...(verdict ? { verified: { verdict } } : {}) });
    const project = { ...tree(), acceptance: { itemCount: 4 }, acceptanceResult: { score: 0.5 }, candidates: { kept: [row(1), row(1, 'refuted'), row(0.5), row(0.25), row(0.1)] } };
    expect(resultsRubric(project)).toBe(0.463);
    expect(resultsRubric({ ...project, acceptance: {} })).toBeNull();
    const base = projectScore({ ...project, acceptanceResult: null, candidates: null }).score;
    expect(projectScore(project)).toMatchObject({ acceptance: 0.5, results: 0.463 });
    expect(projectScore(project).score).toBeCloseTo(0.6 * ((0.5 + 0.463) / 2) + 0.4 * base, 3);
  });

  it('refuses a change like one that failed on several pieces of the same type and was never kept', async () => {
    const change = 'Add local-language real estate portal queries and direct listing URLs for rustic land';
    const trials = ['D1.1', 'D2', 'D1.2'].map((nodeId, i) => ({ nodeId, change: `${change} ${['Portugal', 'Spain', 'Greece'][i]}`, outcome: 'reverted-whole', type: 'sub-question|lookup|fact', at: at(i) }));
    const project = { id: 'p', question: 'q', nodes: [...tree().nodes, blankNode({ id: 'D3', parentId: 'Q', question: 'permits?', status: 'weak' })], improve: { trials } };
    let runs = 0;
    let saved = structuredClone(project);
    const engine = { load: async () => structuredClone(saved), store: { save: async (p: typeof project) => { saved = p; } }, emit: () => {}, run: async () => { runs += 1; }, researchLeaf: async () => { runs += 1; }, resetWithAncestors: () => {} };
    const improver = new ProjectImprover({ engine: engine as never });
    improver.propose = async () => ({ change: `${change} Turkey`, searchQueries: ['arsa satılık'], type: 'sub-question|lookup|fact' });
    const state = { best: { score: 0.3 }, deadline: Date.now() + 60000, lock: { run: (f: () => unknown) => f() } };
    expect(await improver.trial('p', 'D3', state)).toEqual({ kept: false });
    expect(runs).toBe(0);
    expect(saved.improve.trials.at(-1)).toMatchObject({ outcome: 'repeat', detail: expect.stringMatching(/^like a change tested 3 times on 3 pieces of this type \(D1\.1, D2, D1\.2\) and never kept/) });
  });

  it('records provider-outage when a quota error is thrown during trial, and error for other errors', async () => {
    const project = { id: 'p', question: 'q', nodes: [...tree().nodes], improve: { trials: [] } };
    let saved = structuredClone(project);
    const engine = { load: async () => structuredClone(saved), store: { save: async (p: typeof project) => { saved = structuredClone(p); } }, emit: () => {}, resetWithAncestors: () => {}, run: async () => ({ ...structuredClone(saved), phase: 'done' }) };
    const improver = new ProjectImprover({ engine: engine as never, sleep: async () => {} });
    improver.propose = async () => { throw new Error('every provider failed for improve: gemini HTTP 503: high demand'); };
    const state = { best: { score: 0.3 }, deadline: Date.now() + 3600000, lock: { run: (f: () => unknown) => f() } };
    await improver.trial('p', 'D1.1', state);
    expect(saved.improve.trials.at(-1).outcome).toBe('provider-outage');
    expect(saved.improve.trials.at(-1).detail).toContain('every provider failed for improve: gemini HTTP 503');

    const project2 = { id: 'p2', question: 'q', nodes: [...tree().nodes], improve: { trials: [] } };
    let saved2 = structuredClone(project2);
    const engine2 = { load: async () => structuredClone(saved2), store: { save: async (p: typeof project2) => { saved2 = structuredClone(p); } }, emit: () => {}, resetWithAncestors: () => {}, run: async () => ({ ...structuredClone(saved2), phase: 'done' }) };
    const improver2 = new ProjectImprover({ engine: engine2 as never, sleep: async () => {} });
    improver2.propose = async () => { throw new TypeError('some coding bug'); };
    const state2 = { best: { score: 0.3 }, deadline: Date.now() + 3600000, lock: { run: (f: () => unknown) => f() } };
    await improver2.trial('p2', 'D1.1', state2);
    expect(saved2.improve.trials.at(-1).outcome).toBe('error');
    expect(saved2.improve.trials.at(-1).detail).toContain('some coding bug');
  });

  it('stallCheck ignores provider-outage trials for stall detection', () => {
    const t0 = Date.parse('2026-10-24T10:00:00Z');
    const at = (min: number) => new Date(t0 + min * 60000).toISOString();
    const kept = { nodeId: 'D2', outcome: 'kept', change: 'k', at: at(10) };
    const outageTrials = Array.from({ length: 25 }, (_, i) => ({ nodeId: 'Q', outcome: 'provider-outage', change: `outage ${i}`, at: at(30 + i) }));
    const project = { improve: { startedAt: at(0), trials: [kept, ...outageTrials] }, acceptanceResult: { checks: [] } };
    const stall = stallCheck(project, t0 + 130 * 60000);
    expect(stall.stalled).toBe(false);
    expect(stall.trialsSinceKept).toBe(0);

    const noGainTrials = Array.from({ length: 20 }, (_, i) => ({ nodeId: 'Q', outcome: 'no-gain', change: `try ${i}`, at: at(30 + i) }));
    const project2 = { improve: { startedAt: at(0), trials: [kept, ...noGainTrials] }, acceptanceResult: { checks: [] } };
    const stall2 = stallCheck(project2, t0 + 130 * 60000);
    expect(stall2.stalled).toBe(true);
    expect(stall2.trialsSinceKept).toBe(20);
  });
});

describe('a trial that researches only what it changed', () => {
  it('reuses the stored table and researches only the given pieces, without touching the portals', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-improve-reuse-'));
    const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({}) };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search, store: new ProjectStore({ dir }), lanes: 1 });
    const created = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    const done = await engine.run(created.id);
    const leaf = done.nodes.find((n: { id: string }) => n.id !== 'Q' && !done.nodes.some((c: { parentId: string }) => c.parentId === n.id));
    const collected: string[] = [];
    const collect = engine.collectCandidates.bind(engine);
    engine.collectCandidates = async (p: never, options: { reuse?: boolean } = {}) => { collected.push(options.reuse ? 'reuse' : 'fresh'); return collect(p, options); };
    const researched: string[] = [];
    const research = engine.researchLeaf.bind(engine);
    engine.researchLeaf = async (p: never, node: { id: string }) => { researched.push(node.id); return research(p, node); };
    const stored = await engine.load(created.id);
    engine.resetWithAncestors(stored, leaf.id);
    await engine.store.save(stored);
    const pages = new Map();
    const reused = await engine.run(created.id, { memo: false, reuse: true, pieces: [leaf.id], pages });
    expect(collected).toEqual([]);
    expect(researched).toEqual([leaf.id]);
    expect(reused.candidates).toBeNull();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('reads each acceptance page once per loop and reuses the cached text on the re-measure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-improve-pages-'));
    const reads: string[] = [];
    const one = 'https://auto.example/inzerat/225881782/citroen-c3.php';
    const search = {
      enabled: true,
      lastErrors: [],
      search: async () => [],
      readPage: async (url: string) => { reads.push(url); return { status: 200, text: `Citroen C3 1.4i hatchback 54 kW 150 000 km cena 15 000 Kč ${url} `.repeat(6) }; },
      describe: () => ({}),
    };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search, store: new ProjectStore({ dir }) });
    const project = {
      id: 'p',
      question: 'Find accurate hatchback car listings at least 1 car',
      acceptance: { expected: 'one hatchback listing', itemCount: 1, urlsLive: true, valueRange: null, unit: 'CZK', mustMention: [] },
      candidates: null,
      report: { deliverables: [] },
      nodes: [{ id: 'D1', parentId: 'Q', status: 'verified', dependsOn: [], specs: [], sources: [], finding: { items: [{ url: one, value: 15000, unit: 'CZK' }] } }],
    };
    const pages = new Map();
    await engine.checkAcceptance(project as never, pages);
    const first = { score: project.acceptanceResult.score, checks: project.acceptanceResult.checks };
    await engine.checkAcceptance(project as never, pages);
    expect(reads).toEqual([one]);
    expect({ score: project.acceptanceResult.score, checks: project.acceptanceResult.checks }).toEqual(first);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});

describe('plateau', () => {
  const t0 = Date.parse('2026-10-24T10:00:00Z');
  const at = (min: number) => new Date(t0 + min * 60000).toISOString();

  it('counts PLATEAU_TRIALS non-kept finished trials in a row', () => {
    const trials = Array.from({ length: PLATEAU_TRIALS }, (_, i) => ({ nodeId: 'D1.1', outcome: 'reverted-whole', change: `try ${i}`, at: at(i) }));
    expect(plateauCheck(trials).plateaued).toBe(true);
    expect(plateauCheck(trials).trialsSinceKept).toBe(PLATEAU_TRIALS);
    expect(plateauCheck(trials.slice(0, PLATEAU_TRIALS - 1)).plateaued).toBe(false);
  });

  it('resets the count when a trial is kept', () => {
    const trials = [
      ...Array.from({ length: PLATEAU_TRIALS - 1 }, (_, i) => ({ nodeId: 'D1.1', outcome: 'reverted-whole', change: `try ${i}`, at: at(i) })),
      { nodeId: 'D1.1', outcome: 'kept', change: 'k', at: at(PLATEAU_TRIALS - 1) },
      { nodeId: 'D1.1', outcome: 'reverted-whole', change: 'after', at: at(PLATEAU_TRIALS) },
    ];
    expect(plateauCheck(trials).plateaued).toBe(false);
    expect(plateauCheck(trials).trialsSinceKept).toBe(1);
  });

  it('does not count provider outages or errors toward the plateau', () => {
    const trials = [
      ...Array.from({ length: PLATEAU_TRIALS }, (_, i) => ({ nodeId: 'D1.1', outcome: i % 2 ? 'provider-outage' : 'error', change: `outage ${i}`, at: at(i) })),
    ];
    expect(plateauCheck(trials).plateaued).toBe(false);
    expect(plateauCheck(trials).trialsSinceKept).toBe(0);
    const mixed = [
      ...Array.from({ length: PLATEAU_TRIALS - 1 }, (_, i) => ({ nodeId: 'D1.1', outcome: i % 2 ? 'provider-outage' : 'reverted-whole', change: `m ${i}`, at: at(i) })),
      { nodeId: 'D1.1', outcome: 'kept', change: 'k', at: at(PLATEAU_TRIALS - 1) },
    ];
    expect(plateauCheck(mixed).plateaued).toBe(false);
  });

  it('counts only the trials of the current loop run and skips stopped or conflicting trials', () => {
    const earlier = Array.from({ length: PLATEAU_TRIALS }, (_, i) => ({ nodeId: 'D1.1', outcome: 'no-gain', change: `old ${i}`, at: at(i) }));
    const current = [{ nodeId: 'D1.1', outcome: 'no-gain', change: 'new', at: at(100) }];
    expect(plateauCheck([...earlier, ...current], at(50)).trialsSinceKept).toBe(1);
    expect(plateauCheck([...earlier, ...current]).plateaued).toBe(true);
    const interrupted = Array.from({ length: PLATEAU_TRIALS }, (_, i) => ({ nodeId: 'D1.1', outcome: i % 2 ? 'reverted-stopped' : 'conflict', change: `s ${i}`, at: at(i) }));
    expect(plateauCheck(interrupted).trialsSinceKept).toBe(0);
  });

  it('keeps looping through a plateau while time is left and ends at the deadline, not at the plateau', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-improve-plateau-'));
    const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({}) };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search, store: new ProjectStore({ dir }), lanes: 1 });
    const project = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    await engine.run(project.id);
    let clock = 0;
    const improver = new ProjectImprover({ engine, now: () => (clock += 1000), sleep: async () => {} });
    // never propose a change that can be kept: every trial is a no-gain / repeat
    improver.propose = async () => ({ change: 'nothing useful', searchQueries: ['x'] });
    improver.start(project.id, { hours: 0.05 });
    for (let i = 0; i < 1000 && improver.isActive(project.id); i++) await new Promise((r) => setTimeout(r, 10));
    const saved = await engine.load(project.id);
    expect(saved.improve.active).toBe(false);
    expect(saved.improve.stopReason).toBe('time limit reached');
    expect(saved.improve.trials.length).toBeGreaterThanOrEqual(PLATEAU_TRIALS);
    expect(saved.improve.trials.every((t: { outcome: string }) => t.outcome !== 'kept')).toBe(true);
    expect(saved.improve.stall?.stalled).toBe(true);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});

describe('nothing left to gain', () => {
  const nodes = [
    { id: 'D1', parentId: 'Q', status: 'verified', specs: [], dependsOn: [] },
    { id: 'D2', parentId: 'Q', status: 'supported', specs: [], dependsOn: [] },
  ];
  const fullChecks = [
    { id: 'count', label: 'At least 50 valid items', value: 1 },
    { id: 'live', label: 'Links open a real page', value: 1 },
  ];

  it('ends early only when every acceptance check is at 100% and every piece passes', () => {
    const perfect = { nodes, acceptanceResult: { score: 1, checks: fullChecks } };
    expect(nothingLeftToGain(perfect)).toEqual({ ok: true, reason: 'nothing left to gain: every expected-result check is at 100% and every piece passes' });
    expect(nothingLeftToGain({ ...perfect, acceptanceResult: { score: 0.807, checks: [...fullChecks, { id: 'range', label: 'Value within 0–20000 EUR', value: 0.807 }] } }).ok).toBe(false);
    const weakPiece = { nodes: [...nodes, { id: 'D3', parentId: 'Q', status: 'weak', specs: [], dependsOn: [] }], acceptanceResult: { score: 1, checks: fullChecks } };
    const withWeak = nothingLeftToGain(weakPiece);
    expect(withWeak.ok).toBe(false);
    expect(withWeak.failingPieces).toEqual(['D3']);
    expect(failingPieces(weakPiece)).toEqual(['D3']);
    expect(nothingLeftToGain({ nodes, acceptanceResult: null }).ok).toBe(false);
  });
});

describe('proposals stay in the asked regions', () => {
  const regions = ['PT', 'ES', 'TR', 'VN'];
  const outsideOf = (text: string) => countriesIn(text).filter((c: string) => !regions.includes(c));

  it('trims out-of-region names from a proposal before it is tried, using the b7772e trial strings', () => {
    const { variant, trimmed } = trimProposalRegions({
      change: 'Search for coastal plots in Italy, Greece, Croatia, Bulgaria and Turkey on sahibinden.com, hepsiemlak.com; Vietnam on batdongsan.com.vn, chotot.com',
      searchQueries: ['land for sale in Italy Greece Croatia', 'satılık tarla arsa Muğla denize yakın'],
      split: [{ title: 'Italy Greece', question: 'Plots in Italy, Greece, Croatia and Bulgaria under 20000 EUR?' }],
      add: [{ question: 'Add a new sub-piece that searches for low-cost coastal plots in Greece, Bulgaria, Romania, and Croatia' }],
      sourceUrls: ['https://www.idealista.pt/x', 'https://www.immobiliare.it/vendita/terreno/'],
    }, regions);
    expect([...trimmed].sort()).toEqual(['Bulgaria', 'Croatia', 'Greece', 'Italy', 'Romania']);
    expect(variant.change).toBe('Search for coastal plots in Turkey on sahibinden.com, hepsiemlak.com; Vietnam on batdongsan.com.vn, chotot.com');
    expect(variant.change).toContain('Turkey');
    expect(variant.change).toContain('Vietnam');
    expect(variant.searchQueries[0]).toBe('land for sale in Portugal and Spain and Turkey and Vietnam');
    expect(variant.searchQueries[1]).toBe('satılık tarla arsa Muğla denize yakın');
    expect(variant.sourceUrls).toEqual(['https://www.idealista.pt/x']);
    const allText = [variant.change, ...variant.searchQueries, variant.split[0].title, variant.split[0].question, variant.add[0].question].join(' ');
    expect(outsideOf(allText)).toEqual([]);
    expect(countriesIn(allText)).toEqual(expect.arrayContaining(['TR', 'VN']));
  });

  it('leaves a proposal that names only allowed regions untouched', () => {
    const change = 'Which coastal parcels in Portugal, Spain, Turkey and Vietnam are listed for sale under 20,000 EUR?';
    const { variant, trimmed } = trimProposalRegions({ change, searchQueries: ['arsa satılık Muğla', 'đất nền Bình Thuận abaixo de 500 milhões'] }, regions);
    expect(trimmed).toEqual([]);
    expect(variant.change).toBe(change);
    expect(variant.searchQueries).toEqual(['arsa satılık Muğla', 'đất nền Bình Thuận abaixo de 500 milhões']);
  });

  it('a trimmed split no longer trips the outside-regions structural gate instead of being reverted whole', () => {
    const project = {
      question: 'Find appropriate plots to buy for a glamping business under 20000 EUR near the sea in Portugal, Spain, Turkey and Vietnam',
      brief: { kind: { label: 'plot of land', terms: ['terreno', 'plot of land'] }, regions, valueRange: [0, 20000], unit: 'EUR' },
      nodes: [
        { id: 'D1', parentId: 'Q', title: 'Land cost', question: 'Average land price per m² in Spain coastal zones?', dependsOn: [], status: 'weak', searchQueries: [], sourceUrls: [] },
        { id: 'D8', parentId: 'Q', title: 'Candidates', question: 'Which coastal plots in the asked countries are for sale?', dependsOn: [], status: 'weak', searchQueries: [], sourceUrls: [] },
      ],
    };
    const raw = {
      change: 'Split into sub-pieces for France, Italy, Spain, Greece and Turkey',
      split: [
        { question: 'Which coastal plots in Greece, Bulgaria, Romania and Croatia are for sale under 20,000 EUR?' },
        { question: 'Which Turkish coastal plots on sahibinden.com and hepsiemlak.com are for sale under 20,000 EUR?' },
      ],
    };
    const untrimmed = structuredClone(project);
    applyVariant(untrimmed, 'D8', raw as never);
    expect(structuralIssues(untrimmed).some((i: string) => i.startsWith('outside-regions:'))).toBe(true);
    const { variant, trimmed } = trimProposalRegions(raw, regions);
    expect(trimmed.length).toBeGreaterThan(0);
    const trimmedProject = structuredClone(project);
    applyVariant(trimmedProject, 'D8', variant as never);
    expect(structuralIssues(trimmedProject).some((i: string) => i.startsWith('outside-regions:'))).toBe(false);
    const splitText = trimmedProject.nodes.filter((n) => n.parentId === 'D8').map((n: { question: string }) => n.question).join(' ');
    expect(outsideOf(splitText)).toEqual([]);
    expect(splitText).toContain('sahibinden.com');
  });
});

describe('new data that serves the purpose is kept', () => {
  const brief = { kind: { label: 'plot of land', terms: ['terreno', 'plot of land', 'arsa', 'tarla'] }, regions: ['PT', 'ES', 'TR', 'VN'], valueRange: [0, 20000], unit: 'EUR', excludes: [] };
  const knownRow = { title: 'Terreno para venda Ericeira Portugal', url: 'https://www.imovirtual.com/pt/anuncio/terreno-para-venda-ID1iW4W', value: 9000, unit: 'EUR', place: 'Ericeira, Portugal' };
  const before = { nodes: [{ id: 'D8.3', parentId: 'Q', status: 'weak', sources: [], finding: { answer: 'none', items: [knownRow] } }] };
  const after = { nodes: [{ id: 'D8.3', parentId: 'Q', status: 'weak', sources: [], finding: { answer: 'none', items: [
    knownRow,
    { title: 'Terreno para venda Ericeira Portugal', url: 'https://www.imovirtual.com/pt/anuncio/terreno-para-venda-ID1ibp8', value: 1500, unit: 'EUR', place: 'Ericeira, Portugal' },
    { title: 'Tarla satılık Muğla Türkiye', url: 'https://www.sahibinden.com/ilan/tarla-satilik-mugla-ID99', value: 600000, unit: 'TRY', place: 'Muğla, Turkey' },
    { title: 'Terreno para venda Lisboa Portugal', url: 'https://www.imovirtual.com/pt/anuncio/terreno-caro-ID77', value: 25000, unit: 'EUR', place: 'Lisboa, Portugal' },
    { title: 'Działka na sprzedaż Gdańsk Polska', url: 'https://www.olx.pl/ogloszenie/dzialka-ID5', value: 5000, unit: 'EUR', place: 'Gdańsk, Poland' },
  ] } }] };

  it('collects the new listing rows and keeps only those that pass every hard criterion', () => {
    const gain = dataGain(before, after, brief);
    expect(newListingRows(before, after).map((r: { url: string }) => r.url)).toEqual([
      'https://www.imovirtual.com/pt/anuncio/terreno-para-venda-ID1ibp8',
      'https://www.sahibinden.com/ilan/tarla-satilik-mugla-ID99',
      'https://www.imovirtual.com/pt/anuncio/terreno-caro-ID77',
      'https://www.olx.pl/ogloszenie/dzialka-ID5',
    ]);
    expect(gain.found).toBe(4);
    expect(gain.passing.map((r: { url: string }) => r.url)).toEqual(['https://www.imovirtual.com/pt/anuncio/terreno-para-venda-ID1ibp8']);
    expect(gain.detail).toBe('+4 listings from imovirtual.com, olx.pl, sahibinden.com, 1 pass every hard criterion');
    expect(passingHardRows(gain.passing, brief)).toHaveLength(1);
    expect(passingHardRows([after.nodes[0].finding.items[2], after.nodes[0].finding.items[3], after.nodes[0].finding.items[4]], brief)).toEqual([]);
  });

  it('merges the passing rows into the research node and never rows that fail a hard criterion', () => {
    const target = structuredClone(before);
    expect(mergeDataRows(target, dataGain(before, after, brief).passing, 'D8.3')).toEqual(['https://www.imovirtual.com/pt/anuncio/terreno-para-venda-ID1ibp8']);
    expect(target.nodes[0].finding.items.map((i: { url: string }) => i.url)).toEqual([knownRow.url, 'https://www.imovirtual.com/pt/anuncio/terreno-para-venda-ID1ibp8']);
  });

  it('adds nothing when the research already holds the listing, so the trial is no data gain', () => {
    const target = structuredClone(before);
    const passing = dataGain(before, after, brief).passing;
    mergeDataRows(target, passing, 'D8.3');
    expect(mergeDataRows(target, passing, 'D8.3')).toEqual([]);
  });

  it('keeps new passing rows on a reverted text change and logs them in plain words, counting the trial as a gain', async () => {
    const t0 = Date.parse('2026-11-12T10:00:00Z');
    const at = (min: number) => new Date(t0 + min * 60000).toISOString();
    const project = { id: 'p', question: 'q', brief, nodes: [...tree().nodes, blankNode({ id: 'D3', parentId: 'Q', question: 'permits?', status: 'weak' })], improve: { trials: [], remeasureNoise: [0, 0, 0, 0, 0] } };
    let saved = structuredClone(project);
    const engine = {
      load: async () => structuredClone(saved),
      store: { save: async (p: typeof project) => { saved = structuredClone(p); } },
      emit: () => {},
      resetWithAncestors: (p: typeof project, id: string) => { p.nodes.find((n) => n.id === id)!.status = 'pending'; },
      run: async () => {
        const after = structuredClone(saved);
        after.nodes.find((n) => n.id === 'D3')!.finding = { answer: 'x', items: [{ title: 'Terreno para venda Ericeira Portugal', url: 'https://www.imovirtual.com/pt/anuncio/terreno-para-venda-ID1ibp8', value: 1500, unit: 'EUR', place: 'Ericeira, Portugal' }] };
        return { ...after, phase: 'done' };
      },
      resynthesize: async () => {},
    };
    const state = { best: { score: 0.3 }, deadline: Date.now() + 3600000, lock: { run: (f: () => unknown) => f() }, measure: () => ({ score: 0.3 }) };
    const improver = new ProjectImprover({ engine: engine as never });
    const trialProject = structuredClone(project);
    trialProject.nodes.find((n) => n.id === 'D3')!.question = 'which permits apply to tents?';
    const base = { at: at(0), nodeId: 'D3', before: 0.3 };
    const result = await improver.commit('p', { snapshot: project, project: trialProject, touched: ['D3'], removed: [], researched: false, nodeId: 'D3', base, change: 'sharper permit question' }, state);
    expect(result).toMatchObject({ kept: true, data: true });
    expect(saved.improve.trials.at(-1)).toMatchObject({ outcome: 'kept-data', score: 0.3, detail: '+1 listings from imovirtual.com, 1 pass every hard criterion' });
    expect(saved.nodes.find((n) => n.id === 'D3')!.question).toBe('permits?');
    expect(saved.nodes.find((n) => n.id === 'D3')!.finding.items.map((i: { url: string }) => i.url)).toContain('https://www.imovirtual.com/pt/anuncio/terreno-para-venda-ID1ibp8');
  });

  it('a kept-data trial resets the plateau, the stall and the rest like a kept change', () => {
    const t0 = Date.parse('2026-11-12T10:00:00Z');
    const at = (min: number) => new Date(t0 + min * 60000).toISOString();
    expect([...GAIN_OUTCOMES]).toEqual(['kept', 'kept-data']);
    const trials = [
      ...Array.from({ length: PLATEAU_TRIALS }, (_, i) => ({ nodeId: 'D1.1', outcome: 'reverted-whole', change: `try ${i}`, at: at(i) })),
      { nodeId: 'D1.1', outcome: 'kept-data', change: 'k', at: at(PLATEAU_TRIALS) },
      { nodeId: 'D1.1', outcome: 'reverted-whole', change: 'after', at: at(PLATEAU_TRIALS + 1) },
    ];
    expect(plateauCheck(trials).plateaued).toBe(false);
    expect(plateauCheck(trials).trialsSinceKept).toBe(1);
    const project = { improve: { startedAt: at(0), trials }, acceptanceResult: { checks: [] } };
    const stall = stallCheck(project, t0 + (PLATEAU_TRIALS + 30) * 60000);
    expect(stall.stalled).toBe(false);
    expect(stall.trialsSinceKept).toBe(1);
    const rest = [...Array.from({ length: REST_AFTER_FUTILE }, (_, i) => ({ nodeId: 'D1.1', outcome: 'reverted-whole', at: at(100 + i) })), { nodeId: 'D1.1', outcome: 'kept-data', at: at(200) }, ...Array.from({ length: REST_AFTER_FUTILE - 1 }, (_, i) => ({ nodeId: 'D1.1', outcome: 'reverted-whole', at: at(300 + i) }))];
    expect([...restingPieces(rest, t0 + 400 * 60000)]).toEqual([]);
  });
});

describe('a weak piece is retried with different queries', () => {
  const t0 = Date.parse('2026-11-12T10:00:00Z');
  const at = (min: number) => new Date(t0 + min * 60000).toISOString();

  it('records the queries a trial used and refuses the same queries again', () => {
    const trials = [
      { nodeId: 'D8.3.b', outcome: 'no-gain', queries: ['arsa satılık Muğla', 'tarla satılık denize yakın'], at: at(0) },
      { nodeId: 'D8.3.b', outcome: 'reverted-whole', queries: ['arsa satılık Muğla'], at: at(1) },
      { nodeId: 'D9.1', outcome: 'no-gain', queries: ['đất nền Bình Thuận'], at: at(2) },
    ];
    expect(usedQueries(trials, 'D8.3.b')).toEqual(['arsa satılık Muğla', 'tarla satılık denize yakın']);
    expect(sameQueriesAgain({ searchQueries: ['arsa satılık Muğla', 'tarla satılık denize yakın'] }, { searchQueries: ['arsa satılık Muğla'] }, trials, 'D8.3.b')).toBe(true);
    expect(sameQueriesAgain({ searchQueries: ['arsa satılık Muğla', 'sahibinden satılık arsa Aydın'] }, { searchQueries: ['arsa satılık Muğla'] }, trials, 'D8.3.b')).toBe(false);
    expect(sameQueriesAgain({ searchQueries: ['arsa satılık Muğla'], sourceUrls: ['https://www.hepsiemlak.com/arsa/Mugla'] }, { searchQueries: ['arsa satılık Muğla'], sourceUrls: [] }, trials, 'D8.3.b')).toBe(false);
    expect(sameQueriesAgain({ change: 'reword only' }, { searchQueries: [] }, trials, 'D8.3.b')).toBe(false);
  });

  it('refuses a retry with the same queries on the same piece without researching it again', async () => {
    const project = { id: 'p', question: 'q', nodes: [...tree().nodes, blankNode({ id: 'D3', parentId: 'Q', question: 'permits?', status: 'weak', searchQueries: ['permit tents Brno'] })], improve: { trials: [{ nodeId: 'D3', outcome: 'no-gain', change: 'first try', queries: ['permit tents Brno'], at: at(0) }] } };
    let runs = 0;
    let saved = structuredClone(project);
    const engine = { load: async () => structuredClone(saved), store: { save: async (p: typeof project) => { saved = p; } }, emit: () => {}, run: async () => { runs += 1; }, researchLeaf: async () => { runs += 1; }, resetWithAncestors: () => {} };
    const improver = new ProjectImprover({ engine: engine as never });
    improver.propose = async () => ({ change: 'retry with the same queries', searchQueries: ['permit tents Brno'], type: 'sub-question|lookup|fact' });
    const state = { best: { score: 0.3 }, deadline: Date.now() + 60000, lock: { run: (f: () => unknown) => f() } };
    expect(await improver.trial('p', 'D3', state)).toEqual({ kept: false });
    expect(runs).toBe(0);
    expect(saved.improve.trials.at(-1)).toMatchObject({ outcome: 'repeat', queries: ['permit tents Brno'] });
    expect(saved.improve.trials.at(-1).detail).toMatch(/the same queries were already used on D3 \(permit tents Brno\); different sources or queries are required/);
  });
});
