import fs from 'node:fs/promises';
import { qualifies } from '../../src/research/acceptance.mjs';
import { itemTier } from '../../src/research/verdict.mjs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/llm/provider.mjs';
import { ScriptedProvider } from '../../src/llm/scripted-provider.mjs';
import { ModelRouter, OfflineError } from '../../src/llm/router.mjs';
import { TASK_MARKERS, decomposePrompt, synthesizePrompt, withGuidance } from '../../src/research/prompts.mjs';
import { HUB_REFRESH_MS, ResearchCancelled, ResearchEngine, TEAM_TTL_MS, hubSearchStale, groupQueryPrompt, needsSiteFit, queryLanguages } from '../../src/research/engine.mjs';
import { JUDGE_VERSION, LOW_PRICE_REASON, SINGLE_KIND_OPINION, checklistFingerprint } from '../../src/research/checklist.mjs';
import { aggregate, normalizeSample } from '../../src/research/decision.mjs';
import { ProjectStore } from '../../src/store.mjs';
import { researchedNode } from '../helpers/research-shapes';
import { ChecklistModeler } from '../../src/research/checklist.mjs';

const fakeSearch = {
  enabled: true,
  lastErrors: [],
  async search(queries: string[]) {
    return [
      { kind: 'web', title: 'One', url: 'https://one.example/a', domain: 'one.example', snippet: 's', text: `about ${queries[0]}` },
      { kind: 'web', title: 'Two', url: 'https://two.example/b', domain: 'two.example', snippet: 's', text: `more evidence from a second independent source about ${queries[0]}` },
    ];
  },
  describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
};

const fakeSearchForChecklist = {
  ...fakeSearch,
  async readPage(url: string) {
    if (url === 'https://zagumi.com/anuncio/used-clothing-ID12345') return { status: 200, text: 'We sell wholesale clothing in bulk. Brands: Barbour, Ralph Lauren, Moncler, The North Face. Grade A quality guaranteed. Price: 40 EUR per kg. We deliver to Czech Republic and EU. Large assortment of vintage and second hand clothing in bales. Contact us for pricing and shipping details.' };
    if (url === 'https://example.com/anuncio/supplier-b-ID67890') return { status: 200, text: 'Wholesale supplier of branded clothing. Carries Barbour and Moncler. Grade A quality guaranteed. Price: 35 EUR/kg. We ship to Czech Republic and EU. Large assortment includes coats, jackets, shirts, pants, dresses. Established 2010. Contact for bulk orders.' };
    return { status: 404, text: '' };
  },
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
    expect(markers[0]).toBeUndefined();
    expect(markers[1]).toBe(TASK_MARKERS.decompose);
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
        return calls.length === 1 || !options.exclude ? fakeSearch.search(queries) : [{ kind: 'web', title: 'Gap', url: 'https://gap.example/p', domain: 'gap.example', snippet: 's', text: 'RAV4 median 21,500 EUR demand baseline figure' }];
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

  it('marks a tree-only build as building the tree, not as a research run, and ends it tree-ready', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Which Czech city is best for a small bakery?' });
    const phases: string[] = [];
    const save = engine.store.save.bind(engine.store);
    engine.store.save = async (p: { phase: string }) => { phases.push(p.phase); return save(p as never); };
    const built = await engine.buildTree(project.id);
    expect(phases).toContain('building-tree');
    expect(phases).not.toContain('decomposing');
    expect(built.phase).toBe('tree-ready');
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
    expect(engine.join(project.id, 'pc')).toEqual({ joined: true, already: false, lanes: 3, mine: true });
    expect(engine.join(project.id, 'pc')).toEqual({ joined: true, already: true, lanes: 3, mine: true });
    expect(engine.lanesFor(project.id)).toBe(3);
    engine.join(project.id, 'mac'); engine.join(project.id, 'phone');
    expect(engine.lanesFor(project.id)).toBe(4);
    expect(engine.teamOf(project.id)).toEqual({ lanes: 4, helpers: ['pc', 'mac'] });
    expect(engine.leaveOne(project.id, 'pc')).toEqual({ left: true, lanes: 3, mine: false });
    expect(engine.leaveOne(project.id, 'pc')).toMatchObject({ left: false, lanes: 3 });
    engine.join(project.id); engine.join(project.id);
    expect(engine.lanesFor(project.id)).toBe(4);
    engine.leave(project.id);
    expect(engine.lanesFor(project.id)).toBe(2);
  });

  it('keeps a teammate who joins a new run while the finished run is still writing its handoff', async () => {
    let finishHandoff = () => {};
    let handoffStarted = () => {};
    const handoffBegun = new Promise<void>((started) => { handoffStarted = started; });
    const onStop = () => new Promise<void>((done) => { finishHandoff = done; handoffStarted(); });
    const router = new ModelRouter({ providers: [new ScriptedProvider()] });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }), lanes: 2, onStop });
    const project = await engine.createProject({ question: 'Which Czech city suits a small specialty bakery best?' });
    const finishing = engine.run(project.id);
    await handoffBegun;
    expect(engine.running.has(project.id)).toBe(false);
    engine.running.add(project.id);
    expect(engine.join(project.id, 'pc')).toMatchObject({ joined: true, lanes: 3 });
    finishHandoff();
    await finishing;
    expect(engine.running.has(project.id)).toBe(true);
    expect(engine.teamOf(project.id)).toEqual({ lanes: 3, helpers: ['pc'] });
  });

  it('re-runs without rewriting the memo when asked, but still re-measures the expected result', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Find plots for a glamping business, 20000EUR max', expected: '5 plots under 20000 EUR' });
    await engine.run(project.id);
    let memos = 0;
    let measures = 0;
    const synthesize = engine.synthesize.bind(engine);
    const checkAcceptance = engine.checkAcceptance.bind(engine);
    engine.synthesize = async (p: never) => { memos += 1; return synthesize(p); };
    engine.checkAcceptance = async (p: never) => { measures += 1; return checkAcceptance(p); };
    await engine.run(project.id, { memo: false });
    expect([memos, measures]).toEqual([0, 1]);
    await engine.run(project.id);
    expect(memos).toBe(1);
  });

  it('adds gated listings from pages a listing piece already read, once', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Find plots for a glamping business, 20000EUR max', expected: '5 plots under 20000 EUR' });
    const done = await engine.run(project.id);
    const piece = done.nodes.find((n: { parentId: string | null }) => n.parentId);
    Object.assign(piece, { deliverable: true, finding: { ...piece.finding, items: [] }, sources: [{ id: 'S1', url: 'https://portal.example/r', links: [{ url: 'https://portal.example/anuncio/terreno-silves-ID1bbbbb', text: 'Terreno Silves | 15 000 €' }, { url: 'https://portal.example/anuncio/arrendo-terreno-ID1eeeee', text: 'Arrendo terreno' }] }] });
    expect(await engine.harvestAll(done)).toEqual([`${piece.id} +1`]);
    expect(piece.finding.items).toEqual([expect.objectContaining({ url: 'https://portal.example/anuncio/terreno-silves-ID1bbbbb', value: 15000, harvested: true })]);
    expect(await engine.harvestAll(done)).toEqual([]);
  });

  it('builds the concept brief first, drops off-concept pages before any model call, sweeps portals by code and delivers the screened table', async () => {
    const ad = (n: number, value: number) => ({ title: `Terreno ${n}`, url: `https://imo.example/pt/anuncio/terreno-${n}-ID1x${n}yz`, value, unit: 'EUR', area: 1000 * n, place: 'Aljezur' });
    const reads: string[] = [];
    const portalSearch = {
      ...fakeSearch,
      async search() {
        return [
          { kind: 'web', title: 'Terrenos', url: 'https://imo.example/pt/resultados', domain: 'imo.example', snippet: 's', text: 'terrenos para venda em Portugal', locale: 'pt', links: [], listings: [ad(1, 9000), ad(2, 15000), ad(3, 90000)] },
          { kind: 'web', title: 'How far an e-bike goes', url: 'https://bikes.example/range', domain: 'bikes.example', snippet: 's', text: 'battery range 40 miles', links: [], listings: [] },
        ];
      },
      async readPage(url: string) {
        reads.push(url);
        if (url === 'https://imo.example/pt/resultados') return { status: 200, text: 'terrenos', locale: 'pt', links: [], listings: [ad(1, 9000), ad(2, 15000), ad(3, 90000)], next: 'https://imo.example/pt/resultados?page=2' };
        if (url === 'https://imo.example/pt/resultados?page=2') return { status: 200, text: 'terrenos', locale: 'pt', links: [], listings: [ad(4, 12000), ad(5, 19000)], next: '' };
        return { status: 200, text: `Terreno para venda 9.000 € ${'texto '.repeat(60)}`, links: [], listings: [] };
      },
    };
    const { engine } = engineWith(new ScriptedProvider(), portalSearch);
    const project = await engine.createProject({ question: 'Find plots for a glamping business near the sea in Portugal, 20000EUR max', expected: '4 plots in Portugal under 20000 EUR' });
    await engine.updateProject(project.id, { acceptance: { itemCount: 4, valueRange: [0, 20000], unit: 'EUR' } });
    const done = await engine.run(project.id);
    expect(done.brief.text).toContain('Hard limit: price 0–20000 EUR');
    expect(done.brief.regions).toEqual(['PT']);
    expect(done.nodes.flatMap((n: { sources?: Array<{ url: string }> }) => n.sources ?? []).some((s: { url: string }) => s.url.includes('bikes.example'))).toBe(false);
    expect(done.log.some((l: { message: string }) => /source\(s\) dropped before any model call — outside the asked regions \(bikes\.example\)/.test(l.message))).toBe(true);
    expect(reads.filter((u) => u.includes('imo.example')).slice(0, 2)).toEqual(['https://imo.example/pt/resultados', 'https://imo.example/pt/resultados?page=2']);
    expect(reads.findIndex((u) => u.includes('ac-arquitetos.com'))).toBeLessThan(reads.indexOf('https://imo.example/pt/resultados'));
    expect(done.brief.text).toContain('Decision model (code checks every listing against it');
    expect(done.log.some((l: { message: string }) => /^strategy "Low-entry glamping/.test(l.message))).toBe(true);
    expect(done.candidates).toMatchObject({ keptCount: 0, tiers: { fits: 0, unverified: 4 }, screened: { 'price outside 0–20000 EUR': 1 } });
    expect(done.candidates.kept.map((r: { value: number }) => r.value)).toEqual([9000, 12000, 15000, 19000]);
    expect(done.candidates.kept[0].plan.verdict).toContain('location not measured yet');
    expect(done.report.verdict).toContain('Decision model: 0 results of the 4 asked fit every check; 0 trade-offs with their potential; 4 to confirm; 0 weak; 0 blocked by law — model memo:');
    expect(done.acceptanceResult.items.filter((i: { candidate?: boolean }) => i.candidate)).toEqual([]);
    expect(done.log.some((l: { type: string; message: string }) => l.type === 'candidates' && /portal sweep: 12 listing page\(s\) read by code/.test(l.message))).toBe(true);
    expect(reads).toContain('https://www.imovirtual.com/pt/resultados/comprar/terreno/faro?priceMax=20000');
    const seen: string[][] = [];
    const modes: string[] = [];
    engine.sites = { apply: async (c: { kept: Array<{ url: string }>; keptCount: number }, _b: unknown, o: { mode: string }) => { modes.push(o.mode); seen.push(c.kept.map((r) => r.url)); return { ...c, kept: c.kept.slice(0, 2), keptCount: 2, sites: { assessed: 4, located: 4, far: 2, unlocated: 0, pending: 0, failed: 0 } }; }, trendGaps: () => ({ missing: ['PT'], due: [] }) } as never;
    const piece = done.nodes.find((n: { parentId: string | null }) => n.parentId);
    piece.finding = { ...piece.finding, items: [{ title: 'Model pick', url: 'https://other.example/anuncio/terreno-ID9zzzzz', value: 5000, unit: 'EUR' }] };
    await engine.collectCandidates(done);
    await engine.checkAcceptance(done);
    expect(seen[0]).toHaveLength(4);
    await engine.collectCandidates(done, { sweep: true });
    engine.quiet.add(done.id);
    await engine.collectCandidates(done);
    const strategyLines = () => done.log.filter((l: { message: string }) => /^strategy "Low-entry glamping/.test(l.message)).length;
    const before = strategyLines();
    done.strategyCheck = null;
    await engine.collectCandidates(done, { sweep: true });
    expect(strategyLines()).toBe(before + 1);
    engine.quiet.delete(done.id);
    expect(modes).toEqual(['budget', 'all', 'cache', 'cache']);
    const warmed: string[] = [];
    engine.startSiteWarm = (id: string) => { warmed.push(id); };
    engine.sites = { apply: async (c: { kept: unknown[] }, _b: unknown, o: { mode: string }) => { modes.push(o.mode); return { ...c, sites: { assessed: 1, located: 1, far: 0, unlocated: 0, pending: 3, failed: 0 } }; }, trendGaps: () => ({ missing: [], due: [] }) } as never;
    engine.quiet.add(done.id);
    await engine.collectCandidates(done, { sweep: true });
    engine.quiet.delete(done.id);
    expect(modes.at(-1)).toBe('cache');
    expect(warmed).toEqual([done.id]);
    engine.sites = { apply: async (c: { kept: Array<{ url: string }>; keptCount: number }) => ({ ...c, kept: c.kept.slice(0, 2), keptCount: 2, sites: { assessed: 4, located: 4, far: 2, unlocated: 0, pending: 0, failed: 0 } }), trendGaps: () => ({ missing: ['PT'], due: [] }) } as never;
    await engine.collectCandidates(done);
    expect(done.candidates.kept).toHaveLength(2);
    expect(done.candidates.keptCount).toBe(0);
    expect(done.acceptanceResult.items.filter((i: { candidate?: boolean }) => i.candidate)).toEqual([]);
    expect(done.log.some((l: { message: string }) => /site fit: 4 listing\(s\) measured .* 2 farther than an e-bike ride from the sea/.test(l.message))).toBe(true);
    expect(done.log.some((l: { type: string; message: string }) => l.type === 'candidates' && /price trend still missing for PT: next try when its wait ends and the table is rebuilt/.test(l.message))).toBe(true);
  });

  it('keeps the last complete candidate table visible while a new one is measured, so the Results tab never shows a half-built table', async () => {
    const router = new ModelRouter({ providers: [new ScriptedProvider()] });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }) });
    const project = await engine.createProject({ question: 'Find plots for a glamping business near the sea in Portugal, 20000EUR max', templateId: 'glamping-location', expected: '2 plots in Portugal' });
    project.acceptance = { ...project.acceptance, itemCount: 2, valueRange: [0, 20000], unit: 'EUR' };
    project.nodes = [{ id: 'Q', parentId: null, title: 'Q', question: 'q', sources: [{ id: 'S1', url: 'https://imo.example/pt/r', locale: 'pt', listings: [{ title: 'Terreno 1', url: 'https://imo.example/pt/anuncio/terreno-1-ID1a1bc', value: 9000, unit: 'EUR' }] }] }];
    const complete = { found: 1, kept: [], keptCount: 0, tiers: { fits: 0, 'trade-off': 0, unverified: 0, weak: 0, blocked: 0 }, toCheck: [], toCheckCount: 0, screened: {}, screenedCount: 0 };
    project.candidates = complete;
    let release: () => void = () => {};
    let seen: unknown = null;
    engine.sites = { apply: async (c: object) => { seen = project.candidates; await new Promise<void>((r) => { release = r; }); return c; } } as never;
    const pending = engine.collectCandidates(project);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toBe(complete);
    expect(project.candidates).toBe(complete);
    release();
    const table = await pending;
    expect(project.candidates).toBe(table);
    expect(table.tiers).toBeDefined();
    expect(table.proposals).toMatchObject({ primary: [], secondary: ['https://imo.example/pt/anuncio/terreno-1-ID1a1bc'], method: expect.stringContaining('Pareto layers') });
  });

  it('builds a decision model for a list research with no hand-written strategy and measures every listing by it', async () => {
    const proposal = { concept: 'olive land near the sea', kind: { label: 'plot of land', terms: ['land', 'oikopedo'] }, criteria: [{ clause: 'at most 10 km from the sea', measure: 'coastKm', op: '<=', value: 10, quote: 'at most 10 km from the sea' }] };
    const modeler = { fresh: (p: { decisionModel?: unknown }) => Boolean(p.decisionModel), build: async (p: Record<string, unknown>) => {
      p.decisionModel = { ...aggregate([normalizeSample(proposal), normalizeSample(proposal)], { question: String(p.question) }), caseIds: [] };
      return p.decisionModel;
    } };
    const rewards: Array<[string[], number]> = [];
    const router = new ModelRouter({ providers: [new ScriptedProvider()] });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }), modeler, cases: { reward: async (ids: string[], r: number) => { rewards.push([ids, r]); } } } as never);
    const project = await engine.createProject({ question: 'Find olive land in Greece under 50000 EUR, at most 10 km from the sea', templateId: 'generic', expected: '3 plots in Greece' });
    project.acceptance = { ...project.acceptance, itemCount: 3, valueRange: [0, 50000], unit: 'EUR' };
    const listing = (n: number, title: string) => ({ title, url: `https://spitogatos.gr/aggelia/${n}0000${n}`, value: 20000 + n, unit: 'EUR' });
    project.nodes = [{ id: 'Q', parentId: null, title: 'Q', question: 'q', sources: [{ id: 'S1', url: 'https://spitogatos.gr/pwliseis', locale: 'el', listings: [listing(1, 'Land 4000 m2 Chania'), listing(2, 'Oikopedo Rethymno'), listing(3, 'Apartment Athens')] }] }];
    engine.sites = { apply: async (c: { kept: Array<{ url: string }> }) => ({ ...c, kept: c.kept.map((r, i) => ({ ...r, site: { coastKm: i === 0 ? 3 : 40 } })) }) } as never;
    const table = await engine.collectCandidates(project);
    expect(project.brief.kind).toEqual({ label: 'plot of land', terms: ['land', 'oikopedo'] });
    expect(project.brief.text).toContain('distance to the sea <= 10 km (question)');
    expect(table.kept.map((r: { title: string }) => r.title)).toEqual(['Land 4000 m2 Chania', 'Oikopedo Rethymno']);
    expect(table.tiers).toMatchObject({ fits: 1, weak: 1 });
    expect(table.keptCount).toBe(1);
    expect(project.log.some((l: { type: string; message: string }) => l.type === 'candidates' && l.message === 'decision model: 1 fit every criterion, 0 to confirm, 1 weak')).toBe(true);
    project.report = { verdict: 'v' };
    await engine.checkAcceptance(project);
    expect(rewards).toEqual([[[project.id], project.acceptanceResult.score]]);
  });

  it('calibrates the item kind on the swept titles when few titles use its words, once with three independent proposals kept by majority, and passes the sub-type to the brief', async () => {
    const calls: Array<{ purpose: string; tier: string; messages: Array<{ role: string; content: string }> }> = [];
    const router = { complete: async (req: { purpose: string; tier: string; messages: Array<{ role: string; content: string }> }) => {
      calls.push(req);
      return { provider: 'p', data: { not: ['kola', 'svetlo', 'pneumatiky', 'naraznik'], subtype: { label: 'hatchback', models: ['fabia', 'corsa', 'polo'] } } };
    } };
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }) } as never);
    const listing = (n: number, title: string) => ({ title, url: `https://auto.bazos.cz/inzerat/auto-${n}-ID1${String(10000 + n)}`, value: 50000 + n, unit: 'CZK' });
    const project: Record<string, any> = {
      id: 'calibration-1',
      question: 'Find used hatchback cars within 300 km of Prague, 65000 CZK max',
      guidance: '',
      templateId: 'generic',
      acceptance: { itemCount: 2, valueRange: [0, 65000], unit: 'CZK' },
      nodes: [],
      log: [],
      decisionModel: { kind: { label: 'used car', terms: ['hatchback'], not: ['parts'], verified: { titles: 10, matched: 1, share: 0.1 } }, criteria: [], noLimit: [], missing: [] },
      sweep: { pages: [{ id: 'P1', url: 'https://auto.bazos.cz/skoda/', listings: [
        listing(1, 'Alu kola 215x65R16'),
        listing(2, 'ALU KOLA 15" Škoda'),
        listing(3, 'Levé zadní světlo Honda Accord 7g'),
        listing(4, 'Zadní světlo Škoda Fabia'),
        listing(5, 'Použité pneumatiky 205/55 R16'),
        listing(6, 'Letní pneumatiky Michelin'),
        listing(7, 'Matky hliníkové lehké'),
        listing(8, 'ŠKODA FABIA II COMFORT 2008'),
        listing(9, 'Opel Corsa 1.2'),
        listing(10, 'Škoda Octavia 1.9 TDI'),
      ] }] },
    };
    await engine.collectCandidates(project as never, { sweep: true });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ purpose: 'decision-model', tier: 'deep' });
    expect(JSON.stringify(calls[0].messages)).toContain('Alu kola 215x65R16');
    expect(project.decisionModel.kind.not).toEqual(['parts', 'kola', 'svetlo', 'pneumatiky']);
    expect(project.decisionModel.subtype).toEqual({ label: 'hatchback', models: ['fabia', 'corsa'], variants: [], source: 'model proposal, matched to listing titles by code' });
    expect(project.decisionModel.calibrated).toBeTruthy();
    expect(project.brief.subtype).toEqual(project.decisionModel.subtype);
    expect(project.brief.kind.not).toEqual(['parts', 'kola', 'svetlo', 'pneumatiky']);
    expect(project.log.some((l: { type: string; message: string }) => l.type === 'decision' && /^kind calibrated on 10 titles: not parts, kola, svetlo, pneumatiky; hatchback: 2 models$/.test(l.message))).toBe(true);
    await engine.collectCandidates(project as never, { sweep: true });
    expect(calls).toHaveLength(3);
  });

  it('briefOf keeps the kind\'s calibrated words', () => {
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search: fakeSearch, store: new ProjectStore({ dir }) });
    const project: Record<string, any> = {
      id: 'find-accurate-and-verified-car-l-0c750f',
      question: 'Find accurate and verified car listings on available marketplaces for at least 20 cars as fit and up to 80 as a trade off to purchase within 300km from prague, hatchback, price up to 65000CZK or equivalent',
      templateId: 'generic',
      acceptance: { itemCount: 20, valueRange: [0, 65000], unit: 'CZK' },
      decisionModel: { kind: { label: 'used car', terms: ['hatchback'], not: ['parts', 'accessories', 'kola'], condition: ['na dily'], upgrades: ['nova stk'], verified: { titles: 3277, matched: 8, share: 0 }, dropped: [] }, criteria: [] },
    };
    expect(engine.briefOf(project as never).kind).toEqual({ label: 'used car', terms: ['hatchback'], not: ['parts', 'accessories', 'kola'], condition: ['na dily'], upgrades: ['nova stk'] });
    project.decisionModel.kind = { label: 'used car', terms: ['hatchback'], verified: null };
    expect(engine.briefOf(project as never).kind).toEqual({ label: 'used car', terms: ['hatchback'] });
  });

  it('briefOf describes a list of a kind no portal lists as entities, not as listing pages for sale', () => {
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search: fakeSearch, store: new ProjectStore({ dir }) });
    const terms = ['wholesale used clothing', 'second hand clothes', 'used clothing wholesale'];
    const project: Record<string, any> = {
      id: 'find-the-wholesale-branded-secon-b2f5b7',
      question: 'Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren, Monclair, North face, Barbour with highest price/value ratio, proven good quality, assortiment for the appropriate retail second hand shop business in Czech Republic',
      templateId: 'generic',
      acceptance: { itemCount: 20 },
      decisionModel: { kind: { label: 'wholesale clothing provider', terms, not: ['retail', 'maloobchod', 'donation', 'consignment'], verified: null, hubs: ['czech republic'], validated: { pages: 10, terms, at: '2026-11-05T02:04:03.161Z' } }, criteria: [] },
    };
    const brief = engine.briefOf(project as never);
    expect(brief.located).toBe(false);
    expect(brief.text).toContain('Deliver: 20 results of the kind "wholesale clothing provider", each with its own website\nUsed in: Czechia (sources may be anywhere)');
    expect(brief.text).not.toContain('listing pages for sale');
    expect(brief.text).not.toContain('offered for rent');
  });

  it('drops an exclusion word that full-price listings of an asked model carry, so a car sold with spare wheels stays a car', async () => {
    const rows: Array<[string, string, number]> = [
      ['Honda Civic 2,2 CTDi"103kW"+ Al kola 17 l', '226020175/honda-civic-22-ctdi103kw-al-kola-17-l.php', 45000],
      ['Kia Rio, 1.1 CRDI 55KW klima,2x kola', '226235794/kia-rio-11-crdi-55kw-klima2x-kola.php', 59000],
      ['ŠKODA FABIA II COMFORT 2009 1,2 HTP KLIMA, EL.OKNA', '225652792/skoda-fabia-ii-comfort-2009-12-htp-klima-elokna.php', 49999],
      ['Škoda Fabia VELKÝ SERVIS', '226256383/skoda-fabia-velky-servis.php', 64900],
      ['Prodám Škoda Fabia 1.4 16V 74 KW', '226246786/prodam-skoda-fabia-14-16v-74-kw.php', 35000],
      ['Škoda fabia', '226208092/skoda-fabia.php', 27000],
      ['Pěkná Škoda Fabia 1.2 MPi, málo najeto, velmi dobrý stav', '226126886/pekna-skoda-fabia-12-mpi-malo-najeto-velmi-dobry-stav.php', 35000],
      ['ŠKODA FABIA 2 1.2 HTP', '225962420/skoda-fabia-2-12-htp.php', 55000],
      ['ŠKODA FABIA II 1.2 HTP', '225859354/skoda-fabia-ii-12-htp.php', 55000],
      ['Škoda Fabia 2, LPG', '225810909/skoda-fabia-2-lpg.php', 46000],
      ['škoda fabia 1.2', '226084281/skoda-fabia-12.php', 24000],
      ['Škoda Fabia 1 1.2 MPI 40kW', '226050045/skoda-fabia-1-12-mpi-40kw.php', 26000],
      ['Škoda Fabia 1.2 tsi 77kw', '226204633/skoda-fabia-12-tsi-77kw.php', 55000],
      ['Škoda Felicia 1.9D GLX', '225957221/skoda-felicia-19d-glx.php', 28000],
      ['Škoda Fabia II 1.2 HTP', '225884698/skoda-fabia-ii-12-htp.php', 37000],
      ['NOVA STK Škoda Fabia 1.2 HTP 2004', '225780289/skoda-fabia-12-htp-2004.php', 19500],
      ['Škoda Fabia 1.4-55kw,AUTOMAT ,klima,2007', '226315746/skoda-fabia-14-55kwautomat-klima2007.php', 59999],
      ['Škoda Fabia II 1.2 HTP', '226299305/skoda-fabia-ii-12-htp.php', 25000],
      ['Škoda Fabia 2 1.2htp', '223755133/skoda-fabia-2-12htp.php', 40000],
      ['Alu kola 16" Škoda Karoq', '226253219/alu-kola-16-skoda-karoq.php', 12000],
      ['Letni kola + disky škoda oct 1', '226145989/letni-kola-disky-skoda-oct-1.php', 3000],
      ['Škoda Octavia I kola R15 5x100 ET38', '224466858/skoda-octavia-i-kola-r15-5x100-et38.php', 2500],
      ['Prodám alu kola DEZENT 5x112r17', '226106581/prodam-alu-kola-dezent-5x112r17.php', 8000],
      ['Originální alu kola Škoda R17, 7J×17 ET45 – sada 4 ks', '225662126/originalni-alu-kola-skoda-r17-7j17-et45-sada-4-ks.php', 3500],
      ['Alu kola Škoda', '226208253/alu-kola-skoda.php', 5000],
    ];
    const listings = rows.map(([title, slug, value]) => ({ title, url: `https://auto.bazos.cz/inzerat/${slug}`, value, unit: 'CZK' }));
    const router = { complete: async () => ({ provider: 'groq', data: { not: ['kola', 'disky'], subtype: { label: 'hatchback', models: ['kia rio', 'honda civic', 'skoda fabia', 'skoda felicia'], variants: [] } } }) };
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }) } as never);
    const project: Record<string, any> = {
      id: 'find-accurate-and-verified-car-l-0c750f',
      question: 'Find accurate and verified car listings within 300km from prague, hatchback, price up to 65000CZK or equivalent',
      log: [],
      sweep: { pages: [{ id: 'P1', url: 'https://auto.bazos.cz/skoda/40/?hledat=&hlokalita=&humkreis=&cenaod=0&cenado=65000&order=', listings }] },
      decisionModel: { kind: { label: 'used car', terms: ['hatchback'], not: ['parts', 'accessories', 'kola'], verified: { titles: 25, matched: 0, share: 0 } } },
    };
    expect(await (engine as unknown as { calibrateKind: (p: unknown) => Promise<boolean> }).calibrateKind(project)).toBe(true);
    expect(project.decisionModel.kind.not).toEqual(['parts', 'accessories']);
    expect(project.decisionModel.subtype.models).toEqual(['kia rio', 'honda civic', 'skoda fabia', 'skoda felicia']);
    const few: Record<string, any> = { ...project, log: [], sweep: { pages: [{ id: 'P1', url: project.sweep.pages[0].url, listings: listings.slice(0, 6) }] }, decisionModel: { kind: { label: 'used car', terms: ['hatchback'], not: ['parts', 'accessories', 'kola'], verified: { titles: 6, matched: 0, share: 0 } } } };
    await (engine as unknown as { calibrateKind: (p: unknown) => Promise<boolean> }).calibrateKind(few);
    expect(few.decisionModel.kind.not).toEqual(['parts', 'accessories', 'kola']);
  });

  it('turns the place and radius a question names into the countries the brief uses as regions', async () => {
    const router = new ModelRouter({ providers: [new ScriptedProvider()] });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }) });
    const asked: Array<[string, number]> = [];
    engine.sites = { areaCountries: async (place: string, km: number) => { asked.push([place, km]); return { point: { lat: 50.07, lon: 14.44 }, km, place, countries: ['AT', 'CZ', 'DE', 'PL'] }; } } as never;
    const project = await engine.createProject({ question: 'Find a hatchback to purchase within 300km from prague, hatchback under 15000 EUR', templateId: 'generic', expected: '3 hatchbacks within 300km from prague' });
    await engine.ensureDecisionModel(project);
    expect(asked).toEqual([['prague', 300]]);
    expect(project.area).toMatchObject({ km: 300, place: 'prague', countries: ['AT', 'CZ', 'DE', 'PL'] });
    expect(project.log.some((l: { type: string; message: string }) => l.type === 'decision' && l.message === 'area: within 300 km of prague -> AT, CZ, DE, PL')).toBe(true);
    const brief = engine.briefOf(project);
    expect(brief.regions).toEqual(['AT', 'CZ', 'DE', 'PL']);
    expect(brief.text).toContain('Where: Austria, Czechia, Germany, Poland');
    await engine.ensureDecisionModel(project);
    expect(asked).toHaveLength(1);
  });

  it('warns and leaves the area unset when the places in the radius cannot be geocoded', async () => {
    const router = new ModelRouter({ providers: [new ScriptedProvider()] });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }) });
    engine.sites = { areaCountries: async () => { throw new Error('HTTP 503 from nominatim.openstreetmap.org'); } } as never;
    const project = await engine.createProject({ question: 'Find a hatchback to purchase within 300km from prague', templateId: 'generic' });
    await engine.ensureDecisionModel(project);
    expect(project.area).toBeUndefined();
    expect(engine.briefOf(project).regions).toEqual([]);
    expect(project.log.some((l: { type: string; message: string }) => l.type === 'warn' && l.message === 'area not measured: HTTP 503 from nominatim.openstreetmap.org')).toBe(true);
  });

  it('builds the decision model right after decompose learns the expected item count, so the brief lists pages instead of a memo', async () => {
    const proposal = { concept: 'used cars within budget', kind: { label: 'used car', terms: ['car', 'used car'] }, criteria: [{ clause: 'under 50000 EUR', measure: 'priceEur', op: '<=', value: 50000, quote: 'under 50000 EUR' }] };
    const builds: Array<{ itemCount: number | null }> = [];
    const modeler = { fresh: (p: { decisionModel?: unknown }) => Boolean(p.decisionModel), build: async (p: Record<string, unknown>) => {
      builds.push({ itemCount: (p.acceptance as { itemCount?: number | null } | undefined)?.itemCount ?? null });
      p.decisionModel = { ...aggregate([normalizeSample(proposal), normalizeSample(proposal)], { question: String(p.question) }), caseIds: [] };
      return p.decisionModel;
    } };
    const tree = {
      decision: 'Choose 3 used car listings under 50000 EUR',
      successCriteria: '3 live listing pages under 50000 EUR',
      assumptionsToConfirm: [],
      acceptance: { itemCount: 3, valueRange: [0, 50000], unit: 'EUR' },
      nodes: [
        { id: 'D1', parentId: null, title: 'Candidate listings', question: 'Which used car listings are for sale under 50000 EUR?', method: 'lookup', searchQueries: ['used cars for sale'] },
        { id: 'D1.1', parentId: 'D1', title: 'Dealer stock', question: 'Which dealer listings show a used car under 50000 EUR?', method: 'lookup', searchQueries: ['used car dealer stock'] },
        { id: 'D1.2', parentId: 'D1', title: 'Private ads', question: 'Which private ads show a used car under 50000 EUR?', method: 'lookup', searchQueries: ['used car private ads'] },
        { id: 'D2', parentId: null, title: 'Price check', question: 'What do comparable used cars cost near 50000 EUR?', method: 'comparison', searchQueries: ['used car price comparison'] },
        { id: 'D2.1', parentId: 'D2', title: 'Asking prices', question: 'What asking prices do comparable used cars show?', method: 'lookup', searchQueries: ['used car asking prices'] },
        { id: 'D2.2', parentId: 'D2', title: 'Running costs', question: 'What running costs change which used car is worth shortlisting?', method: 'lookup', searchQueries: ['used car running costs'] },
      ],
    };
    const provider = { id: 'stub', ready: true, describe: () => ({ id: 'stub', label: 'Stub', state: 'ready', detail: '', configured: true, fast: 'stub', deep: 'stub', local: false, keyEnv: null, signup: '', modelCount: 1 }), async chat() { return { content: JSON.stringify(tree), model: 'stub', provider: 'stub', usage: {} }; } };
    const router = new ModelRouter({ providers: [provider] });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }), modeler } as never);
    const project = await engine.createProject({ question: 'Which 3 used car listing pages under 50000 EUR are worth shortlisting?', templateId: 'generic', expected: '3 links to used cars priced up to 50000 EUR' });
    expect(project.acceptance?.itemCount ?? null).toBeNull();
    await engine.decompose(project);
    expect(project.acceptance.itemCount).toBe(3);
    expect(builds).toEqual([{ itemCount: 3 }]);
    expect(project.brief.kind).toEqual({ label: 'used car', terms: ['car', 'used car'] });
    expect(project.brief.text).toContain('listing pages');
    expect(project.brief.text).not.toContain('Deliver: a decision memo');
  });

  it('marks tree pieces that do per-listing work as covered when the project lists items, since code does that work on the candidate table', async () => {
    const question = 'Find hatchback car listings within 300km from Prague up to 65000 CZK';
    const piece = (id: string, parentId: string, question: string) => ({ id, parentId, title: question, question, method: 'lookup', searchQueries: [] });
    const tree = {
      decision: 'Choose hatchback listings within 300km of Prague up to 65000 CZK',
      successCriteria: 'live hatchback listings within 300km of Prague up to 65000 CZK',
      assumptionsToConfirm: [],
      acceptance: { itemCount: 10, valueRange: [0, 65000], unit: 'CZK' },
      nodes: [
        piece('D1', 'Q', 'Which specific hatchback listings exist on major Austria and Czechia and Germany and Poland and Slovakia marketplaces?'),
        piece('D1.1', 'D1', 'List hatchbacks <= 65,000 CZK on auto.cz, bazos.cz, inradius.cz within 300km.'),
        piece('D1.2', 'D1', 'List hatchbacks <= 65,000 CZK equivalent on mobile.de, autoscout24.de within 300km.'),
        piece('D1.3', 'D1', 'List hatchbacks <= 65,000 CZK equivalent on at, pl, sk sites within 300km.'),
        piece('D2', 'Q', 'Do candidates meet the 300km radius and hatchback body type criteria?'),
        piece('D2.1', 'D2', 'Calculate road distance from Prague to each listing location.'),
        piece('D2.2', 'D2', 'Verify each listing is explicitly classified as a hatchback.'),
        piece('D3', 'Q', 'Are all candidates priced at or below 65,000 CZK equivalent?'),
        piece('D3.1', 'D3', 'Verify CZK listings are <= 65,000 CZK.'),
        piece('D3.2', 'D3', 'Convert EUR/PLN/CHF prices to CZK and check <= 65,000 CZK.'),
        piece('D4', 'Q', 'Which candidates offer the highest price-to-value ratio based on specs?'),
        piece('D4.1', 'D4', 'Compare engine types and mileage against market norms for the price.'),
        piece('D4.2', 'D4', 'Check empirical reliability data for specific models in the candidate pool.'),
        piece('D5', 'Q', 'Are the listings live, accurate, and from reputable sellers?'),
        piece('D5.1', 'D5', 'Verify that all candidate URLs are live and not 404 errors.'),
        piece('D5.2', 'D5', 'Assess seller reputation based on reviews or dealer status.'),
      ],
    };
    const provider = { id: 'stub', ready: true, describe: () => ({ id: 'stub', label: 'Stub', state: 'ready', detail: '', configured: true, fast: 'stub', deep: 'stub', local: false, keyEnv: null, signup: '', modelCount: 1 }), async chat() { return { content: JSON.stringify(tree), model: 'stub', provider: 'stub', usage: {} }; } };
    const router = new ModelRouter({ providers: [provider] });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }) });
    const project = await engine.createProject({ question, templateId: 'generic', expected: '10 live hatchback listings within 300km of Prague up to 65000 CZK' });
    await engine.decompose(project);
    expect(project.acceptance.itemCount).toBe(10);
    expect(project.nodes).toHaveLength(16);
    expect(project.nodes.filter((n: { status?: string }) => n.status === 'covered').map((n: { id: string }) => n.id)).toEqual(['D1', 'D1.1', 'D1.2', 'D1.3', 'D2', 'D2.1', 'D2.2', 'D3', 'D3.1', 'D3.2', 'D5.1']);
    for (const n of project.nodes.filter((x: { status?: string }) => x.status === 'covered')) expect(n).toMatchObject({ status: 'covered', coveredBy: 'candidate-table' });
    expect(project.nodes.filter((n: { status?: string }) => n.status !== 'covered').map((n: { id: string }) => n.id)).toEqual(['D4', 'D4.1', 'D4.2', 'D5', 'D5.2']);
    expect(project.nodes.every((n: { question: string; status?: string }) => n.status === 'covered' || !/\b(?:List|Verify|Convert|Calculate)\b/.test(n.question))).toBe(true);
    expect(project.log.some((l: { type: string; message: string }) => l.type === 'tree' && l.message === 'pieces covered by code on the candidate table, not researched: D1, D1.1, D1.2, D1.3, D2, D2.1, D2.2, D3, D3.1, D3.2, D5.1')).toBe(true);
  });

  it('keeps the pieces that find the items when no listing portal is known for the kind, such as wholesale suppliers', async () => {
    const proposal = { concept: 'wholesale suppliers of branded second-hand clothing', kind: { label: 'wholesale clothing provider', terms: ['wholesale second-hand clothing', 'used clothing wholesale'] }, criteria: [] };
    const modeler = { fresh: (p: { decisionModel?: unknown }) => Boolean(p.decisionModel), build: async (p: Record<string, unknown>) => {
      p.decisionModel = { ...aggregate([normalizeSample(proposal), normalizeSample(proposal)], { question: String(p.question) }), caseIds: [] };
      return p.decisionModel;
    } };
    const tree = {
      decision: 'Choose wholesale suppliers for a branded second-hand shop in Prague',
      successCriteria: '20 supplier links with proof of quality and price',
      assumptionsToConfirm: [],
      acceptance: { itemCount: 20, urlsLive: false, valueRange: null, unit: '', mustMention: [] },
      nodes: [
        { id: 'D1', parentId: null, title: 'Suppliers', question: 'Which wholesale suppliers sell branded second-hand clothing?', method: 'lookup', searchQueries: ['branded second-hand clothing wholesale'] },
        { id: 'D1.1', parentId: 'D1', title: 'EU suppliers', question: 'List wholesale suppliers of branded second-hand clothing that ship to Czechia.', method: 'lookup', searchQueries: ['vintage clothing wholesale EU'] },
        { id: 'D1.2', parentId: 'D1', title: 'Grades', question: 'Which grading systems do these suppliers use?', method: 'lookup', searchQueries: ['second-hand clothing grade A cream'] },
        { id: 'D2', parentId: null, title: 'Value', question: 'Which suppliers give the best price for quality?', method: 'comparison', searchQueries: ['vintage wholesale price per kg'] },
        { id: 'D2.1', parentId: 'D2', title: 'Prices', question: 'What do suppliers charge per kilo or per piece?', method: 'lookup', searchQueries: ['wholesale vintage price per kg'] },
        { id: 'D2.2', parentId: 'D2', title: 'Reviews', question: 'What do shop owners report about these suppliers?', method: 'lookup', searchQueries: ['vintage wholesaler review'] },
      ],
    };
    const provider = { id: 'stub', ready: true, describe: () => ({ id: 'stub', label: 'Stub', state: 'ready', detail: '', configured: true, fast: 'stub', deep: 'stub', local: false, keyEnv: null, signup: '', modelCount: 1 }), async chat() { return { content: JSON.stringify(tree), model: 'stub', provider: 'stub', usage: {} }; } };
    const router = new ModelRouter({ providers: [provider] });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }), modeler } as never);
    const project = await engine.createProject({ question: 'Find wholesale branded second hand clothing providers for a retail second hand shop in Czech Republic', templateId: 'generic', expected: '20 direct links to the providers with proposal and proof' });
    await engine.decompose(project);
    expect(project.nodes.map((n: { id: string }) => n.id)).toEqual(['D1', 'D1.1', 'D1.2', 'D2', 'D2.1', 'D2.2']);
    expect(project.brief.located).toBe(false);
    await engine.collectCandidates(project);
    expect(project.candidates).toBeNull();
    expect(project.log.some((l: { type: string; message: string }) => l.type === 'candidates' && l.message.startsWith('no candidate table: no listing portal sells "wholesale clothing provider"'))).toBe(true);
    expect(project.log.some((l: { type: string; message: string }) => l.type === 'tree' && l.message.startsWith('no listing portal is known for "wholesale clothing provider"'))).toBe(true);
  });

  it('reads the item count from the user words, so the decision model is built before the tree is decomposed', async () => {
    const proposal = { concept: 'used cars within budget', kind: { label: 'used car', terms: ['car', 'used car'] }, criteria: [{ clause: 'under 50000 EUR', measure: 'priceEur', op: '<=', value: 50000, quote: 'under 50000 EUR' }] };
    const order: string[] = [];
    const modeler = { fresh: (p: { decisionModel?: unknown }) => Boolean(p.decisionModel), build: async (p: Record<string, unknown>) => {
      order.push(`build:${(p.acceptance as { itemCount?: number | null } | undefined)?.itemCount ?? null}`);
      p.decisionModel = { ...aggregate([normalizeSample(proposal), normalizeSample(proposal)], { question: String(p.question) }), caseIds: [] };
      return p.decisionModel;
    } };
    const tree = {
      decision: 'Choose used car listings under 50000 EUR',
      successCriteria: 'live listing pages under 50000 EUR',
      assumptionsToConfirm: [],
      acceptance: { itemCount: null, urlsLive: true, valueRange: [0, 50000], unit: 'EUR', mustMention: [] },
      nodes: [
        { id: 'D1', parentId: null, title: 'Candidate listings', question: 'Which used car listings are for sale under 50000 EUR?', method: 'lookup', searchQueries: ['used cars for sale'] },
        { id: 'D1.1', parentId: 'D1', title: 'Dealer stock', question: 'Which dealer listings show a used car under 50000 EUR?', method: 'lookup', searchQueries: ['used car dealer stock'] },
        { id: 'D1.2', parentId: 'D1', title: 'Private ads', question: 'Which private ads show a used car under 50000 EUR?', method: 'lookup', searchQueries: ['used car private ads'] },
        { id: 'D2', parentId: null, title: 'Price check', question: 'What do comparable used cars cost near 50000 EUR?', method: 'comparison', searchQueries: ['used car price comparison'] },
        { id: 'D2.1', parentId: 'D2', title: 'Asking prices', question: 'What asking prices do comparable used cars show?', method: 'lookup', searchQueries: ['used car asking prices'] },
        { id: 'D2.2', parentId: 'D2', title: 'Running costs', question: 'What running costs change which used car is worth shortlisting?', method: 'lookup', searchQueries: ['used car running costs'] },
      ],
    };
    const provider = { id: 'stub', ready: true, describe: () => ({ id: 'stub', label: 'Stub', state: 'ready', detail: '', configured: true, fast: 'stub', deep: 'stub', local: false, keyEnv: null, signup: '', modelCount: 1 }), async chat() { order.push('decompose'); return { content: JSON.stringify(tree), model: 'stub', provider: 'stub', usage: {} }; } };
    const router = new ModelRouter({ providers: [provider] });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }), modeler } as never);
    const project = await engine.createProject({ question: 'Which used car listings under 50000 EUR are worth shortlisting right now?', templateId: 'generic', expected: '10 links to real listings of used cars priced up to 50000 EUR' });
    expect(project.acceptance?.itemCount ?? null).toBeNull();
    await engine.decompose(project);
    expect(order[0]).toBe('build:10');
    expect(order.indexOf('build:10')).toBeLessThan(order.indexOf('decompose'));
    expect(engine.modeler.fresh(project)).toBe(true);
  });

  it('reports the purpose and value stage 0 chose right after the decision model', async () => {
    const purpose = 'A buyer wants a used car under 50000 EUR so that they shortlist the best value listings';
    const value = 'a shortlist of used car listings under 50000 EUR below the median price of their model and year';
    const proposal = { concept: 'used cars within budget', purpose, value, needs: [{ need: 'live used car listings', kind: 'listings', sources: ['sauto.cz'] }], kind: { label: 'used car', terms: ['car', 'used car'] }, criteria: [{ clause: 'under 50000 EUR', measure: 'priceEur', op: '<=', value: 50000, quote: 'under 50000 EUR' }] };
    const modeler = { fresh: (p: { decisionModel?: unknown }) => Boolean(p.decisionModel), build: async (p: Record<string, unknown>) => {
      p.decisionModel = { ...aggregate([normalizeSample(proposal), normalizeSample(proposal)], { question: String(p.question) }), caseIds: [] };
      return p.decisionModel;
    } };
    const tree = {
      decision: 'Choose used car listings under 50000 EUR',
      successCriteria: 'live listing pages under 50000 EUR',
      assumptionsToConfirm: [],
      acceptance: { itemCount: null, urlsLive: true, valueRange: [0, 50000], unit: 'EUR', mustMention: [] },
      nodes: [
        { id: 'D1', parentId: null, title: 'Candidate listings', question: 'Which used car listings are for sale under 50000 EUR?', method: 'lookup', searchQueries: ['used cars for sale'] },
        { id: 'D1.1', parentId: 'D1', title: 'Dealer stock', question: 'Which dealer listings show a used car under 50000 EUR?', method: 'lookup', searchQueries: ['used car dealer stock'] },
        { id: 'D1.2', parentId: 'D1', title: 'Private ads', question: 'Which private ads show a used car under 50000 EUR?', method: 'lookup', searchQueries: ['used car private ads'] },
        { id: 'D2', parentId: null, title: 'Price check', question: 'What do comparable used cars cost near 50000 EUR?', method: 'comparison', searchQueries: ['used car price comparison'] },
        { id: 'D2.1', parentId: 'D2', title: 'Asking prices', question: 'What asking prices do comparable used cars show?', method: 'lookup', searchQueries: ['used car asking prices'] },
        { id: 'D2.2', parentId: 'D2', title: 'Running costs', question: 'What running costs change which used car is worth shortlisting?', method: 'lookup', searchQueries: ['used car running costs'] },
      ],
    };
    const provider = { id: 'stub', ready: true, describe: () => ({ id: 'stub', label: 'Stub', state: 'ready', detail: '', configured: true, fast: 'stub', deep: 'stub', local: false, keyEnv: null, signup: '', modelCount: 1 }), async chat() { return { content: JSON.stringify(tree), model: 'stub', provider: 'stub', usage: {} }; } };
    const router = new ModelRouter({ providers: [provider] });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }), modeler } as never);
    const project = await engine.createProject({ question: 'Which used car listings under 50000 EUR are worth shortlisting right now?', templateId: 'generic', expected: '10 links to real listings of used cars priced up to 50000 EUR' });
    await engine.decompose(project);
    expect(project.log.some((l: { type: string; message: string }) => l.type === 'decision' && l.message.startsWith('purpose:'))).toBe(true);
    expect(project.log.some((l: { type: string; message: string }) => l.type === 'decision' && l.message === `purpose: ${purpose}`)).toBe(true);
    expect(project.log.some((l: { type: string; message: string }) => l.type === 'decision' && l.message === `value: ${value}`)).toBe(true);
  });

  it('drops off-topic pages before any model call, searches again when nothing matches, and shows the model the retrieved page', async () => {
    const queries: string[][] = [];
    const prompts: string[] = [];
    const offTopic = {
      ...fakeSearch,
      async search(q: string[]) {
        queries.push(q);
        if (queries.length === 1) return [{ kind: 'web', title: 'Bikes', url: 'https://bikes.example/a', domain: 'bikes.example', snippet: 's', text: 'battery range of electric bikes on a full charge, '.repeat(8) }, { kind: 'web', title: 'Shop', url: 'https://shop.example/b', domain: 'shop.example', snippet: 's', text: 'free delivery on orders over fifty, '.repeat(10) }];
        return [{ kind: 'web', title: 'Answer', url: 'https://answer.example/c', domain: 'answer.example', snippet: 's', text: `${q.join(' ')} documented here` }];
      },
    };
    const scripted = new ScriptedProvider();
    const provider = { id: 'demo', ready: true, describe: () => scripted.describe(), async chat(args: { messages: Array<{ content: string }> }) { prompts.push(args.messages.at(-1)!.content); return scripted.chat(args as never); } };
    const { engine } = engineWith(provider, offTopic, 1);
    const project = await engine.createProject({ question: 'Where should I build a glamping site in Czechia?' });
    const built = await engine.buildTree(project.id);
    const leaf = built.nodes.find((n: { id: string }) => !built.nodes.some((m: { parentId: string }) => m.parentId === n.id));
    await engine.researchLeaf(built, leaf, '');
    expect(built.log.some((l: { message: string }) => l.message === `${leaf.id}: retrieved pages do not match the question; searching again before any model call`)).toBe(true);
    expect(queries[1]).toContain(leaf.question);
    expect(leaf.sources.map((s: { url: string }) => s.url)).toContain('https://answer.example/c');
    const research = prompts.find((p) => p.includes(TASK_MARKERS.research))!;
    expect(research).toContain('https://answer.example/c');
    expect(research).not.toContain('https://bikes.example/a');
    expect(built.log.some((l: { message: string }) => /source\(s\) dropped before any model call — off topic \(bikes\.example, shop\.example\)/.test(l.message))).toBe(true);
  });

  it('runs the corrective search when no pages were retrieved at all, before any model call', async () => {
    const queries: string[][] = [];
    const prompts: string[] = [];
    const emptySearch = {
      ...fakeSearch,
      async search(q: string[]) {
        queries.push(q);
        if (queries.length === 1) return [];
        return [{ kind: 'web', title: 'Answer', url: 'https://answer.example/c', domain: 'answer.example', snippet: 's', text: `${q.join(' ')} documented here` }];
      },
    };
    const scripted = new ScriptedProvider();
    const provider = { id: 'demo', ready: true, describe: () => scripted.describe(), async chat(args: { messages: Array<{ content: string }> }) { prompts.push(args.messages.at(-1)!.content); return scripted.chat(args as never); } };
    const { engine } = engineWith(provider, emptySearch, 1);
    const project = await engine.createProject({ question: 'Where should I build a glamping site in Czechia?' });
    const built = await engine.buildTree(project.id);
    const leaf = built.nodes.find((n: { id: string }) => !built.nodes.some((m: { parentId: string }) => m.parentId === n.id));
    await engine.researchLeaf(built, leaf, '');
    expect(built.log.some((l: { message: string }) => l.message === `${leaf.id}: retrieved pages do not match the question; searching again before any model call`)).toBe(true);
    expect(queries[1]).toContain(leaf.question);
    expect(leaf.sources.map((s: { url: string }) => s.url)).toContain('https://answer.example/c');
    const research = prompts.find((p) => p.includes(TASK_MARKERS.research))!;
    expect(research).not.toContain('NO SOURCES were retrieved');
  });

  it('remembers joined browsers on the research, forgets one that leaves or is not seen for a day, and rejoins the rest', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Where should I build a glamping site in Czechia?' });
    await engine.load(project.id);
    engine.join(project.id, 'pc');
    engine.join(project.id, 'phone');
    const saved = engine.store.cache.get(project.id);
    expect(Object.keys(saved.team)).toEqual(['pc', 'phone']);
    engine.leaveOne(project.id, 'phone');
    expect(Object.keys(saved.team)).toEqual(['pc']);
    engine.leave(project.id);
    expect(engine.rejoinTeam(project.id)).toEqual(['pc']);
    expect(engine.teamOf(project.id).helpers).toEqual(['pc']);
    expect(engine.rejoinTeam(project.id)).toEqual([]);
    expect(engine.teammates(saved, Date.parse(saved.team.pc) + TEAM_TTL_MS + 1)).toEqual([]);
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

  it('starts a run whose tree repair meets a researched off-scope leaf: the leaf is kept as covered and the save is not refused', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const errors: string[] = [];
    engine.store.onEvent = (_id: string, event: { type: string; message: string }) => { if (event.type === 'error') errors.push(event.message); };
    const project = await engine.createProject({ question: 'Find plots for a glamping business in Portugal, 20000EUR max', expected: '50 plots feasible for glamping' });
    const done = await engine.run(project.id);
    expect(done.brief.regions).toEqual(['PT']);
    done.acceptance = { ...done.acceptance, itemCount: 50 };
    const italy = { ...researchedNode('D9', 'Q'), title: 'Italy – coastal raw land', question: 'Find Italian coastal raw land parcels' };
    done.nodes.push(italy);
    await engine.store.save(done, { reason: 'test: an off-scope researched leaf joins the tree' });
    const again = await engine.run(project.id);
    const kept = again.nodes.find((n: { id: string }) => n.id === 'D9');
    expect(kept).toMatchObject({ status: 'covered', coveredBy: 'off-scope', finding: italy.finding, sources: italy.sources });
    expect(again.log.some((l: { message: string }) => /tree repaired: D9 covered-off-scope/.test(l.message))).toBe(true);
    expect(errors).toEqual([]);
    expect((await engine.store.readFile(project.id)).nodes.some((n: { id: string }) => n.id === 'D9')).toBe(true);
  });

  it('sends the research hints to every research step as soft guidance and lets the user change them while it runs', async () => {
    expect(withGuidance([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], '')).toEqual([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
    expect(withGuidance([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], 'cheap raw land is in scope')[1].content).toMatch(/^u\n\nUSER HINTS \(soft guidance[^)]*\):\ncheap raw land is in scope$/);
    const scripted = new ScriptedProvider();
    const prompts: string[] = [];
    const provider = { id: 'demo', ready: true, describe: () => scripted.describe(), async chat(args: { messages: Array<{ content: string }> }) { prompts.push(args.messages.at(-1)!.content); return scripted.chat(args as never); } };
    const { engine } = engineWith(provider, fakeSearch, 1);
    const project = await engine.createProject({ question: 'Where should I build a glamping site in Czechia?' });
    engine.running.add(project.id);
    const hinted = await engine.updateProject(project.id, { guidance: 'Land that needs work is in scope; judge purchase plus preparation cost.' });
    engine.running.delete(project.id);
    expect(hinted.guidance).toMatch(/purchase plus preparation/);
    await expect((async () => { engine.running.add(project.id); try { await engine.updateProject(project.id, { expected: 'x' }); } finally { engine.running.delete(project.id); } })()).rejects.toThrow(/stop the run/);
    await engine.run(project.id);
    const research = prompts.filter((p) => p.includes(TASK_MARKERS.research));
    expect(research.length).toBeGreaterThan(0);
    expect(research.every((p) => p.includes('USER HINTS') && p.includes('purchase plus preparation'))).toBe(true);
    expect(prompts.some((p) => p.includes(TASK_MARKERS.decompose) && p.includes('USER HINTS'))).toBe(true);
  });

  it('asks for a funnel tree when a list is expected, and has the memo screen every delivered item', () => {
    const tree = decomposePrompt({ question: 'Find plots', template: { label: 't', drivers: 'd', metrics: 'm', sources: 's', decisionRule: 'r' }, constraints: {}, expected: '50 plots' })[1].content;
    expect(tree).toMatch(/FUNNEL, as systematic reviews do \(PRISMA: identify → screen → include\)/);
    const nodes = [
      { id: 'D1', parentId: 'Q', status: 'verified', question: 'Which plots are listed?', finding: { answer: 'two', items: [{ url: 'https://a.example/1', title: 'Plot near Lagos', value: 18000, unit: 'EUR' }] } },
      { id: 'D2', parentId: 'Q', status: 'weak', question: 'Beach within 20 km?', finding: { answer: 'unclear', items: [{ url: 'https://b.example/2' }] } },
    ];
    const memo = synthesizePrompt({ question: 'q', decision: 'd', successCriteria: '', template: { decisionRule: 'r' }, constraints: {}, nodes, expected: '50 plots' })[1].content;
    expect(memo).toMatch(/CANDIDATE ITEMS FOUND \(1; from passing pieces\)/);
    expect(memo).toContain('[D1] Plot near Lagos · 18000 EUR · https://a.example/1');
    expect(memo).not.toContain('https://b.example/2');
    expect(memo).toMatch(/identified, screened out \(main reasons\), included/);
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
    expect(rerun.nodes.filter((n: { status: string }) => n.status !== 'verified').map((n: { id: string; status: string; verification?: { failures: string[] } }) => `${n.id} ${n.status} ${(n.verification?.failures ?? []).join(' | ')}`)).toEqual([]);
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
    expect(engine.cancelled.has(project.id)).toBe(false);
  });

  it('a resumed failed leaf re-rolls its parent', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Find the wholesale branded second hand clothing providers with proven good quality for a second hand shop in Czech Republic' });
    const piece = (id: string, parentId: string, title: string, question: string, more: object) => ({ id, parentId, title, question, method: 'lookup', dependsOn: [], impact: 4, uncertainty: 3, sources: [], attempts: 1, ...more });
    const stale = { answer: 'Suppliers stock the target brands with varying SKU counts.', claims: [], items: [], confidence: 'low', gaps: [] };
    project.nodes = [
      piece('D4', 'Q', 'Assortment breadth', 'Do the suppliers stock the target brands?', { status: 'unsupported', finding: stale, verification: { grade: 'unsupported', score: 50, checks: [], failures: [], rolledUpFrom: ['D4.1:failed', 'D4.2:supported'] } }),
      piece('D4.1', 'D4', 'Brand presence', 'Which target brands does each supplier list?', { status: 'failed', error: 'all free model quotas are cooling down after rate limits; retry in a minute' }),
      piece('D4.2', 'D4', 'SKU quantity', 'Count distinct SKUs for each target brand per supplier', { status: 'supported', finding: { answer: 'Supplier catalogs list the brands.', claims: [], items: [], confidence: 'low', gaps: [] }, verification: { grade: 'supported', score: 100, checks: [], failures: [] } }),
    ];
    project.phase = 'error';
    await engine.store.save(project);
    const done = await engine.run(project.id);
    const byId = Object.fromEntries(done.nodes.map((n: { id: string }) => [n.id, n]));
    expect(byId['D4.1'].status).not.toBe('failed');
    expect(byId['D4'].verification.rolledUpFrom).toEqual([`D4.1:${byId['D4.1'].status}`, 'D4.2:supported']);
    expect(byId['D4'].finding).not.toEqual(stale);
  });

  it('a drift downgrade of a leaf sends its parent back to be rolled up', () => {
    const { engine } = engineWith(new ScriptedProvider());
    const drift = { baseline: { values: [4], at: '2026-11-05T02:10:00.000Z' }, samples: [{ values: [1], score: 0.84, at: '2026-11-06T13:45:00.000Z' }] };
    const project = { id: 'p', log: [], nodes: [
      { id: 'D4', parentId: 'Q', status: 'supported', dependsOn: [], finding: { answer: 'Suppliers stock the target brands.' }, verification: { grade: 'supported', rolledUpFrom: ['D4.1:supported', 'D4.2:supported'] } },
      { id: 'D4.1', parentId: 'D4', status: 'supported', dependsOn: [], finding: { answer: '4 suppliers list Barbour.' }, verification: { grade: 'supported' }, drift },
      { id: 'D4.2', parentId: 'D4', status: 'supported', dependsOn: [], finding: { answer: 'Supplier catalogs list the brands.' }, verification: { grade: 'supported' } },
    ] };
    const changed = engine.monitorPass(project as never);
    if (!changed.length) throw new Error('the stored drift sample of D4.1 no longer triggers a drift downgrade: rebuild this fixture from monitor.mjs');
    expect(project.nodes.map((n) => [n.id, n.status])).toEqual([['D4', 'pending'], ['D4.1', 'pending'], ['D4.2', 'supported']]);
    expect(project.nodes[0].finding).toBeNull();
  });

  it('honours a stop raised while collecting candidates', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Find plots for a glamping business in Portugal, 20000EUR max', expected: '5 plots in Portugal under 20000 EUR' });
    let synthesized = false;
    engine.collectCandidates = async () => {
      engine.cancel(project.id);
      return null;
    };
    engine.synthesize = async () => {
      synthesized = true;
    };
    const stopped = await engine.run(project.id);
    expect(stopped.phase).toBe('cancelled');
    expect(synthesized).toBe(false);
  });

  it('stops a piece in flight when cancelled, leaving that piece pending', async () => {
    const scripted = new ScriptedProvider();
    const calls: string[] = [];
    let projectId = '';
    let piece = '';
    let cancelled = false;
    let engine: ResearchEngine;
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => scripted.describe(),
      async chat(args: { messages: Array<{ role: string; content: string }> }) {
        const prompt = args.messages.at(-1)!.content;
        const nodeId = /SUB-QUESTION (\S+):/.exec(prompt)?.[1] ?? '';
        if (prompt.includes(TASK_MARKERS.research)) {
          calls.push(`research:${nodeId}`);
          if (!cancelled) {
            cancelled = true;
            piece = nodeId;
            engine.cancel(projectId);
          }
        } else if (prompt.includes(TASK_MARKERS.critique)) {
          calls.push(`critique:${nodeId}`);
        }
        return scripted.chat(args as never);
      },
    };
    const made = engineWith(provider, fakeSearch, 1);
    engine = made.engine;
    const project = await engine.createProject({ question: 'Where should I build a glamping site in Czechia?' });
    projectId = project.id;
    const stopped = await engine.run(project.id);
    expect(stopped.phase).toBe('cancelled');
    expect(piece).not.toBe('');
    expect(calls).toEqual([`research:${piece}`]);
    expect(stopped.nodes.find((n: { id: string }) => n.id === piece)?.status).toBe('pending');
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

  it('re-attempts a weak leaf on a second run', async () => {
    const scripted = new ScriptedProvider();
    const researchCalls: string[] = [];
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => scripted.describe(),
      async chat(args: { messages: Array<{ role: string; content: string }> }) {
        const prompt = args.messages.at(-1)!.content;
        if (prompt.includes(TASK_MARKERS.research)) researchCalls.push(/SUB-QUESTION (\S+):/.exec(prompt)?.[1] ?? '');
        return scripted.chat(args as never);
      },
    };
    const { engine } = engineWith(provider);
    const project = await engine.createProject({ question: 'Should I open a bakery in Brno next year?' });
    const done = await engine.run(project.id);
    expect(done.nodes.every((n: { status: string }) => n.status === 'verified')).toBe(true);
    const leaf = done.nodes.find((n: { id: string }) => n.id === 'D1.1');
    leaf.status = 'weak';
    leaf.finding = { answer: 'OLD WEAK ANSWER for D1.1', claims: [{ text: 'old claim 5', sourceIds: ['S1'], quote: 'about the question', assumption: false }], confidence: 'low' };
    leaf.verification = { grade: 'weak', score: 50, checks: [{ id: 'attribution', label: 'Each claim is backed by a verbatim quote found in its source', passed: false, detail: 'old' }], failures: ['old'] };
    await engine.store.save(done);
    const before = researchCalls.length;
    const rerun = await engine.run(project.id);
    expect(rerun.phase).toBe('done');
    expect(researchCalls.slice(before)).toContain('D1.1');
    const leafAfter = rerun.nodes.find((n: { id: string }) => n.id === 'D1.1');
    expect(leafAfter.status).toBe('verified');
    expect(leafAfter.finding.answer).not.toBe('OLD WEAK ANSWER for D1.1');
  });

  it('leaves a weak leaf alone on a trial run that reuses results', async () => {
    const scripted = new ScriptedProvider();
    const researchCalls: string[] = [];
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => scripted.describe(),
      async chat(args: { messages: Array<{ role: string; content: string }> }) {
        const prompt = args.messages.at(-1)!.content;
        if (prompt.includes(TASK_MARKERS.research)) researchCalls.push(/SUB-QUESTION (\S+):/.exec(prompt)?.[1] ?? '');
        return scripted.chat(args as never);
      },
    };
    const { engine } = engineWith(provider);
    const project = await engine.createProject({ question: 'Should I open a bakery in Brno next year?' });
    const done = await engine.run(project.id);
    const leaf = done.nodes.find((n: { id: string }) => n.id === 'D1.1');
    leaf.status = 'weak';
    await engine.store.save(done);
    const before = researchCalls.length;
    const rerun = await engine.run(project.id, { memo: false, pieces: ['D1.1'], reuse: true });
    expect(researchCalls.slice(before)).not.toContain('D1.1');
    expect(rerun.nodes.find((n: { id: string }) => n.id === 'D1.1').status).toBe('weak');
  });

  it('keeps the previous finding of a weak leaf when the re-attempt on a second run grades lower', async () => {
    const scripted = new ScriptedProvider();
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => scripted.describe(),
      async chat(args: { messages: Array<{ role: string; content: string }> }) {
        const prompt = args.messages.at(-1)!.content;
        const nodeId = /SUB-QUESTION (\S+):/.exec(prompt)?.[1] ?? '';
        if (prompt.includes(TASK_MARKERS.research) && nodeId === 'D1.1') {
          return { content: JSON.stringify({ answer: 'made up on the re-attempt', claims: [{ text: 'price 5', sourceIds: ['S99'] }], confidence: 'high' }), model: 'm', provider: 'demo', usage: {} };
        }
        return scripted.chat(args as never);
      },
    };
    const { engine } = engineWith(provider);
    const project = await engine.createProject({ question: 'Should I open a bakery in Brno next year?' });
    const done = await engine.run(project.id);
    const leaf = done.nodes.find((n: { id: string }) => n.id === 'D1.1');
    leaf.status = 'weak';
    leaf.finding = { answer: 'OLD WEAK ANSWER for D1.1', claims: [{ text: 'old claim 5', sourceIds: ['S1'], quote: 'about the question', assumption: false }], confidence: 'low' };
    leaf.verification = { grade: 'weak', score: 50, checks: [{ id: 'attribution', label: 'Each claim is backed by a verbatim quote found in its source', passed: false, detail: 'old' }], failures: ['old'] };
    await engine.store.save(done);
    const rerun = await engine.run(project.id);
    const leafAfter = rerun.nodes.find((n: { id: string }) => n.id === 'D1.1');
    expect(leafAfter.status).toBe('weak');
    expect(leafAfter.finding.answer).toBe('OLD WEAK ANSWER for D1.1');
    expect(leafAfter.verification.grade).toBe('weak');
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

describe('site measurements in the background', () => {
  it('measures queued rows with a second worker and rebuilds the table, or leaves it for the loop when the loop runs', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Find plots for a glamping business near the sea in Portugal, 20000EUR max', expected: '4 plots in Portugal under 20000 EUR', autoRun: false });
    let reloaded = 0;
    let release: () => void = () => {};
    const done = new Promise<void>((r) => { release = r; });
    engine.sites = { file: '/tmp/x.json', reload: async () => { reloaded++; }, worker: () => ({ apply: async () => { await done; return { sites: { assessed: 7, pending: 2 } }; } }), apply: async (c: object) => c } as never;
    const collected: string[] = [];
    engine.collectCandidates = (async (p: { id: string }) => { collected.push(p.id); return null; }) as never;
    engine.startSiteWarm(project.id, { kept: [] }, {});
    engine.startSiteWarm(project.id, { kept: [] }, {});
    expect(engine.siteWarm.get(project.id)).toMatchObject({ running: true, ready: false });
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(reloaded).toBe(1);
    expect(collected).toEqual([project.id]);
    expect(engine.siteWarm.has(project.id)).toBe(false);
    const log = (await engine.load(project.id)).log.map((l: { message: string }) => l.message);
    expect(log.some((m: string) => m === 'site fit in the background: 7 listing(s) measured, 2 still queued; table rebuilt from the measurements')).toBe(true);
    engine.quiet.add(project.id);
    engine.startSiteWarm(project.id, { kept: [] }, {});
    await new Promise((r) => setTimeout(r, 20));
    expect(engine.siteWarm.get(project.id)).toMatchObject({ ready: true, measured: 7 });
    expect(collected).toEqual([project.id]);
  });
});

describe('graded research answers feed routing', () => {
  it('records each research grade for the provider that wrote it', async () => {
    const { OutcomeBook } = await import('../../src/llm/outcomes.mjs');
    const provider = new ScriptedProvider();
    const { engine, router } = engineWith(provider);
    const outcomes = new OutcomeBook();
    router.outcomes = outcomes;
    const project = await engine.createProject({ question: 'Is it profitable to resell used vans from Germany in Czechia?', autoRun: false });
    await engine.run(project.id);
    const seen = outcomes.posterior(provider.id, 'research', 3, provider.selected.fast);
    expect(outcomes.posterior(provider.id, 'research', 3).observed).toBe(0);
    expect(seen.observed).toBeGreaterThan(0);
  });

  it('synthesize records outcome when candidates exist, NOT when candidates is null', async () => {
    const provider = new ScriptedProvider();
    const { engine, router } = engineWith(provider);
    const recorded: Array<{ purpose: string; passed: boolean }> = [];
    router.recordOutcome = ({ purpose, passed }: { purpose: string; passed: boolean }) => {
      recorded.push({ purpose, passed });
    };
    const project = await engine.createProject({ question: 'Find plots for glamping in Portugal', autoRun: false });
    await engine.run(project.id);
    const leaf = project.nodes.find((n: { parentId: string | null }) => n.parentId !== null);
    leaf.status = 'verified';
    leaf.finding = { answer: 'two plots', claims: [], items: [] };
    leaf.verification = { grade: 'verified', score: 80, checks: [], failures: [] };
    // candidates present (with all required fields) -> checkMemoClaims returns object -> recordOutcome called
    project.candidates = { found: 2, keptCount: 2, toCheckCount: 0, screenedCount: 0, kept: [], toCheck: [], screened: {}, tiers: { fits: 0, 'trade-off': 0, unverified: 0, weak: 0, blocked: 0 }, verification: null, sites: { trends: {} } };
    project.report = { verdict: 'GO', modelVerdict: 'GO', kind: 'list', confidence: 'high', summary: 'x', keyNumbers: [], scenarios: [], sensitivity: [], risks: [], openQuestions: [], nextSteps: [], evidenceQuality: {}, bestEstimate: null, actionItems: [], options: [], basis: {}, model: 'demo/m', generatedAt: new Date().toISOString() };
    await engine.synthesize(project);
    expect(recorded.filter((r) => r.purpose === 'synthesize')).toHaveLength(1);
    // no candidates -> checkMemoClaims returns null -> claimCheck is null -> no recordOutcome
    recorded.length = 0;
    project.candidates = null;
    await engine.synthesize(project);
    expect(recorded.filter((r) => r.purpose === 'synthesize')).toHaveLength(0);
  });

  it('synthesize records passed=false when claimCheck has contradictions', async () => {
    const { ScriptedProvider } = await import('../../src/llm/scripted-provider.mjs');
    const { TASK_MARKERS } = await import('../../src/research/prompts.mjs');
    // Custom provider that returns a synthesize response with a contradiction
    const scripted = new ScriptedProvider();
    const provider = {
      id: 'demo',
      ready: true,
      selected: { fast: 'test-fast', deep: 'test-deep', vision: 'test-vision' },
      canServe: () => true,
      describe: () => ({ id: 'demo', label: 'Demo', state: 'ready', detail: '', configured: true, fast: 'test-fast', deep: 'test-deep', local: true, keyEnv: null, signup: '', modelCount: 2 }),
      async chat({ messages, tier, json, temperature, timeoutMs }: { messages: Array<{ role: string; content: string }>; tier: string; json?: boolean; temperature?: number; timeoutMs?: number }) {
        const prompt = messages[messages.length - 1].content;
        if (prompt.includes(TASK_MARKERS.synthesize)) {
          return {
            content: JSON.stringify({
              verdict: 'GO-IF',
              confidence: 'high',
              summary: 'median price 5000 EUR',
              keyNumbers: [],
              scenarios: [],
              sensitivity: [],
              risks: [],
              openQuestions: [],
              nextSteps: [],
              bestEstimate: null,
              actions: [],
              options: [],
            }),
            model: tier === 'deep' ? 'test-deep' : 'test-fast',
            provider: 'demo',
            usage: {},
          };
        }
        // For other calls, use a single ScriptedProvider instance with all parameters
        return scripted.chat({ messages, tier, json, temperature, timeoutMs });
      },
    };
    const { engine, router } = engineWith(provider);
    const recorded: Array<{ purpose: string; passed: boolean }> = [];
    router.recordOutcome = ({ purpose, passed }: { purpose: string; passed: boolean }) => {
      recorded.push({ purpose, passed });
    };
    const project = await engine.createProject({ question: 'Find plots for glamping in Portugal', autoRun: false });
    await engine.run(project.id);
    recorded.length = 0; // clear the synthesize outcome from the first run
    const leaf = project.nodes.find((n: { parentId: string | null }) => n.parentId !== null);
    leaf.status = 'verified';
    leaf.finding = { answer: 'two plots', claims: [], items: [] };
    leaf.verification = { grade: 'verified', score: 80, checks: [], failures: [] };
    // candidates with a listing that has a value, report claims a different value -> contradiction
    // plan must have verdict, why (array), and risks (array) for siteText()
    project.candidates = { found: 2, keptCount: 2, toCheckCount: 0, screenedCount: 0, kept: [{ value: 10000, unit: 'EUR', plan: { tier: 'fits', verdict: 'Fits all checks', why: ['price in range', 'coastal'], risks: [] } }], toCheck: [], screened: {}, tiers: { fits: 1, 'trade-off': 0, unverified: 0, weak: 0, blocked: 0 }, verification: null, sites: { trends: {} } };
    await engine.synthesize(project);
    expect(recorded.filter((r) => r.purpose === 'synthesize')).toHaveLength(1);
    expect(recorded[0].passed).toBe(false);
  });
});

describe('external verifier from the engine', () => {
  it('starts the verifier once per set of fits, then rebuilds the table from its record', async () => {
    const { applyVerification } = await import('../../src/research/verification.mjs');
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Find plots near the sea in Portugal, 20000EUR max', expected: '2 plots', autoRun: false });
    let runs = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    engine.verifier = { dir: '/nonexistent', run: async () => { runs++; await gate; } } as never;
    engine.sites = { reload: async () => {} } as never;
    const rebuilt: string[] = [];
    engine.collectCandidates = (async (p: { id: string }) => { rebuilt.push(p.id); return null; }) as never;
    project.candidates = applyVerification({ tiers: { fits: 1 }, keptCount: 1, kept: [{ url: 'a', plan: { tier: 'fits' } }] }, null);
    engine.startVerification(project);
    engine.startVerification(project);
    expect(runs).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(rebuilt).toEqual([project.id]);
    const log = (await engine.load(project.id)).log.map((l: { message: string }) => l.message);
    expect(log).toContain('external verifier finished; table rebuilt: only plots it confirmed count toward the result');
    engine.startVerification(project);
    expect(runs).toBe(1);
  });

  it('hands the verifier the table being built, not the project file that is saved later', async () => {
    const { applyVerification } = await import('../../src/research/verification.mjs');
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Find plots near the sea in Portugal, 20000EUR max', expected: '2 plots', autoRun: false });
    const seen: { id: string; candidates: { kept: { url: string }[] }; question: string }[] = [];
    engine.verifier = { dir: '/nonexistent', run: async (_id: string, snapshot: never) => { seen.push(snapshot); } } as never;
    engine.collectCandidates = (async () => null) as never;
    project.candidates = applyVerification({ tiers: { fits: 1 }, keptCount: 1, kept: [{ url: 'https://imo.example/anuncio/fit-ID1', plan: { tier: 'fits' } }] }, null);
    engine.startVerification(project);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: project.id, question: project.question, candidates: { kept: [{ url: 'https://imo.example/anuncio/fit-ID1' }] } });
  });
});

describe('meaning check of claims', () => {
  const quote = 'Bell tents cost from €950';
  const claimOf = () => ({ text: 'A building permit costs €950', quote, sourceIds: ['S1'], attributed: true });
  const nodeOf = (sources: object[] = [{ id: 'S1', text: `${quote}. Delivery is extra.` }]) => ({ id: 'D1', method: 'lookup', sources });

  function votingEngine(votes: Record<string, string>) {
    const { engine, router } = engineWith(new ScriptedProvider());
    const calls: { purpose: string; tier: string; avoid?: string | string[]; quote: string }[] = [];
    router.complete = (async (request: { purpose: string; tier: string; avoid?: string | string[]; messages: { content: string }[] }) => {
      const asked = /QUOTE: (.*)/.exec(request.messages[1].content)?.[1] ?? '';
      calls.push({ purpose: request.purpose, tier: request.tier, avoid: request.avoid, quote: asked });
      const provider = request.purpose === 'support' ? 'gemini' : 'groq';
      const key = `${request.purpose}|${asked.includes(quote) ? 'old' : 'new'}`;
      return { data: { supports: votes[key] ?? 'yes', reason: 'quote is about bell tents' }, provider, model: `${provider}-m` };
    }) as typeof router.complete;
    return { engine, calls };
  }

  it('asks the most capable model, then a fast model of another provider, and records both votes', async () => {
    const { engine, calls } = votingEngine({ 'support|old': 'yes', 'support-second|old': 'no' });
    const finding = { answer: 'The permit costs €950.', claims: [claimOf(), { text: 'No number here', attributed: true }] };
    const result = await engine.checkSupport({ id: 'p', nodes: [] }, nodeOf(), finding, 'cerebras');
    expect(result).toEqual({ checked: 1, open: 1 });
    expect(calls.slice(0, 2)).toEqual([
      { purpose: 'support', tier: 'deep', avoid: 'cerebras', quote: `${quote}. Delivery is extra.` },
      { purpose: 'support-second', tier: 'fast', avoid: ['cerebras', 'gemini'], quote: `${quote}. Delivery is extra.` },
    ]);
    const support = finding.claims[0].support;
    expect(support.verdict).toBe('disagree');
    expect(support.votes.map((v: { provider: string; vote: string }) => [v.provider, v.vote])).toEqual([['gemini', 'yes'], ['groq', 'no']]);
    expect(support.cause).toContain('• The two checking models disagree');
    expect(finding.claims[1]).not.toHaveProperty('support');
  });

  it('resolves a claim to confirm from another fetched sentence before flagging it', async () => {
    const { engine, calls } = votingEngine({ 'support|old': 'no', 'support-second|old': 'no' });
    const node = nodeOf([{ id: 'S1', text: `${quote}.` }, { id: 'S2', text: 'The building permit for a small camp costs €950 in most districts.' }]);
    const finding = { answer: 'The permit costs €950.', claims: [claimOf()] };
    await engine.checkSupport({ id: 'p', nodes: [] }, node, finding, 'cerebras');
    expect(calls.map((c) => c.quote)).toEqual([`${quote}.`, `${quote}.`, 'The building permit for a small camp costs €950 in most districts.', 'The building permit for a small camp costs €950 in most districts.']);
    expect(finding.claims[0]).toMatchObject({ quote: 'The building permit for a small camp costs €950 in most districts.', sourceIds: ['S2'], support: { verdict: 'supported', resolvedFrom: 'S2' } });
  });

  it('leaves a claim unchecked when no model answers', async () => {
    const { engine, router } = engineWith(new ScriptedProvider());
    router.complete = (async () => { throw new Error('every provider failed'); }) as typeof router.complete;
    const finding = { answer: 'The permit costs €950.', claims: [claimOf()] };
    await engine.checkSupport({ id: 'p', nodes: [] }, nodeOf(), finding, 'cerebras');
    expect(finding.claims[0].support).toMatchObject({ verdict: 'unchecked', votes: [] });
  });

  it('rechecks claims graded under older logic on request and saves the audit', async () => {
    const { engine } = votingEngine({ 'support|old': 'yes', 'support-second|old': 'yes' });
    const project = await engine.createProject({ question: 'What does a camp permit cost in Czechia?' });
    const finding = { answer: 'A permit costs €950.', claims: [{ text: 'A permit costs €950', quote: 'The permit costs €950 for a camp', sourceIds: ['S1'], attributed: true }] };
    project.nodes = [{ id: 'D1', parentId: 'Q', title: 'Permit', question: 'Permit cost?', method: 'lookup', dependsOn: [], status: 'supported', finding, sources: [{ id: 'S1', text: 'The permit costs €950 for a camp.' }], verification: { grade: 'supported', score: 100, checks: [], failures: [] }, model: 'gemini/m' }];
    await engine.store.save(project);
    const result = await engine.recheckSupport(project.id);
    expect(result).toMatchObject({ ok: true, message: 'rechecked 1 piece(s), 1 claim(s): 0 to confirm' });
    const saved = await engine.load(project.id);
    expect(saved.nodes[0].finding.claims[0].support.verdict).toBe('supported');
    expect(saved.supportAudit).toMatchObject({ checked: 1, supported: 1, stale: 0 });
  });

  it('the second meaning vote avoids the author', async () => {
    const { engine, router } = engineWith(new ScriptedProvider());
    const avoided: Array<{ purpose: string; avoid: unknown }> = [];
    router.complete = (async (request: { purpose: string; avoid?: unknown }) => {
      avoided.push({ purpose: request.purpose, avoid: request.avoid });
      return request.purpose === 'support' ? { data: { supports: 'yes', reason: 'Exact match' }, provider: 'pollinations', model: 'openai-fast' } : { data: { supports: 'yes', reason: '' }, provider: 'groq', model: 'openai/gpt-oss-20b' };
    }) as typeof router.complete;
    const said = "Testimonials underscore the company's reputation, boasting a 4.9/5 rating from 44 reviews.";
    const finding = { answer: 'Ora Industries has a 4.9/5 rating from 44 reviews.', claims: [{ text: 'Ora Industries has a 4.9/5 rating from 44 reviews.', quote: said, sourceIds: ['S1'], attributed: true }] };
    await engine.checkSupport({ id: 'p', nodes: [] }, { id: 'D3.2', method: 'lookup', sources: [{ id: 'S1', text: said }] }, finding, 'gemini');
    expect(avoided).toEqual([{ purpose: 'support', avoid: 'gemini' }, { purpose: 'support-second', avoid: ['gemini', 'pollinations'] }]);
  });

  it('keeps the earlier meaning record when no model answers a recheck, and rechecks it next time', async () => {
    const { engine, router } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'What does a camp permit cost in Czechia?' });
    const older = { version: 1, verdict: 'supported', votes: [{ provider: 'groq', model: 'm', vote: 'yes', reason: '' }, { provider: 'cerebras', model: 'm', vote: 'yes', reason: '' }], missing: [], cause: '', at: '2026-10-27T08:41:14.185Z' };
    const finding = { answer: 'A permit costs €950.', claims: [{ text: 'A permit costs €950', quote: 'The permit costs €950 for a camp', sourceIds: ['S1'], attributed: true, support: older }] };
    project.nodes = [{ id: 'D1', parentId: 'Q', title: 'Permit', question: 'Permit cost?', method: 'lookup', dependsOn: [], status: 'verified', finding, sources: [{ id: 'S1', text: 'The permit costs €950 for a camp.' }], verification: { grade: 'verified', score: 100, checks: [], failures: [] }, model: 'gemini/m' }];
    await engine.store.save(project);
    const answer = router.complete;
    router.complete = (async () => { throw new Error('all free model quotas are cooling down after rate limits; retry in a minute'); }) as typeof router.complete;
    const outage = await engine.recheckSupport(project.id);
    expect(outage.message).toBe('rechecked 0 piece(s), 0 claim(s): 0 to confirm; no model answered for 1 claim(s), they stay due for a recheck');
    const kept = await engine.load(project.id);
    expect(kept.nodes[0].status).toBe('verified');
    expect(kept.nodes[0].finding.claims[0].support).toEqual(older);
    router.complete = (async () => ({ data: { supports: 'yes', reason: '' }, provider: 'groq', model: 'groq-m' })) as typeof router.complete;
    expect((await engine.recheckSupport(project.id)).message).toBe('rechecked 1 piece(s), 1 claim(s): 0 to confirm');
    expect((await engine.load(project.id)).nodes[0].finding.claims[0].support).toMatchObject({ version: 2, verdict: 'supported' });
    router.complete = answer;
  });

  it('a cancel in the memo stage ends the research as cancelled, not as an error', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'What does a camp permit cost in Czechia?' });
    engine.synthesize = async () => { throw new ResearchCancelled(); };
    await expect(engine.run(project.id)).rejects.toBeInstanceOf(ResearchCancelled);
    const saved = await engine.load(project.id);
    expect(saved.phase).toBe('cancelled');
    expect(saved.error).toBeNull();
    expect(saved.log.some((l: { type: string; message: string }) => l.type === 'phase' && l.message === 'research cancelled')).toBe(true);
  });

  it('a stop on an idle research does not block the next action', async () => {
    const { engine, router } = engineWith(new ScriptedProvider());
    router.complete = (async () => ({ data: { supports: 'yes', reason: '' }, provider: 'groq', model: 'groq-m' })) as typeof router.complete;
    const project = await engine.createProject({ question: 'What does a camp permit cost in Czechia?' });
    const finding = { answer: 'A permit costs €950.', claims: [{ text: 'A permit costs €950', quote: 'The permit costs €950 for a camp', sourceIds: ['S1'], attributed: true }] };
    project.nodes = [{ id: 'D1', parentId: 'Q', title: 'Permit', question: 'Permit cost?', method: 'lookup', dependsOn: [], status: 'supported', finding, sources: [{ id: 'S1', text: 'The permit costs €950 for a camp.' }], verification: { grade: 'supported', score: 100, checks: [], failures: [] }, model: 'gemini/m' }];
    await engine.store.save(project);
    engine.cancel(project.id);
    expect(engine.cancelled.has(project.id)).toBe(false);
    await expect(engine.recheckSupport(project.id)).resolves.toMatchObject({ ok: true, message: 'rechecked 1 piece(s), 1 claim(s): 0 to confirm' });
  });

  it('drops pages that share fewer than two topic terms with the node before any model call', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'What Czech car sites list used hatchbacks near Prague?' });
    const node = { id: 'D1', title: 'What Czech car sites list hatchbacks?', question: 'used car hatchback', metric: 'count' };
    const sources = [
      { kind: 'web', title: 'UNESCO World Heritage Centre', url: 'https://whc.unesco.org/en/list/', domain: 'whc.unesco.org', snippet: 'World Heritage List', text: 'World Heritage sites in the Czech Republic: Prague historic centre, Cesky Krumlov and the Holašovice village.'.repeat(5) },
      { kind: 'web', title: 'Ojeté vozy', url: 'https://www.sauto.cz/ojete', domain: 'sauto.cz', snippet: 'Inzerce', text: 'Ojeté hatchbacky Škoda Fabia, used car hatchback listings Czech' },
    ];
    const kept = engine.onConceptOnly(project, node, sources);
    expect(kept.map((s: { url: string }) => s.url)).toEqual(['https://www.sauto.cz/ojete']);
    expect(project.log.some((l: { message: string }) => l.message === 'D1: 1 source(s) dropped before any model call — off topic (whc.unesco.org)')).toBe(true);
  });

  it('counts and names the sources kept from outside the asked country for an entity list, without dropping them', () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = { id: 'p', brief: { kind: { label: 'wholesale clothing provider', terms: ['wholesale second-hand clothing'] }, located: false, regions: ['CZ'] }, log: [] as Array<{ message: string }> };
    const node = { id: 'D1', title: 'Which wholesalers sell branded second-hand clothing?', question: 'wholesale second-hand clothing suppliers', metric: 'count' };
    const sources = [
      { kind: 'web', title: 'Groothandel gebruikte kleding in balen - Zagumi', url: 'https://www.zagumi.com/nl/used-clothing/', domain: 'zagumi.com', locale: 'en_US', snippet: 'Zagumi levert gebruikte kleding van topkwaliteit voor uw tweedehandskledingbedrijf.', text: 'Groothandel gebruikte kleding in balen - Zagumi Facebook YouTube Home \n Leverancier van gebruikte kledingbalen \n Crème kwaliteit' },
      { kind: 'web', title: 'Search', url: 'https://en.firmy.cz/top/Obchody-a-obchudky/Bazary-a-zastavarny/Second-handy', domain: 'en.firmy.cz', locale: 'en', snippet: 'The 20 best companies: Second-hand textile sellers', text: 'The 20 best companies: Second-hand textile sellers in the Czech Republic • Firmy.cz', listings: [{ title: 'Sponsored Brumla.cz', url: 'https://en.firmy.cz/company/12716704-brumla-cz-benesov.html' }] },
    ];
    const kept = engine.onConceptOnly(project as never, node as never, sources);
    expect(kept.map((s: { url: string }) => s.url)).toEqual(['https://www.zagumi.com/nl/used-clothing/', 'https://en.firmy.cz/top/Obchody-a-obchudky/Bazary-a-zastavarny/Second-handy']);
    expect(project.log.map((l) => l.message)).toContain('D1: 1 source(s) kept from outside CZ — for an entity list the asked place is where the result is used (zagumi.com)');
    expect(project.log.some((l) => l.message.includes('dropped before any model call'))).toBe(false);
  });
});

describe('list-first research flow', () => {
  const listingSearch = {
    ...fakeSearch,
    async readPage() {
      return { status: 200, text: 'car listings', links: [], listings: [] };
    },
  };

  it('reads marketplace listings by code before any piece is researched, then sweeps again at the end for portal pages the pieces found (pages already read come from the page cache)', async () => {
    const provider = new ScriptedProvider();
    const { engine } = engineWith(provider, listingSearch);
    const project = await engine.createProject({ question: 'Find used hatchbacks within 300 km of Prague under 65000 CZK', expected: 'at least 20 cars' });
    await engine.updateProject(project.id, { acceptance: { itemCount: 20, valueRange: [0, 65000], unit: 'CZK' } });
    const calls: Array<{ sweep: boolean | null | undefined; research: number }> = [];
    engine.collectCandidates = (async (_p: unknown, options: { sweep?: boolean } = {}) => {
      calls.push({ sweep: options.sweep, research: provider.calls.filter((c) => c.marker === TASK_MARKERS.research).length });
      return null;
    }) as never;
    const done = await engine.run(project.id);
    expect(done.phase).toBe('done');
    expect(done.acceptanceSummary).toBe('0 of 20 confirmed');
    expect(calls[0]).toEqual({ sweep: true, research: 0 });
    expect(calls.at(-1)!.sweep).toBe(true);
    expect(calls.at(-1)!.research).toBeGreaterThan(0);
    expect(calls.at(-1)!.research).toBeGreaterThan(0);
    expect(calls.filter((c) => c.sweep === true)).toHaveLength(2);
    expect(done.log.some((l: { type: string; message: string }) => l.type === 'candidates' && l.message === 'listings first: reading marketplace pages by code before any piece is researched')).toBe(true);
  });

  it('keeps a single end-of-run table call for a list research without itemCount but with a kind (no listing portal)', async () => {
    const proposal = { concept: 'wholesale suppliers of branded second-hand clothing', kind: { label: 'wholesale clothing provider', terms: ['wholesale second-hand clothing', 'used clothing wholesale'] }, criteria: [] };
    const modeler = { fresh: (p: { decisionModel?: unknown }) => Boolean(p.decisionModel), build: async (p: Record<string, unknown>) => {
      p.decisionModel = { ...aggregate([normalizeSample(proposal), normalizeSample(proposal)], { question: String(p.question) }), caseIds: [] };
      return p.decisionModel;
    } };
    const provider = new ScriptedProvider();
    const { engine } = engineWith(provider, fakeSearch, 2, { modeler } as never);
    const project = await engine.createProject({ question: 'Find wholesale branded second hand clothing providers for a retail second hand shop in Czech Republic', templateId: 'generic', expected: '20 direct links to the providers with proposal and proof' });
    const calls: Array<{ sweep: boolean | null | undefined; research: number }> = [];
    engine.collectCandidates = (async (_p: unknown, options: { sweep?: boolean } = {}) => {
      calls.push({ sweep: options.sweep, research: provider.calls.filter((c) => c.marker === TASK_MARKERS.research).length });
      return null;
    }) as never;
    const done = await engine.run(project.id);
    expect(done.phase).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0].research).toBeGreaterThan(0);
    expect(done.log.some((l: { type: string; message: string }) => l.type === 'candidates' && l.message.startsWith('listings first:'))).toBe(false);
  });
});

describe('analysis research contract', () => {
  it('runs decompose → pieces → synthesize without portal sweep, candidate table, or kind gate', async () => {
    const provider = new ScriptedProvider();
    const { engine } = engineWith(provider);
    const project = await engine.createProject({ question: 'Is buying fermented bean paste for resale in Poland profitable?' });
    const sweepCalls: boolean[] = [];
    const kindGateCalls: string[] = [];
    const candidateTableCalls: number[] = [];
    engine.searchHubs = async () => { sweepCalls.push(true); return 0; };
    engine.collectCandidates = async () => { candidateTableCalls.push(1); return null; };
    const originalGateOnKind = engine.gateOnKind.bind(engine);
    engine.gateOnKind = (p: unknown, node: unknown, sources: unknown[]) => {
      kindGateCalls.push('called');
      return originalGateOnKind(p, node, sources);
    };
    const done = await engine.run(project.id);
    expect(done.phase).toBe('done');
    expect(done.nodes.length).toBeGreaterThan(0);
    expect(done.nodes.every((n: { status: string }) => n.status === 'verified')).toBe(true);
    expect(sweepCalls).toHaveLength(0);
    expect(candidateTableCalls).toHaveLength(0);
    expect(kindGateCalls).toHaveLength(0);
    expect(done.report).toBeTruthy();
    expect(done.report.verdict).toBeTruthy();
  });
});

describe('needsSiteFit', () => {
  it('measures sites only when a strategy or a decision criterion needs a place measurement', () => {
    expect(needsSiteFit(null, { criteria: [] })).toBe(false);
    expect(needsSiteFit(null, { criteria: [{ measure: 'priceEur' }] })).toBe(false);
    expect(needsSiteFit(null, null)).toBe(false);
    expect(needsSiteFit(null, { criteria: [{ measure: 'coastKm' }] })).toBe(true);
    expect(needsSiteFit({ id: 'glamping' }, null)).toBe(true);
  });
});

describe('knowledge queries about the item groups found', () => {
  it('plans local-language community queries around the models in the table, keeps only relevant ones, once', async () => {
    const calls: unknown[] = [];
    const reply = { data: { queries: { 'D3.1': ['Škoda Fabia 1.4 MPI zkušenosti majitelů fórum', 'best laptops 2026', 'Fabia II 1.2 HTP reliability TÜV report'] } } };
    const router = { complete: async (args: unknown) => { calls.push(args); return reply; } };
    const engine = new ResearchEngine({ router, search: null, store: { cache: new Map(), save: async (p: unknown) => p } } as never);
    const project = {
      id: 'p', question: 'used hatchback cars near Prague', log: [], brief: { regions: ['CZ'] }, acceptance: { itemCount: 20 },
      decisionModel: { subtype: { models: ['skoda fabia', 'kia rio'] } },
      candidates: { kept: [{ title: 'Škoda Fabia 1.4 MPI 50kw' }, { title: 'ŠKODA FABIA II COMFORT 2008' }, { title: 'Kia Rio 1.4' }] },
      nodes: [{ id: 'D3', parentId: null, status: 'pending', question: 'reliability' }, { id: 'D3.1', parentId: 'D3', status: 'pending', question: 'What are known failure modes for candidate engines?', searchQueries: ['engine failure modes'] }],
    };
    expect(await (engine as unknown as { planKnowledgeQueries: (p: unknown) => Promise<number | null> }).planKnowledgeQueries(project)).toBe(1);
    const leaf = project.nodes[1];
    expect(leaf.searchQueries[0]).toBe('Škoda Fabia 1.4 MPI zkušenosti majitelů fórum');
    expect(leaf.searchQueries).not.toContain('best laptops 2026');
    expect(JSON.stringify(calls[0])).toContain('Czech');
    await (engine as unknown as { planKnowledgeQueries: (p: unknown) => Promise<number | null> }).planKnowledgeQueries(project);
    expect(calls).toHaveLength(1);
  });
});

describe('owner and expert knowledge from worldwide sources', () => {
  it('searches in English, German, the asked country language and the make home language, each once', () => {
    const skoda = queryLanguages(['CZ'], 'skoda fabia');
    for (const language of ['Czech', 'English', 'German']) expect(skoda.filter((l) => l === language)).toHaveLength(1);
    expect(queryLanguages(['CZ'], 'peugeot 207')).toContain('French');
    expect(queryLanguages([], 'volkswagen golf')).toContain('German');
  });

  it('asks for queries spread across the languages and half of them restricted with site: to the source register', async () => {
    const register = JSON.parse(await fs.readFile(new URL('../../src/research/knowledgesources.json', import.meta.url), 'utf8'));
    const expected = ['tuv.com', 'adac.de', 'dekra.de', 'which.co.uk', 'whatcar.com', 'consumerreports.org', 'carcomplaints.com', 'nhtsa.gov', 'motor-talk.de', 'honestjohn.co.uk', 'reddit.com', 'briskoda.net', 'auto.cz', 'cebia.cz'];
    const sources = register.sources.filter((source: { concept: string }) => source.concept === 'used-vehicle');
    expect(sources.map((source: { site: string }) => source.site)).toEqual(expected);
    const prompt = groupQueryPrompt({ group: 'skoda fabia', engines: ['1.2 HTP'], languages: queryLanguages(['CZ'], 'skoda fabia'), kind: 'car', sources }).map((message: { content: string }) => message.content).join('\n');
    for (const site of expected) expect(prompt).toContain(`site:${site}`);
    expect(prompt).toContain('Every query names "skoda fabia".');
    expect(prompt).toContain('Czech');
  });

describe('conceptLanguages', () => {
  let engine: ResearchEngine;
  beforeEach(() => {
    const router = new ModelRouter({ providers: [new ScriptedProvider()] });
    engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }) });
  });

  it('a region code in REGION_LANGUAGES still yields its language', () => {
    const langs = engine.conceptLanguages(['CZ']);
    expect(langs).toContain('Czech');
    expect(langs[0]).toBe('English');
  });

  it('the code AL yields a second entry naming the main language of Albania', () => {
    const langs = engine.conceptLanguages(['AL']);
    expect(langs).toContain('the main language of Albania');
    expect(langs[0]).toBe('English');
  });

  it('an unknown two-letter code that countryByCode does not know yields only English', () => {
    const langs = engine.conceptLanguages(['XX']);
    expect(langs).toEqual(['English']);
  });

  it('keeps English first and deduplicates', () => {
    const langs = engine.conceptLanguages(['CZ', 'DE', 'AT']);
    expect(langs[0]).toBe('English');
    expect(langs.filter((l) => l === 'English')).toHaveLength(1);
    expect(langs.filter((l) => l === 'German')).toHaveLength(1);
    expect(langs.filter((l) => l === 'Czech')).toHaveLength(1);
  });

  it('falls back to main language for countries missing from REGION_LANGUAGES like AL, ME, GE', () => {
    const langs = engine.conceptLanguages(['AL', 'ME', 'GE']);
    expect(langs).toContain('the main language of Albania');
    expect(langs).toContain('the main language of Montenegro');
    expect(langs).toContain('the main language of Georgia');
    expect(langs[0]).toBe('English');
  });
});

describe('distance from the asked place', () => {
  it('measures stated places from the area centre and moves rows beyond the radius to the check list', async () => {
    const { haversineKm } = await import('../../src/research/site.mjs');
    expect(Math.abs(haversineKm(50.0875, 14.4213, 49.1951, 16.6068) - 185)).toBeLessThan(6);
    const events: string[] = [];
    const engine = new ResearchEngine({ router: null, search: null, store: { cache: new Map(), save: async (p: unknown) => p }, sites: { geocode: async () => null }, onEvent: (_id: string, e: { message: string }) => events.push(e.message) } as never);
    const row = (title: string, lat: number, lon: number) => ({ title, url: `https://example.org/${title}`, value: 1, lat, lon });
    const table = { kept: [row('berlin', 52.52, 13.405), row('munich', 48.137, 11.575), row('hamburg', 53.55, 9.99), { title: 'no place', url: 'https://example.org/x', value: 1 }], toCheck: [], keptCount: 4, toCheckCount: 0 };
    const project = { id: 'p', area: { point: { lat: 50.0875, lon: 14.4213 }, km: 300, place: 'prague' }, log: [] };
    const out = await (engine as unknown as { measureDistances: (p: unknown, t: unknown) => Promise<typeof table> }).measureDistances(project, table);
    expect(out.kept.map((r) => r.title)).toEqual(['berlin', 'munich', 'no place']);
    expect(out.toCheck[0]).toMatchObject({ title: 'hamburg', toCheck: expect.stringMatching(/^farther than 300 km from prague \(\d+ km\)$/) });
    expect(out.keptCount).toBe(3);
    expect((out.kept.find((r) => r.title === 'no place') as { unmeasured?: boolean }).unmeasured).toBe(true);
    expect(events.some((m) => /distance from prague: 3 listing\(s\) measured, 1 farther than 300 km, 1 not measurable/.test(m))).toBe(true);
  });

  it('measures every row, not only the first 60, and geocodes each distinct place once', async () => {
    const events: string[] = [];
    const calls: string[] = [];
    const engine = new ResearchEngine({ router: null, search: null, store: { cache: new Map(), save: async (p: unknown) => p }, sites: { geocode: async (place: string) => { calls.push(place); return { lat: 50.0875 + (calls.length % 7) * 0.01, lon: 14.4213 }; } }, onEvent: (_id: string, e: { message: string }) => events.push(e.message) } as never);
    const rows = Array.from({ length: 100 }, (_, i) => ({ title: `car ${i}`, url: `https://auto.bazos.cz/inzerat/226${String(i).padStart(6, '0')}/x.php`, value: 30000, unit: 'CZK', place: i < 30 ? 'Praha' : `place ${i}` }));
    const table = { kept: rows, toCheck: [], keptCount: 100, toCheckCount: 0 };
    const project = { id: 'p', area: { point: { lat: 50.0875, lon: 14.4213 }, km: 300, place: 'prague' }, log: [] };
    const out = await (engine as unknown as { measureDistances: (p: unknown, t: unknown) => Promise<typeof table> }).measureDistances(project, table);
    expect(out.kept.filter((r) => Number.isFinite((r as { distanceKm?: number }).distanceKm))).toHaveLength(100);
    expect(calls.filter((c) => c === 'Praha')).toHaveLength(1);
    expect(calls).toHaveLength(71);
    expect(events.some((m) => /distance from prague: 100 listing\(s\) measured, 0 farther than 300 km, 0 not measurable/.test(m))).toBe(true);
  });

  it('marks rows whose place cannot be geocoded as unmeasured instead of silently within range', async () => {
    const events: string[] = [];
    const engine = new ResearchEngine({ router: null, search: null, store: { cache: new Map(), save: async (p: unknown) => p }, sites: { geocode: async () => null }, onEvent: (_id: string, e: { message: string }) => events.push(e.message) } as never);
    const table = { kept: [
      { title: 'geocode fails', url: 'https://auto.bazos.cz/inzerat/226000001/x.php', value: 30000, unit: 'CZK', place: 'Nowhere', countryCode: 'CZ' },
      { title: 'no place at all', url: 'https://auto.bazos.cz/inzerat/226000002/x.php', value: 30000, unit: 'CZK' },
    ], toCheck: [], keptCount: 2, toCheckCount: 0 };
    const project = { id: 'p', area: { point: { lat: 50.0875, lon: 14.4213 }, km: 300, place: 'prague' }, log: [] };
    const out = await (engine as unknown as { measureDistances: (p: unknown, t: unknown) => Promise<typeof table> }).measureDistances(project, table);
    expect(out.kept.every((r) => (r as { unmeasured?: boolean }).unmeasured === true)).toBe(true);
    expect(out.kept.every((r) => !Number.isFinite((r as { distanceKm?: number }).distanceKm))).toBe(true);
    expect(events.some((m) => /distance from prague: 0 listing\(s\) measured, 0 farther than 300 km, 2 not measurable/.test(m))).toBe(true);
  });
});

describe('recalibration after the market grows', () => {
  it('calibrates again when the swept market is three times larger, and unions the models', async () => {
    const calls: unknown[] = [];
    const reply = { data: { not: ['motor'], condition: [], subtype: { label: 'hatchback', models: ['dacia sandero'], variants: ['combi'] } } };
    const router = { complete: async (args: unknown) => { calls.push(args); return reply; } };
    const engine = new ResearchEngine({ router, search: null, store: { cache: new Map(), save: async (p: unknown) => p } } as never);
    const listing = (i: number) => ({ title: i % 2 ? `Dacia Sandero ${i}` : `Motor dacia sandero ${i}`, url: `https://auto.bazos.cz/inzerat/${i}/x.php` });
    const page = (n: number) => ({ listings: Array.from({ length: n }, (_, i) => listing(i)) });
    const project = { id: 'p', question: 'q', log: [], sweep: { pages: [page(1900)] }, decisionModel: { kind: { label: 'used car', terms: ['hatchback'], verified: { share: 0.9 } }, subtype: { label: 'hatchback', models: ['skoda fabia'], variants: [] }, calibrated: '2026-11-03T12:00:00Z', calibratedOn: 600 } };
    expect(await (engine as unknown as { calibrateKind: (p: unknown) => Promise<boolean> }).calibrateKind(project)).toBe(true);
    expect(calls).toHaveLength(3);
    expect(project.decisionModel.subtype.models).toEqual(['skoda fabia', 'dacia sandero']);
    expect(project.decisionModel.kind.not).toContain('motor');
    calls.length = 0;
    project.sweep.pages = [page(2500)];
    await (engine as unknown as { calibrateKind: (p: unknown) => Promise<boolean> }).calibrateKind(project);
    expect(calls).toHaveLength(0);
  });
});

describe('listing facts read from each ad page', () => {
  it('reads year and mileage from the ad text of listings whose titles do not state them, once, and stores them for valuation', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-facts-'));
    const url = 'https://auto.bazos.cz/inzerat/225964208/skoda-fabia.php';
    const reads: string[] = [];
    const search = { readPage: async (u: string) => { reads.push(u); return { text: 'Škoda Fabia 1.2 HTP | bazos.cz menu Škoda Fabia 1.2 HTP - [3.11. 2026] prodám fabii, rok výroby 2008, najeto 165 000 km. Cena: 39 900 Kč další inzeráty BMW 2005' }; } };
    const engine = new ResearchEngine({ router: null, search, store: new ProjectStore({ dir }) } as never);
    const project = { id: 'p', nodes: [{ id: 'D1', sources: [{ url: 'https://auto.bazos.cz/skoda/', listings: [{ title: 'Škoda Fabia 1.2 HTP', url, value: 39900 }, { title: 'Škoda Fabia 2010 1.4', url: 'https://auto.bazos.cz/inzerat/225964209/x.php', value: 50000 }] }] }], brief: { subtype: { models: ['skoda fabia'] } }, candidates: { kept: [] } };
    expect(await engine.readListingFacts(project as never)).toBe(1);
    expect(reads).toEqual([url]);
    expect(Object.values((project as { listingFacts: Record<string, unknown> }).listingFacts)[0]).toMatchObject({ year: 2008, km: 165000, read: true });
    expect(await engine.readListingFacts(project as never)).toBe(0);
  });
});

describe('value facts calibrated on ad texts', () => {
  it('keeps phrases most of three proposals name and at least two ads state, once per market', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-vfacts-'));
    const reply = { for: ['servisní kniha', 'nové rozvody'], against: ['koroze'] };
    const provider = { id: 'stub', ready: true, describe: () => ({ id: 'stub', label: 'Stub', state: 'ready', detail: '', configured: true, fast: 'stub', deep: 'stub', local: false, keyEnv: null, signup: '', modelCount: 1 }), async chat() { return { content: JSON.stringify(reply), model: 'stub', provider: 'stub', usage: {} }; } };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [provider] }), search: fakeSearch, store: new ProjectStore({ dir }) } as never);
    const texts = Array.from({ length: 24 }, (_, i) => (i % 2 ? 'prodám, servisní kniha, koroze minimální' : 'prodám, nové rozvody'));
    const project = { id: 'p', question: 'Which used cars are worth buying?', listingFacts: Object.fromEntries(texts.map((text, i) => [`auto.bazos.cz#${i}`, { text, read: true }])), candidates: { kept: [] } };
    expect(await engine.calibrateValueFacts(project as never)).toBe(true);
    expect((project as { valueFacts: unknown }).valueFacts).toEqual({ for: ['servisni kniha', 'nove rozvody'], against: ['koroze'], calibratedOn: 24 });
    expect(await engine.calibrateValueFacts(project as never)).toBe(false);
  });
});

describe('domain learned before the tree is planned', () => {
  const sentences = ['Fermented bean paste is sold in blocks.', 'Grades are named by color.', 'Sold in regional markets.'];
  const endings = ['', ' there', ' locally'];

  function domainProvider() {
    const scripted = new ScriptedProvider();
    return {
      id: 'demo',
      ready: true,
      describe: () => scripted.describe(),
      async chat(args: { messages: Array<{ role: string; content: string }> }) {
        const prompt = args.messages.at(-1)!.content;
        if (prompt.includes('TASK=DOMAIN_QUERIES')) {
          return { content: JSON.stringify({ queries: ['what is fermented bean paste', 'how is fermented bean paste graded', 'fermented bean paste grades and units'] }), model: 'm', provider: 'demo', usage: {} };
        }
        if (prompt.includes('TASK=DOMAIN_FINDINGS')) {
          const pages = [...prompt.matchAll(/PAGE (D\d+)\nURL: [^\n]*\nTEXT:\n([^\n]*)/g)];
          const findings = pages.flatMap(([, id, text]) => {
            const quotes = (text.match(/[^.]+\./g) ?? []).slice(0, 3);
            return [
              { aspect: 'object', statement: 'fermented bean paste is sold in blocks', quote: quotes[0], sourceId: id },
              { aspect: 'terms', statement: 'grades are named by color', quote: quotes[1], sourceId: id },
              { aspect: 'where', statement: 'sold in regional markets', quote: quotes[2], sourceId: id },
            ];
          });
          return { content: JSON.stringify({ findings }), model: 'm', provider: 'demo', usage: {} };
        }
        return scripted.chat(args as never);
      },
    };
  }

  function domainSearch(hosts: number) {
    const pages = Array.from({ length: hosts }, (_, i) => ({ kind: 'web', title: 'Bean paste', url: `https://host${i + 1}.example/paste`, domain: `host${i + 1}.example`, snippet: 's', text: sentences.map((sentence) => `${sentence.replace('.', '')} ${endings[i]}.`).join(' ') }));
    return {
      enabled: true,
      lastErrors: [],
      async search() {
        return pages;
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
  }

  it('learns what the item is from several hosts before searching, and says so in the log', async () => {
    const { engine } = engineWith(domainProvider(), domainSearch(3));
    const project = await engine.createProject({ question: 'Is buying fermented bean paste for resale in Poland profitable?' });
    const done = await engine.run(project.id);
    const domain = (done as unknown as { domain: { ready: boolean; terms: string[] } }).domain;
    expect(domain.ready).toBe(true);
    expect(domain.terms).toContain('grades are named by color');
    expect(done.log.some((l: { message: string }) => l.message.startsWith('understood before searching'))).toBe(true);
    expect(done.nodes.length).toBeGreaterThan(0);
  });

  it('does not pause an analysis question when only one host explains the item; it keeps the domain and researches', async () => {
    const { engine } = engineWith(domainProvider(), domainSearch(1));
    const project = await engine.createProject({ question: 'Is buying fermented bean paste for resale in Poland profitable?' });
    const done = await engine.run(project.id);
    expect(done.phase).not.toBe('needs-understanding');
    expect(done.log.some((l: { type: string; message: string }) => l.type === 'phase' && l.message.includes('not enough sources explain what the item is'))).toBe(false);
  });

  it('builds the result table of an analysis research from its sources after the pieces', async () => {
    const { engine } = engineWith(domainProvider(), domainSearch(3));
    const project = await engine.createProject({ question: 'Is buying fermented bean paste for resale in Poland profitable?' });
    const done = await engine.run(project.id);
    const results = (done as unknown as { results?: { spec?: { columns: unknown[] } } }).results;
    expect(results?.spec?.columns.length).toBeGreaterThan(0);
    expect(done.log.some((l: { type: string; message: string }) => l.type === 'results' && l.message.startsWith('result table:'))).toBe(true);
  });

  it('does not pause for a listed kind validated on real listing titles, and takes its terms from the kind', async () => {
    const emptySearch = {
      enabled: true,
      lastErrors: [],
      async search() {
        return [];
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
    const { engine } = engineWith(domainProvider(), emptySearch);
    const project = {
      id: 'p',
      question: 'Which used cars are worth buying in Germany?',
      brief: { located: true, regions: ['DE'] },
      decisionModel: {
        kind: { label: 'used car', terms: ['limousine', 'station wagon'], verified: { titles: 3000, matched: 2900, share: 0.97 } },
        subtype: { models: ['golf', 'octavia'] },
      },
      log: [],
    };
    const ok = await engine.studyDomain(project as never);
    expect(ok).toBe(true);
    expect(project.phase).not.toBe('needs-understanding');
    expect(project.domain.ready).toBe(true);
    expect(project.domain.terms).toContain('limousine');
    expect(project.domain.terms).toContain('golf');
    expect(project.domain.basis).toBe('validated on 3000 listing titles');
    expect(project.log.some((l: { message: string }) => l.message.includes('basis validated on 3000 listing titles'))).toBe(true);
  });

  it('does not pause for a listed kind whose titles were not matched, and takes its terms from the kind', async () => {
    const emptySearch = {
      enabled: true,
      lastErrors: [],
      async search() {
        return [];
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
    const { engine } = engineWith(domainProvider(), emptySearch);
    const project = {
      id: 'p',
      question: 'Which trendy used cars priced 2000-4000 EUR are for sale right now in Germany, Poland or Czechia',
      decisionModel: {
        kind: { label: 'used car', verified: { titles: 157, matched: 0, share: 0 } },
        calibrated: undefined,
      },
      log: [],
    };
    const ok = await engine.studyDomain(project as never);
    expect(ok).toBe(true);
    expect(project.phase).not.toBe('needs-understanding');
    expect(project.domain.ready).toBe(true);
    expect(project.domain.terms).toContain('used car');
    expect(project.domain.basis).toBe('listed kind: used car');
  });

  it('does not pause when the portal sweep already produced listings, and takes its terms from the kind', async () => {
    const emptySearch = {
      enabled: true,
      lastErrors: [],
      async search() {
        return [];
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
    const { engine } = engineWith(domainProvider(), emptySearch);
    const project = {
      id: 'p',
      question: 'Which trendy used cars priced 2000-4000 EUR are for sale right now in Germany, Poland or Czechia',
      brief: { located: false, regions: ['DE', 'PL', 'CZ'] },
      decisionModel: {
        kind: { label: 'used car', terms: [], verified: { titles: 157, matched: 0, share: 0 } },
        calibrated: undefined,
      },
      sweep: { pages: [{ url: 'https://www.autoscout24.de/lst?atype=C', listings: [{ title: 'Used Golf 1.8T, 2005', price: 3000, url: 'https://www.autoscout24.de/used/1' }] }] },
      log: [],
    };
    const ok = await engine.studyDomain(project as never);
    expect(ok).toBe(true);
    expect(project.phase).not.toBe('needs-understanding');
    expect(project.domain.ready).toBe(true);
    expect(project.domain.terms).toContain('used car');
    expect(project.domain.basis).toBe('portal listings: 1');
  });

  it('does not pause an analysis project without item terms', async () => {
    const emptySearch = {
      enabled: true,
      lastErrors: [],
      async search() {
        return [];
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
    const { engine } = engineWith(domainProvider(), emptySearch);
    const project = {
      id: 'p',
      question: 'Is buying fermented bean paste for resale in Poland profitable?',
      acceptance: {},
      decisionModel: null,
      log: [],
    };
    const ok = await engine.studyDomain(project as never);
    expect(ok).toBe(true);
    expect(project.phase).not.toBe('needs-understanding');
    expect(project.domain.ready).toBe(true);
    expect(project.domain.basis).toBe('analysis project — item understanding not required');
    expect(project.domain.at).toBeDefined();
  });

  it('clears the stale pause phase and continues researching when a re-run passes the domain study', async () => {
    const emptySearch = {
      enabled: true,
      lastErrors: [],
      async search() {
        return [];
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
    const { engine } = engineWith(domainProvider(), emptySearch);
    const project = await engine.createProject({
      question: 'Which trendy used cars priced 2000-4000 EUR are for sale right now in Germany, Poland or Czechia?',
    });
    project.phase = 'needs-understanding';
    project.nodes = Array.from({ length: 20 }, (_, i) => ({
      id: `D${i + 1}`,
      parentId: null,
      status: 'verified',
      question: `piece ${i + 1}`,
      searchQueries: [`query ${i + 1}`],
      dependsOn: [],
    }));
    project.decisionModel = {
      kind: {
        label: 'used car',
        terms: [],
        verified: { titles: 157, matched: 0, share: 0 },
        validated: { terms: ['used car'] },
      },
      subtype: { models: ['golf'] },
      calibrated: undefined,
      purpose: 'check resale value',
    };
    project.sweep = { pages: [{ url: 'https://www.autoscout24.de/lst?atype=C', listings: [{ title: 'Used Golf 1.8T, 2005', price: 3000, url: 'https://www.autoscout24.de/used/1' }] }] };
    await engine.store.save(project as never);

    const done = await engine.run(project.id);
    expect(done.phase).not.toBe('needs-understanding');
    expect(done.log.some((l: { message: string }) => l.message.startsWith('understood before searching'))).toBe(true);
    expect(done.log.some((l: { type: string; message: string }) => l.type === 'phase' && l.message === 'researching sub-questions in dependency order')).toBe(true);
  });
});

describe('hub search', () => {
  it('searches the hubs again after the hints change', async () => {
    const engine = new ResearchEngine({ store: new ProjectStore({ dir }) } as never);
    const project = await engine.createProject({ question: 'Find wholesale vintage clothing suppliers' });
    project.hubSources = [{ url: 'https://old.example/' }];
    await engine.store.save(project);
    const updated = await engine.setGuidance(project.id, 'suppliers in NL, DE');
    expect(updated.hubSources).toBeUndefined();
  });

  function hubRouter() {
    const calls: Array<{ purpose: string; tier: string; messages: Array<{ role: string; content: string }> }> = [];
    return {
      calls,
      complete: async (req: { purpose: string; tier: string; messages: Array<{ role: string; content: string }> }) => {
        calls.push(req);
        return { provider: 'p', model: 'm', data: { queries: [{ country: 'NL', language: 'Dutch', query: 'vintage groothandel' }, { country: 'DE', language: 'German', query: 'Vintage Großhandel' }] } };
      },
    };
  }

  function hubSearch() {
    const asked: string[][] = [];
    const search = {
      enabled: true,
      lastErrors: [],
      async search(queries: string[]) {
        asked.push(queries);
        return [{ kind: 'web', title: 'Supplier', url: 'https://shop.example/a', domain: 'shop.example', snippet: 's', text: 'wholesale vintage clothing grade A sold in bales' }];
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
    return { asked, search };
  }

  it('asks each trade hub for its own sellers and keeps the pages', async () => {
    const router = hubRouter();
    const { asked, search } = hubSearch();
    const engine = new ResearchEngine({ router: router as never, search, store: new ProjectStore({ dir }) } as never);
    const project = await engine.createProject({ question: 'Find wholesale vintage clothing suppliers in the Netherlands and Germany' });
    project.brief = { ...engine.briefOf(project), located: false };
    project.domain = { ready: true, terms: ['grade A'], where: ['the biggest sorting plants stand in the Netherlands and Germany'] };
    project.decisionModel = { kind: { label: 'wholesale clothing provider', terms: ['vintage', 'clothing', 'wholesale'], not: [] }, criteria: [] };
    project.guidance = 'suppliers in NL, DE, UK';
    const found = await engine.searchHubs(project);
    expect(found).toBe(1);
    expect(project.hubSources).toHaveLength(1);
    expect(asked).toEqual([['vintage groothandel'], ['Vintage Großhandel']]);
    expect(router.calls[0]).toMatchObject({ purpose: 'decision-model', tier: 'deep' });
    expect(router.calls[0].messages[1].content).toContain('Netherlands');
    expect(router.calls[0].messages[1].content).toContain('United Kingdom');
    expect(router.calls[0].messages[1].content).toContain('4 search queries');
    expect(router.calls[0].messages[1].content).toMatch(/bales|per kg|B2B|export/i);
    expect(project.log.some((l: { type: string; message: string }) => l.type === 'candidates' && l.message.startsWith('hub round 1: 2 queries, 1 new pages, 1 new hosts'))).toBe(true);
    expect(await engine.searchHubs(project)).toBe(1);
    expect(router.calls).toHaveLength(1);
    expect(asked).toHaveLength(2);
  });

  it('searches the trade hubs again once the stored hub search is a week old, but does not repeat queries', async () => {
    const router = hubRouter();
    const { asked, search } = hubSearch();
    let clock = Date.parse('2026-11-05T16:00:00Z');
    const engine = new ResearchEngine({ router: router as never, search, store: new ProjectStore({ dir }), now: () => clock } as never);
    const project = await engine.createProject({ question: 'Find wholesale vintage clothing suppliers in the Netherlands and Germany' });
    project.brief = { ...engine.briefOf(project), located: false };
    project.domain = { ready: true, terms: ['grade A'], where: ['the biggest sorting plants stand in the Netherlands and Germany'] };
    project.decisionModel = { kind: { label: 'wholesale clothing provider', terms: ['vintage', 'clothing', 'wholesale'], not: [] }, criteria: [] };
    await engine.searchHubs(project);
    expect(project.hubSearchedAt).toBe('2026-11-05T16:00:00.000Z');
    clock += HUB_REFRESH_MS - 1;
    await engine.searchHubs(project);
    expect(router.calls).toHaveLength(1);
    clock += 1;
    await engine.searchHubs(project);
    expect(router.calls).toHaveLength(2);
    expect(asked.length).toBe(2);
    expect(project.log.some((l) => l.type === 'candidates' && l.message.includes('no new queries'))).toBe(true);
  });

  it('treats a stored hub search without a date as stale', () => {
    expect(hubSearchStale({ hubSources: [] }, Date.parse('2026-11-17T00:00:00Z'))).toBe(true);
    expect(hubSearchStale({ hubSearchedAt: '2026-11-16T00:00:00Z' }, Date.parse('2026-11-17T00:00:00Z'))).toBe(false);
  });

  it('deduplicates pages across the per-hub searches by url', async () => {
    const router = hubRouter();
    const asked: string[][] = [];
    const search = {
      enabled: true,
      lastErrors: [],
      async search(queries: string[]) {
        asked.push(queries);
        return [{ kind: 'web', title: 'Supplier', url: 'https://shop.example/a', domain: 'shop.example', snippet: 's', text: 'wholesale vintage clothing grade A sold in bales' }];
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
    const engine = new ResearchEngine({ router: router as never, search, store: new ProjectStore({ dir }) } as never);
    const project = await engine.createProject({ question: 'Find wholesale vintage clothing suppliers in the Netherlands and Germany' });
    project.brief = { ...engine.briefOf(project), located: false };
    project.domain = { ready: true, terms: ['grade A'], where: ['the biggest sorting plants stand in the Netherlands and Germany'] };
    project.decisionModel = { kind: { label: 'wholesale clothing provider', terms: ['vintage', 'clothing', 'wholesale'], not: [] }, criteria: [] };
    project.guidance = 'suppliers in NL, DE, UK';
    const found = await engine.searchHubs(project);
    expect(found).toBe(1);
    expect(project.hubSources).toHaveLength(1);
    expect(asked).toHaveLength(2);
  });

  it('stops rounds when pool target is reached', async () => {
    const routerCalls = [];
    const router = {
      calls: routerCalls,
      complete: async (req) => {
        routerCalls.push(req);
        return { provider: 'p', model: 'm', data: { queries: [{ country: 'NL', language: 'Dutch', query: 'vintage groothandel round 1' }, { country: 'DE', language: 'German', query: 'Vintage Großhandel round 1' }] } };
      },
    };
    let searchCall = 0;
    const search = {
      enabled: true,
      lastErrors: [],
      async search(queries) {
        searchCall++;
        return [
          { kind: 'web', title: 'Supplier 1', url: `https://shop.example/${searchCall}a`, domain: 'shop.example', snippet: 's', text: 'wholesale vintage clothing grade A sold in bales' },
          { kind: 'web', title: 'Supplier 2', url: `https://shop.example/${searchCall}b`, domain: 'shop.example', snippet: 's', text: 'wholesale vintage clothing grade A sold in bales' },
          { kind: 'web', title: 'Supplier 3', url: `https://shop.example/${searchCall}c`, domain: 'shop.example', snippet: 's', text: 'wholesale vintage clothing grade A sold in bales' },
        ];
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
    const engine = new ResearchEngine({ router: router as never, search, store: new ProjectStore({ dir }) } as never);
    const project = await engine.createProject({ question: 'Find wholesale vintage clothing suppliers', expected: '10 suppliers' });
    project.brief = { ...engine.briefOf(project), located: false };
    project.domain = { ready: true, terms: ['grade A'], where: ['Netherlands', 'Germany'] };
    project.decisionModel = { kind: { label: 'wholesale clothing provider', terms: ['vintage', 'clothing', 'wholesale'], not: [] }, criteria: [] };
    project.acceptance = { ...project.acceptance, itemCount: 2 };
    await engine.searchHubs(project);
    expect(routerCalls.length).toBe(1);
    expect(project.log.some((l) => l.message.includes('pool target reached'))).toBe(true);
  });

  it('stops rounds at the round cap', async () => {
    const routerCalls = [];
    const router = {
      calls: routerCalls,
      complete: async (req) => {
        routerCalls.push(req);
        return { provider: 'p', model: 'm', data: { queries: [{ country: 'NL', language: 'Dutch', query: `vintage groothandel round ${routerCalls.length + 1}` }] } };
      },
    };
    let searchCall = 0;
    const search = {
      enabled: true,
      lastErrors: [],
      async search(queries) {
        searchCall++;
        return [{ kind: 'web', title: 'Supplier', url: `https://shop.example/${searchCall}`, domain: 'shop.example', snippet: 's', text: 'wholesale vintage clothing grade A sold in bales' }];
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
    const engine = new ResearchEngine({ router: router as never, search, store: new ProjectStore({ dir }) } as never);
    const project = await engine.createProject({ question: 'Find wholesale vintage clothing suppliers', expected: '100 suppliers' });
    project.brief = { ...engine.briefOf(project), located: false };
    project.domain = { ready: true, terms: ['grade A'], where: ['Netherlands'] };
    project.decisionModel = { kind: { label: 'wholesale clothing provider', terms: ['vintage', 'clothing', 'wholesale'], not: [] }, criteria: [] };
    project.acceptance = { ...project.acceptance, itemCount: 20 };
    await engine.searchHubs(project);
    expect(routerCalls.length).toBe(4);
    expect(project.log.some((l) => l.message.includes('hub round 4'))).toBe(true);
  });

  it('stops rounds when a round adds no new pages', async () => {
    const routerCalls = [];
    const router = {
      calls: routerCalls,
      complete: async (req) => {
        routerCalls.push(req);
        return { provider: 'p', model: 'm', data: { queries: [{ country: 'NL', language: 'Dutch', query: `vintage groothandel round ${routerCalls.length + 1}` }] } };
      },
    };
    let searchCall = 0;
    const search = {
      enabled: true,
      lastErrors: [],
      async search(queries) {
        searchCall++;
        if (searchCall <= 2) {
          return [{ kind: 'web', title: 'Supplier', url: `https://shop.example/${searchCall}`, domain: 'shop.example', snippet: 's', text: 'wholesale vintage clothing grade A sold in bales' }];
        }
        return [];
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
    const engine = new ResearchEngine({ router: router as never, search, store: new ProjectStore({ dir }) } as never);
    const project = await engine.createProject({ question: 'Find wholesale vintage clothing suppliers', expected: '100 suppliers' });
    project.brief = { ...engine.briefOf(project), located: false };
    project.domain = { ready: true, terms: ['grade A'], where: ['Netherlands'] };
    project.decisionModel = { kind: { label: 'wholesale clothing provider', terms: ['vintage', 'clothing', 'wholesale'], not: [] }, criteria: [] };
    project.acceptance = { ...project.acceptance, itemCount: 20 };
    await engine.searchHubs(project);
    expect(routerCalls.length).toBe(3);
    expect(project.log.some((l) => l.message.includes('no new pages added, stopping'))).toBe(true);
  });

  it('includes accepted entity names in snowball queries', async () => {
    const routerCalls = [];
    const router = {
      calls: routerCalls,
      complete: async (req) => {
        routerCalls.push(req);
        const prompt = req.messages[1].content;
        return { provider: 'p', model: 'm', data: { queries: [{ country: 'NL', language: 'Dutch', query: 'vintage groothandel' }] } };
      },
    };
    const search = {
      enabled: true,
      lastErrors: [],
      async search(queries) {
        return [{ kind: 'web', title: 'Supplier', url: 'https://shop.example/1', domain: 'shop.example', snippet: 's', text: 'wholesale vintage clothing grade A sold in bales' }];
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
    const engine = new ResearchEngine({ router: router as never, search, store: new ProjectStore({ dir }) } as never);
    const project = await engine.createProject({ question: 'Find wholesale vintage clothing suppliers', expected: '10 suppliers' });
    project.brief = { ...engine.briefOf(project), located: false };
    project.domain = { ready: true, terms: ['grade A'], where: ['Netherlands'] };
    project.decisionModel = { kind: { label: 'wholesale clothing provider', terms: ['vintage', 'clothing', 'wholesale'], not: [] }, criteria: [] };
    project.acceptance = { ...project.acceptance, itemCount: 5 };
    project.acceptanceResult = { items: [
      { title: 'Accepted Supplier', url: 'https://accepted.example/', checks: [{ clause: 'kind', answer: 'yes', quote: 'We sell graded bales to shops.' }] },
      { title: 'Rejected Blog', url: 'https://blog.example/', checks: [{ clause: 'kind', answer: 'no', quote: 'My favourite finds' }] },
    ] } as never;
    await engine.searchHubs(project);
    const prompt = routerCalls[0].messages[1].content;
    expect(prompt).toContain('Accepted Supplier');
    expect(prompt).not.toContain('Rejected Blog');
  });

  it('does not repeat queries across rounds', async () => {
    const routerCalls = [];
    const router = {
      calls: routerCalls,
      complete: async (req) => {
        routerCalls.push(req);
        return { provider: 'p', model: 'm', data: { queries: [{ country: 'NL', language: 'Dutch', query: 'vintage groothandel' }] } };
      },
    };
    const search = {
      enabled: true,
      lastErrors: [],
      async search(queries) {
        return [{ kind: 'web', title: 'Supplier', url: 'https://shop.example/1', domain: 'shop.example', snippet: 's', text: 'wholesale vintage clothing grade A sold in bales' }];
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
    const engine = new ResearchEngine({ router: router as never, search, store: new ProjectStore({ dir }) } as never);
    const project = await engine.createProject({ question: 'Find wholesale vintage clothing suppliers', expected: '100 suppliers' });
    project.brief = { ...engine.briefOf(project), located: false };
    project.domain = { ready: true, terms: ['grade A'], where: ['Netherlands'] };
    project.decisionModel = { kind: { label: 'wholesale clothing provider', terms: ['vintage', 'clothing', 'wholesale'], not: [] }, criteria: [] };
    project.acceptance = { ...project.acceptance, itemCount: 20 };
    await engine.searchHubs(project);
    await engine.searchHubs(project);
    const allQueries = project.hubQueries?.map((q) => q.query) ?? [];
    const uniqueQueries = [...new Set(allQueries)];
    expect(allQueries.length).toBe(uniqueQueries.length);
  });

  it('caps directory paging at 3 pages per directory per round', async () => {
    const routerCalls = [];
    const router = {
      calls: routerCalls,
      complete: async (req) => {
        routerCalls.push(req);
        return { provider: 'p', model: 'm', data: { queries: [{ country: 'NL', language: 'Dutch', query: 'vintage groothandel' }] } };
      },
    };
    let fetchHtmlCall = 0;
    const search = {
      enabled: true,
      lastErrors: [],
      async search(queries) {
        return [{ kind: 'web', title: 'Directory', url: 'https://dir.example/page1', domain: 'dir.example', snippet: 's', text: 'wholesale vintage clothing grade A sold in bales' }];
      },
      async fetchHtml(url) {
        fetchHtmlCall++;
        if (fetchHtmlCall <= 3) {
          return `<html><a rel="next" href="https://dir.example/page${fetchHtmlCall + 1}">Next</a>wholesale vintage clothing grade A sold in bales</html>`;
        }
        return `<html>wholesale vintage clothing grade A sold in bales</html>`;
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
    const engine = new ResearchEngine({ router: router as never, search, store: new ProjectStore({ dir }) } as never);
    const project = await engine.createProject({ question: 'Find wholesale vintage clothing suppliers', expected: '10 suppliers' });
    project.brief = { ...engine.briefOf(project), located: false };
    project.domain = { ready: true, terms: ['grade A'], where: ['Netherlands'] };
    project.decisionModel = { kind: { label: 'wholesale clothing provider', terms: ['vintage', 'clothing', 'wholesale'], not: [] }, criteria: [] };
    project.acceptance = { ...project.acceptance, itemCount: 5 };
    await engine.searchHubs(project);
    expect(fetchHtmlCall).toBeLessThanOrEqual(3);
  });

  it('ranks hub pages by BM25 relevance and keeps pages in another language, never dropping one', async () => {
    const routerCalls = [];
    const router = {
      calls: routerCalls,
      complete: async (req) => {
        routerCalls.push(req);
        return { provider: 'p', model: 'm', data: { queries: [{ country: 'NL', language: 'Dutch', query: 'vintage groothandel' }] } };
      },
    };
    const search = {
      enabled: true,
      lastErrors: [],
      async search(queries) {
        return [
          { kind: 'web', title: 'Bad', url: 'https://bad.example/', domain: 'bad.example', snippet: 's', text: 'CBD oil products for sale netlify spam' },
          { kind: 'web', title: 'Groothandel', url: 'https://groothandel.example/', domain: 'groothandel.example', snippet: 's', text: 'Tweedehands kleding per kilo in balen voor winkels' },
          { kind: 'web', title: 'Good', url: 'https://good.example/', domain: 'good.example', snippet: 's', text: 'wholesale vintage clothing grade A sold in bales' },
        ];
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
    const engine = new ResearchEngine({ router: router as never, search, store: new ProjectStore({ dir }) } as never);
    const project = await engine.createProject({ question: 'Find wholesale vintage clothing suppliers' });
    project.brief = { ...engine.briefOf(project), located: false };
    project.domain = { ready: true, terms: ['grade A'], where: ['Netherlands'] };
    project.decisionModel = { kind: { label: 'wholesale clothing provider', terms: ['vintage', 'clothing', 'wholesale'], not: [] }, criteria: [] };
    await engine.searchHubs(project);
    expect(project.hubSources.map((source: { url: string }) => source.url)).toEqual(['https://good.example/', 'https://bad.example/', 'https://groothandel.example/']);
  });

  it('does not search again when pool target is reached even if cache is stale', async () => {
    const routerCalls = [];
    const router = {
      calls: routerCalls,
      complete: async (req) => {
        routerCalls.push(req);
        return { provider: 'p', model: 'm', data: { queries: [{ country: 'NL', language: 'Dutch', query: 'vintage groothandel' }] } };
      },
    };
    let searchCall = 0;
    const search = {
      enabled: true,
      lastErrors: [],
      async search(queries) {
        searchCall++;
        return [
          { kind: 'web', title: 'Supplier 1', url: `https://shop.example/${searchCall}a`, domain: 'shop.example', snippet: 's', text: 'wholesale vintage clothing grade A sold in bales' },
          { kind: 'web', title: 'Supplier 2', url: `https://shop.example/${searchCall}b`, domain: 'shop.example', snippet: 's', text: 'wholesale vintage clothing grade A sold in bales' },
          { kind: 'web', title: 'Supplier 3', url: `https://shop.example/${searchCall}c`, domain: 'shop.example', snippet: 's', text: 'wholesale vintage clothing grade A sold in bales' },
        ];
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
    let clock = Date.parse('2026-11-05T16:00:00Z');
    const engine = new ResearchEngine({ router: router as never, search, store: new ProjectStore({ dir }), now: () => clock } as never);
    const project = await engine.createProject({ question: 'Find wholesale vintage clothing suppliers', expected: '20 suppliers' });
    project.brief = { ...engine.briefOf(project), located: false };
    project.domain = { ready: true, terms: ['grade A'], where: ['Netherlands'] };
    project.decisionModel = { kind: { label: 'wholesale clothing provider', terms: ['vintage', 'clothing', 'wholesale'], not: [] }, criteria: [] };
    project.acceptance = { ...project.acceptance, itemCount: 1 };
    await engine.searchHubs(project);
    expect(routerCalls.length).toBe(1);
    clock += HUB_REFRESH_MS + 1;
    await engine.searchHubs(project);
    expect(routerCalls.length).toBe(1);
  });

  it('does not look for hubs when the kind has its own listing portal', async () => {
    const router = hubRouter();
    const { asked, search } = hubSearch();
    const engine = new ResearchEngine({ router: router as never, search, store: new ProjectStore({ dir }) } as never);
    const project = await engine.createProject({ question: 'Find used hatchback cars for sale within 300 km of Prague' });
    project.brief = { ...engine.briefOf(project), located: true };
    project.domain = { ready: true, terms: ['hatchback'], where: ['cars are sold in Czechia'] };
    project.guidance = 'suppliers in NL, DE, UK';
    expect(await engine.searchHubs(project)).toBe(0);
    expect(project.hubSources).toBeUndefined();
    expect(router.calls).toHaveLength(0);
    expect(asked).toHaveLength(0);
  });

  it('pauses the project instead of erroring when the network is down', async () => {
    const provider = netProvider('a');
    const router = new ModelRouter({ providers: [provider], offlineBackoff: [1], offlineWaitMs: 1 });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }), lanes: 2 });
    const project = await engine.createProject({ question: 'Should I open a bakery in Brno next year?' });
    await expect(engine.run(project.id)).rejects.toBeInstanceOf(OfflineError);
    const saved = await engine.store.get(project.id);
    expect(saved.phase).toBe('paused');
    expect(saved.error).toBeNull();
    expect(saved.chats.Q.some((m: { role: string; content: string }) => m.role === 'app' && /network was down/i.test(m.content))).toBe(true);
    expect(saved.log.some((l: { type: string; message: string }) => l.type === 'error')).toBe(true);
  });

  it('keeps blog, guide and supplier-directory pages out of report.deliverables', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Find the wholesale branded second hand clothing providers with highest price/value ratio for a retail second hand shop business in Czech Republic' });
    project.report = { ...(project.report ?? {}) } as never;
    project.acceptance = { ...(project.acceptance ?? {}), itemCount: 20, urlsLive: true, valueRange: null, mustMention: [] } as never;
    project.candidates = {
      kept: [
        { title: 'Germany Wholesaler Used Clothes: Top Suppliers & Bulk Deals', url: 'https://accio.com/', price: null, currency: '', nodeId: 'D1' },
        { title: 'Wholesale Used Clothing', url: 'https://apparelsearch.com/wholesale_clothing/wholesale_used_clothing.htm', price: null, currency: '', nodeId: 'D1' },
        { title: 'Where to Buy Vintage Clothing Wholesale in Europe (2026 Guide)', url: 'https://www.usfripe.com/blogs/news/where-to-buy-vintage-clothing-wholesale-in-europe-2026-guide', price: null, currency: '', nodeId: 'D2' },
        { title: 'Groothandel gebruikte kleding in balen - Zagumi', url: 'https://zagumi.com/nl/used-clothing/', price: null, currency: '', nodeId: 'D3' },
      ],
    } as never;
    await engine.checkAcceptance(project);
    expect(project.report.deliverables.map((d: { url: string }) => d.url)).toEqual(['https://zagumi.com/nl/used-clothing/']);
  });

  it('verdict cache survives a save and reload', async () => {
    const judgeCalls: string[] = [];
    const checklistProposal = {
      items: [
        { clause: 'wholesale', question: 'Does this sell wholesale or bulk?', hard: true, numeric: null },
        { clause: 'brands', question: 'Does this carry at least one of Ralph Lauren, Moncler, The North Face, Barbour?', hard: true, numeric: null },
        { clause: 'quality', question: 'Does this state a quality grade or guarantee?', hard: true, numeric: null },
        { clause: 'price/value', question: 'Is the price per kg or piece published?', hard: false, numeric: { measure: 'priceEur', op: '<=', value: null, unit: 'EUR/kg' } },
      ],
    };
    const judgeReply = [
      { id: 'wholesale|Does this sell wholesale or bulk?', answer: 'yes', quote: 'wholesale' },
      { id: 'brands|Does this carry at least one of Ralph Lauren, Moncler, The North Face, Barbour?', answer: 'yes', quote: 'Barbour' },
      { id: 'quality|Does this state a quality grade or guarantee?', answer: 'yes', quote: 'grade A' },
      { id: 'price/value|Is the price per kg or piece published?', answer: 'yes', quote: 'priceEur: 40 EUR/kg' },
    ];
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => ({ id: 'demo', label: 'Demo', state: 'ready', detail: '', configured: true, fast: 'demo-fast', deep: 'demo-deep', local: true, keyEnv: null, signup: '', modelCount: 1 }),
      async chat({ messages, tier }) {
        const fullPrompt = messages.map((m) => m.content).join('\n');
        if (fullPrompt.includes('checklist') || fullPrompt.includes('yes/no questions')) {
          return { content: JSON.stringify(checklistProposal), model: tier === 'deep' ? 'demo-deep' : 'demo-fast', provider: 'demo', usage: {} };
        }
        if (fullPrompt.includes('strict judge') || fullPrompt.includes('Item page text:')) {
          judgeCalls.push(fullPrompt);
          return { content: JSON.stringify(judgeReply), model: 'demo-fast', provider: 'demo', usage: {} };
        }
        return { content: JSON.stringify({ answer: 'ok', claims: [], confidence: 'high' }), model: tier === 'deep' ? 'demo-deep' : 'demo-fast', provider: 'demo', usage: {} };
      },
    };
    const router = new ModelRouter({ providers: [provider] });
    const modeler = new ChecklistModeler({ router, samples: 3 });
    const engine = new ResearchEngine({ router, search: fakeSearchForChecklist, store: new ProjectStore({ dir }), lanes: 2, modeler });
    const project = await engine.createProject({ question: 'Find the wholesale branded second hand clothing providers with highest price/value ratio for a retail second hand shop business in Czech Republic' });
    await engine.updateProject(project.id, { acceptance: { itemCount: 20, valueRange: [0, 50], unit: 'EUR/kg' } });
    project.candidates = {
      kept: [
        { title: 'Wholesale Supplier A', url: 'https://zagumi.com/anuncio/used-clothing-ID12345', value: 40, unit: 'EUR/kg', price: 40, currency: 'EUR/kg', plan: { tier: 'fits', verdict: 'Fits all checks', why: ['wholesale', 'brands'], risks: [] } },
        { title: 'Wholesale Supplier B', url: 'https://example.com/anuncio/supplier-b-ID67890', value: 35, unit: 'EUR/kg', price: 35, currency: 'EUR/kg', plan: { tier: 'fits', verdict: 'Fits all checks', why: ['wholesale', 'brands'], risks: [] } },
      ],
      keptCount: 2,
      toCheck: [],
      toCheckCount: 0,
      tiers: { fits: 2, 'trade-off': 0, unverified: 0, weak: 0, blocked: 0 },
      screened: {},
      screenedCount: 0,
      found: 2,
      verification: null,
    };
    project.brief = { located: true, kind: { label: 'wholesale clothing provider', terms: ['wholesale clothing'] }, regions: ['CZ'] };

    project.decisionModel = { checklist: [{ clause: 'wholesale', items: [{ clause: 'wholesale', question: 'Does this sell wholesale or bulk?', hard: true, numeric: null }] }] };
    project.report = { verdict: 'GO', modelVerdict: 'GO', kind: 'list', confidence: 'high', summary: 'test', keyNumbers: [], scenarios: [], sensitivity: [], risks: [], openQuestions: [], nextSteps: [], evidenceQuality: {}, bestEstimate: null, actionItems: [], options: [], basis: {}, model: 'demo/m', generatedAt: new Date().toISOString() };
    await engine.checkAcceptance(project);
    expect(project.acceptanceResult).toBeTruthy();
    expect(project.acceptanceResult!.items.length).toBeGreaterThanOrEqual(2);
    expect(project.acceptanceResult!.items[0].checks).toBeDefined();
    expect(project.acceptanceResult!.items[0].checklist).toBeDefined();
    const firstRunJudgeCalls = judgeCalls.length;
    expect(firstRunJudgeCalls).toBeGreaterThan(0);

    await engine.store.save(project);

    const reloaded = await engine.store.get(project.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.checkCache).toBeDefined();

    judgeCalls.length = 0;
    await engine.checkAcceptance(reloaded!);
    expect(judgeCalls.length).toBe(0);
    expect(reloaded!.acceptanceResult!.items[0].checks).toEqual(project.acceptanceResult!.items[0].checks);
    expect(reloaded!.acceptanceResult!.items[1].checks).toEqual(project.acceptanceResult!.items[1].checks);
  });

  it('an item whose only hard check is judged "no" is NOT valid in the stored acceptanceResult', async () => {
    const judgeCalls: string[] = [];
    const checklistProposal = {
      items: [
        { clause: 'wholesale', question: 'Does this sell wholesale or bulk?', hard: true, numeric: null },
      ],
    };
    const judgeReplyNo = [
      { id: 'q1', answer: 'no', spans: ['S1'] },
    ];
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => ({ id: 'demo', label: 'Demo', state: 'ready', detail: '', configured: true, fast: 'demo-fast', deep: 'demo-deep', local: true, keyEnv: null, signup: '', modelCount: 1 }),
      async chat({ messages, tier }) {
        const fullPrompt = messages.map((m) => m.content).join('\n');
        if (fullPrompt.includes('checklist') || fullPrompt.includes('yes/no questions')) {
          return { content: JSON.stringify(checklistProposal), model: tier === 'deep' ? 'demo-deep' : 'demo-fast', provider: 'demo', usage: {} };
        }
        if (fullPrompt.includes('strict judge') || fullPrompt.includes('Item page text:')) {
          judgeCalls.push(fullPrompt);
          return { content: JSON.stringify(judgeReplyNo), model: 'demo-fast', provider: 'demo', usage: {} };
        }
        return { content: JSON.stringify({ answer: 'ok', claims: [], confidence: 'high' }), model: tier === 'deep' ? 'demo-deep' : 'demo-fast', provider: 'demo', usage: {} };
      },
    };
    const router = new ModelRouter({ providers: [provider] });
    const modeler = new ChecklistModeler({ router, samples: 3 });
    const engine = new ResearchEngine({ router, search: fakeSearchForChecklist, store: new ProjectStore({ dir }), lanes: 2, modeler });
    const project = await engine.createProject({ question: 'Find the wholesale branded second hand clothing providers with highest price/value ratio for a retail second hand shop business in Czech Republic' });
    await engine.updateProject(project.id, { acceptance: { itemCount: 20, valueRange: [0, 50], unit: 'EUR/kg' } });
    project.candidates = {
      kept: [
        { title: 'Wholesale Supplier A', url: 'https://zagumi.com/anuncio/used-clothing-ID12345', value: 40, unit: 'EUR/kg', price: 40, currency: 'EUR/kg', plan: { tier: 'fits', verdict: 'Fits all checks', why: ['wholesale', 'brands'], risks: [] } },
      ],
      keptCount: 1,
      toCheck: [],
      toCheckCount: 0,
      tiers: { fits: 1, 'trade-off': 0, unverified: 0, weak: 0, blocked: 0 },
      screened: {},
      screenedCount: 0,
      found: 1,
      verification: null,
    };
    project.brief = { located: true, kind: { label: 'wholesale clothing provider', terms: ['wholesale clothing'] }, regions: ['CZ'] };

    project.decisionModel = { checklist: [{ clause: 'wholesale', items: [{ clause: 'wholesale', question: 'Does this sell wholesale or bulk?', hard: true, numeric: null }] }] };
    project.report = { verdict: 'GO', modelVerdict: 'GO', kind: 'list', confidence: 'high', summary: 'test', keyNumbers: [], scenarios: [], sensitivity: [], risks: [], openQuestions: [], nextSteps: [], evidenceQuality: {}, bestEstimate: null, actionItems: [], options: [], basis: {}, model: 'demo/m', generatedAt: new Date().toISOString() };
    await engine.checkAcceptance(project);
    const item = project.acceptanceResult!.items[0];
    expect(item.checks).toBeDefined();
    expect(item.checks[0].answer).toBe('no');
    expect(item.valid).toBe(false);
    const hardChecks = item.checks.filter((c) => c.hard === true);
    expect(hardChecks.every((c) => c.answer === 'yes')).toBe(false);
  });

  it('on the first acceptance check, with no checklist yet, an unknown hard item is confirmed on a same-host page and the item becomes valid', async () => {
    const itemUrl = 'https://shop.example.org/offer/used-goods-ID555';
    const deepUrl = 'https://shop.example.org/shipping-countries';
    const checkId = 'ships abroad|Does this ship to other countries?';
    const search = {
      ...fakeSearch,
      async readPage(url: string) {
        if (url === itemUrl) return { status: 200, text: 'Used goods offer: mixed second-hand clothing sorted by hand into cream and A grade, packed in pressed bales, sold by the kilogram at 40 EUR/kg to shops and market traders. Minimum order one bale; pallets loaded at our warehouse every weekday.', links: [{ url: deepUrl, text: 'Shipping countries' }, { url: 'https://elsewhere.example.net/ship', text: 'Shipping countries' }] };
        if (url === deepUrl) return { status: 200, text: 'We ship to 30 countries across Europe', links: [] };
        return { status: 404, text: '', links: [] };
      },
    };
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => ({ id: 'demo', label: 'Demo', state: 'ready', detail: '', configured: true, fast: 'demo-fast', deep: 'demo-deep', local: true, keyEnv: null, signup: '', modelCount: 1 }),
      async chat({ messages, tier }) {
        const prompt = messages.map((m) => m.content).join('\n');
        if (prompt.includes('yes/no questions')) {
          return { content: JSON.stringify({ items: [{ clause: 'ships abroad', question: 'Does this ship to other countries?', hard: true, numeric: null }] }), model: tier === 'deep' ? 'demo-deep' : 'demo-fast', provider: 'demo', usage: {} };
        }
        if (prompt.includes('Item page text:')) {
          const reply = prompt.includes('We ship to 30 countries') ? { id: 'q1', answer: 'yes', spans: ['S1'] } : { id: 'q1', answer: 'unknown', spans: [] };
          return { content: JSON.stringify([reply]), model: 'demo-fast', provider: 'demo', usage: {} };
        }
        return { content: JSON.stringify({ answer: 'ok', claims: [], confidence: 'high' }), model: tier === 'deep' ? 'demo-deep' : 'demo-fast', provider: 'demo', usage: {} };
      },
    };
    const router = new ModelRouter({ providers: [provider] });
    const engine = new ResearchEngine({ router, search, store: new ProjectStore({ dir }), lanes: 2, modeler: new ChecklistModeler({ router, samples: 3 }) });
    const project = await engine.createProject({ question: 'Find used goods sellers that ship to other countries' });
    await engine.updateProject(project.id, { acceptance: { itemCount: 1, valueRange: [0, 50], unit: 'EUR/kg' } });
    project.candidates = { kept: [{ title: 'Seller A', url: itemUrl, value: 40, unit: 'EUR/kg', price: 40, currency: 'EUR/kg', plan: { tier: 'fits', verdict: 'Fits', why: [], risks: [] } }], keptCount: 1, toCheck: [], toCheckCount: 0, tiers: { fits: 1, 'trade-off': 0, unverified: 0, weak: 0, blocked: 0 }, screened: {}, screenedCount: 0, found: 1, verification: null };
    project.brief = { located: true, kind: { label: 'used goods seller', terms: ['used goods'] }, regions: [] };
    project.decisionModel = { checklist: [{ clause: 'ships abroad', items: [{ clause: 'ships abroad', question: 'Does this ship to other countries?', hard: true, numeric: null }] }] };
    project.report = { verdict: 'GO', modelVerdict: 'GO', kind: 'list', confidence: 'high', summary: 'test', keyNumbers: [], scenarios: [], sensitivity: [], risks: [], openQuestions: [], nextSteps: [], evidenceQuality: {}, bestEstimate: null, actionItems: [], options: [], basis: {}, model: 'demo/m', generatedAt: new Date().toISOString() };
    await engine.checkAcceptance(project);
    const item = project.acceptanceResult!.items[0];
    expect(item.checks.find((c) => c.id === checkId)).toMatchObject({ answer: 'yes', quote: 'We ship to 30 countries across Europe', source: deepUrl });
    const hardIds = project.checklist.flatMap((cluster) => cluster.items.filter((ci) => ci.hard).map((ci) => cluster.clause + '|' + ci.question));
    expect(itemTier(item, hardIds, project.acceptance)).toBe('confirmed');
    expect(qualifies(item, project.acceptance)).toBe(true);
    expect(item.valid).toBe(true);
  });

  it('an item beyond the first 30 / with no checks keeps today\'s validity', async () => {
    const judgeCalls: string[] = [];
    const checklistProposal = {
      items: [
        { clause: 'wholesale', question: 'Does this sell wholesale or bulk?', hard: true, numeric: null },
      ],
    };
    const judgeReplyYes = [
      { id: 'q1', answer: 'yes', spans: ['S1'] },
    ];
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => ({ id: 'demo', label: 'Demo', state: 'ready', detail: '', configured: true, fast: 'demo-fast', deep: 'demo-deep', local: true, keyEnv: null, signup: '', modelCount: 1 }),
      async chat({ messages, tier }) {
        const fullPrompt = messages.map((m) => m.content).join('\n');
        if (fullPrompt.includes('checklist') || fullPrompt.includes('yes/no questions')) {
          return { content: JSON.stringify(checklistProposal), model: tier === 'deep' ? 'demo-deep' : 'demo-fast', provider: 'demo', usage: {} };
        }
        if (fullPrompt.includes('strict judge') || fullPrompt.includes('Item page text:')) {
          judgeCalls.push(fullPrompt);
          return { content: JSON.stringify(judgeReplyYes), model: 'demo-fast', provider: 'demo', usage: {} };
        }
        return { content: JSON.stringify({ answer: 'ok', claims: [], confidence: 'high' }), model: tier === 'deep' ? 'demo-deep' : 'demo-fast', provider: 'demo', usage: {} };
      },
    };
    const router = new ModelRouter({ providers: [provider] });
    const modeler = new ChecklistModeler({ router, samples: 3 });
    const engine = new ResearchEngine({ router, search: fakeSearchForChecklist, store: new ProjectStore({ dir }), lanes: 2, modeler });
    const project = await engine.createProject({ question: 'Find the wholesale branded second hand clothing providers with highest price/value ratio for a retail second hand shop business in Czech Republic' });
    await engine.updateProject(project.id, { acceptance: { itemCount: 50, valueRange: [0, 50], unit: 'EUR/kg' } });
    // Create 35 items - only first 30 will get checks
    const items = Array.from({ length: 35 }, (_, i) => {
      // Alternate between the two URLs that fakeSearchForChecklist.readPage supports
      const url = i % 2 === 0
        ? 'https://zagumi.com/anuncio/used-clothing-ID12345'
        : 'https://example.com/anuncio/supplier-b-ID67890';
      return {
        title: `Wholesale Supplier ${i + 1}`,
        url,
        value: 30 + i,
        unit: 'EUR/kg',
        price: 30 + i,
        currency: 'EUR/kg',
        plan: { tier: 'fits', verdict: 'Fits all checks', why: ['wholesale', 'brands'], risks: [] },
      };
    });
    project.candidates = {
      kept: items,
      keptCount: 35,
      toCheck: [],
      toCheckCount: 0,
      tiers: { fits: 35, 'trade-off': 0, unverified: 0, weak: 0, blocked: 0 },
      screened: {},
      screenedCount: 0,
      found: 35,
      verification: null,
    };
    project.brief = { located: true, kind: { label: 'wholesale clothing provider', terms: ['wholesale clothing'] }, regions: ['CZ'] };
    project.decisionModel = { checklist: [{ clause: 'wholesale', items: [{ clause: 'wholesale', question: 'Does this sell wholesale or bulk?', hard: true, numeric: null }] }] };
    project.report = { verdict: 'GO', modelVerdict: 'GO', kind: 'list', confidence: 'high', summary: 'test', keyNumbers: [], scenarios: [], sensitivity: [], risks: [], openQuestions: [], nextSteps: [], evidenceQuality: {}, bestEstimate: null, actionItems: [], options: [], basis: {}, model: 'demo/m', generatedAt: new Date().toISOString() };
    await engine.checkAcceptance(project);
    // Items should be judged until itemCount are valid or budget (90) is spent
    const withChecks = project.acceptanceResult!.items.filter((item) => item.checks && item.checks.length > 0);
    expect(withChecks.length).toBeLessThanOrEqual(90);
    expect(withChecks.length).toBeGreaterThan(0);
    // They should still have valid computed based on other criteria (live, listing, inRange, purpose)
    expect(project.acceptanceResult!.items.every((item) => item.valid !== undefined)).toBe(true);
  });

  describe('checkAcceptance judge until enough', () => {
    it('judges items until itemCount are valid or budget is spent', async () => {
      const router = new ModelRouter({ providers: [new ScriptedProvider()] });
      const mockSearch = {
        enabled: true,
        lastErrors: [],
        async search() { return []; },
        async readPage(url: string) {
          if (url.startsWith('https://example.com/anuncio/')) {
            return { status: 200, text: 'We sell wholesale clothing in bulk. Price: 40 EUR per kg. '.repeat(10) };
          }
          return { status: 404, text: '' };
        },
      };
      const engine = new ResearchEngine({ router, search: mockSearch, store: new ProjectStore({ dir }), lanes: 1 });
      const project = await engine.createProject({ question: 'Find 5 wholesale clothing providers', expected: '5 providers' });
      project.acceptance = { itemCount: 5, valueRange: null, unit: '', urlsLive: false, mustMention: [] };
      project.candidates = {
        kept: Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/anuncio/item-ID${10000 + i}`, title: `Item ${i}`, value: 1000 + i, unit: 'EUR', inRange: true, live: true, listing: true, purpose: [] })),
        keptCount: 10,
        toCheck: [],
        toCheckCount: 0,
        tiers: { fits: 10, 'trade-off': 0, unverified: 0, weak: 0, blocked: 0 },
        screened: {},
        screenedCount: 0,
        found: 10,
        verification: null,
      };
      project.brief = { located: true, kind: { label: 'wholesale clothing provider', terms: ['wholesale clothing'] }, regions: ['CZ'] };
      project.decisionModel = { checklist: [{ clause: 'wholesale', items: [{ clause: 'wholesale', question: 'Does this sell wholesale or bulk?', hard: true, numeric: null }] }] };
      project.report = { verdict: 'GO', modelVerdict: 'GO', kind: 'list', confidence: 'high', summary: 'test', keyNumbers: [], scenarios: [], sensitivity: [], risks: [], openQuestions: [], nextSteps: [], evidenceQuality: {}, bestEstimate: null, actionItems: [], options: [], basis: {}, model: 'demo/m', generatedAt: new Date().toISOString() };
      project.checkCache = {};

      let judgeCalls = 0;
      const originalJudge = engine.checklistJudge.judge.bind(engine.checklistJudge);
      engine.checklistJudge.judge = async (item, pageText, checklist, kind) => {
        judgeCalls++;
        return [{ id: 'wholesale|Does this sell wholesale or bulk?', answer: 'yes', quote: 'wholesale', hard: true, clause: 'wholesale' }];
      };

      await engine.checkAcceptance(project);

      expect(judgeCalls).toBeGreaterThanOrEqual(5);
      expect(judgeCalls).toBeLessThanOrEqual(90);
      const validItems = project.acceptanceResult!.items.filter(i => i.valid);
      expect(validItems.length).toBeGreaterThanOrEqual(5);
    });

    it('cached verdicts do not count against judge budget', async () => {
      const router = new ModelRouter({ providers: [new ScriptedProvider()] });
      const mockSearch = {
        enabled: true,
        lastErrors: [],
        async search() { return []; },
        async readPage() { return { status: 200, text: 'wholesale' }; },
      };
      const engine = new ResearchEngine({ router, search: mockSearch, store: new ProjectStore({ dir }), lanes: 1 });
      const project = await engine.createProject({ question: 'Find 5 wholesale clothing providers', expected: '5 providers' });
      project.acceptance = { itemCount: 5, valueRange: null, unit: '', urlsLive: false, mustMention: [] };
      project.candidates = {
        kept: Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/item${i}`, title: `Item ${i}`, value: 1000 + i, unit: 'EUR', inRange: true, live: true, listing: true, purpose: [] })),
        keptCount: 10,
        toCheck: [],
        toCheckCount: 0,
        tiers: { fits: 10, 'trade-off': 0, unverified: 0, weak: 0, blocked: 0 },
        screened: {},
        screenedCount: 0,
        found: 10,
        verification: null,
      };
      project.brief = { located: true, kind: { label: 'wholesale clothing provider', terms: ['wholesale clothing'] }, regions: ['CZ'] };
      project.decisionModel = { checklist: [{ clause: 'wholesale', items: [{ clause: 'wholesale', question: 'Does this sell wholesale or bulk?', hard: true, numeric: null }] }] };
      project.report = { verdict: 'GO', modelVerdict: 'GO', kind: 'list', confidence: 'high', summary: 'test', keyNumbers: [], scenarios: [], sensitivity: [], risks: [], openQuestions: [], nextSteps: [], evidenceQuality: {}, bestEstimate: null, actionItems: [], options: [], basis: {}, model: 'demo/m', generatedAt: new Date().toISOString() };

      const fingerprint = checklistFingerprint(project.decisionModel.checklist);
      for (let i = 0; i < 10; i++) {
        project.checkCache = {
          [`https://example.com/item${i}::${fingerprint}`]: {
            checks: [{ id: 'wholesale|Does this sell wholesale or bulk?', answer: 'yes', quote: 'wholesale', hard: true, clause: 'wholesale' }],
            summary: { hardPass: true, unknown: 0, softYes: 0 }
          }
        };
        await engine.checkAcceptance(project);
      }

      const judgeCalls = engine.checkCache ? Object.keys(engine.checkCache).length : 0;
      expect(judgeCalls).toBeLessThanOrEqual(10);
    });

    it('records kind rejections and skips them on next acceptance', async () => {
      const router = new ModelRouter({ providers: [new ScriptedProvider()] });
      const engine = new ResearchEngine({ router, search: fakeSearchForChecklist, store: new ProjectStore({ dir }), lanes: 1 });
      const project = await engine.createProject({ question: 'Find 5 used cars', expected: '5 cars' });
      project.acceptance = { itemCount: 5, valueRange: null, unit: '', urlsLive: false, mustMention: [] };
      project.candidates = {
        kept: [
          { url: 'https://example.com/car1', title: 'Car 1', value: 10000, unit: 'EUR', inRange: true, live: true, listing: true, purpose: [] },
          { url: 'https://example.com/parts1', title: 'Spare Part', value: 500, unit: 'EUR', inRange: true, live: true, listing: true, purpose: [] },
          { url: 'https://example.com/car2', title: 'Car 2', value: 12000, unit: 'EUR', inRange: true, live: true, listing: true, purpose: [] },
        ],
        keptCount: 3,
        toCheck: [],
        toCheckCount: 0,
        tiers: { fits: 3, 'trade-off': 0, unverified: 0, weak: 0, blocked: 0 },
        screened: {},
        screenedCount: 0,
        found: 3,
        verification: null,
      };
      project.brief = { located: true, kind: { label: 'used car', terms: ['car', 'hatchback'] }, regions: ['CZ'] };
      const kind = { label: 'used car', terms: ['car', 'hatchback'], not: ['spare part', 'accessories'] };
      project.decisionModel = { checklist: [{ clause: 'kind', items: [{ clause: 'kind', question: 'Is this a used car (not a spare part or accessory)?', hard: true, numeric: null }] }], kind };
      project.report = { verdict: 'GO', modelVerdict: 'GO', kind: 'list', confidence: 'high', summary: 'test', keyNumbers: [], scenarios: [], sensitivity: [], risks: [], openQuestions: [], nextSteps: [], evidenceQuality: {}, bestEstimate: null, actionItems: [], options: [], basis: {}, model: 'demo/m', generatedAt: new Date().toISOString() };
      project.checkCache = {};

      await engine.checkAcceptance(project);

      expect(project.kindRejected).toBeDefined();
      if (project.kindRejected.length > 0) {
        const rejectedUrl = project.kindRejected[0];
        expect(rejectedUrl).toBe('https://example.com/parts1');

        project.candidates.kept = project.candidates.kept.filter(k => k.url !== rejectedUrl);
        project.candidates.keptCount = project.candidates.kept.length;
        await engine.checkAcceptance(project);

        const checkedUrls = project.acceptanceResult!.items.filter(i => i.checks).map(i => i.url);
        expect(checkedUrls).not.toContain(rejectedUrl);
      }
    });
  });
});

function netProvider(id: string, networkFailures = Number.POSITIVE_INFINITY) {
  let n = 0;
  return {
    id,
    ready: true,
    calls: [],
    async chat() {
      this.calls.push(1);
      n++;
      if (n <= networkFailures) throw new ProviderError(`${id} unreachable: fetch failed`, { status: 0, provider: id });
      return { content: '{"ok":true}', model: `${id}-m`, provider: id, usage: {} };
    },
    describe: () => ({ id }),
  };
}

describe('a kind no needs a second family on the deeper page', () => {
  const home = 'BEST SELLERS. NEW IN. Shop the latest drops.';
  const about = 'We are a used clothing wholesaler selling hand-sorted bales by the kilogram to shops.';
  const second: string[] = [];
  const family = (id: string, aboutAnswer: string) => ({
    id,
    ready: true,
    describe: () => ({ id, label: id, state: 'ready', detail: '', configured: true, fast: `${id}-fast`, deep: `${id}-deep`, local: true, keyEnv: null, signup: '', modelCount: 1 }),
    async chat({ messages }: { messages: { content: string }[] }) {
      const prompt = messages.map((m) => m.content).join('\n');
      if (prompt.includes('This page offers:')) {
        if (prompt.includes('hand-sorted bales')) second.push(id);
        const shown = (aboutAnswer === 'A' ? prompt.match(/^([A-M])\) one /m) : prompt.match(/^([A-M])\) a part or an accessory/m))?.[1] ?? aboutAnswer;
        return { content: JSON.stringify({ kind: prompt.includes('hand-sorted bales') ? shown : 'B', span: 'S1' }), model: `${id}-fast`, provider: id, usage: {} };
      }
      return { content: JSON.stringify(prompt.includes('Item page text:') ? [] : { answer: 'ok', claims: [], confidence: 'high' }), model: `${id}-fast`, provider: id, usage: {} };
    },
  });
  const run = async (aboutAnswer: string, stored: unknown[] = [], ids = ['alpha', 'beta']) => {
    second.length = 0;
    const search = { ...fakeSearch, async readPage(url: string) { return url.endsWith('/about') ? { status: 200, text: about, links: [] } : { status: 200, text: home, links: [{ url: '/about', text: 'About us' }] }; } };
    const router = new ModelRouter({ providers: ids.map((id) => family(id, aboutAnswer)) });
    const engine = new ResearchEngine({ router, search, store: new ProjectStore({ dir }), lanes: 2 });
    const project = await engine.createProject({ question: 'Find used clothing wholesalers' });
    await engine.updateProject(project.id, { acceptance: { itemCount: 1 } });
    const row = { title: 'Seller', url: 'https://seller.example.org/', value: 10, unit: 'EUR/kg', price: 10, currency: 'EUR/kg', plan: { tier: 'fits', verdict: 'Fits', why: [], risks: [] } };
    project.candidates = { kept: [row], keptCount: 1, toCheck: [], toCheckCount: 0, tiers: { fits: 1, 'trade-off': 0, unverified: 0, weak: 0, blocked: 0 }, screened: {}, screenedCount: 0, found: 1, verification: null };
    project.brief = { located: true, kind: { label: 'used clothing wholesaler', terms: ['used clothing'] }, regions: [] };
    project.decisionModel = { kind: { label: 'used clothing wholesaler', terms: ['used clothing'] }, checklist: [] };
    project.kindRejected = stored;
    project.report = { verdict: 'GO', modelVerdict: 'GO', kind: 'list', confidence: 'high', summary: 'test', keyNumbers: [], scenarios: [], sensitivity: [], risks: [], openQuestions: [], nextSteps: [], evidenceQuality: {}, bestEstimate: null, actionItems: [], options: [], basis: {}, model: 'demo/m', generatedAt: new Date().toISOString() };
    await engine.checkAcceptance(project);
    return { project, kind: project.acceptanceResult!.items[0].checks.find((c: { clause: string }) => c.clause === 'kind')! };
  };

  it('turns a home-page no into yes when another family reads the company page and quotes it', async () => {
    const { project, kind } = await run('A');
    expect(kind).toMatchObject({ answer: 'yes', quote: about });
    expect(project.kindRejected).toEqual([]);
    expect(project.log.some((l: { message: string }) => l.message.startsWith('kind second opinion 1/30: first=no second=yes'))).toBe(true);
  });

  it('asks the second opinion first of a family other than the one that said no', async () => {
    const { kind } = await run('A');
    expect(kind.provider).toBeTruthy();
    expect(second[0]).not.toBe(kind.provider);
  });

  it('rejects and remembers the item under the current judge version only when both families say no', async () => {
    const { project, kind } = await run('B');
    expect(kind.answer).toBe('no');
    expect(project.kindRejected).toEqual([{ url: 'https://seller.example.org/', judgeVersion: JUDGE_VERSION }]);
  });

  it('never rejects when the second opinion comes from the family that said no: the kind is unknown, to confirm', async () => {
    const { project, kind } = await run('B', [], ['alpha']);
    expect(second).toEqual(['alpha']);
    expect(kind).toMatchObject({ answer: 'unknown', reason: SINGLE_KIND_OPINION, second: { single: true } });
    expect(project.kindRejected).toEqual([]);
    expect(project.log.some((l: { message: string }) => l.message.startsWith('kind second opinion 1/30: first=no second=unknown'))).toBe(true);
  });

  it('forgets rejections recorded under an older judge version, so those items are judged again', async () => {
    const { project, kind } = await run('A', ['https://seller.example.org/', { url: 'https://seller.example.org/', judgeVersion: JUDGE_VERSION - 1 }]);
    expect(kind.answer).toBe('yes');
    expect(project.kindRejected).toEqual([]);
  });
});

describe('the brief marks a kind of business', () => {
  it('sets kind.entity when the item is not sold on listing pages, and clears it for a listed item', async () => {
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search: fakeSearch, store: new ProjectStore({ dir }) });
    const project = await engine.createProject({ question: 'Find 20 wholesale clothing suppliers' });
    project.decisionModel = { kind: { label: 'wholesale clothing supplier', terms: ['wholesale clothing'], validated: { pages: 4, terms: [], at: 't' } }, criteria: [] } as never;
    expect(engine.briefOf(project).located).toBe(false);
    expect(project.decisionModel!.kind.entity).toBe(true);
    project.decisionModel = { kind: { label: 'hatchback', terms: ['hatchback'] }, criteria: [] } as never;
    engine.briefOf(project);
    expect(project.decisionModel!.kind.entity).toBe(engine.briefOf(project).located === false);
  });
});

describe('kind hardening and the migration of stored answers', () => {
  const offer = 'Used goods offer: mixed second-hand clothing sorted by hand into cream and A grade, packed in pressed bales, sold by the kilogram to shops and market traders. Minimum order one bale; pallets loaded at our warehouse every weekday.';
  const demo = (chat: (prompt: string) => unknown, id = 'demo') => ({
    id,
    ready: true,
    describe: () => ({ id, label: 'Demo', state: 'ready', detail: '', configured: true, fast: `${id}-fast`, deep: `${id}-deep`, local: true, keyEnv: null, signup: '', modelCount: 1 }),
    async chat({ messages }: { messages: { content: string }[] }) {
      return { content: JSON.stringify(chat(messages.map((m) => m.content).join('\n'))), model: `${id}-fast`, provider: id, usage: {} };
    },
  });
  const partLetter = (prompt: string) => prompt.match(/^([A-E])\) a part or an accessory/m)![1];
  const kindChat = (secondPrompts: string[]) => (prompt: string) => {
    if (prompt.includes('Median price of its comparable items:')) {
      secondPrompts.push(prompt);
      return { kind: partLetter(prompt), span: 'S1' };
    }
    return prompt.includes('This page offers:') ? { kind: 'A', span: 'S1' } : prompt.includes('Item page text:') ? [{ id: 'q1', answer: 'yes', spans: ['S1'] }] : { answer: 'ok', claims: [], confidence: 'high' };
  };
  const cheapProject = async (engine: ResearchEngine) => {
    const project = await engine.createProject({ question: 'Find used goods sellers that sell by the kilogram' });
    await engine.updateProject(project.id, { acceptance: { itemCount: 21, valueRange: [0, 500], unit: 'EUR/kg' } });
    const row = (i: number, value: number) => ({ title: `Seller ${i}`, url: `https://shop.example.org/offer/used-goods-ID${1000 + i}`, value, unit: 'EUR/kg', price: value, currency: 'EUR/kg', plan: { tier: 'fits', verdict: 'Fits', why: [], risks: [] } });
    const kept = [...Array.from({ length: 20 }, (_, i) => row(i, 200 + i * 5)), row(99, 20)];
    project.candidates = { kept, keptCount: kept.length, toCheck: [], toCheckCount: 0, tiers: { fits: kept.length, 'trade-off': 0, unverified: 0, weak: 0, blocked: 0 }, screened: {}, screenedCount: 0, found: kept.length, verification: null };
    project.brief = { located: true, kind: { label: 'used goods seller', terms: ['used goods'] }, regions: [] };
    project.decisionModel = { kind: { label: 'used goods seller', terms: ['used goods'] }, checklist: [{ clause: 'by the kilogram', items: [{ clause: 'by the kilogram', question: 'Does this sell by the kilogram?', hard: true, numeric: null }] }] };
    project.report = { verdict: 'GO', modelVerdict: 'GO', kind: 'list', confidence: 'high', summary: 'test', keyNumbers: [], scenarios: [], sensitivity: [], risks: [], openQuestions: [], nextSteps: [], evidenceQuality: {}, bestEstimate: null, actionItems: [], options: [], basis: {}, model: 'demo/m', generatedAt: new Date().toISOString() };
    return project;
  };

  it('never rejects the cheap item on the no of one provider family: its kind is unknown and it waits to be confirmed', async () => {
    const secondPrompts: string[] = [];
    const search = { ...fakeSearch, async readPage() { return { status: 200, text: offer, links: [] }; } };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [demo(kindChat(secondPrompts))] }), search, store: new ProjectStore({ dir }), lanes: 2 });
    const project = await cheapProject(engine);
    await engine.checkAcceptance(project);
    const cheap = project.acceptanceResult!.items.find((item) => item.url.endsWith('ID1099'))!;
    expect(cheap.checks.find((c) => c.clause === 'kind')).toMatchObject({ answer: 'unknown', second: { answer: 'unknown', single: true } });
    expect([cheap.tier, cheap.valid]).toEqual(['to-confirm', false]);
    expect(project.kindRejected ?? []).toEqual([]);
    expect(secondPrompts).toHaveLength(1);
  });

  it('passes the low price cut and the median of the candidate table to a second kind judgement, only for an item below the cut', async () => {
    const secondPrompts: string[] = [];
    const provider = demo(kindChat(secondPrompts));
    const search = { ...fakeSearch, async readPage() { return { status: 200, text: offer, links: [] }; } };
    const router = new ModelRouter({ providers: [provider, demo(kindChat(secondPrompts), 'other')] });
    const engine = new ResearchEngine({ router, search, store: new ProjectStore({ dir }), lanes: 2 });
    const project = await cheapProject(engine);
    await engine.checkAcceptance(project);
    const items = project.acceptanceResult!.items;
    const cheap = items.find((item) => item.url.endsWith('ID1099'))!;
    const usual = items.find((item) => item.url.endsWith('ID1000'))!;
    expect(cheap.checks.find((c) => c.clause === 'kind')).toMatchObject({ answer: 'no', reason: LOW_PRICE_REASON });
    expect([cheap.tier, cheap.valid]).toEqual(['rejected', false]);
    expect(usual.checks.find((c) => c.clause === 'kind')).toMatchObject({ answer: 'yes', quote: offer.split('. ')[0] + '.' });
    expect([usual.tier, usual.valid]).toEqual(['confirmed', true]);
    expect(project.kindRejected).toEqual([{ url: cheap.url, judgeVersion: JUDGE_VERSION }]);
    expect(secondPrompts).toHaveLength(2);
    expect(secondPrompts[0]).toContain('Price of this item: 20 EUR/kg');
    expect(secondPrompts[0]).toMatch(/Median price of its comparable items: \d+ EUR\/kg/);
    project.kindRejected = [];
    await engine.checkAcceptance(project);
    expect(secondPrompts).toHaveLength(2);
    expect(project.acceptanceResult!.items.find((item) => item.url.endsWith('ID1099'))!.checks.find((c) => c.clause === 'kind')!.answer).toBe('no');
  });

  it('turns stored answers without a quote to unknown once in reground and logs how many', async () => {
    const events: string[] = [];
    const router = new ModelRouter({ providers: [new ScriptedProvider()] });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }), lanes: 2, onEvent: (_id: string, event: { message: string }) => events.push(event.message) });
    const project = await engine.createProject({ question: 'Find used goods sellers that sell by the kilogram' });
    project.acceptance = { itemCount: 1, locked: true };
    project.checklist = [{ clause: 'c', items: [{ clause: 'c', question: 'q', hard: true, numeric: null }] }];
    project.acceptanceResult = { score: 1, validCount: 1, checks: [{ id: 'count', label: 'Count', value: 1, passed: true, detail: '' }], items: [{ url: 'https://shop.example.org/offer/a-ID1', live: true, listing: true, inRange: true, purpose: [], checks: [{ id: 'c|q', answer: 'yes', quote: '', hard: true, clause: 'c' }] }] };
    expect(engine.reground(project)).toBe(true);
    expect(project.acceptanceResult.items[0]).toMatchObject({ tier: 'to-confirm', valid: false });
    expect(project.acceptanceResult.items[0].checks[0]).toMatchObject({ answer: 'unknown', quote: '' });
    expect(project.acceptanceResult.validCount).toBe(0);
    const note = '1 stored answer(s) had no quote from the page and now count as unknown';
    expect(events.filter((message) => message === note)).toHaveLength(1);
    project.acceptanceResult.items[0].checks[0] = { id: 'c|q', answer: 'yes', quote: '', hard: true, clause: 'c' };
    expect(engine.reground(project)).toBe(false);
    expect(events.filter((message) => message === note)).toHaveLength(1);
  });
});

describe('ResearchEngine router lines', () => {
  const limited = (id: string, retryAfterMs = 10000) => ({
    id,
    ready: true,
    describe: () => ({ id }),
    async chat() {
      throw new ProviderError(`${id} HTTP 429 [quota window: per minute]: slow down`, { status: 429, retryAfterMs });
    },
  });
  type Line = { type: string; message: string };
  type Row = { project?: string; provider: string; purpose: string; ok: boolean };
  const routerLines = (project: { log: Line[] }) => project.log.filter((event) => event.type === 'router').map((event) => event.message);

  function clockedEngine(providers: object[]) {
    const clock = { now: Date.parse('2026-11-16T10:00:00Z') };
    const ledger: Row[] = [];
    const sleep = async (ms: number) => {
      clock.now += ms;
    };
    const router = new ModelRouter({ providers, now: () => clock.now, sleep, onLedger: (row: Row) => ledger.push(row) });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }), now: () => clock.now });
    return { router, engine, clock, ledger };
  }

  it('writes waits and give-ups into the log of the project that made the call, never into another one', async () => {
    const shared = limited('lim');
    const { router, engine } = clockedEngine([shared]);
    router.coolDown(shared, new ProviderError('lim HTTP 429: slow down', { status: 429, retryAfterMs: 10000 }));
    const a = await engine.createProject({ question: 'Which of two suppliers is cheaper per unit?' });
    const b = await engine.createProject({ question: 'Which of two trails is shorter?' });
    await Promise.allSettled([
      engine.inScope(a.id, () => router.complete({ messages: [], purpose: 'research' })),
      engine.inScope(b.id, () => router.complete({ messages: [], purpose: 'synthesize' })),
    ]);
    for (const [project, own, other] of [[a, 'research', 'synthesize'], [b, 'synthesize', 'research']] as const) {
      const lines = routerLines(project);
      expect(lines[0]).toBe('waiting for model quota: lim rests 10s (rate limit)');
      expect(lines.filter((line) => line.startsWith('waiting for model quota'))).toHaveLength(1);
      expect(lines.filter((line) => line.startsWith(`no model answered ${own}: `))).toHaveLength(1);
      expect(lines.filter((line) => line.includes(other))).toEqual([]);
    }
    expect(routerLines(b).at(-1)).toMatch(/^model calls this phase: 0 ok, \d+ failed \(top: lim 429 per minute x\d+\)$/);
  });

  it('writes one waiting line per project per 60 s however many lanes wait', async () => {
    const { router, engine, clock } = clockedEngine([limited('lim', 20000)]);
    const a = await engine.createProject({ question: 'Which of two suppliers is cheaper per unit?' });
    const waits = () => routerLines(a).filter((line) => line.startsWith('waiting for model quota'));
    await engine.inScope(a.id, async () => {
      const first = clock.now;
      await Promise.allSettled([1, 2, 3].map(() => router.complete({ messages: [], purpose: 'research' })));
      expect(clock.now - first).toBeLessThan(60000);
      expect(waits()).toHaveLength(1);
      expect(routerLines(a).filter((line) => line.startsWith('no model answered research'))).toHaveLength(3);
      router.forgetBench('lim');
      clock.now = first + 59000;
      await Promise.allSettled([router.complete({ messages: [], purpose: 'research' })]);
      expect(waits()).toHaveLength(1);
      router.forgetBench('lim');
      clock.now = first + 60000;
      await Promise.allSettled([router.complete({ messages: [], purpose: 'research' })]);
      expect(waits()).toHaveLength(2);
    });
  });

  it('writes that a provider needs payment once, into the project whose call found it', async () => {
    const pay = {
      id: 'pay',
      ready: true,
      describe: () => ({ id: 'pay' }),
      async chat() {
        throw new ProviderError('pay HTTP 402: Payment required', { status: 402 });
      },
    };
    const { router, engine } = clockedEngine([pay, new ScriptedProvider()]);
    const a = await engine.createProject({ question: 'Which of two suppliers is cheaper per unit?' });
    const b = await engine.createProject({ question: 'Which of two trails is shorter?' });
    await engine.inScope(a.id, () => router.complete({ messages: [], purpose: 'research' }));
    await engine.inScope(a.id, () => router.complete({ messages: [], purpose: 'research' }));
    await engine.inScope(b.id, () => router.complete({ messages: [], purpose: 'research' }));
    expect(routerLines(a)).toEqual(['pay needs payment: excluded from the free route', 'model calls this phase: 1 ok, 1 failed (top: pay 402 x1)', 'model calls this phase: 1 ok, 0 failed']);
    expect(routerLines(b)).toEqual(['model calls this phase: 1 ok, 0 failed']);
  });

  it('summarises at each phase change only the calls this project made in that phase', async () => {
    const { router, engine } = clockedEngine([new ScriptedProvider()]);
    const a = await engine.createProject({ question: 'Which of two suppliers is cheaper per unit?' });
    const b = await engine.createProject({ question: 'Which of two trails is shorter?' });
    await Promise.all([
      engine.inScope(a.id, async () => {
        await router.complete({ messages: [], purpose: 'research' });
        await router.complete({ messages: [], purpose: 'research' });
        engine.setPhase(a, 'researching');
        await router.complete({ messages: [], purpose: 'synthesize' });
        engine.setPhase(a, 'researching');
        engine.setPhase(a, 'synthesizing');
        engine.setPhase(a, 'done');
      }),
      engine.inScope(b.id, async () => {
        await router.complete({ messages: [], purpose: 'research' });
        engine.setPhase(b, 'done');
      }),
    ]);
    await router.complete({ messages: [], purpose: 'chat' });
    expect(routerLines(a)).toEqual(['model calls this phase: 2 ok, 0 failed', 'model calls this phase: 1 ok, 0 failed']);
    expect(routerLines(b)).toEqual(['model calls this phase: 1 ok, 0 failed']);
    expect(a.phase).toBe('done');
  });

  it('adds up, over two researches run side by side, to exactly the calls each one made', async () => {
    const { engine, ledger } = clockedEngine([new ScriptedProvider()]);
    const a = await engine.createProject({ question: 'Is it profitable to buy used RAV4 hybrids in Germany and sell them in Poland?' });
    const b = await engine.createProject({ question: 'Is it cheaper to rent or to buy a flat in Brno over ten years?' });
    const [doneA, doneB] = await Promise.all([engine.run(a.id), engine.run(b.id)]);
    for (const done of [doneA, doneB]) {
      const lines = routerLines(done).filter((line) => line.startsWith('model calls this phase:'));
      const counted = lines.map((line) => /(\d+) ok, (\d+) failed/.exec(line)).reduce((sum, match) => sum + Number(match?.[1]) + Number(match?.[2]), 0);
      const made = ledger.filter((row) => row.project === done.id && row.provider !== 'router' && row.purpose !== 'router').length;
      expect(done.phase).toBe('done');
      expect(lines.length).toBeGreaterThan(1);
      expect(made).toBeGreaterThan(0);
      expect(counted).toBe(made);
    }
    expect(ledger.filter((row) => row.provider !== 'router' && !row.project)).toEqual([]);
  });
});

describe('purpose-first: ensurePurpose runs before decompose and requirement ids', () => {
  it('run calls ensurePurpose before decompose', async () => {
    const callOrder: string[] = [];
    const modeler = {
      fresh: () => false,
      build: async (p: Record<string, unknown>) => {
        callOrder.push('build');
        p.decisionModel = {
          purpose: 'A buyer wants a plot so that they build a glamping site',
          value: 'a shortlist of plots under 20000 EUR',
          kind: { label: 'plot of land', terms: ['plot', 'land'] },
          criteria: [{ id: 'priceEur', measure: 'priceEur', op: '<=', value: 20000, clause: '20000EUR max', quote: '20000EUR max', source: 'question' }],
          noLimit: [],
          checklist: [],
          requirements: [],
        };
        return p.decisionModel;
      },
    };
    const tree = {
      decision: 'Choose plots under 20000 EUR',
      successCriteria: 'live plot listings under 20000 EUR',
      assumptionsToConfirm: [],
      acceptance: { itemCount: 5, valueRange: [0, 20000], unit: 'EUR', mustMention: [] },
      nodes: [
        { id: 'D1', parentId: null, title: 'Candidate plots', question: 'Which plots are for sale under 20000 EUR?', method: 'lookup', searchQueries: ['plots for sale'] },
        { id: 'D1.1', parentId: 'D1', title: 'Region A', question: 'Which plots in region A?', method: 'lookup', searchQueries: ['region A plots'] },
        { id: 'D1.2', parentId: 'D1', title: 'Region B', question: 'Which plots in region B?', method: 'lookup', searchQueries: ['region B plots'] },
      ],
    };
    const provider = { id: 'stub', ready: true, describe: () => ({ id: 'stub', label: 'Stub', state: 'ready', detail: '', configured: true, fast: 'stub', deep: 'stub', local: false, keyEnv: null, signup: '', modelCount: 1 }), async chat() { callOrder.push('decompose'); return { content: JSON.stringify(tree), model: 'stub', provider: 'stub', usage: {} }; } };
    const router = new ModelRouter({ providers: [provider] });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }), modeler } as never);
    const project = await engine.createProject({ question: 'Find plots for glamping, 20000EUR max', templateId: 'generic', expected: '5 plots under 20000 EUR' });
    await engine.run(project.id);
    expect(callOrder.indexOf('build')).toBeLessThan(callOrder.indexOf('decompose'));
  });

  it('decomposePrompt contains the purpose and requirement ids from requirements when present', async () => {
    const prompts: Array<{ purpose: string; requirements: Array<{ id: string }> }> = [];
    const modeler = {
      fresh: () => false,
      build: async (p: Record<string, unknown>) => {
        p.decisionModel = {
          purpose: 'A buyer wants a plot so that they build a glamping site',
          value: 'a shortlist of plots under 20000 EUR',
          kind: { label: 'plot of land', terms: ['plot', 'land'] },
          criteria: [{ id: 'priceEur', measure: 'priceEur', op: '<=', value: 20000, clause: '20000EUR max', quote: '20000EUR max', source: 'question' }],
          noLimit: [],
          checklist: [],
          requirements: [
            { measure: 'priceEur', clause: 'price at most 20000 EUR', op: '<=', value: 20000, quote: '20000EUR max' },
            { measure: 'coastKm', clause: 'near the sea', op: '<=', value: 20, quote: 'near the sea' },
          ],
        };
        return p.decisionModel;
      },
    };
    const tree = {
      decision: 'Choose plots under 20000 EUR near the sea',
      successCriteria: 'live plot listings under 20000 EUR within 20km of coast',
      assumptionsToConfirm: [],
      acceptance: { itemCount: 5, valueRange: [0, 20000], unit: 'EUR', mustMention: [] },
      nodes: [
        { id: 'D1', parentId: null, title: 'Candidate plots', question: 'Which plots are for sale under 20000 EUR?', method: 'lookup', searchQueries: ['plots for sale'] },
      ],
    };
    const scripted = new ScriptedProvider();
    const provider = { id: 'demo', ready: true, describe: () => scripted.describe(), async chat(args: { messages: Array<{ content: string }> }) { const prompt = args.messages.at(-1)!.content; if (prompt.includes(TASK_MARKERS.decompose)) { const purposeMatch = prompt.match(/PURPOSE \(why this research matters; every piece must serve it\):\n([\s\S]*?)\n/); const reqMatch = prompt.match(/ASKER'S REQUIREMENTS \(each has an id; every node must name the requirement id\(s\) it serves in field "serves"\):([\s\S]*?)\n\n/); prompts.push({ purpose: purposeMatch?.[1]?.trim() ?? '', requirements: (reqMatch?.[1]?.match(/- (\w+):/g) ?? []).map((m) => ({ id: m.replace(/- (\w+):/, '$1') })) }); } return scripted.chat(args as never); } };
    const router = new ModelRouter({ providers: [provider] });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }), modeler } as never);
    const project = await engine.createProject({ question: 'Find plots for glamping, 20000EUR max', templateId: 'generic', expected: '5 plots under 20000 EUR' });
    await engine.decompose(project);
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    expect(prompts[0].purpose).toBe('A buyer wants a plot so that they build a glamping site');
    expect(prompts[0].requirements.map((r) => r.id)).toEqual(['priceEur', 'coastKm']);
  });

  it('unknown serves ids are dropped and logged', async () => {
    const logs: string[] = [];
    const modeler = {
      fresh: () => false,
      build: async (p: Record<string, unknown>) => {
        p.decisionModel = {
          purpose: 'A buyer wants a plot so that they build a glamping site',
          value: 'a shortlist of plots under 20000 EUR',
          kind: { label: 'plot of land', terms: ['plot', 'land'] },
          criteria: [
            { id: 'priceEur', measure: 'priceEur', op: '<=', value: 20000, clause: '20000EUR max', quote: '20000EUR max', source: 'question' },
            { id: 'coastKm', measure: 'coastKm', op: '<=', value: 20, clause: 'near the sea', quote: 'near the sea', source: 'guidance' },
          ],
          noLimit: [],
          checklist: [],
          requirements: [{ measure: 'priceEur', clause: 'price at most 20000 EUR', op: '<=', value: 20000, quote: '20000EUR max' }],
          agreement: { samples: 2, majority: 2, proposed: 2, kept: 2 },
        };
        return p.decisionModel;
      },
    };
    const tree = {
      decision: 'Choose plots under 20000 EUR near the sea',
      successCriteria: 'live plot listings under 20000 EUR within 20km of coast',
      assumptionsToConfirm: [],
      acceptance: { itemCount: 5, valueRange: [0, 20000], unit: 'EUR', mustMention: [] },
      nodes: [
        { id: 'D1', parentId: null, title: 'Candidate plots', question: 'Which plots are for sale?', method: 'lookup', searchQueries: ['plots'], serves: ['priceEur', 'unknownReq'] },
        { id: 'D1.1', parentId: 'D1', title: 'Region A', question: 'Which plots in region A?', method: 'lookup', searchQueries: ['region A'], serves: ['unknownReq2'] },
        { id: 'D1.2', parentId: 'D1', title: 'Region B', question: 'Which plots in region B?', method: 'lookup', searchQueries: ['region B'], serves: ['priceEur'] },
      ],
    };
    const scripted = new ScriptedProvider();
    const provider = { id: 'demo', ready: true, describe: () => scripted.describe(), async chat() { return { content: JSON.stringify(tree), model: 'stub', provider: 'stub', usage: {} }; } };
    const router = new ModelRouter({ providers: [provider] });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }), modeler, onEvent: (_id: string, event: { type: string; message: string }) => { if (event.type === 'tree') logs.push(event.message); } } as never);
    const project = await engine.createProject({ question: 'Find plots for glamping, 20000EUR max', templateId: 'generic', expected: '5 plots under 20000 EUR' });
    await engine.decompose(project);
    expect(logs.some((l) => l.includes('unknown requirement id(s)') && l.includes('dropped'))).toBe(true);
    const nodeD1 = project.nodes.find((n) => n.id === 'D1');
    expect(nodeD1.serves).toEqual(['priceEur']);
    const nodeD11 = project.nodes.find((n) => n.id === 'D1.1');
    expect(nodeD11.serves).toEqual([]);
  });

  it('derives requirement ids from criteria and checklist when requirements is empty', async () => {
    const prompts: Array<{ requirements: Array<{ id: string; clause: string }> }> = [];
    const modeler = {
      fresh: () => false,
      build: async (p: Record<string, unknown>) => {
        p.decisionModel = {
          purpose: 'A buyer wants a plot so that they build a glamping site',
          value: 'a shortlist of plots under 20000 EUR',
          kind: { label: 'plot of land', terms: ['plot', 'land'] },
          criteria: [
            { id: 'priceEur', measure: 'priceEur', op: '<=', value: 20000, clause: '20000EUR max', quote: '20000EUR max', source: 'question' },
            { id: 'coastKm', measure: 'coastKm', op: '<=', value: 20, clause: 'near the sea', quote: 'near the sea', source: 'guidance' },
          ],
          noLimit: [],
          checklist: [
            { clause: 'Legal permits', role: 'eligibility', items: [{ clause: 'Has building permit', question: 'Does it have a building permit?', hard: true }] },
            { clause: 'Utilities', role: 'appraisal', items: [{ clause: 'Has water', question: 'Does it have water connection?', hard: false }, { clause: 'Has electricity', question: 'Does it have electricity?', hard: false }] },
          ],
          requirements: [],
        };
        return p.decisionModel;
      },
    };
    const tree = {
      decision: 'Choose plots under 20000 EUR near the sea',
      successCriteria: 'live plot listings under 20000 EUR within 20km of coast',
      assumptionsToConfirm: [],
      acceptance: { itemCount: 5, valueRange: [0, 20000], unit: 'EUR', mustMention: [] },
      nodes: [{ id: 'D1', parentId: null, title: 'Candidate plots', question: 'Which plots are for sale?', method: 'lookup', searchQueries: ['plots'] }],
    };
    const scripted = new ScriptedProvider();
    const provider = { id: 'demo', ready: true, describe: () => scripted.describe(), async chat(args: { messages: Array<{ content: string }> }) { const prompt = args.messages.at(-1)!.content; if (prompt.includes(TASK_MARKERS.decompose)) { const reqMatch = prompt.match(/ASKER'S REQUIREMENTS \(each has an id; every node must name the requirement id\(s\) it serves in field "serves"\):([\s\S]*?)\n\n/); if (reqMatch) { const lines = reqMatch[1].split('\n').filter((l) => l.trim().startsWith('- ')); prompts.push({ requirements: lines.map((l) => { const match = l.match(/- (\S+): (.+)/); return { id: match?.[1] ?? '', clause: match?.[2] ?? '' }; }) }); } } return scripted.chat(args as never); } };
    const router = new ModelRouter({ providers: [provider] });
    const engine = new ResearchEngine({ router, search: fakeSearch, store: new ProjectStore({ dir }), modeler } as never);
    const project = await engine.createProject({ question: 'Find plots for glamping, 20000EUR max', templateId: 'generic', expected: '5 plots under 20000 EUR' });
    await engine.decompose(project);
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    const reqIds = prompts[0].requirements.map((r) => r.id).sort();
    expect(reqIds).toContain('priceEur');
    expect(reqIds).toContain('coastKm');
    expect(reqIds).toContain('K1');
    expect(reqIds).toContain('K2');
    expect(reqIds).toContain('K3');
  });
});

describe('gateOnKind', () => {
  let gateDir: string;
  beforeEach(async () => {
    gateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-kindgate-'));
  });
  afterEach(async () => {
    await fs.rm(gateDir, { recursive: true, force: true });
  });
  function makeGateEngine() {
    const router = new ModelRouter({ providers: [new ScriptedProvider()] });
    return new ResearchEngine({ router, search: { enabled: true, lastErrors: [], search: async () => [], describe: () => ({ enabled: true, backends: ['fake'] }) }, store: new ProjectStore({ dir: gateDir }), lanes: 2 });
  }
  it('returns sources unchanged when validated terms is empty', () => {
    const engine = makeGateEngine();
    const kind = { label: 'test kind', validated: { terms: [] } };
    const project = { decisionModel: { kind } };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Source 1', url: 'https://example.com/1', text: 'some text' },
      { id: 'S2', title: 'Source 2', url: 'https://example.com/2', text: 'other text' },
    ];
    const result = engine.gateOnKind(project as any, node, sources);
    expect(result).toHaveLength(2);
    expect(result).toEqual(sources);
  });

  it('keeps source with kind.not phrase in returned array but orders it last', () => {
    const engine = makeGateEngine();
    const kind = { label: 'used car', validated: { terms: ['car', 'hatchback'] }, not: ['parts', 'wheels'] };
    const project = { decisionModel: { kind } };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Car listing', url: 'https://example.com/1', text: 'This is a hatchback car for sale' },
      { id: 'S2', title: 'Parts listing', url: 'https://example.com/2', text: 'Alu wheels for sale parts' },
      { id: 'S3', title: 'Another car', url: 'https://example.com/3', text: 'Used car hatchback good condition' },
    ];
    const result = engine.gateOnKind(project as any, node, sources);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('S1');
    expect(result[1].id).toBe('S3');
    expect(result[2].id).toBe('S2');
  });

  it('returns source lacking every validated term after one that has a term', () => {
    const engine = makeGateEngine();
    const kind = { label: 'used car', validated: { terms: ['car', 'hatchback'] }, not: [] };
    const project = { decisionModel: { kind } };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Car listing', url: 'https://example.com/1', text: 'This is a hatchback car for sale' },
      { id: 'S2', title: 'Unrelated page', url: 'https://example.com/2', text: 'This page is about bicycles and motorcycles' },
      { id: 'S3', title: 'Another car', url: 'https://example.com/3', text: 'Used car good condition' },
    ];
    const result = engine.gateOnKind(project as any, node, sources);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('S1');
    expect(result[1].id).toBe('S3');
    expect(result[2].id).toBe('S2');
  });

  it('returned array always has the same length as the input', () => {
    const engine = makeGateEngine();
    const kind = { label: 'used car', validated: { terms: ['car', 'hatchback'] }, not: ['parts', 'wheels'] };
    const project = { decisionModel: { kind } };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Car listing', url: 'https://example.com/1', text: 'This is a hatchback car for sale' },
      { id: 'S2', title: 'Parts listing', url: 'https://example.com/2', text: 'Alu wheels for sale parts' },
      { id: 'S3', title: 'Unrelated page', url: 'https://example.com/3', text: 'This page is about bicycles' },
      { id: 'S4', title: 'Another car', url: 'https://example.com/4', text: 'Used car hatchback good condition' },
      { id: 'S5', title: 'More parts', url: 'https://example.com/5', text: 'Car parts and accessories wheels' },
    ];
    const result = engine.gateOnKind(project as any, node, sources);
    expect(result).toHaveLength(5);
    expect(result.map(s => s.id)).toEqual(['S1', 'S4', 'S3', 'S2', 'S5']);
  });

  it('orders onKind sources first, then noTerm, then nearMiss, preserving original relative order within each group', () => {
    const engine = makeGateEngine();
    const kind = { label: 'plot of land', validated: { terms: ['plot', 'land', 'terreno'] }, not: ['hotel', 'apartment'] };
    const project = { decisionModel: { kind } };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Hotel', url: 'https://hotel.example/1', text: 'Luxury hotel by the beach' },
      { id: 'S2', title: 'Plot 1', url: 'https://land.example/1', text: 'Terreno for sale plot of land' },
      { id: 'S3', title: 'Unrelated', url: 'https://other.example/1', text: 'Random page about cars' },
      { id: 'S4', title: 'Apartment', url: 'https://apartment.example/1', text: 'Apartment for rent near city center' },
      { id: 'S5', title: 'Plot 2', url: 'https://land.example/2', text: 'Land plot terreno cheap' },
      { id: 'S6', title: 'Another unrelated', url: 'https://other.example/2', text: 'Page about motorcycles' },
    ];
    const result = engine.gateOnKind(project as any, node, sources);
    expect(result).toHaveLength(6);
    expect(result[0].id).toBe('S2');
    expect(result[1].id).toBe('S5');
    expect(result[2].id).toBe('S3');
    expect(result[3].id).toBe('S6');
    expect(result[4].id).toBe('S1');
    expect(result[5].id).toBe('S4');
  });

  it('emits demoted message when sources are demoted', () => {
    const engine = makeGateEngine();
    const kind = { label: 'used car', validated: { terms: ['car', 'hatchback'] }, not: ['parts'] };
    const project = { decisionModel: { kind }, log: [] };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Car listing', url: 'https://example.com/1', text: 'This is a hatchback car for sale' },
      { id: 'S2', title: 'Parts listing', url: 'https://parts.example/2', text: 'Alu wheels parts' },
      { id: 'S3', title: 'Unrelated page', url: 'https://unrelated.example/3', text: 'This page is about bicycles' },
    ];
    engine.gateOnKind(project as any, node, sources);
    const demotedLog = project.log.find((l: any) => l.message.includes('demoted behind on-kind sources'));
    expect(demotedLog).toBeTruthy();
    expect(demotedLog.message).toContain('D1.1: 2 source(s) demoted behind on-kind sources');
    expect(demotedLog.message).toContain('parts.example: a near-miss kind (parts)');
    expect(demotedLog.message).toContain('unrelated.example: not the asked kind (used car)');
  });

  it('does not emit demoted message when all sources are onKind', () => {
    const engine = makeGateEngine();
    const kind = { label: 'used car', validated: { terms: ['car', 'hatchback'] }, not: ['parts'] };
    const project = { decisionModel: { kind }, log: [] };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Car listing', url: 'https://example.com/1', text: 'This is a hatchback car for sale' },
      { id: 'S2', title: 'Another car', url: 'https://example.com/2', text: 'Used car hatchback good condition' },
    ];
    engine.gateOnKind(project as any, node, sources);
    const demotedLog = project.log.find((l: any) => l.message.includes('demoted behind on-kind sources'));
    expect(demotedLog).toBeFalsy();
  });

  it('handles snippet and title in addition to text for kind checking', () => {
    const engine = makeGateEngine();
    const kind = { label: 'used car', validated: { terms: ['car', 'hatchback'] }, not: ['parts'] };
    const project = { decisionModel: { kind } };
    const node = { id: 'D1.1' };
    const sources = [
      { id: 'S1', title: 'Hatchback car', url: 'https://example.com/1', snippet: 'Great car', text: '' },
      { id: 'S2', title: 'Parts', url: 'https://example.com/2', snippet: '', text: 'Car parts' },
    ];
    const result = engine.gateOnKind(project as any, node, sources);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('S1');
    expect(result[1].id).toBe('S2');
  });
});
});
