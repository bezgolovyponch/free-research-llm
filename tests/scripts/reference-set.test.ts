import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BATCH_SIZE, DEFAULT_TARGET, LABEL_RULE, ROOT, TASKS, TYPES, buildSet, checkLabel, factJudgements, itemJudgements, judgementId, labelFiles, loadProjects, loadReplays, manifestOf, mergeLabels, pageId, pagesOf, parseArgs, readSet, replayJudgements, researchType, roundRobin, sampleJudgements, sentencesOf, sourceJudgements } from '../../scripts/reference-set.mjs';

const text = (topic: string) => `${topic} is offered here to groups of any size. The price is stated per person on this page. Bookings are taken by phone and by mail every weekday. ${'More about the offer follows in the next lines of this page. '.repeat(4)}`;
const source = (id: string, url: string, topic: string) => ({ id, kind: 'web', title: `${topic} page`, url, text: text(topic) });

function project(id: string, more: Record<string, unknown> = {}) {
  const sources = [source('S1', `https://one.example.org/${id}/a`, 'Alpha'), source('S2', `https://two.example.org/${id}/b`, 'Beta'), source('S3', `https://three.example.org/${id}/c`, 'Gamma')];
  return {
    id,
    question: `Which things of ${id} are offered to groups`,
    acceptance: { itemCount: null },
    nodes: [
      { id: 'Q', question: 'root', sources: [] },
      { id: 'D1.1', title: 'Offers', question: 'Who offers it to groups?', sources, finding: { claims: [{ text: 'Alpha is offered', quote: 'Alpha is offered here to groups of any size.', sourceIds: ['S1'] }, { text: 'no quote', quote: '', sourceIds: ['S2'] }, { text: 'not on the page', quote: 'This sentence is on no page.', sourceIds: ['S2'] }], items: [{ title: 'Alpha', url: sources[0].url }] } },
    ],
    ...more,
  };
}

const listProject = project('list-aaa111', { acceptance: { itemCount: 5 }, decisionModel: { kind: { label: 'group offer', not: ['voucher'] }, checklist: [{ clause: 'for groups', items: [{ clause: 'for groups', question: 'Does this offer take groups?', hard: true }, { clause: 'for groups', question: 'Within 5 km?', hard: true, numeric: { measure: 'distanceKm', op: '<=', value: 5, unit: 'km' } }] }] }, acceptanceResult: { items: [{ title: 'Alpha offer', url: 'https://one.example.org/list-aaa111/a', checks: [{ id: 'for groups|Does this offer take groups?', answer: 'unknown' }] }] } });

describe('reference set: arguments', () => {
  it('needs an output folder that is outside the repository or under data/, so pages never go into git', () => {
    expect(parseArgs(['build', '--projects', 'p', '--out', path.join(ROOT, 'docs', 'set')]).error).toContain('must be under data/');
    expect(parseArgs(['build', '--projects', 'p']).error).toContain('--out is required');
    expect(parseArgs(['build', '--out', os.tmpdir()]).error).toContain('--projects or --replays is required');
    const args = parseArgs(['build', '--projects', 'p', '--replays', 'r', '--out', path.join(ROOT, 'data', 'reference', 'v1'), '--require', 'a, b', '--fetch']);
    expect(args).toMatchObject({ command: 'build', projects: 'p', replays: 'r', target: DEFAULT_TARGET, seed: 1, perResearch: 12, require: ['a', 'b'], fetch: true });
    for (const bad of ['149', '301', 'x']) expect(parseArgs(['build', '--projects', 'p', '--out', os.tmpdir(), '--target', bad]).error).toContain('--target must be a whole number from 150 to 300');
    expect(parseArgs(['label-file', '--set', 's'])).toMatchObject({ command: 'label-file', size: BATCH_SIZE, labeller: null });
    expect(parseArgs(['merge', '--set', 's', '--labels', 'a.json', '--labels', 'b.json']).labels).toHaveLength(2);
    expect(parseArgs(['merge', '--set', 's']).error).toContain('--set and --labels are required');
    expect(parseArgs(['other']).error).toContain('usage:');
  });
});

describe('reference set: judgements from a stored research', () => {
  it('names the research type from what the research stored, never from a word in its question', () => {
    expect(researchType({ valueFacts: {}, brief: { located: true } })).toBe('valuation');
    expect(researchType({ brief: { located: true } })).toBe('located-listings');
    expect(researchType({ candidates: { kept: [{}] } })).toBe('located-listings');
    expect(researchType({ acceptance: { itemCount: 20 }, brief: { located: false } })).toBe('entity-list');
    expect(researchType({ report: { options: [{}, {}] } })).toBe('comparison');
    expect(researchType({ question: 'Find 20 cars to compare and value' })).toBe('knowledge');
    expect(TYPES).toEqual(['located-listings', 'entity-list', 'knowledge', 'valuation', 'comparison']);
  });

  it('keeps one stored text per page address', () => {
    const pages = pagesOf(project('p1', { hubSources: [{ url: 'https://hub.example.org/x', title: 'Hub', text: text('Hub') }, { url: 'https://short.example.org/x', text: 'too short' }, { url: '', text: text('No address') }] }));
    expect([...pages.keys()]).toEqual(['https://one.example.org/p1/a', 'https://two.example.org/p1/b', 'https://three.example.org/p1/c', 'https://hub.example.org/x']);
  });

  it('pairs every delivered item page with each checklist question, and every page with the kind question', () => {
    const judgements = itemJudgements(listProject);
    expect(judgements.filter((entry) => entry.check === 'question')).toEqual([expect.objectContaining({ task: 'item-check', research: 'list-aaa111', type: 'entity-list', url: 'https://one.example.org/list-aaa111/a', title: 'Alpha offer', delivered: true, clause: 'for groups', question: 'Does this offer take groups?', hard: true, stored: 'not stated' })]);
    const kinds = judgements.filter((entry) => entry.check === 'kind');
    expect(kinds.map((entry) => entry.delivered)).toEqual([true, false, false]);
    expect(kinds[0]).toMatchObject({ question: 'Is this page one group offer offered as asked (not a part, accessory, wanted ad or list and not voucher)?', kind: { label: 'group offer', not: ['voucher'] }, stored: null });
    expect(itemJudgements(project('bare'))).toEqual([]);
  });

  it('pairs each source with the question of its piece, and each quoted claim found on its page with that question', () => {
    const sources = sourceJudgements(project('p1'));
    expect(sources.map((entry) => [entry.url.slice(-1), entry.stored])).toEqual([['a', 'yes'], ['b', 'yes'], ['c', null]]);
    expect(sources[0]).toMatchObject({ task: 'source-relevance', type: 'knowledge', question: 'Does this source help answer: Who offers it to groups?', context: { purpose: 'Which things of p1 are offered to groups', subject: 'Offers' } });
    const facts = factJudgements(project('p1'));
    expect(facts).toEqual([expect.objectContaining({ task: 'fact-subject', url: 'https://one.example.org/p1/a', fact: 'Alpha is offered here to groups of any size.', question: 'Does the quoted statement apply to the subject asked: Who offers it to groups?' })]);
  });
});

describe('reference set: judgements from a stored replay', () => {
  const replay = {
    name: 'library',
    type: 'entity-list',
    entry: { question: 'Find libraries', kind: 'library' },
    plan: { subjects: ['parsing library', 'maintained library'] },
    tree: { tree: { purpose: { text: 'a developer wants a maintained library' } } },
    sources: { kept: [{ url: 'https://k.example.org/1', title: 'Kept one', judgedBy: 'p1' }, { url: 'https://k.example.org/2', title: 'Kept two', judgedBy: 'p1' }], dropped: [{ url: 'https://d.example.org/1', reason: 'off-subject: a different subject' }, { url: 'https://d.example.org/2', reason: 'not judged' }] },
    second: { rows: [{ url: 'https://k.example.org/1', state: 'disagrees', reason: 'off-subject: a different subject', second: { by: 'p2' } }, { url: 'https://k.example.org/2', state: 'same provider', reason: '', second: { by: 'p1' } }] },
  };

  it('takes kept and dropped scoping sources with the answer each provider gave', () => {
    const judgements = replayJudgements(replay);
    expect(judgements.map((entry) => [entry.url.slice(8), entry.stored, entry.answers])).toEqual([
      ['k.example.org/1', 'yes', [{ provider: 'p1', answer: 'yes' }, { provider: 'p2', answer: 'no' }]],
      ['k.example.org/2', 'yes', [{ provider: 'p1', answer: 'yes' }]],
      ['d.example.org/1', 'no', [{ provider: null, answer: 'no' }]],
      ['d.example.org/2', null, []],
    ]);
    expect(judgements[0]).toMatchObject({ task: 'source-relevance', research: 'library', type: 'entity-list', question: 'Is this source about the asked subject: parsing library; maintained library', context: { purpose: 'a developer wants a maintained library' } });
  });

  it('reads the replay folders and gives each the research type of the questions file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-refreplay-'));
    await fs.mkdir(path.join(dir, 'library'));
    await fs.mkdir(path.join(dir, 'empty'));
    await fs.writeFile(path.join(dir, 'library', 'library-0-scope-sources.json'), JSON.stringify(replay.sources));
    await fs.writeFile(path.join(dir, 'library', 'library-0-scope-plan.json'), JSON.stringify(replay.plan));
    const loaded = await loadReplays(dir, { library: { type: 'entity-list', kind: 'library' } });
    expect(loaded.map((entry) => [entry.name, entry.type, entry.sources.kept.length, entry.second])).toEqual([['library', 'entity-list', 2, null]]);
    expect(await loadReplays(null)).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('reference set: sampling', () => {
  const candidate = (task: string, type: string, research: string, n: number) => ({ task, type, research, url: `https://${research}.example.org/${task}/${n}`, question: 'q' });
  const many = (task: string, type: string, research: string, count: number) => Array.from({ length: count }, (_, n) => candidate(task, type, research, n));

  it('takes turns across the lists', () => {
    expect(roundRobin([[1, 2, 3], [4], [5, 6]])).toEqual([1, 4, 5, 2, 6, 3]);
  });

  it('stratifies by research type, takes turns across researches, caps each research and fills the target across the three tasks', () => {
    const pool = [...many('item-check', 'entity-list', 'big', 200), ...many('item-check', 'knowledge', 'small', 3), ...many('source-relevance', 'located-listings', 'big', 200), ...many('source-relevance', 'valuation', 'cars', 40), ...many('fact-subject', 'comparison', 'cmp', 5)];
    const picked = sampleJudgements(pool, { target: 60, seed: 1, perResearch: 30 });
    const count = (keep: (entry: { task: string; type: string; research: string }) => boolean) => picked.filter(keep).length;
    expect(picked).toHaveLength(60);
    expect(TASKS.map((task) => count((entry) => entry.task === task))).toEqual([28, 27, 5]);
    expect(count((entry) => entry.research === 'small')).toBe(3);
    expect(count((entry) => entry.task === 'source-relevance' && entry.type === 'valuation')).toBeGreaterThanOrEqual(13);
    expect(count((entry) => entry.task === 'item-check' && entry.research === 'big')).toBe(25);
    const capped = sampleJudgements(pool, { target: 300, seed: 1, perResearch: 12 });
    expect(Math.max(...TASKS.map((task) => capped.filter((entry) => entry.task === task && entry.research === 'big').length))).toBe(12);
    expect(new Set(capped.map(judgementId)).size).toBe(capped.length);
  });

  it('draws the same sample for the same seed, another for another seed, and never the same judgement twice', () => {
    const pool = [...many('item-check', 'entity-list', 'a', 40), ...many('item-check', 'entity-list', 'a', 40)];
    const first = sampleJudgements(pool, { target: 10, seed: 5 });
    expect(sampleJudgements(pool, { target: 10, seed: 5 })).toEqual(first);
    expect(sampleJudgements(pool, { target: 10, seed: 6 })).not.toEqual(first);
    expect(sampleJudgements(pool, { target: 300, perResearch: 100 })).toHaveLength(40);
  });

  it('spreads one research over its pages before it takes a second question of one page', () => {
    const pool = ['a', 'b', 'c'].flatMap((page) => ['q1', 'q2', 'q3'].map((question) => ({ task: 'item-check', type: 'entity-list', research: 'r', url: `https://r.example.org/${page}`, question })));
    const picked = sampleJudgements(pool, { target: 3, seed: 2 });
    expect(new Set(picked.map((entry) => entry.url)).size).toBe(3);
  });
});

describe('reference set: build, label files and merge', () => {
  const build = async (more: Record<string, unknown> = {}) => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-refset-'));
    const built = await buildSet({ projects: [listProject, project('know-bbb222')], out, target: 150, now: () => new Date('2026-11-18T10:00:00Z'), ...more });
    return { out, built };
  };

  it('writes the records with an empty label slot, the page texts, the stored answers and the counts', async () => {
    const { out, built } = await build();
    const set = await readSet(out);
    expect(set).toMatchObject({ version: 1, builtAt: '2026-11-18T10:00:00.000Z', seed: 1, target: 150, labels: ['yes', 'no', 'not stated'] });
    expect(set.records.length).toBe(built.records.length);
    expect(set.records.every((record: { label: unknown; quote: unknown; labeller: unknown }) => record.label === null && record.quote === null && record.labeller === null)).toBe(true);
    expect(set.records.every((record: Record<string, unknown>) => !('stored' in record) && !('answers' in record))).toBe(true);
    expect(built.manifest).toMatchObject({ judgements: 12, byTask: { 'item-check': 4, 'source-relevance': 6, 'fact-subject': 2 }, byType: { 'entity-list': 8, knowledge: 4 }, researches: 2, pages: 6, missingRequired: [] });
    const first = set.records[0];
    expect(first.page).toBe(pageId(first.url));
    expect(await fs.readFile(path.join(out, 'pages', `${first.page}.txt`), 'utf8')).toContain('is offered here to groups of any size.');
    expect((await sentencesOf(out, first))[0]).toMatchObject({ id: 'S1' });
    const stored = JSON.parse(await fs.readFile(path.join(out, 'answers-stored.json'), 'utf8'));
    expect(stored.run).toBe('stored');
    expect(stored.answers).toContainEqual(expect.objectContaining({ task: 'item-check', research: 'list-aaa111', provider: 'stored', answer: 'not stated' }));
    expect((await fs.readdir(path.join(out, 'pages'))).length).toBe(6);
    await fs.rm(out, { recursive: true, force: true });
  });

  it('refuses to write when a required research gave no judgement, and accepts the short id at the end of a research id', async () => {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-refset-'));
    const refused = await buildSet({ projects: [listProject], out, target: 150, require: ['aaa111', 'zzz999'] });
    expect(refused.error).toBe('no judgement from the required research(es) zzz999; nothing was written');
    expect(await fs.readdir(out)).toEqual([]);
    expect(manifestOf([{ research: 'x-aaa111', task: 't', type: 'k', page: 'p' }], { required: ['aaa111', 'x-aaa111', 'aa111'] }).missingRequired).toEqual(['aa111']);
    await fs.rm(out, { recursive: true, force: true });
  });

  it('reads a replay source page once by code when asked, stores it, and counts the sources it could not read', async () => {
    const replay = { name: 'trail', type: 'located-listings', entry: { kind: 'trail' }, plan: { subjects: ['trail'] }, tree: null, second: null, sources: { kept: [{ url: 'https://k.example.org/1', title: 'Kept', judgedBy: 'p1' }, { url: 'https://k.example.org/gone', title: 'Gone', judgedBy: 'p1' }], dropped: [] } };
    const read: string[] = [];
    const readPage = async (url: string) => { read.push(url); return url.endsWith('gone') ? { text: '' } : { text: text('Trail') }; };
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-refset-'));
    const fetched = await buildSet({ replays: [replay], out, target: 150, readPage, require: ['trail'] });
    expect(read).toEqual(['https://k.example.org/1', 'https://k.example.org/gone']);
    expect(fetched.manifest).toMatchObject({ judgements: 1, byType: { 'located-listings': 1 }, skipped: { 'replay source: the page could not be read': 1 } });
    expect(fetched.storedAnswers).toEqual([expect.objectContaining({ provider: 'p1', answer: 'yes', research: 'trail' })]);
    const none = await buildSet({ replays: [replay], out, target: 150 });
    expect(none.manifest.skipped).toEqual({ 'replay source: no stored page text (run with --fetch)': 2 });
    await fs.rm(out, { recursive: true, force: true });
  });

  it('writes the unlabelled records for a labeller in batches of 25, each with the sentences of its page as ids', async () => {
    const { out } = await build();
    const made = await labelFiles({ set: out, size: 5, labeller: 'strong-model' });
    expect(made).toMatchObject({ open: 12, labelled: 0 });
    expect(made.batches.map((file: string) => path.basename(file))).toEqual(['batch-001.json', 'batch-002.json', 'batch-003.json']);
    const batch = JSON.parse(await fs.readFile(made.batches[0], 'utf8'));
    expect(batch).toMatchObject({ batch: 1, of: 3, labeller: 'strong-model', labels: ['yes', 'no', 'not stated'], rule: LABEL_RULE });
    expect(batch.records).toHaveLength(5);
    expect(batch.records[0]).toMatchObject({ label: null, quote: null, labeller: 'strong-model' });
    expect(batch.records[0].sentences[0]).toEqual({ id: 'S1', text: expect.stringContaining('is offered here to groups of any size.') });
    expect(BATCH_SIZE).toBe(25);
    expect((await labelFiles({ set: path.join(out, 'missing') })).error).toContain('no reference set');
    await fs.rm(out, { recursive: true, force: true });
  });

  it('accepts a label only with a sentence id of the page, unless the label is not stated', () => {
    const spans = [{ id: 'S1', text: 'a' }, { id: 'S2', text: 'b' }];
    expect(checkLabel({ label: 'yes', quote: ['S2'] }, spans, 'owner')).toEqual({ value: { label: 'yes', quote: ['S2'], labeller: 'owner' } });
    expect(checkLabel({ label: 'no', quote: '[s1]' }, spans, 'owner').value).toMatchObject({ label: 'no', quote: ['S1'] });
    expect(checkLabel({ label: 'not stated', quote: null }, spans, 'owner').value).toEqual({ label: 'not stated', quote: null, labeller: 'owner' });
    expect(checkLabel({ label: 'unknown' }, spans, 'owner').value.label).toBe('not stated');
    expect(checkLabel({ label: 'yes', quote: null }, spans, 'owner').error).toBe('a label without a sentence id is refused unless it is "not stated"');
    expect(checkLabel({ label: 'yes', quote: 'The sentence itself.' }, spans, 'owner').error).toContain('not on the page');
    expect(checkLabel({ label: 'no', quote: ['S1', 'S9'] }, spans, 'owner').error).toBe('the quote names a sentence id that is not on the page: S9');
    expect(checkLabel({ label: 'maybe', quote: ['S1'] }, spans, 'owner').error).toContain('must be one of yes, no, not stated');
    expect(checkLabel({ label: 'yes', quote: ['S1'] }, spans, null).error).toBe('the labeller is not named');
  });

  it('merges the accepted labels into the set, lists every refused one with its reason, and never overwrites another label silently', async () => {
    const { out } = await build();
    const set = await readSet(out);
    const [a, b, c, d] = set.records;
    const file = path.join(out, 'labels.json');
    await fs.writeFile(file, JSON.stringify({ labeller: 'strong-model', records: [{ id: a.id, label: 'yes', quote: ['S1'] }, { id: b.id, label: 'no', quote: null }, { id: c.id, label: 'not stated', quote: null }, { id: d.id, label: null, quote: null }, { id: 'J-missing', label: 'yes', quote: ['S1'] }] }));
    const merged = await mergeLabels({ set: out, labels: [file, path.join(out, 'absent.json')] });
    expect(merged).toMatchObject({ merged: 2, labelled: 2, total: 12 });
    expect(merged.refused.map((entry: { id: string | null; why: string }) => [entry.id, entry.why])).toEqual([[b.id, 'a label without a sentence id is refused unless it is "not stated"'], ['J-missing', 'no such record in the set'], [null, 'the file is not a list of labelled records']]);
    const after = await readSet(out);
    expect(after.records.slice(0, 4).map((record: { label: string | null; quote: string[] | null; labeller: string | null }) => [record.label, record.quote, record.labeller])).toEqual([['yes', ['S1'], 'strong-model'], [null, null, null], ['not stated', null, 'strong-model'], [null, null, null]]);
    const other = path.join(out, 'owner.json');
    await fs.writeFile(other, JSON.stringify([{ id: a.id, label: 'no', quote: ['S2'], labeller: 'owner' }]));
    const conflict = await mergeLabels({ set: out, labels: [other] });
    expect(conflict).toMatchObject({ merged: 0, labelled: 2 });
    expect(conflict.refused[0].why).toBe('already labelled "yes" by strong-model; use --replace to overwrite');
    expect((await mergeLabels({ set: out, labels: [other], replace: true })).merged).toBe(1);
    expect((await readSet(out)).records[0]).toMatchObject({ label: 'no', quote: ['S2'], labeller: 'owner' });
    expect((await labelFiles({ set: out })).open).toBe(10);
    await fs.rm(out, { recursive: true, force: true });
  });

  it('loads stored researches from a folder and skips files that are not one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-refprojects-'));
    await fs.writeFile(path.join(dir, 'a.json'), JSON.stringify(listProject));
    await fs.writeFile(path.join(dir, 'b.json'), '{broken');
    await fs.writeFile(path.join(dir, 'c.json'), JSON.stringify({ note: 'not a research' }));
    expect((await loadProjects(dir)).map((entry: { id: string }) => entry.id)).toEqual(['list-aaa111']);
    expect(await loadProjects(null)).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
