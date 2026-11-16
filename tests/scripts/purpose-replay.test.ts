import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODES, ROOT, bannedCalls, insideRepo, metricRows, parseArgs, quoteOfSpans, readBaseline, runReplay, storedMatrix, storedNotes, storedSources, tableText } from '../../scripts/purpose-replay.mjs';
import { sentenceSpans } from '../../src/research/spans.mjs';
import fixture from '../fixtures/verdict-0c750f.json';
import { fakeEmbedder, fakeRouter, pickLetter } from '../helpers/fakes';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.join(HERE, '..', 'fixtures', 'sim-out');
const read = async (name: string) => JSON.parse(await fs.readFile(path.join(SIM, `${name}.json`), 'utf8'));
const questions = JSON.parse(await fs.readFile(path.join(ROOT, 'scripts', 'purpose-replay.questions.json'), 'utf8'));

const page = 'The rear axle beam rusts at the mount. Owners report the fault after ten years. A renewed rear axle removes the fault.';
const refined = { refine: 'AND', questions: [{ q: 'Is the known fault fixed?', checker: 'page', threshold: null }], obstacles: [{ obstacle: 'The fault is present', checker: 'page', threshold: null }] };

function script() {
  return {
    perspectives: { perspectives: [{ name: 'Workshop', aspects: [{ lang: 'English', phrase: 'known faults' }, { lang: 'Czech', phrase: 'časté závady' }] }] },
    'source-relevance': { about: 'A', market: 'A', span: 'S1' },
    'scope-notes': { notes: [{ spans: ['S1'], label: 'rust at the mount' }, { spans: ['S77'], label: 'invented' }] },
    purpose: { who: 'a buyer', outcome: 'a sound car for little money', why: 'a small budget', anchors: ['C1'] },
    implications: { implications: [] },
    requirements: (request: { messages: { content: string }[] }) => ({ groups: [...request.messages[1].content.matchAll(/^\[(S\d+)\]/gm)].map((match) => [match[1]]) }),
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
    expect(files).toEqual(['car-0-scope-notes.json', 'car-0-scope-plan.json', 'car-0-scope-sources.json', 'car-1-tree.json', 'car-2-identity.json', 'car-3-facts.json', 'car-4-ach.json', 'car-ledger.json', 'car-metrics.json', 'hosts.json']);
    expect(search.searched[0]).toEqual(['car known faults', 'car časté závady']);
    expect(search.searched[1]).toEqual(['Alpha 1.2 known faults', 'Alpha 1.2 časté závady']);
    expect(run.phase).toBe('needs-confirmation');
    expect(run.tree.ops.refused).toHaveLength(1);
    expect(run.tree.ops.refused[0].why).toContain('is a protected tension goal');
    expect(metrics.map((row: { id: string }) => row.id)).toEqual(['sources', 'second-opinion', 'notes', 'tensions', 'value-cost', 'numbers', 'trace', 'scope', 'ach', 'facts', 'grades', 'prices', 'judge', 'kind', 'banned', 'calls']);
    const byId = Object.fromEntries(metrics.map((row: { id: string; value: string; pass: boolean | null }) => [row.id, row]));
    expect(byId.sources).toMatchObject({ value: '4 kept, 0 dropped', pass: true });
    expect(byId['second-opinion']).toMatchObject({ value: '4 of 4', pass: true });
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
    const stored = JSON.parse(await fs.readFile(path.join(out, 'car-4-ach.json'), 'utf8'));
    expect(stored.kept.every((row: { marks: Record<string, string> }) => new Set(Object.values(row.marks)).size > 1)).toBe(true);
    expect(stored.tyres.cut).toBeGreaterThan(2000);
    const second = router.calls.filter((call) => call.task === 'source-relevance').slice(4, 8);
    expect(second.every((call) => Array.isArray(call.avoid) && call.avoid.length === 1)).toBe(true);
  });

  it('runs stages 0 to 2 only for the other researches, and reports a run with too few sources as a fail', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-replay-'));
    const few = { ...search, searched: [], async search() { return [{ url: 'https://one.example.cz/a', title: 'One', text: page }]; } };
    const { run, metrics } = await runReplay({ mode: 'suppliers', entry: questions.suppliers, out, router: fakeRouter(script()), search: few, embedder: fakeEmbedder(), fixture, languages: ['English'] });
    expect((await fs.readdir(out)).sort()).toEqual(['suppliers-0-scope-notes.json', 'suppliers-0-scope-plan.json', 'suppliers-0-scope-sources.json', 'suppliers-1-tree.json', 'suppliers-ledger.json', 'suppliers-metrics.json']);
    expect(run.car).toBeNull();
    expect(metrics.find((row: { id: string }) => row.id === 'sources')).toMatchObject({ value: '1 kept, 0 dropped', pass: false });
    expect(metrics.map((row: { id: string }) => row.id)).toContain('direction');
  });

  it('runs the two counter-example questions: no tension goal, and the cost side only when the consumes vote says so', async () => {
    const replay = async (mode: 'library' | 'trail', more: Record<string, unknown>) => {
      const out = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-replay-'));
      const { run, metrics } = await runReplay({ mode, entry: questions[mode], out, router: fakeRouter({ ...script(), tensions: { pairs: [] }, ...more }), search: { ...search, searched: [] }, embedder: fakeEmbedder(), fixture, languages: ['English'] });
      return { run, byId: Object.fromEntries(metrics.map((row: { id: string }) => [row.id, row])) };
    };
    const library = await replay('library', { consumes: { consumes: false } });
    expect(library.run.tree.goals.map((goal: { role?: string }) => goal.role ?? '')).toEqual(['']);
    expect(library.byId.tensions).toMatchObject({ baseline: '-', value: '0 voted pair(s), 0 goal(s), 0 cited explanation(s), 0 research gap(s)', target: 'no tension goal', pass: true });
    expect(library.byId['value-cost']).toMatchObject({ value: 'consumes no: neither side', pass: true });
    const trail = await replay('trail', { consumes: { consumes: true } });
    expect(trail.run.tree.goals.map((goal: { role?: string }) => goal.role ?? '')).toEqual(['', 'value', 'cost']);
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
    expect(passes({ tensions: { pairs: [] }, consumes: { value: false, decided: true }, goals: [] })).toEqual({ sources: false, 'second-opinion': false, notes: true, tensions: true, 'value-cost': true, numbers: true, trace: true, scope: null, banned: false, calls: false });
    expect(passes(null)).toMatchObject({ tensions: false, 'value-cost': false, numbers: false, trace: false });
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
