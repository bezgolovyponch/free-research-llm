import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../src/llm/scripted-provider.mjs';
import { ModelRouter } from '../../src/llm/router.mjs';
import { ResearchEngine } from '../../src/research/engine.mjs';
import { ProjectStore } from '../../src/store.mjs';
import { CONCEPT_MARKER, MAX_MEMBERS, MIN_MEMBERS, UMBRELLA_PAGES, applyConceptCard, conceptCardPrompt, conceptPageLimit, conceptPages, conceptQueries, conceptQueryCount, conceptQueryPrompt, groundMembers, isUmbrella, memberTerms, mergeConceptCards, sameMember } from '../../src/research/concept.mjs';
import { aggregate, decisionPrompt, normalizeSample, votedMembers } from '../../src/research/decision.mjs';
import { domainUnderstanding, supportedMembers } from '../../src/research/domain.mjs';
import { entityDeliverables, kindOnPage, purposeChecks } from '../../src/research/acceptance.mjs';
import { kindCluster } from '../../src/research/checklist.mjs';

const roofer = { label: 'roofer', terms: ['roofing contractor', 'roof repair'] };
const plumber = { label: 'plumber', terms: ['plumbing', 'pipe repair'] };
const electrician = { label: 'electrician', terms: ['electrician', 'electrical installation'] };
const contractors = { label: 'home improvement contractor', terms: ['home improvement contractor'], members: [roofer, plumber, electrician] };

const page = (host: string, title: string, text: string) => ({ title, url: `https://${host}/`, text });

describe('an item asked as a category of several kinds', () => {
  it('is a category only when it names at least two kinds', () => {
    expect(MIN_MEMBERS).toBe(2);
    expect(isUmbrella(contractors)).toBe(true);
    expect(isUmbrella({ label: 'roofer', terms: ['roofer'], members: [roofer] })).toBe(false);
    expect(isUmbrella({ label: 'roofer', terms: ['roofer'] })).toBe(false);
    expect(isUmbrella(null)).toBe(false);
  });

  it('takes the words of a kind from its terms, or from its label when it has none', () => {
    expect(memberTerms({ label: 'Roofer', terms: ['Roofing Contractor', 'roofing contractor', ''] })).toEqual(['roofing contractor']);
    expect(memberTerms({ label: 'Roofer', terms: [] })).toEqual(['roofer']);
    expect(memberTerms({})).toEqual([]);
  });

  it('treats two kinds as the same when they share the label or a term', () => {
    expect(sameMember(roofer, { label: 'Roofer', terms: ['tiles'] })).toBe(true);
    expect(sameMember(roofer, { label: 'roof fixer', terms: ['roof repair'] })).toBe(true);
    expect(sameMember(roofer, plumber)).toBe(false);
  });
});

describe('the concept card of a category', () => {
  it('asks for one query per kind, up to the category limit', () => {
    expect(conceptQueryCount(contractors)).toBe(6);
    const many = { ...contractors, members: Array.from({ length: 20 }, (_, i) => ({ label: `kind ${i}`, terms: [`kind ${i}`] })) };
    expect(conceptQueryCount(many)).toBe(12);
    expect(conceptQueryCount({ label: 'roofer', terms: ['roofer'] })).toBe(6);
    const prompt = conceptQueryPrompt({ kind: contractors, question: 'Find 30 home improvement contractors in Porto', languages: ['English', 'Portuguese'] });
    expect(prompt[0].content).toContain('kinds of one category');
    expect(prompt[1].content).toContain('Category: home improvement contractor');
    expect(prompt[1].content).toContain('- plumber (words sellers use: plumbing, pipe repair)');
    expect(prompt[1].content).toContain('Write 6 queries');
    expect(prompt[1].content).toContain('One kind per query');
    expect(prompt[1].content).toContain('languages: Portuguese');
  });

  it('falls back to one query per kind when the model writes none', () => {
    expect(conceptQueries(contractors)).toEqual(['roofer roofing contractor', 'plumber plumbing', 'electrician electrical installation']);
  });

  it('reads more pages for a category than for one kind', () => {
    expect(conceptPageLimit(contractors)).toBe(UMBRELLA_PAGES);
    expect(conceptPageLimit({ label: 'roofer', terms: ['roofer'] })).toBe(10);
    const sources = Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, url: `https://h${i}.example/`, text: 'x' }));
    expect(conceptPages(sources)).toHaveLength(10);
    expect(conceptPages(sources, UMBRELLA_PAGES)).toHaveLength(UMBRELLA_PAGES);
  });

  it('asks the model for the kinds the pages show, the proposed ones and new ones', () => {
    const prompt = conceptCardPrompt({ kind: contractors, question: 'q', pages: [{ id: 'P1', title: 'Roof repair Porto', text: 'roofing contractor' }] });
    expect(prompt[0].content).toContain('"members"');
    expect(prompt[0].content).toContain('not proposed below counts too');
    expect(prompt[1].content).toContain(CONCEPT_MARKER);
    expect(prompt[1].content).toContain('Category asked: home improvement contractor');
    expect(prompt[1].content).toContain('Kinds proposed: roofer, plumber, electrician');
    expect(prompt[1].content).toContain('[P1] Roof repair Porto');
  });

  it('keeps the phrases of a kind that most proposals name, under the label first seen', () => {
    const merged = mergeConceptCards([
      { data: { members: [{ label: 'roofer', terms: ['roofing contractor', 'roof tiles'] }, { label: 'plumber', terms: ['plumbing'] }], not: ['hardware store'], hubs: [] } },
      { data: { members: [{ label: 'roofer', terms: ['roofing contractor'] }, { label: 'plumbing service', terms: ['plumbing'] }], not: [], hubs: [] } },
      { data: { members: [{ label: 'gardener', terms: ['garden care'] }], not: ['hardware store'], hubs: [] } },
    ]);
    expect(merged.data.members).toEqual([{ label: 'roofer', terms: ['roofing contractor'] }, { label: 'plumber', terms: ['plumbing'] }]);
    expect(merged.data.not).toEqual(['hardware store']);
    expect(mergeConceptCards([{ data: { terms: ['land'], not: [], hubs: [] } }]).data).toEqual({ terms: ['land'], not: [], hubs: [] });
  });

  it('keeps a phrase of a kind only when two pages carry it', () => {
    const pages = [page('a.example', 'Roofing contractor Porto', 'roof repair and plumbing'), page('b.example', 'Roofing contractor Braga', 'tiles'), page('c.example', 'Electrician', 'wiring')];
    const card = applyConceptCard({ terms: [], not: [], hubs: [], members: [{ label: 'roofer', terms: ['roofing contractor'] }, { label: 'plumber', terms: ['plumbing'] }] }, pages);
    expect(card.members).toEqual([{ label: 'roofer', terms: ['roofing contractor'] }]);
    expect(applyConceptCard({ terms: [], not: [], hubs: [] }, pages)).not.toHaveProperty('members');
  });

  it('needs two sellers for a word of a kind, so a business name on two pages of its own site is not a kind word', () => {
    const pages = [
      { title: 'Porto Pipes plumbing', url: 'https://portopipes.example/', text: 'Porto Pipes: plumbing' },
      { title: 'Porto Pipes boilers', url: 'https://www.portopipes.example/boilers', text: 'Porto Pipes boiler service' },
      { title: 'Leak Fix', url: 'https://leakfix.example/', text: 'plumbing' },
    ];
    const card = applyConceptCard({ members: [{ label: 'plumber', terms: ['plumbing', 'porto pipes'] }] }, pages);
    expect(card.members).toEqual([{ label: 'plumber', terms: ['plumbing'] }]);
    expect(groundMembers([{ label: 'plumber', terms: ['porto pipes', 'plumbing'] }], [], pages)[0].grounded).toEqual(['plumbing']);
  });

  it('grounds each proposed kind on the pages, adds the words and the kinds the pages name, and keeps the unconfirmed kinds', () => {
    const pages = [
      page('a.example', 'Roof repair in Porto', 'Roof repair and new tiles.'),
      page('b.example', 'Roof repair Braga', 'Roofers for every roof.'),
      page('c.example', 'Plumbing Porto', 'Pipe repair and boilers.'),
      page('d.example', 'Plumbing Braga', 'Leaks fixed.'),
    ];
    const grounded = groundMembers(contractors.members, [{ label: 'plumbing service', terms: ['plumbing', 'boiler service'] }, { label: 'window fitter', terms: ['window fitting'] }], pages);
    expect(grounded.map((m) => m.label)).toEqual(['roofer', 'plumber', 'electrician', 'window fitter']);
    expect(grounded[0].grounded).toEqual(['roof repair']);
    expect(grounded[1].terms).toEqual(['plumbing', 'pipe repair', 'boiler service']);
    expect(grounded[1].grounded).toEqual(['plumbing', 'boiler service']);
    expect(grounded[2].grounded).toEqual([]);
    expect(grounded[3].grounded).toEqual(['window fitting']);
    const full = Array.from({ length: MAX_MEMBERS }, (_, i) => ({ label: `kind ${i}`, terms: [`kind ${i}`] }));
    expect(groundMembers(full, [{ label: 'one more', terms: ['one more'] }], pages)).toHaveLength(MAX_MEMBERS);
  });
});

describe('the decision model of a category', () => {
  const sample = (members: object[], label = 'home improvement contractor') => normalizeSample({ concept: 'c', kind: { label, terms: ['home improvement contractor'], members }, criteria: [] });

  it('reads the kinds a proposal lists and drops the unnamed ones', () => {
    const one = normalizeSample({ kind: { label: 'contractor', terms: ['contractor'], members: [{ label: 'Roofer', terms: [] }, { label: '', terms: ['x'] }, { label: 'plumber', terms: ['plumbing', 'a'.repeat(31)] }] } });
    expect(one.kind.members).toEqual([{ label: 'Roofer', terms: ['roofer'] }, { label: 'plumber', terms: ['plumbing'] }]);
    expect(normalizeSample({ kind: { label: 'roofer', terms: ['roofer'] } }).kind.members).toEqual([]);
  });

  it('keeps the kinds most proposals name, merged by a shared word, and adds their words to the kind', () => {
    const samples = [sample([roofer, plumber, electrician]), sample([{ label: 'roof fixer', terms: ['roof repair'] }, plumber]), sample([roofer, { label: 'gardener', terms: ['garden care'] }])];
    expect(votedMembers(samples, 2)).toEqual([{ label: 'roofer', terms: ['roofing contractor', 'roof repair'] }, { label: 'plumber', terms: ['plumbing', 'pipe repair'] }]);
    const model = aggregate(samples, { question: 'Find 30 home improvement contractors in Porto' });
    expect(model.kind.members).toHaveLength(2);
    expect(model.kind.terms).toEqual(['home improvement contractor', 'roofing contractor', 'roof repair', 'plumbing', 'pipe repair']);
  });

  it('is one kind when most proposals list no kinds, or when fewer than two kinds win the vote', () => {
    const single = aggregate([sample([]), sample([]), sample([roofer, plumber])], { question: 'q' });
    expect(single.kind).not.toHaveProperty('members');
    expect(single.kind.terms).toEqual(['home improvement contractor']);
    const split = aggregate([sample([roofer, plumber]), sample([electrician, { label: 'gardener', terms: ['garden care'] }]), sample([roofer, { label: 'painter', terms: ['painting'] }])], { question: 'q' });
    expect(split.kind).not.toHaveProperty('members');
  });

  it('asks the model for the kinds of a category, with a neutral example', () => {
    const prompt = decisionPrompt({ question: 'q' })[0].content;
    expect(prompt).toContain('"members": [{"label": "...", "terms": ["..."]}]');
    expect(prompt).toContain('a category that covers several distinct kinds');
  });
});

describe('understanding a category before searching', () => {
  const sources = [
    { id: 'D1', url: 'https://a.example/x', title: 'Roofing contractor', text: 'Roofing contractor for tiles. Plumbing too.' },
    { id: 'D2', url: 'https://b.example/y', title: 'Roofing contractor list', text: 'A roofing contractor fixes roofs. Plumbing and boilers.' },
    { id: 'D3', url: 'https://c.example/z', title: 'Electrician', text: 'An electrician wires houses.' },
  ];
  const object = [{ aspect: 'object', statement: 'contractors repair homes', quote: 'q', sourceId: 'D1', host: 'a.example' }];

  it('names a kind when two sites use one of its words', () => {
    expect(supportedMembers(contractors.members, sources)).toEqual([{ label: 'roofer', term: 'roofing contractor' }, { label: 'plumber', term: 'plumbing' }]);
  });

  it('is ready when sites name two kinds of the category, though no single word for it agrees', () => {
    const understanding = domainUnderstanding(object, { sources, members: contractors.members });
    expect(understanding.ready).toBe(true);
    expect(understanding.terms).toEqual(['roofing contractor', 'plumbing']);
    expect(understanding.basis).toBe('kinds of the category named on 2+ sites: roofer, plumber');
  });

  it('stays paused when sites name only one kind, or when no kinds are given', () => {
    expect(domainUnderstanding(object, { sources: sources.slice(0, 1).concat(sources[2]), members: contractors.members }).ready).toBe(false);
    expect(domainUnderstanding(object, { sources }).ready).toBe(false);
  });
});

describe('checking delivered pages against a category', () => {
  it('passes a page that shows any kind of the category, not only the category word', () => {
    const checks = purposeChecks({ question: 'Find 30 home improvement contractors in Porto', decisionModel: { kind: contractors } });
    const kind = checks.find((c: { id: string }) => c.id === 'purpose-kind');
    expect(kind.terms).toEqual(['home improvement contractor', 'roofing contractor', 'roof repair', 'plumbing', 'pipe repair', 'electrician', 'electrical installation']);
    expect(kind.label).toBe('Page shows one of the kinds of the asked home improvement contractor: roofer / plumber / electrician');
    expect(kindOnPage('Emergency plumbing in Porto', kind)).toBe(true);
    expect(kindOnPage('Bakery in Porto', kind)).toBe(false);
  });

  it('keeps the asked words of one kind as before', () => {
    const checks = purposeChecks({ question: 'Find 30 roofers in Porto', decisionModel: { kind: { label: 'roofer', terms: ['roofers', 'roof repair'] } } });
    expect(checks.find((c: { id: string }) => c.id === 'purpose-kind').terms).toEqual(['roofers']);
  });

  it('delivers a seller of one kind, anchored on the words of that kind rather than the category label', async () => {
    const nodes = [{ id: 'A', sources: [{ url: 'https://porto-pipes.example/', title: 'Pipe repair and plumbing in Porto', text: 'Pipe repair, plumbing and boilers in Porto.' }] }];
    const terms = contractors.members.flatMap(memberTerms);
    expect(await entityDeliverables(nodes as never, { terms, kindLabel: contractors.label })).toEqual([]);
    expect((await entityDeliverables(nodes as never, { terms, kindLabel: contractors.label, members: contractors.members })).map((d: { url: string }) => d.url)).toEqual(['https://porto-pipes.example/']);
  });

  it('asks the page judge for one of the kinds', () => {
    expect(kindCluster(contractors).items[0].question).toBe('Is this page one home improvement contractor offered as asked, of one of these kinds: roofer, plumber, electrician (not a part, accessory, wanted ad or list)?');
    expect(kindCluster({ label: 'roofer', terms: ['roofer'] }).items[0].question).toBe('Is this page one roofer offered as asked (not a part, accessory, wanted ad or list)?');
  });
});

describe('the engine with a category', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-umbrella-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function provider(cardMembers: object[]) {
    const scripted = new ScriptedProvider();
    return {
      id: 'demo',
      ready: true,
      describe: () => scripted.describe(),
      async chat(args: { messages: Array<{ role: string; content: string }> }) {
        const prompt = args.messages.at(-1)!.content;
        if (prompt.includes(CONCEPT_MARKER)) return { content: JSON.stringify({ members: cardMembers, not: ['hardware store'], hubs: [] }), model: 'm', provider: 'demo', usage: {} };
        if (prompt.startsWith('Category:')) return { content: JSON.stringify({ queries: ['roofing contractor porto', 'plumbing porto', 'electrician porto'] }), model: 'm', provider: 'demo', usage: {} };
        return scripted.chat(args as never);
      },
    };
  }

  function search(pages: object[]) {
    const asked: Array<{ queries: string[]; maxSources: number }> = [];
    return {
      asked,
      enabled: true,
      lastErrors: [],
      async search(queries: string[], options: { maxSources: number }) {
        asked.push({ queries, maxSources: options.maxSources });
        return pages;
      },
      describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
    };
  }

  function engineWith(cardMembers: object[], pages: object[]) {
    const router = new ModelRouter({ providers: [provider(cardMembers)] as never });
    const found = search(pages);
    return { found, engine: new ResearchEngine({ router, search: found, store: new ProjectStore({ dir }) } as never) };
  }

  const project = () => ({ id: 'p', question: 'Find 30 home improvement contractors in Porto', brief: { located: false, regions: ['PT'] }, decisionModel: { kind: structuredClone(contractors), criteria: [] }, log: [] as Array<{ type: string; message: string }> });

  it('confirms a category when the pages name two of its kinds, and keeps the kinds not seen yet', async () => {
    const pages = [
      { title: 'Roof repair Porto', url: 'https://a.example/', text: 'Roof repair and roofing contractor services.' },
      { title: 'Roof repair Braga', url: 'https://b.example/', text: 'Roof repair for homes.' },
      { title: 'Plumbing Porto', url: 'https://c.example/', text: 'Plumbing, pipe repair and boiler service.' },
      { title: 'Plumbing Braga', url: 'https://d.example/', text: 'Plumbing, boiler service.' },
    ];
    const { engine, found } = engineWith([{ label: 'plumber', terms: ['plumbing', 'boiler service'] }], pages);
    const p = project();
    expect(await engine.validateConcept(p as never)).toBe(true);
    expect(found.asked[0].maxSources).toBe(UMBRELLA_PAGES);
    expect(found.asked[0].queries).toEqual(['roofing contractor porto', 'plumbing porto', 'electrician porto']);
    const kind = p.decisionModel.kind as unknown as { terms: string[]; members: Array<{ label: string; grounded: boolean }>; validated: { members: string[]; terms: string[] }; not: string[] };
    expect(kind.validated.members).toEqual(['roofer', 'plumber']);
    expect(kind.validated.terms).toEqual(['roof repair', 'plumbing', 'boiler service']);
    expect(kind.members.map((m) => [m.label, m.grounded])).toEqual([['roofer', true], ['plumber', true], ['electrician', false]]);
    expect(kind.terms).toEqual(expect.arrayContaining(['electrician', 'boiler service', 'home improvement contractor']));
    expect(p.log.some((l) => l.type === 'decision' && l.message.includes('confirmed as a category on 4 page(s): 2 kind(s) named by sellers (roofer, plumber); kept without a page yet: electrician'))).toBe(true);
  });

  it('goes on with the Hints when the pages name a single kind in different words, and pauses without Hints', async () => {
    const pages = [
      { title: 'Groothandel', url: 'https://a.example/', text: 'Tweedehands kleding per kilo in balen.' },
      { title: 'Hurtownia', url: 'https://b.example/', text: 'Odziez uzywana na wage, bele.' },
    ];
    const single = { label: 'used clothing wholesaler', terms: ['used clothing wholesaler'] };
    const run = async (guidance: string) => {
      const { engine } = engineWith([], pages);
      const p = { ...project(), guidance, decisionModel: { kind: structuredClone(single), criteria: [] } } as ReturnType<typeof project> & { phase?: string; guidance: string };
      return { ok: await engine.validateConcept(p as never), p };
    };
    const hinted = await run('graded vintage clothing sold per kg in bales');
    expect(hinted.ok).toBe(true);
    expect(hinted.p.phase).toBeUndefined();
    expect((hinted.p.decisionModel.kind as unknown as { validated: { basis: string } }).validated.basis).toBe('hints');
    expect(hinted.p.log.some((l) => l.type === 'decision' && l.message.includes('name it in different words; your Hints describe the item'))).toBe(true);
    const bare = await run('');
    expect(bare.ok).toBe(false);
    expect(bare.p.phase).toBe('needs-concept');
  });

  it('pauses when the pages confirm only one kind of the category', async () => {
    const pages = [
      { title: 'Roof repair Porto', url: 'https://a.example/', text: 'Roof repair.' },
      { title: 'Roof repair Braga', url: 'https://b.example/', text: 'Roof repair.' },
    ];
    const { engine } = engineWith([], pages);
    const p = project() as ReturnType<typeof project> & { phase?: string };
    expect(await engine.validateConcept(p as never)).toBe(false);
    expect(p.phase).toBe('needs-concept');
    expect(p.log.some((l) => l.type === 'phase' && l.message.includes('confirm only roofer — name the kinds you mean'))).toBe(true);
  });

  it('builds the decision model before the domain study, from the count the question states, so the study knows the kinds', async () => {
    const prompts: string[] = [];
    const scripted = new ScriptedProvider();
    const domainProvider = {
      id: 'demo',
      ready: true,
      describe: () => scripted.describe(),
      async chat(args: { messages: Array<{ role: string; content: string }> }) {
        const prompt = args.messages.at(-1)!.content;
        prompts.push(prompt);
        if (prompt.includes('TASK=DOMAIN_QUERIES')) return { content: JSON.stringify({ queries: ['roofing contractor porto', 'plumbing porto'] }), model: 'm', provider: 'demo', usage: {} };
        if (prompt.includes('TASK=DOMAIN_FINDINGS')) return { content: JSON.stringify({ findings: [{ aspect: 'object', statement: 'contractors repair homes', quote: 'Roofing contractor for tiles.', sourceId: 'D1' }] }), model: 'm', provider: 'demo', usage: {} };
        return scripted.chat(args as never);
      },
    };
    const sources = [
      { title: 'Roofing contractor', url: 'https://a.example/', text: 'Roofing contractor for tiles. Plumbing too.' },
      { title: 'Roofing contractor list', url: 'https://b.example/', text: 'A roofing contractor fixes roofs. Plumbing and boilers.' },
    ];
    const built: number[] = [];
    const modeler = {
      fresh: () => false,
      async build(p: { acceptance: { itemCount: number }; decisionModel: object }) {
        built.push(p.acceptance.itemCount);
        p.decisionModel = { kind: structuredClone(contractors), criteria: [], noLimit: [], missing: [], caseIds: [], agreement: { samples: 3, majority: 2 } };
        return p.decisionModel;
      },
    };
    const router = new ModelRouter({ providers: [domainProvider] as never });
    const engine = new ResearchEngine({ router, search: search(sources), store: new ProjectStore({ dir }), modeler } as never);
    const p = await engine.createProject({ question: 'Find 30 home improvement companies in Porto with their own websites' });
    expect(await engine.studyDomain(p)).toBe(true);
    expect(built).toEqual([30]);
    expect(prompts.find((prompt) => prompt.includes('TASK=DOMAIN_QUERIES'))).toContain('OBJECT TO STUDY:\nhome improvement contractor');
    const domain = (p as unknown as { domain: { ready: boolean; basis: string } }).domain;
    expect(domain.ready).toBe(true);
    expect(domain.basis).toBe('kinds of the category named on 2+ sites: roofer, plumber');
  });

  it('pauses when fewer than two pages are found', async () => {
    const { engine } = engineWith([], [{ title: 'Roof repair Porto', url: 'https://a.example/', text: 'Roof repair.' }]);
    const p = project() as ReturnType<typeof project> & { phase?: string };
    expect(await engine.validateConcept(p as never)).toBe(false);
    expect(p.log.some((l) => l.message.includes('one page about the kinds of "home improvement contractor" was found'))).toBe(true);
  });

  it('under FRL_NO_PAUSE goes on without Hints when the pages name a single kind in different words, and the gap becomes one knowledge piece', async () => {
    const before = process.env.FRL_NO_PAUSE;
    process.env.FRL_NO_PAUSE = '1';
    try {
      const pages = [
        { title: 'Groothandel', url: 'https://a.example/', text: 'Tweedehands kleding per kilo in balen.' },
        { title: 'Hurtownia', url: 'https://b.example/', text: 'Odziez uzywana na wage, bele.' },
      ];
      const { engine } = engineWith([], pages);
      const p = { ...project(), nodes: [], guidance: '', decisionModel: { kind: { label: 'used clothing wholesaler', terms: ['used clothing wholesaler'] }, criteria: [] } } as never as { phase?: string; nodes: Array<{ title: string; knowledge?: string }>; decisionModel: { kind: { validated: { basis: string } } }; log: Array<{ type: string; message: string }> };
      expect(await engine.validateConcept(p as never)).toBe(true);
      expect(p.phase).toBeUndefined();
      expect(p.decisionModel.kind.validated.basis).toBe('no-pause');
      expect(p.nodes.map((n) => n.title)).toEqual(['What a used clothing wholesaler is called']);
      expect(p.log.some((l) => l.type === 'decision' && l.message.includes('"used clothing wholesaler" do not call it the same thing: research continues, each page is judged for the kind, and the gap becomes a knowledge piece'))).toBe(true);
      expect(await engine.validateConcept(p as never)).toBe(true);
      expect(p.nodes).toHaveLength(1);
    } finally {
      if (before === undefined) delete process.env.FRL_NO_PAUSE;
      else process.env.FRL_NO_PAUSE = before;
    }
  });

  it('under FRL_NO_PAUSE goes on when the pages confirm only one kind of the category, and asks what the category consists of', async () => {
    const before = process.env.FRL_NO_PAUSE;
    process.env.FRL_NO_PAUSE = '1';
    try {
      const pages = [
        { title: 'Roof repair Porto', url: 'https://a.example/', text: 'Roof repair.' },
        { title: 'Roof repair Braga', url: 'https://b.example/', text: 'Roof repair.' },
      ];
      const { engine } = engineWith([], pages);
      const p = { ...project(), nodes: [] } as never as { phase?: string; nodes: Array<{ title: string; question: string }>; decisionModel: { kind: { label: string; validated: { basis: string } } } };
      expect(await engine.validateConcept(p as never)).toBe(true);
      expect(p.phase).toBeUndefined();
      expect(p.decisionModel.kind.validated.basis).toBe('no-pause');
      expect(p.nodes.map((n) => n.title)).toEqual([`What a ${p.decisionModel.kind.label} is`]);
      expect(p.nodes[0].question).toContain('what does it consist of?');
    } finally {
      if (before === undefined) delete process.env.FRL_NO_PAUSE;
      else process.env.FRL_NO_PAUSE = before;
    }
  });
});
