import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/llm/provider.mjs';
import { ScriptedProvider } from '../../src/llm/scripted-provider.mjs';
import { ModelRouter } from '../../src/llm/router.mjs';
import { TASK_MARKERS, decomposePrompt, synthesizePrompt, withGuidance } from '../../src/research/prompts.mjs';
import { ResearchEngine, TEAM_TTL_MS, needsSiteFit } from '../../src/research/engine.mjs';
import { aggregate, normalizeSample } from '../../src/research/decision.mjs';
import { ProjectStore } from '../../src/store.mjs';

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
    expect(done.report.verdict).toContain('Decision model: 0 plots of the 4 asked fit every check; 0 trade-offs with their potential; 4 to confirm; 0 weak; 0 blocked by law — model memo:');
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
    expect(project.log.some((l: { type: string; message: string }) => l.type === 'decision' && /^kind calibrated on 10 titles: not parts, kola, svetlo, pneumatiky; hatchback: 2 models$/.test(l.message))).toBe(true);
    await engine.collectCandidates(project as never, { sweep: true });
    expect(calls).toHaveLength(3);
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

  it('drops tree pieces that do per-listing work when the project lists items, since code does that work on the candidate table', async () => {
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
    expect(project.nodes.map((n: { id: string }) => n.id)).toEqual(['D4', 'D4.1', 'D4.2', 'D5', 'D5.2']);
    expect(project.nodes.every((n: { question: string }) => !/\b(?:List|Verify|Convert|Calculate)\b/.test(n.question))).toBe(true);
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
  });

  it('honours a stop raised while collecting candidates', async () => {
    const { engine } = engineWith(new ScriptedProvider());
    const project = await engine.createProject({ question: 'Should I open a bakery in Brno next year?' });
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
    const seen = outcomes.posterior(provider.id, 'research', 3);
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
    const calls: { purpose: string; tier: string; avoid?: string; quote: string }[] = [];
    router.complete = (async (request: { purpose: string; tier: string; avoid?: string; messages: { content: string }[] }) => {
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
      { purpose: 'support-second', tier: 'fast', avoid: 'gemini', quote: `${quote}. Delivery is extra.` },
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
    expect(calls[0]).toEqual({ sweep: true, research: 0 });
    expect(calls.at(-1)!.sweep).toBe(true);
    expect(calls.at(-1)!.research).toBeGreaterThan(0);
    expect(calls.at(-1)!.research).toBeGreaterThan(0);
    expect(calls.filter((c) => c.sweep === true)).toHaveLength(2);
    expect(done.log.some((l: { type: string; message: string }) => l.type === 'candidates' && l.message === 'listings first: reading marketplace pages by code before any piece is researched')).toBe(true);
  });

  it('keeps a single end-of-run table call for a research that does not ask for items', async () => {
    const provider = new ScriptedProvider();
    const { engine } = engineWith(provider);
    const project = await engine.createProject({ question: 'Should I import e-bikes from Germany to Czechia?' });
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
    expect(JSON.stringify(calls[0])).toContain('the main language of Czechia');
    await (engine as unknown as { planKnowledgeQueries: (p: unknown) => Promise<number | null> }).planKnowledgeQueries(project);
    expect(calls).toHaveLength(1);
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
    expect(events.some((m) => /distance from prague: 3 listing\(s\) measured, 1 farther than 300 km, 1 without a stated place/.test(m))).toBe(true);
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

