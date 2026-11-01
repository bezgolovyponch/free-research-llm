import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/llm/provider.mjs';
import { ScriptedProvider } from '../../src/llm/scripted-provider.mjs';
import { ModelRouter } from '../../src/llm/router.mjs';
import { TASK_MARKERS, decomposePrompt, synthesizePrompt, withGuidance } from '../../src/research/prompts.mjs';
import { ResearchEngine, TEAM_TTL_MS } from '../../src/research/engine.mjs';
import { aggregate, normalizeSample } from '../../src/research/decision.mjs';
import { ProjectStore } from '../../src/store.mjs';

const fakeSearch = {
  enabled: true,
  lastErrors: [],
  async search(queries: string[]) {
    return [
      { kind: 'web', title: 'One', url: 'https://one.example/a', domain: 'one.example', snippet: 's', text: `about ${queries[0]}` },
      { kind: 'web', title: 'Two', url: 'https://two.example/b', domain: 'two.example', snippet: 's', text: 'more evidence from a second independent source on the same question' },
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
    expect(modes).toEqual(['budget', 'all', 'cache', 'all']);
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

  it('searches again before any model call when no retrieved page matches the piece, and shows the model the best passages', async () => {
    const queries: string[][] = [];
    const prompts: string[] = [];
    const offTopic = {
      ...fakeSearch,
      async search(q: string[]) {
        queries.push(q);
        if (queries.length === 1) return [{ kind: 'web', title: 'Bikes', url: 'https://bikes.example/a', domain: 'bikes.example', snippet: 's', text: 'battery range' }, { kind: 'web', title: 'Shop', url: 'https://shop.example/b', domain: 'shop.example', snippet: 's', text: 'free delivery' }];
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
    expect(research.indexOf('https://answer.example/c')).toBeLessThan(research.indexOf('https://bikes.example/a'));
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
