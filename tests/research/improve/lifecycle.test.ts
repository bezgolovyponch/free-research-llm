import { describe, expect, it } from 'vitest';
import { ProjectImprover } from '../../../src/research/improve.mjs';
import { blankNode } from '../../../src/research/tree.mjs';
import { crashedLoop } from '../../../src/watchdog.mjs';

const QUESTION = 'Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren, Monclair, North face, Barbour with highest price/value ratio , proven good quality, assortiment for the appropriate retail second hand shop business in Czech Republic';

function suppliers(improve: Record<string, unknown> = { trials: [] }) {
  return {
    id: 'find-the-wholesale-branded-secon-b2f5b7',
    question: QUESTION,
    phase: 'done',
    improve,
    nodes: [
      blankNode({ id: 'D1', parentId: 'Q', title: 'Identify candidates', question: 'Which wholesale providers sell branded second‑hand apparel in or to Czech Republic?', status: 'weak' }),
      blankNode({ id: 'D2', parentId: 'Q', title: 'Price/value screening', question: 'Do suppliers offer favorable price versus retail for target brands?', status: 'weak' }),
      blankNode({ id: 'D2.1', parentId: 'D2', title: 'Price vs retail', question: 'Calculate average wholesale price per item vs retail for each brand', status: 'weak' }),
      blankNode({ id: 'D2.2', parentId: 'D2', title: 'Published price lists', question: 'Do suppliers publicly list prices for target brands?', status: 'weak' }),
      blankNode({ id: 'D4', parentId: 'Q', title: 'Assortment breadth', question: 'Do suppliers stock the four target brands with sufficient SKUs?', status: 'supported' }),
      blankNode({ id: 'D4.1', parentId: 'D4', title: 'Brand presence', question: 'Confirm presence of Ralph Lauren, Moncler, North Face, Barbour in catalog', status: 'verified' }),
      blankNode({ id: 'D4.2', parentId: 'D4', title: 'SKU quantity', question: 'Count distinct SKUs for each target brand per supplier', status: 'supported' }),
    ],
  };
}

function loopEngine(project: ReturnType<typeof suppliers>) {
  const box = { saved: structuredClone(project), saves: 0, stops: [] as Array<{ reason: string; resume?: Record<string, unknown> }> };
  const engine = {
    quiet: new Set<string>(),
    running: new Set<string>(),
    siteWarm: new Map(),
    load: async () => structuredClone(box.saved),
    store: { cache: new Map(), save: async (p: typeof project) => { box.saved = structuredClone(p); box.saves += 1; return p; } },
    emit: () => {},
    rejoinTeam: () => {},
    leave: () => {},
    cancel: () => {},
    join: () => ({ ok: true }),
    lanesFor: () => 1,
    regroundAndRescore: async () => structuredClone(box.saved),
    run: async () => structuredClone(box.saved),
    onStop: async (_p: unknown, options: { reason: string; resume?: Record<string, unknown> }) => { box.stops.push(options); },
  };
  return { engine, box };
}

async function until(done: () => boolean) {
  for (let i = 0; i < 500 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe('second measurement of a trial (LEARNING-1, row D2)', () => {
  it('the re-measure researches the changed piece again, so the noise sample is a real second measurement', async () => {
    const change = 'Replace the blocked Google-search lookups with direct reads of the public per-brand category pages on consumer resale/outlet platforms (Vinted, eBay, Zalando Lounge, About You, Remix, Sellpy) whose brand-filtered URLs verbatim name Ralph La';
    const project = suppliers({ trials: [], remeasureNoise: [0, 0, 0, 0, 0] });
    const { engine, box } = loopEngine(project);
    const runs: Array<{ pieces?: string[]; reuse?: boolean; memo?: boolean; pages?: unknown; statusAtStart: string }> = [];
    Object.assign(engine, {
      resetWithAncestors: (p: typeof project, id: string) => { p.nodes.find((n) => n.id === id)!.status = 'pending'; },
      run: async (_id: string, options: { pieces?: string[]; reuse?: boolean; memo?: boolean; pages?: unknown }) => {
        const node = box.saved.nodes.find((n) => n.id === 'D2.1')!;
        runs.push({ ...options, statusAtStart: node.status });
        node.status = 'weak';
        node.sources = [{ url: 'https://www.dimanoinmano.it/en/cc94/clothing-house-linens?in_occasione=true' }] as never;
        return { ...structuredClone(box.saved), phase: 'done' };
      },
      remeasure: async () => structuredClone(box.saved),
      resynthesize: async () => {},
    });
    const scores = [0.597, 0.561];
    const state = { best: { score: 0.592 }, deadline: Date.now() + 3600000, lock: { run: (f: () => unknown) => f() }, measure: () => ({ score: scores.shift() }) };
    const improver = new ProjectImprover({ engine: engine as never });
    const trialProject = structuredClone(project);
    trialProject.nodes.find((n) => n.id === 'D2.1')!.sourceUrls = ['https://www.dimanoinmano.it/en/cc94/clothing-house-linens?in_occasione=true'] as never;
    const base = { at: '2026-11-04T08:55:00.485Z', nodeId: 'D2.1', before: 0.592 };
    expect(await improver.commit(project.id, { snapshot: project, project: trialProject, touched: ['D2.1'], removed: [], researched: false, nodeId: 'D2.1', base, change }, state as never)).toEqual({ kept: false });
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => [r.pieces, r.reuse, r.memo, r.statusAtStart])).toEqual([[['D2.1'], true, false, 'pending'], [['D2.1'], true, false, 'pending']]);
    expect(runs[0].pages).toBeInstanceOf(Map);
    expect(runs[1].pages).toBeUndefined();
    expect(box.saved.improve.remeasureNoise).toEqual([0, 0, 0, 0, 0, -0.036]);
    expect((box.saved.improve.trials as Array<Record<string, unknown>>).at(-1)).toMatchObject({ outcome: 'reverted-noise', score: 0.561, detail: expect.stringMatching(/^measured 0\.597, re-measured 0\.561 after researching the same pieces again; /) });
  });

  it('does not blame the change, or record a noise sample, when the second research hits a provider outage', async () => {
    const project = suppliers({ trials: [], remeasureNoise: [0, 0, 0, 0, 0] });
    const { engine, box } = loopEngine(project);
    let calls = 0;
    Object.assign(engine, {
      resetWithAncestors: (p: typeof project, id: string) => { p.nodes.find((n) => n.id === id)!.status = 'pending'; },
      run: async () => {
        calls += 1;
        const node = box.saved.nodes.find((n) => n.id === 'D2.1')!;
        node.sources = [{ url: 'https://www.dimanoinmano.it/en/cc94/clothing-house-linens?in_occasione=true' }] as never;
        node.status = calls === 1 ? 'weak' : 'failed';
        (node as { error?: string }).error = calls === 1 ? undefined : 'every provider failed for rollup: fcc unreachable: timed out || pollinations unreachable: timed out || openrouter unreachable: timed out';
        return { ...structuredClone(box.saved), phase: 'done' };
      },
      resynthesize: async () => {},
    });
    const state = { best: { score: 0.592 }, deadline: Date.now() + 3600000, lock: { run: (f: () => unknown) => f() }, measure: () => ({ score: 0.597 }) };
    const sleeps: number[] = [];
    const improver = new ProjectImprover({ engine: engine as never, sleep: async (ms: number) => { sleeps.push(ms); } });
    const base = { at: '2026-11-04T11:49:56.150Z', nodeId: 'D2.1', before: 0.592 };
    expect(await improver.commit(project.id, { snapshot: project, project: structuredClone(project), touched: ['D2.1'], removed: [], researched: false, nodeId: 'D2.1', base, change: 'direct reads of per-brand catalog pages' }, state as never)).toEqual({ kept: false });
    expect(calls).toBe(2);
    expect((box.saved.improve.trials as Array<Record<string, unknown>>).at(-1)).toMatchObject({ outcome: 'provider-outage' });
    expect(box.saved.improve.remeasureNoise).toEqual([0, 0, 0, 0, 0]);
    expect(sleeps).toHaveLength(1);
  });
});

describe('loop lifecycle', () => {
  it('a stopped loop is not resumed after shutdown (LEARNING-7, row D8)', async () => {
    const { engine, box } = loopEngine(suppliers());
    const improver = new ProjectImprover({ engine: engine as never, sleep: async () => {} });
    let release = () => {};
    let inPass = false;
    improver.pass = async () => {
      inPass = true;
      await new Promise<void>((r) => { release = r; });
      return false;
    };
    const id = box.saved.id;
    improver.start(id, { hours: 8 });
    await until(() => inPass);
    expect(improver.stop(id)).toEqual({ ok: true });
    await improver.shutdown();
    expect(box.stops.at(-1)!.reason).toBe('loop stopped by user');
    expect(box.stops.at(-1)!.resume?.loopHoursLeft).toBeUndefined();
    release();
    await until(() => !improver.isActive(id));
    await new Promise((r) => setTimeout(r, 20));
    expect(box.stops.some((s) => Number(s.resume?.loopHoursLeft) > 0)).toBe(false);
    expect(box.saved.improve).toMatchObject({ active: false });
  });

  it('still saves the hours left for a loop that was running when the app stopped', async () => {
    const { engine, box } = loopEngine(suppliers());
    const improver = new ProjectImprover({ engine: engine as never, sleep: async () => {} });
    let release = () => {};
    let inPass = false;
    improver.pass = async () => {
      inPass = true;
      await new Promise<void>((r) => { release = r; });
      return false;
    };
    improver.start(box.saved.id, { hours: 8 });
    await until(() => inPass);
    await improver.shutdown();
    expect(box.stops.at(-1)).toMatchObject({ reason: 'app stopped', resume: { loopScope: [], loopExclude: [] } });
    expect(Number(box.stops.at(-1)!.resume?.loopHoursLeft)).toBeGreaterThan(7.9);
    release();
    await until(() => !improver.isActive(box.saved.id));
  });

  it('a crash after an earlier user stop is revived: a new loop clears the old stop reason and end time (LEARNING-8, UI-3)', async () => {
    const earlier = { trials: [], active: false, startedAt: '2026-11-03T13:28:11.000Z', deadline: '2026-11-04T11:14:19.686Z', finishedAt: '2026-11-04T00:12:50.617Z', stopReason: 'stopped by user', error: null, baseline: 0.71, best: 0.71 };
    const { engine, box } = loopEngine(suppliers(earlier));
    const startedAt = Date.parse('2026-11-04T00:17:26.392Z');
    const improver = new ProjectImprover({ engine: engine as never, now: () => startedAt, sleep: async () => {} });
    let running: Record<string, unknown> = {};
    improver.pass = async () => {
      running = structuredClone(box.saved.improve);
      throw new TypeError("Cannot read properties of undefined (reading 'status')");
    };
    const id = box.saved.id;
    improver.start(id, { hours: 10.9481375 });
    await until(() => !improver.isActive(id));
    await new Promise((r) => setTimeout(r, 20));
    expect(running).toMatchObject({ active: true, startedAt: '2026-11-04T00:17:26.392Z', stopReason: null, finishedAt: null });
    expect(box.saved.improve).toMatchObject({ active: false, error: "Cannot read properties of undefined (reading 'status')", stopReason: null });
    expect(crashedLoop(box.saved.improve as never, startedAt + 3600000)).toMatchObject({ hoursLeft: expect.closeTo(9.948, 2), scope: [], exclude: [] });
  });

  it('a loop with no target ends at once instead of saving the research until the deadline (LEARNING-12)', async () => {
    const { engine, box } = loopEngine(suppliers());
    let clock = Date.parse('2026-11-04T00:49:31.307Z');
    const improver = new ProjectImprover({ engine: engine as never, now: () => (clock += 5), sleep: async () => {} });
    let passes = 0;
    const pass = improver.pass.bind(improver);
    improver.pass = async (...args: unknown[]) => {
      passes += 1;
      return (pass as (...a: unknown[]) => Promise<boolean>)(...args);
    };
    const id = box.saved.id;
    improver.start(id, { hours: 0.05, nodes: ['D4.1'], exclude: ['Q', 'D1', 'D2', 'D4', 'D4.2'] });
    await until(() => !improver.isActive(id));
    await new Promise((r) => setTimeout(r, 20));
    expect(box.saved.improve).toMatchObject({ active: false, stopReason: 'nothing left to improve in the selection', scope: ['D4.1'] });
    expect(passes).toBe(0);
    expect((box.saved.improve.trials as unknown[]).length).toBe(0);
    expect(box.saves).toBeLessThan(12);
  });
});
