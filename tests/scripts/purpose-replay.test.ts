import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODES, ROOT, bannedCalls, coverageMetric, insideRepo, metricRows, offMarketDrops, parseArgs, quoteOfSpans, readBaseline, replayInputs, runReplay, runSpread, secondKappa, secondOpinions, spreadTable, storedEntry, storedMatrix, storedNotes, storedProject, storedSources, tableText } from '../../scripts/purpose-replay.mjs';
import { needsConfirmation, notModelledOf } from '../../src/research/purpose.mjs';
import { diversityOf, screenSources } from '../../src/research/scoping.mjs';
import { sentenceSpans } from '../../src/research/spans.mjs';
import fixture from '../fixtures/verdict-0c750f.json';
import { FAIL, fakeEmbedder, fakeRouter, pickLetter } from '../helpers/fakes';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.join(HERE, '..', 'fixtures', 'sim-out');
const PROJECTS = path.join(HERE, '..', 'fixtures', 'replay', 'projects');
const golden = async (name: string) => JSON.parse(await fs.readFile(path.join(HERE, '..', 'fixtures', 'replay', `${name}.json`), 'utf8'));
const read = async (name: string) => JSON.parse(await fs.readFile(path.join(SIM, `${name}.json`), 'utf8'));
const questions = JSON.parse(await fs.readFile(path.join(ROOT, 'scripts', 'purpose-replay.questions.json'), 'utf8'));

const page = 'The rear axle beam rusts at the mount. Owners report the fault after ten years. A renewed rear axle removes the fault.';
const refined = { refine: 'AND', questions: [{ q: 'Is the known fault fixed?', checker: 'page', threshold: null }], obstacles: [{ obstacle: 'The fault is present', checker: 'page', threshold: null }] };

function script() {
  return {
    perspectives: { perspectives: [{ name: 'Workshop', aspects: [{ lang: 'English', phrase: 'known faults' }, { lang: 'Czech', phrase: 'časté závady' }] }] },
    'fixed-perspectives': (request: { messages: { content: string }[] }) => (request.messages[1].content.includes('Czech') ? { value: [{ lang: 'English', phrase: 'what makes one good' }, { lang: 'Czech', phrase: 'jak poznat kvalitu' }], cost: [{ lang: 'English', phrase: 'all costs of owning' }, { lang: 'Czech', phrase: 'celkové náklady' }] } : { value: [{ lang: 'English', phrase: 'what makes one good' }], cost: [{ lang: 'English', phrase: 'all costs of owning' }] }),
    'source-relevance': { about: 'A', market: 'A', span: 'S1' },
    'source-role': { role: 'A' },
    'scope-notes': { notes: [{ spans: ['S1'], label: 'rust at the mount' }, { spans: ['S77'], label: 'invented' }] },
    purpose: { who: 'a buyer', outcome: 'a sound car for little money', why: 'a small budget', anchors: ['C1'] },
    implications: { implications: [] },
    requirements: (request: { messages: { content: string }[] }) => {
      const ids = [...request.messages[1].content.matchAll(/^\[([ST]\d+)\]/gm)].map((match) => match[1]);
      return { groups: ids[0].startsWith('T') ? [ids] : ids.map((id) => [id]) };
    },
    tensions: { pairs: [['C1', 'C2']] },
    consumes: { consumes: true },
    restates: { restates: [] },
    'obstacle-stated': { anchor: 'N' },
    'cost-phase': { questions: [{ q: 'What does this phase take?', paid: 'B', checker: 'consensus' }], obstacles: [] },
    'tension-explain': { explanations: [{ explanation: 'A known fault lowers what is asked', notes: ['N1'], test: 'Is the known fault present?', checker: 'page' }, { explanation: 'A repaired fault no longer applies', notes: ['N2'], test: 'Was the fault repaired?', checker: 'page' }, { explanation: 'No note behind it', notes: ['N99'] }] },
    goals: { goals: [{ goal: 'A sound engine and body', anchor: 'C2', notes: ['N1'] }, { goal: 'Arrange financing', anchor: 'C1', notes: [] }] },
    refine: refined,
    trace: (request: { messages: { content: string }[] }) => (request.messages[1].content.includes('Goal: A sound') ? { anchor: pickLetter(request, () => true), relation: 'S' } : { anchor: 'N' }),
    'same-goal': { same: 'B' },
    critique: (request: { messages: { content: string }[] }) => ({ ops: [{ op: 'drop', id: request.messages[1].content.match(/^(G\d+) \[from tension\]/m)![1], reason: 'A' }] }),
    identity: { fields: { L1: { value: 'Alpha 1.2', span: 'S1' } } },
    'source-method': { method: 'D', span: 'S2' },
    facts: { facts: [{ spans: ['S1'], for: 'Q1', direction: '-', scope: 'A' }, { spans: ['S2'], for: 'Q1', direction: '-', scope: 'B' }, { spans: ['S3'], for: 'Q1', direction: '+', scope: 'C' }] },
    'subject-match': { applies: 'B' },
    'claim-pair': { relation: 'A' },
    'ach-row': (request: { messages: { content: string }[] }) => ({ marks: Object.fromEntries(['M1', 'M2', 'M0'].map((id) => [id, id === 'M1' && request.messages[1].content.includes('rusts') ? 'C' : 'N'])) }),
    'kind-second': { kind: 'B', span: 'S1' },
    '': (request: { messages: { content: string }[] }) => (request.messages[1].content.includes('This page offers:') ? { kind: 'A', span: 'S1' } : [{ id: 'q1', answer: 'yes', spans: ['S1'] }, { id: 'q2', answer: 'no', spans: [] }]),
  };
}

const search = {
  searched: [] as string[][],
  async search(queries: string[]) {
    this.searched.push(queries);
    return Array.from({ length: 4 }, (_, i) => ({ url: `https://host${i}.example.cz/page`, title: `Report ${i}`, text: `Report ${i} of the workshop says this. ${page}` }));
  },
  async readPage() {
    return { status: 200, text: `Alpha 1.2 for sale today. ${page}` };
  },
};

describe('purpose replay: arguments', () => {
  it('refuses an --out inside the repository and writes nothing', () => {
    expect(insideRepo(path.join(ROOT, 'data', 'replay'))).toBe(true);
    expect(insideRepo(ROOT)).toBe(true);
    expect(insideRepo(os.tmpdir())).toBe(false);
    expect(parseArgs(['car', '--out', path.join(ROOT, 'out')]).error).toContain('outside the repository');
    expect(parseArgs(['car']).error).toContain('--out is required');
    expect(parseArgs(['boats', '--out', os.tmpdir()]).error).toContain('usage:');
    expect(parseArgs(['all', '--out', os.tmpdir(), '--projects', 'p']).modes).toEqual(MODES);
    const ran = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'purpose-replay.mjs'), 'car', '--out', path.join(ROOT, 'replay-out')], { encoding: 'utf8' });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('outside the repository');
  });

  it('holds the five questions of the simulation as an argument file', () => {
    expect(Object.keys(questions)).toEqual(MODES);
    expect(questions.car.question).toContain('within 300km from prague');
    expect(questions.suppliers.question).toContain('wholesale branded second hand clothing');
    expect(questions.plots.question).toBe('Find appropriate plots to buy for a low-entry glamping business in the EU: affordable and valuable, with a scenic location and future upside');
    expect(questions.library.question).toContain('open-source PDF parsing libraries for Node.js');
    expect(questions.trail.question).toContain('hiking trails within two hours of Prague');
    for (const mode of ['library', 'trail']) {
      expect(questions[mode].question).not.toMatch(/price|cost|cheap|afford|value|budget|worth/i);
      expect(questions[mode].expect).toEqual({ tensions: 0 });
    }
    expect(MODES).toEqual(['car', 'suppliers', 'plots', 'library', 'trail']);
  });
});

describe('purpose replay: with --projects the inputs come from the stored research', () => {
  it('reads the question, the hints and the regions from the stored project, never from the questions file', async () => {
    const inputs = await replayInputs(questions.suppliers, PROJECTS);
    expect(inputs.error).toBeUndefined();
    expect(inputs.entry).toMatchObject({
      question: 'Find wholesale branded second hand clothing providers for a retail second hand shop in Czech Republic and Slovakia',
      guidance: 'Supplier countries: NL, DE, UK, IT, PL, LT',
      regions: ['CZ', 'SK'],
      markets: ['Czechia', 'Slovakia'],
      kind: questions.suppliers.kind,
      project: 'b2f5b7',
      stored: true,
    });
    expect(inputs.entry.question).not.toBe(questions.suppliers.question);
    expect(questions.suppliers.guidance).toBe('');
    expect(inputs.rows).toEqual([{ url: 'https://supplier.example.nl/offer', title: 'Branded mix, sorted' }]);
    expect(storedEntry({ kind: 'k', project: 'x', question: 'old', guidance: 'old hint', regions: ['DE'], markets: ['Germany'] }, { question: 'Find a thing', area: { countries: ['PT'] } })).toEqual({ kind: 'k', project: 'x', question: 'Find a thing', guidance: '', regions: ['PT'], markets: ['Portugal'], stored: true });
    expect((await storedProject(PROJECTS, 'b2f5b7')).id).toBe('b2f5b7-fixture');
  });

  it('gives the stored hints to the purpose tree as one hint anchor for one hint that lists examples', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-replay-'));
    const { entry, rows } = await replayInputs(questions.suppliers, PROJECTS);
    const router = fakeRouter(script());
    const { run } = await runReplay({ mode: 'suppliers', entry, rows, out, router, search: { ...search, searched: [] }, embedder: fakeEmbedder(), fixture, languages: ['English'] });
    expect(run.anchors.filter((anchor: { kind: string }) => anchor.kind === 'hint').map((anchor: { text: string }) => anchor.text)).toEqual(['Supplier countries: NL, DE, UK, IT, PL, LT']);
    expect(run.tree.requirements.hints.grouping).toMatchObject({ grouped: true, valid: 2 });
    expect(router.userText('purpose')).toContain('[H1] Supplier countries: NL, DE, UK, IT, PL, LT');
    expect(router.count('purpose')).toBe(3);
    expect(run.scoping.screened).toEqual({ purpose: 'a buyer wants a sound car for little money, because a small budget', subject: 'wholesale second hand clothing provider, as asked: Find wholesale branded second hand clothing providers for a retail second hand shop in Czech Republic and Slovakia' });
    expect(router.userText('source-relevance')).toContain('Asked market: Czechia, Slovakia');
    expect(router.userText('fixed-perspectives')).toContain('Question: Find wholesale branded second hand clothing providers for a retail second hand shop in Czech Republic and Slovakia');
  });

  it('refuses a research whose stored project is missing instead of falling back to the questions file, and leaves the counter-examples alone', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-projects-'));
    const missing = await replayInputs(questions.suppliers, empty);
    expect(missing.entry).toBeUndefined();
    expect(missing.error).toContain('the stored research b2f5b7 is not readable in');
    expect(missing.error).toContain('come only from the stored research');
    await fs.writeFile(path.join(empty, 'b2f5b7-broken.json'), '{"question": ');
    expect((await replayInputs(questions.suppliers, empty)).error).toContain('b2f5b7');
    expect(await replayInputs(questions.library, empty)).toEqual({ entry: questions.library, rows: [] });
    expect(await replayInputs(questions.suppliers, null)).toEqual({ entry: questions.suppliers, rows: [] });
  });
});

describe('purpose replay: golden assertions on the stored replay outputs', () => {
  const brands = ['Ralph Lauren', 'Monclair', 'North face', 'Barbour'];
  const holding = (anchors: { text: string }[]) => anchors.filter((anchor) => brands.some((brand) => anchor.text.includes(brand)));

  it('a list of examples inside one clause is one requirement', async () => {
    const split = await golden('r1-suppliers-1-tree');
    const grouped = await golden('r3-suppliers-1-tree');
    expect(holding(split.anchors).map((anchor) => anchor.id)).toEqual(['C1', 'C2', 'C3', 'C4']);
    expect(holding(grouped.anchors)).toHaveLength(1);
    expect(brands.every((brand) => holding(grouped.anchors)[0].text.includes(brand))).toBe(true);
    expect(grouped.tree.requirements.grouping).toEqual({ grouped: true, valid: 3 });
  });

  it('every requirement is covered: the coverage row fails on a requirement left out, listed or silent', async () => {
    const grouped = await golden('r3-suppliers-1-tree');
    expect(grouped.tree.unrefined).toEqual(['Identify providers offering specific luxury and outdoor brands']);
    expect(coverageMetric(grouped.tree, grouped.anchors)).toEqual({
      value: '2 of 3 requirement(s) in a kept goal; not modelled: C1 Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren, Monclair, North face, Barbour with highest price/value ratio | C2 proven good quality',
      pass: false,
    });
    expect(notModelledOf({ ...grouped.tree, notModelled: [] }, grouped.anchors).map((entry: { id: string }) => entry.id)).toEqual(['C1']);
    expect(needsConfirmation({ ...grouped.tree, confirmedAt: '2026-11-16T00:00:00Z' })).toBe(true);
    const split = await golden('r1-suppliers-1-tree');
    expect(split.tree.notModelled).toEqual([]);
    const silent = coverageMetric(split.tree, split.anchors);
    expect(silent.pass).toBe(false);
    expect(silent.value).toBe('3 of 6 requirement(s) in a kept goal; not modelled: none; neither covered nor listed: C1 Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren | C2 Monclair | C3 North face');
    const row = (stored: { tree: object; anchors: object[] }) => metricRows('suppliers', { scoping: { sources: [], dropped: [], notes: [] }, second: { agreed: 0, total: 0 }, notesOnPage: 0, car: null, banned: 0, budget: {}, tree: stored.tree, anchors: stored.anchors }, {}).find((entry: { id: string }) => entry.id === 'coverage');
    expect(row(grouped)).toMatchObject({ label: 'Requirements in a kept goal; none silently left out', target: 'every requirement in a kept goal', pass: false });
    expect(tableText('suppliers', [row(split)])).toContain('FAIL | Requirements in a kept goal; none silently left out | not measured | 3 of 6 requirement(s)');
  });

  it('at least 4 distinct kept hosts: 8 and 4 in two suppliers runs, 3, 2 and 3 in the runs that were too thin', async () => {
    const hosts = async (name: string) => diversityOf((await golden(`${name}-0-scope-sources`)).kept).hosts;
    expect([await hosts('r1-suppliers'), await hosts('r3-suppliers'), await hosts('r2-suppliers'), await hosts('r1-library'), await hosts('r1-trail')]).toEqual([8, 4, 3, 2, 3]);
    const thin = await golden('r2-suppliers-0-scope-sources');
    const sources = metricRows('suppliers', { scoping: { sources: thin.kept, dropped: thin.dropped, notes: [] }, second: { agreed: 0, total: 0 }, notesOnPage: 0, car: null, banned: 0, budget: {}, tree: null }, {})[0];
    expect(sources).toMatchObject({ id: 'sources', value: '3 kept from 3 host(s) across 0 perspective(s), 9 dropped', target: '>= 4 hosts across >= 2 perspectives', pass: false });
  });

  it('no knowledge source dropped as off-market: the stored drops carry no voted role and fail; screened again, each drop has a voted role and a knowledge source is kept', async () => {
    const counts = async (name: string) => offMarketDrops(await golden(`${name}-0-scope-sources`));
    expect(await counts('r2-suppliers')).toEqual({ total: 9, knowledge: 0, unrecorded: 9 });
    expect(await counts('r1-trail')).toEqual({ total: 4, knowledge: 0, unrecorded: 4 });
    expect(await counts('r1-library')).toEqual({ total: 0, knowledge: 0, unrecorded: 0 });
    const stored = await golden('r2-suppliers-0-scope-sources');
    const before = metricRows('suppliers', { scoping: { sources: stored.kept, dropped: stored.dropped, notes: [] }, second: { agreed: 0, total: 0 }, notesOnPage: 0, car: null, banned: 0, budget: {}, tree: null }, {})[1];
    expect(before).toMatchObject({ id: 'roles', value: '0 knowledge, 9 without a voted role, of 9 off-market drop(s)', target: '0 knowledge, 0 without a voted role', pass: false });
    const offMarket = stored.dropped.filter((entry: { reason: string }) => entry.reason.startsWith('off-market'));
    const knowledge = new Set([offMarket[4].url, offMarket[7].url, offMarket[8].url]);
    const router = fakeRouter({
      'source-relevance': { about: 'A', market: 'C', span: 'S1' },
      'source-role': (request: { messages: { content: string }[] }) => ({ role: [...knowledge].some((url) => request.messages[1].content.includes(`Source title: ${url}`)) ? 'A' : 'B' }),
    });
    const again = await screenSources({ router, embedder: fakeEmbedder() }, { sources: offMarket.map((entry: { url: string }) => ({ url: entry.url, title: entry.url, text: `This page was stored under ${entry.url} in the replay.` })), purpose: questions.suppliers.question, subject: questions.suppliers.kind, markets: ['Czech Republic'], regions: ['CZ'] });
    expect(again.kept.map((source: { url: string; role: string; market: string }) => [source.url, source.role, source.market])).toEqual([...knowledge].map((url) => [url, 'knowledge', 'C']));
    expect(again.dropped).toHaveLength(6);
    expect(offMarketDrops(again)).toEqual({ total: 6, knowledge: 0, unrecorded: 0 });
    expect(offMarketDrops({ dropped: [{ url: 'u', reason: 'off-market: describes another market', role: 'knowledge' }, { url: 'v', reason: 'off-subject: a different subject' }] })).toEqual({ total: 1, knowledge: 1, unrecorded: 0 });
  });

  it('holds no email address and no phone number in the stored fixtures', async () => {
    const dir = path.join(HERE, '..', 'fixtures', 'replay');
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.json'));
    expect(names).toHaveLength(7);
    for (const name of names) {
      const text = await fs.readFile(path.join(dir, name), 'utf8');
      expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(text).not.toMatch(/(?:\+|00)\d[\d ()./-]{7,}\d|\b\d{3}[ .-]\d{3}[ .-]\d{3,4}\b/);
    }
  });
});

describe('purpose replay: the second opinion is asked on the same sentences and the same role', () => {
  const text = 'The guide explains how to choose a supplier. Grades decide the value of a bale. Offers of another country are listed here.';
  const pageOf = (name: string, more: object) => ({ url: `https://${name}.example.com/page`, title: name, text, about: 'A', market: 'C', span: 'S1', judgedBy: 'p1', ...more });

  it('does not apply the market check to a source voted knowledge, and tells disagreement from a missing or same-provider answer', async () => {
    const pages = [pageOf('guide', { role: 'knowledge' }), pageOf('offers', { role: 'market' }), pageOf('silent', { role: 'knowledge' }), pageOf('alone', { role: 'knowledge', judgedBy: 'p2' }), pageOf('other', { role: 'undecided' })];
    const answers = (request: { messages: { content: string }[] }) => {
      const asked = request.messages[1].content;
      if (asked.includes('Source title: silent')) return FAIL;
      if (asked.includes('Source title: other')) return { about: 'C', market: 'A', span: 'S2' };
      return { about: 'A', market: 'C', span: 'S2' };
    };
    const router = fakeRouter({ 'source-relevance': answers }, { providers: ['p2', 'p3'] });
    const second = await secondOpinions({ router, embedder: fakeEmbedder() }, pages, { purpose: 'p', subject: 's', markets: ['Czech Republic'], regions: ['CZ'] });
    expect(second.rows.map((row: { url: string; state: string; reason: string }) => [row.url.slice(8, -17), row.state, row.reason])).toEqual([
      ['guide', 'agrees', ''],
      ['offers', 'disagrees', 'off-market: describes another market'],
      ['silent', 'not judged', 'not judged'],
      ['alone', 'agrees', ''],
      ['other', 'disagrees', 'off-subject: a different subject'],
    ]);
    expect(second).toMatchObject({ agreed: 2, disagreed: 2, unjudged: 1, same: 0, total: 5 });
    expect(router.calls.map((call) => call.avoid)).toEqual([['p1'], ['p1'], ['p1'], ['p2'], ['p1']]);
    expect(router.userText('source-relevance')).toContain('Purpose: p\nAsked subject: s\nAsked market: Czech Republic');
    const one = await secondOpinions({ router: fakeRouter({ 'source-relevance': { about: 'A', market: 'A', span: 'S1' } }, { providers: ['p1'] }), embedder: fakeEmbedder() }, [pages[0]], { purpose: 'p', subject: 's' });
    expect(one).toMatchObject({ agreed: 0, same: 1, total: 1 });
    expect(one.rows[0].state).toBe('same provider');
    const row = metricRows('plots', { scoping: { sources: [], dropped: [], notes: [] }, second, notesOnPage: 0, car: null, banned: 0, budget: {}, tree: null }, {}).find((entry: { id: string }) => entry.id === 'second-opinion');
    expect(row).toMatchObject({ pass: false, rate: { part: 2, total: 5 } });
    expect(row.value).toMatch(/^2 of 5 \(40%\), kappa (n\/a|-?\d\.\d\d) on 4 judged by another provider \(too few: under 30\); 2 disagree, 1 not judged, 0 answered by the same provider$/);
    expect(second.kappa.n).toBe(4);
  });

  it('reports kappa next to the percent: chance-corrected agreement of the two judgements on the same sources', () => {
    const judged = (first: string, again: string, state = first === again ? 'agrees' : 'disagrees') => ({ state, first: { about: first[0], market: first[1] }, second: { about: again[0], market: again[1] } });
    const rows = [...Array.from({ length: 20 }, () => judged('AA', 'AA')), ...Array.from({ length: 15 }, () => judged('BC', 'BC')), ...Array.from({ length: 5 }, () => judged('AA', 'BC')), ...Array.from({ length: 10 }, () => judged('BC', 'AA')), { state: 'same provider', first: { about: 'A', market: 'A' }, second: { about: 'A', market: 'A' } }, { state: 'not judged', first: { about: 'A', market: 'A' }, second: null }];
    const { kappa, n } = secondKappa(rows);
    expect(n).toBe(50);
    expect(kappa).toBeCloseTo(0.4, 10);
    expect(secondKappa([judged('AA', 'AA'), judged('AA', 'AA')])).toEqual({ kappa: null, n: 2 });
    const row = metricRows('plots', { scoping: { sources: [], dropped: [], notes: [] }, second: { agreed: 35, disagreed: 15, unjudged: 1, same: 1, total: 52, rows }, notesOnPage: 0, car: null, banned: 0, budget: {}, tree: null }, {}).find((entry: { id: string }) => entry.id === 'second-opinion');
    expect(row.value).toBe('35 of 52 (67%), kappa 0.40 on 50 judged by another provider; 15 disagree, 1 not judged, 1 answered by the same provider');
  });

  it('repeats a replay with --runs and reports each rate with its count and its spread over the runs', () => {
    expect(parseArgs(['car', '--out', os.tmpdir()]).runs).toBe(1);
    expect(parseArgs(['car', '--out', os.tmpdir(), '--runs', '3']).runs).toBe(3);
    for (const bad of ['0', '10', '1.5', 'x']) expect(parseArgs(['car', '--out', os.tmpdir(), '--runs', bad]).error).toContain('--runs must be a whole number from 1 to 9');
    const run = (agreed: number, total: number, notes: number) => [
      { id: 'second-opinion', label: 'Second opinion', value: `${agreed} of ${total}`, pass: agreed / total >= 0.8, rate: { part: agreed, total } },
      { id: 'notes', label: 'Notes', value: `${notes} of 10`, pass: notes === 10, rate: { part: notes, total: 10 } },
      { id: 'scope', label: 'Scope', value: 'none', pass: null },
    ];
    const spread = runSpread([run(8, 10, 10), run(6, 10, 10), run(9, 12, 9)]);
    expect(spread[0]).toMatchObject({ id: 'second-opinion', runs: 3, passed: 1, judged: 3, counts: ['8 of 10', '6 of 10', '9 of 12'] });
    expect(spread[0].rate).toMatchObject({ min: 0.6, max: 0.8, n: 3 });
    expect(spread[0].rate.mean).toBeCloseTo((0.8 + 0.6 + 0.75) / 3, 10);
    expect(spread[1]).toMatchObject({ passed: 2, judged: 3, counts: ['10 of 10', '10 of 10', '9 of 10'] });
    expect(spread[2]).toMatchObject({ judged: 0, rate: null });
    const text = spreadTable('car', spread);
    expect(text).toContain('== car: 3 run(s) ==');
    expect(text).toContain('1 of 3 | Second opinion | 8 of 10; 6 of 10; 9 of 12 | 72%, 60% to 80% over 3 run(s)');
    expect(text).toContain('READ | Scope | - | -');
  });

  it('screens the library question against what its requirements mean, not the kind word, the first and the second time', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-replay-'));
    const pdf = { ...search, searched: [], async search() { return [{ url: 'https://docs.example.org/pdf', title: 'Parsing PDF files in Node.js', text: 'This guide compares packages that parse PDF files in Node.js. Each package is rated by its release history. The documentation of each is linked.' }, { url: 'https://town.example.org/loans', title: 'Lending rules of the town library', text: 'The town library lends books for four weeks. Readers renew a loan at the desk. The reading room opens at nine.' }]; } };
    const relevance = (request: { messages: { content: string }[] }) => {
      const asked = request.messages[1].content;
      const meant = asked.includes('Asked subject: library, as asked: Find open-source PDF parsing libraries for Node.js that are actively maintained and well documented');
      return { about: meant && asked.includes('Source title: Parsing PDF files in Node.js') ? 'A' : 'C', market: 'B', span: 'S1' };
    };
    const router = fakeRouter({ ...script(), tensions: { pairs: [] }, 'source-relevance': relevance, 'requirement-subjects': { subjects: [{ anchor: 'C1', phrase: 'PDF parsing libraries for Node.js' }] } });
    const { run } = await runReplay({ mode: 'library', entry: questions.library, out, router, search: pdf, embedder: fakeEmbedder(), fixture, languages: ['English'] });
    expect(run.scoping.queries.map((query: { query: string }) => query.query).slice(0, 3)).toEqual(['PDF parsing libraries for Node.js what makes one good', 'PDF parsing libraries for Node.js all costs of owning', 'PDF parsing libraries for Node.js known faults']);
    expect(run.scoping.queries.every((query: { query: string; subject: string }) => query.subject === 'PDF parsing libraries for Node.js' && !query.query.startsWith('library '))).toBe(true);
    const plan = JSON.parse(await fs.readFile(path.join(out, 'library-0-scope-plan.json'), 'utf8'));
    expect(plan).toMatchObject({ subjects: ['PDF parsing libraries for Node.js'], subjectsFrom: 'requirements', askedSubjects: { rejected: [] } });
    expect(run.scoping.sources.map((source: { url: string; about: string }) => [source.url, source.about])).toEqual([['https://docs.example.org/pdf', 'A']]);
    expect(run.scoping.dropped).toEqual([{ url: 'https://town.example.org/loans', reason: 'off-subject: a different subject' }]);
    expect(run.second).toMatchObject({ agreed: 1, total: 1 });
    expect(router.userText('source-role')).toContain('Asked subject: library, as asked: Find open-source PDF parsing libraries for Node.js');
    const bare = await screenSources({ router: fakeRouter({ 'source-relevance': relevance, 'source-role': { role: 'A' } }), embedder: fakeEmbedder() }, { sources: await pdf.search(), purpose: questions.library.question, subject: questions.library.kind });
    expect(bare.kept).toEqual([]);
  });

  it('judges the second time with the purpose and the subject the first screen used', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-replay-'));
    const rows = [{ title: 'Alpha 1.2', subject: ['Alpha'] }, { title: 'Alpha 1.4', subject: ['Alpha'] }];
    const router = fakeRouter({ ...script(), 'subject-levels': { levels: ['make', 'engine'] } });
    const { run } = await runReplay({ mode: 'plots', entry: { ...questions.trail, kind: 'car' }, rows, out, router, search: { ...search, searched: [] }, embedder: fakeEmbedder(), fixture, languages: ['English'] });
    expect(run.scoping.screened).toEqual({ purpose: 'a buyer wants a sound car for little money, because a small budget', subject: 'car (any of: Alpha)' });
    const judged = router.calls.filter((call) => call.task === 'source-relevance').map((call) => call.messages[1].content);
    expect(judged).toHaveLength(8);
    expect(judged.every((asked) => asked.includes('Asked subject: car (any of: Alpha)'))).toBe(true);
    expect(judged.slice(4)).toEqual(judged.slice(0, 4));
  });
});

describe('purpose replay: the baseline is reproduced from the stored simulation', () => {
  it('counts the notes with a quote on the page: 5 of 10, 0 of 14, 4 of 14', async () => {
    expect(storedNotes(await read('car-0-scope-notes'))).toEqual({ withQuote: 5, total: 10 });
    expect(storedNotes(await read('suppliers-0-scope-notes'))).toEqual({ withQuote: 0, total: 14 });
    expect(storedNotes(await read('plots-0-scope-notes'))).toEqual({ withQuote: 4, total: 14 });
  });

  it('counts the ACH rows that do not discriminate: 9 of 17', async () => {
    expect(storedMatrix(await read('car-4-ach'))).toEqual({ nonDiagnostic: 9, total: 17 });
    expect(await readBaseline(SIM, 'car')).toMatchObject({ notes: '5 of 10', ach: '9 of 17', tensions: 'removed' });
    expect((await readBaseline(path.join(SIM, 'missing'), 'plots')).notes).toBe('4 of 14');
  });

  it('judges the stored scoping sources one by one: 1 of 8 on the market', async () => {
    const router = fakeRouter({ 'source-relevance': (request: { messages: { content: string }[] }) => (request.messages[1].content.includes('page address and text: in CZ') ? { about: 'B', market: 'A', span: 'S1' } : { about: 'C', market: 'C', span: 'S1' }) });
    const counted = await storedSources({ router, embedder: fakeEmbedder() }, await read('car-0-scope-sources'), { purpose: questions.car.question, subject: 'car', markets: ['Czech Republic'], regions: ['CZ'] });
    expect(counted).toEqual({ kept: 1, total: 8 });
    expect(router.calls).toHaveLength(8);
  });

  it('knows whether a quote is made of sentences of a page', () => {
    const spans = sentenceSpans(page);
    expect(quoteOfSpans('Owners report the fault after ten years.', spans)).toBe(true);
    expect(quoteOfSpans('The rear axle beam rusts at the mount. A renewed rear axle removes the fault.', spans)).toBe(true);
    expect(quoteOfSpans('The rear axle rusts.', spans)).toBe(false);
  });
});

describe('purpose replay: one run with fakes', () => {
  it('writes the stage files, keeps the tension goal the critique tried to drop, and prints every metric row', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-replay-'));
    const router = Object.assign(fakeRouter(script()), { ledger: [] as { provider: string; model: string }[] });
    const complete = router.complete.bind(router);
    router.complete = async (request) => {
      const reply = await complete(request);
      router.ledger.push({ provider: reply.provider, model: reply.model });
      return reply;
    };
    const { run, metrics } = await runReplay({ mode: 'car', entry: questions.car, out, router, search, embedder: fakeEmbedder(), fixture, languages: ['English', 'Czech'], env: { FRL_BANNED_FAMILIES: 'p3' } });
    const files = (await fs.readdir(out)).sort();
    expect(files).toEqual(['car-0-scope-notes.json', 'car-0-scope-plan.json', 'car-0-scope-second.json', 'car-0-scope-sources.json', 'car-1-tree.json', 'car-2-identity.json', 'car-3-facts.json', 'car-4-ach.json', 'car-ledger.json', 'car-metrics.json', 'hosts.json']);
    expect(search.searched.slice(0, 3)).toEqual([['car what makes one good', 'car jak poznat kvalitu'], ['car all costs of owning', 'car celkové náklady'], ['car known faults', 'car časté závady']]);
    expect(search.searched[3]).toEqual(['Alpha 1.2 what makes one good', 'Alpha 1.2 jak poznat kvalitu', 'Alpha 1.2 all costs of owning', 'Alpha 1.2 celkové náklady', 'Alpha 1.2 known faults', 'Alpha 1.2 časté závady']);
    expect(run.phase).toBe('needs-confirmation');
    expect(run.tree.ops.refused).toHaveLength(1);
    expect(run.tree.ops.refused[0].why).toContain('is a protected tension goal');
    expect(metrics.map((row: { id: string }) => row.id)).toEqual(['sources', 'roles', 'second-opinion', 'notes', 'tensions', 'value-cost', 'coverage', 'numbers', 'trace', 'scope', 'ach', 'facts', 'grades', 'prices', 'judge', 'kind', 'banned', 'calls']);
    const byId = Object.fromEntries(metrics.map((row: { id: string; value: string; pass: boolean | null }) => [row.id, row]));
    expect(byId.sources).toMatchObject({ value: '4 kept from 4 host(s) across 3 perspective(s), 0 dropped', target: '>= 4 hosts across >= 2 perspectives', pass: true });
    expect(byId.roles).toMatchObject({ value: '0 knowledge, 0 without a voted role, of 0 off-market drop(s)', pass: true });
    expect(byId['second-opinion']).toMatchObject({ pass: true, rate: { part: 4, total: 4 } });
    expect(byId['second-opinion'].value).toMatch(/^4 of 4 \(100%\), kappa (n\/a|-?\d\.\d\d) on 4 judged by another provider \(too few: under 30\); 0 disagree, 0 not judged, 0 answered by the same provider$/);
    expect(byId.coverage.value).toMatch(/^(\d+) of \1 requirement\(s\) in a kept goal/);
    expect(byId.coverage).toMatchObject({ target: 'every requirement in a kept goal', pass: true });
    expect(run.tree.notModelled).toEqual([]);
    const stored = JSON.parse(await fs.readFile(path.join(out, 'car-0-scope-sources.json'), 'utf8'));
    expect(stored.diversity).toEqual({ hosts: 4, perspectives: 3, minHosts: 4, minPerspectives: 2, rounds: 1 });
    expect(stored.kept.every((source: { role: string; perspectives: string[] }) => source.role === 'knowledge' && source.perspectives.length === 3)).toBe(true);
    const seconds = JSON.parse(await fs.readFile(path.join(out, 'car-0-scope-second.json'), 'utf8'));
    expect(seconds.rows[0]).toEqual({ url: 'https://host0.example.cz/page', role: 'knowledge', first: { about: 'A', market: 'A', span: 'S1', by: 'p1' }, second: { about: 'A', market: 'A', span: 'S1', by: 'p2' }, state: 'agrees', reason: '' });
    expect(byId.notes).toMatchObject({ value: '4 of 4', pass: true });
    expect(byId.tensions).toMatchObject({ baseline: 'removed', value: '1 voted pair(s), 1 goal(s), 2 cited explanation(s), 0 research gap(s)', pass: true });
    expect(byId['value-cost']).toMatchObject({ baseline: '-', value: 'consumes yes: value side 1 question(s), cost side 3 of 3 phases with 3 question(s)', pass: true });
    expect(byId.trace).toMatchObject({ value: '0', pass: true });
    expect(byId.scope.value).toContain('proposed: Arrange financing');
    expect(byId.scope.pass).toBeNull();
    expect(byId.ach).toMatchObject({ pass: true });
    expect(byId.facts.value).toMatch(/^0 applied; \d+ listed as not applicable$/);
    expect(byId.grades).toMatchObject({ value: '0', pass: true });
    expect(byId.prices.value).toMatch(/^0; comparables: (below|within|above)$/);
    expect(byId.judge).toMatchObject({ value: '0', pass: true });
    expect(byId.kind).toMatchObject({ value: 'kind no, tier rejected', pass: true });
    expect(router.userText('kind-second')).toContain('Price of this item: 2000 CZK');
    expect(byId.banned.pass).toBe(true);
    expect(byId.calls.pass).toBe(true);
    const text = tableText('car', metrics);
    for (const row of metrics) expect(text).toContain(row.label);
    expect(text).toContain('PASS | Tension goals only for voted pairs of the stated requirements, every explanation cited from a scoping note | removed | 1 voted pair(s), 1 goal(s), 2 cited explanation(s), 0 research gap(s) | one protected goal per voted pair; fewer than 2 cited explanations is a research gap');
    const ach = router.calls.find((call) => call.task === 'ach-row')!.messages.map((message) => message.content).join(' ');
    expect(ach).toContain('What is explained: Meet both at once:');
    expect(ach).toContain('[M0] the combination does not hold here');
    const matrix = JSON.parse(await fs.readFile(path.join(out, 'car-4-ach.json'), 'utf8'));
    expect(matrix.kept.every((row: { marks: Record<string, string> }) => new Set(Object.values(row.marks)).size > 1)).toBe(true);
    expect(matrix.tyres.cut).toBeGreaterThan(2000);
    const second = router.calls.filter((call) => call.task === 'source-relevance').slice(4, 8);
    expect(second.every((call) => Array.isArray(call.avoid) && call.avoid.length === 1)).toBe(true);
  });

  it('runs stages 0 to 2 only for the other researches, and reports a run with too few sources as a fail', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-replay-'));
    const few = { ...search, searched: [], async search() { return [{ url: 'https://one.example.cz/a', title: 'One', text: page }]; } };
    const { run, metrics } = await runReplay({ mode: 'suppliers', entry: questions.suppliers, out, router: fakeRouter(script()), search: few, embedder: fakeEmbedder(), fixture, languages: ['English'] });
    expect((await fs.readdir(out)).sort()).toEqual(['suppliers-0-scope-notes.json', 'suppliers-0-scope-plan.json', 'suppliers-0-scope-second.json', 'suppliers-0-scope-sources.json', 'suppliers-1-tree.json', 'suppliers-ledger.json', 'suppliers-metrics.json']);
    expect(run.car).toBeNull();
    expect(metrics.find((row: { id: string }) => row.id === 'sources')).toMatchObject({ value: '1 kept from 1 host(s) across 3 perspective(s), 0 dropped', pass: false });
    expect(run.scoping.enough).toBe(false);
    expect(metrics.map((row: { id: string }) => row.id)).toContain('direction');
  });

  it('runs the two counter-example questions: no tension goal, and the cost side only when the consumes vote says so', async () => {
    const replay = async (mode: 'library' | 'trail', more: Record<string, unknown>) => {
      const out = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-replay-'));
      const { run, metrics } = await runReplay({ mode, entry: questions[mode], out, router: fakeRouter({ ...script(), tensions: { pairs: [] }, ...more }), search: { ...search, searched: [] }, embedder: fakeEmbedder(), fixture, languages: ['English'] });
      return { run, byId: Object.fromEntries(metrics.map((row: { id: string }) => [row.id, row])) };
    };
    const library = await replay('library', { consumes: { consumes: false } });
    expect(library.run.tree.goals.map((goal: { role?: string }) => goal.role ?? '').every((role: string) => role === '')).toBe(true);
    expect(library.byId.tensions).toMatchObject({ baseline: '-', value: '0 voted pair(s), 0 goal(s), 0 cited explanation(s), 0 research gap(s)', target: 'no tension goal', pass: true });
    expect(library.byId['value-cost']).toMatchObject({ value: 'consumes no: neither side', pass: true });
    const trail = await replay('trail', { consumes: { consumes: true } });
    expect(trail.run.tree.goals.map((goal: { role?: string }) => goal.role ?? '')).toEqual(['', 'value', 'cost', '']);
    expect(trail.byId.tensions).toMatchObject({ target: 'no tension goal', pass: true });
    expect(trail.byId['value-cost']).toMatchObject({ value: 'consumes yes: value side 1 question(s), cost side 3 of 3 phases with 3 question(s)', pass: true });
    const voted = await replay('trail', { consumes: { consumes: true }, tensions: { pairs: [['C1', 'C1']] } });
    expect(voted.byId.tensions).toMatchObject({ value: '1 voted pair(s), 1 goal(s), 2 cited explanation(s), 0 research gap(s)', target: 'no tension goal', pass: false });
  });

  it('counts ledger calls to a banned family, and the tension and value-cost rows fail on a tree that breaks their rule', () => {
    expect(bannedCalls([{ provider: 'a', model: 'qwen3-32b' }, { provider: 'b', model: 'llama-3' }, { provider: 'router', model: 'qwen' }], { FRL_BANNED_FAMILIES: 'qwen' })).toBe(1);
    expect(bannedCalls([{ provider: 'a', model: 'qwen3-32b' }], {})).toBe(0);
    const base = { scoping: { sources: [], dropped: [], notes: [] }, second: { agreed: 0, total: 0 }, notesOnPage: 0, car: null, banned: 2, budget: { tree: { used: 60, cap: 60, skipped: 3 } } };
    const pair = { id: 'C1|C2', a: 'C1', b: 'C2', texts: ['a', 'b'], votes: 2 };
    const method = { id: 'M0', key: 'method', hypothesis: 'the combination does not hold here', notes: [] };
    const tension = (more: object) => ({ id: 'G2', role: 'tension', pair: 'C1|C2', goal: 'Meet both at once: "a" and "b"', state: 'kept', protected: true, trace: { kind: 'rule', text: 'tension' }, hypotheses: [method], questions: [], gap: { kind: 'research gap', found: 0, needed: 2 }, ...more });
    const passes = (tree: object | null) => Object.fromEntries(metricRows('plots', { ...base, tree }, {}).map((row: { id: string; pass: boolean | null }) => [row.id, row.pass]));
    expect(passes({ tensions: { pairs: [] }, consumes: { value: false, decided: true }, goals: [] })).toEqual({ sources: false, roles: true, 'second-opinion': false, notes: true, tensions: true, 'value-cost': true, coverage: true, numbers: true, trace: true, scope: null, banned: false, calls: false });
    expect(passes(null)).toMatchObject({ tensions: false, 'value-cost': false, coverage: false, numbers: false, trace: false });
    expect(passes({ tensions: { pairs: [pair] }, consumes: { value: false, decided: true }, goals: [] }).tensions).toBe(false);
    expect(passes({ tensions: { pairs: [pair] }, consumes: { value: false, decided: true }, goals: [tension({})] }).tensions).toBe(true);
    expect(passes({ tensions: { pairs: [pair] }, consumes: { value: false, decided: true }, goals: [tension({ gap: undefined })] }).tensions).toBe(false);
    expect(passes({ tensions: { pairs: [pair] }, consumes: { value: false, decided: true }, goals: [tension({ hypotheses: [{ id: 'M1', hypothesis: 'no note', notes: [] }, method] })] }).tensions).toBe(false);
    expect(passes({ tensions: { pairs: [pair] }, consumes: { value: false, decided: true }, goals: [tension({ hypotheses: [] })] }).tensions).toBe(false);
    expect(passes({ tensions: { pairs: [] }, consumes: { value: false, decided: true }, goals: [tension({})] }).tensions).toBe(false);
    const value = { id: 'G3', role: 'value', protected: true, state: 'kept', trace: { kind: 'rule', text: 'value' }, questions: [{ id: 'Q1', q: 'x', checker: 'page' }] };
    const cost = (more: object) => ({ id: 'G4', role: 'cost', protected: true, state: 'kept', trace: { kind: 'rule', text: 'cost' }, phases: [{ id: 'pre-transaction', questions: 1 }, { id: 'transaction', questions: 1 }, { id: 'post-transaction', questions: 1 }], questions: [{ id: 'Q2', q: 'a', checker: 'consensus', price: false }, { id: 'Q3', q: 'b', checker: 'code', price: true }, { id: 'Q4', q: 'c', checker: 'official', price: false }], ...more });
    const sides = (consumes: boolean, goals: object[]) => passes({ tensions: { pairs: [] }, consumes: { value: consumes, decided: true }, goals })['value-cost'];
    expect(sides(true, [value, cost({})])).toBe(true);
    expect(sides(true, [value])).toBe(false);
    expect(sides(true, [value, cost({ phases: [{ id: 'pre-transaction', questions: 0 }, { id: 'transaction', questions: 2 }, { id: 'post-transaction', questions: 1 }] })])).toBe(false);
    expect(sides(true, [value, cost({ questions: [{ id: 'Q3', q: 'b', checker: 'page', price: true }] })])).toBe(false);
    expect(sides(true, [value, cost({ questions: [{ id: 'Q3', q: 'b', checker: 'statistic', price: false }] })])).toBe(false);
    expect(sides(false, [value, cost({})])).toBe(false);
  });
});
