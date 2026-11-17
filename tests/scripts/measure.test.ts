import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JUDGE_STAGE, ROOT, answersOf, baselineText, compareRuns, compareText, judgeBaseline, judgeGroups, pairsOf, parseArgs, scoreAnswers, scoreText, spreadText } from '../../scripts/measure.mjs';

type Reply = { id: string; task?: string; research?: string; provider?: string; answer: string };

const record = (id: string, label: string | null, more: Record<string, unknown> = {}) => ({ id, task: 'item-check', research: 'r1', label, quote: label && label !== 'not stated' ? ['S1'] : null, labeller: label ? 'owner' : null, ...more });
const many = (prefix: string, count: number, label: string, more: Record<string, unknown> = {}) => Array.from({ length: count }, (_, at) => record(`${prefix}${at}`, label, more));
const answers = (prefix: string, count: number, answer: string, provider = 'p1', from = 0): Reply[] => Array.from({ length: count }, (_, at) => ({ id: `${prefix}${at + from}`, provider, answer }));

describe('measure: arguments', () => {
  it('needs a reference set, and the files or the output folder of its command', () => {
    expect(parseArgs(['other']).error).toContain('usage:');
    expect(parseArgs(['score', '--answers', 'a.json']).error).toContain('--reference is required');
    expect(parseArgs(['score', '--reference', 'set']).error).toContain('--answers is required');
    expect(parseArgs(['score', '--reference', 'set', '--answers', 'a.json', '--answers', 'b.json']).answers).toHaveLength(2);
    expect(parseArgs(['compare', '--reference', 'set', '--a', 'a.json']).error).toContain('--a and --b are required');
    expect(parseArgs(['compare', '--reference', 'set', '--a', 'a.json', '--b', 'b.json'])).toMatchObject({ command: 'compare', seed: 1, resamples: 2000 });
    expect(parseArgs(['compare', '--reference', 'set', '--a', 'a.json', '--b', 'b.json', '--resamples', '50']).error).toContain('at least 100');
    expect(parseArgs(['judge', '--reference', 'set']).error).toContain('--out is required');
    expect(parseArgs(['judge', '--reference', 'set', '--out', path.join(ROOT, 'docs')]).error).toContain('must be under data/');
    expect(parseArgs(['judge', '--reference', 'set', '--out', path.join(ROOT, 'data', 'reference', 'runs')])).toMatchObject({ command: 'judge', runs: 1, limit: null });
    expect(parseArgs(['judge', '--reference', 'set', '--out', os.tmpdir(), '--runs', '3', '--limit', '10'])).toMatchObject({ runs: 3, limit: 10 });
    expect(parseArgs(['judge', '--reference', 'set', '--out', os.tmpdir(), '--runs', '12']).error).toContain('--runs must be a whole number from 1 to 9');
  });
});

describe('measure: stored answers against the reference set', () => {
  const records = [...many('y', 20, 'yes'), ...many('n', 15, 'no'), ...many('u', 5, 'not stated'), record('open', null), ...many('s', 4, 'yes', { task: 'source-relevance' })];

  it('reads an answers file as a list or as { answers }, with unknown read as not stated', () => {
    expect(answersOf({ answers: [{ id: 'a', answer: 'unknown' }, { id: 'b', answer: 'maybe' }, { answer: 'yes' }] })).toEqual([{ id: 'a', answer: 'not stated' }]);
    expect(answersOf([{ id: 'a', answer: 'YES' }])).toEqual([{ id: 'a', answer: 'yes' }]);
    expect(answersOf(null)).toEqual([]);
  });

  it('scores only labelled records, and names the task, the research and the provider of each pair', () => {
    const pairs = pairsOf(records, [{ id: 'y0', provider: 'p1', answer: 'no' }, { id: 'open', provider: 'p1', answer: 'yes' }, { id: 'gone', provider: 'p1', answer: 'yes' }, { id: 's0', answer: 'yes' }]);
    expect(pairs).toEqual([{ id: 'y0', task: 'item-check', research: 'r1', provider: 'p1', reference: 'yes', answer: 'no' }, { id: 's0', task: 'source-relevance', research: 'r1', provider: 'unknown', reference: 'yes', answer: 'yes' }]);
  });

  it('reports per task and provider the kappa with its count, the confusion counts and the wrong-no rate of the judge', () => {
    const p1 = [...answers('y', 15, 'yes'), ...answers('y', 5, 'no', 'p1', 15), ...answers('n', 15, 'no'), ...answers('u', 3, 'not stated'), ...answers('u', 2, 'no', 'p1', 3)];
    const p2 = [...answers('y', 20, 'yes', 'p2'), ...answers('s', 4, 'yes', 'p2')];
    const score = scoreAnswers(records, [...p1, ...p2]);
    expect(score).toMatchObject({ labelled: 44, answered: 64 });
    expect(score.rows.map((row: { task: string; provider: string; n: number }) => [row.task, row.provider, row.n])).toEqual([['item-check', 'p1', 40], ['item-check', 'p2', 20], ['item-check', 'all', 60], ['source-relevance', 'p2', 4]]);
    const first = score.rows[0];
    expect(first.confusion.matrix).toEqual([[15, 5, 0], [0, 15, 0], [0, 2, 3]]);
    expect(first.wrongNo).toMatchObject({ part: 7, total: 25, rate: 0.28 });
    expect(first.accuracy).toMatchObject({ part: 33, total: 40 });
    expect(first.kappa).toBeCloseTo((0.825 - (0.5 * 0.375 + 0.375 * 0.55 + 0.125 * 0.075)) / (1 - (0.5 * 0.375 + 0.375 * 0.55 + 0.125 * 0.075)), 10);
    expect(first.enough).toBe(true);
    expect(score.rows[1]).toMatchObject({ kappa: null, enough: false, wrongNo: { part: 0, total: 20 } });
    expect(score.rows[3].wrongNo).toBeUndefined();
    const text = scoreText(score);
    expect(text).toContain('labelled records: 44; answers on labelled records: 64');
    expect(text).toContain("== item-check · p1 ==\nCohen's kappa: 0.71 on 40");
    expect(text).toContain('wrong no (a "no" where the reference says yes or not stated): 7 of 25 (28.0%, 95% interval');
    expect(text).toContain("== item-check · p2 ==\nCohen's kappa: n/a on 20 (too few: under 30)");
    expect(text).toContain('  yes        15 | 5 | 0');
  });
});

describe('measure: paired comparison of two runs', () => {
  const research = (name: string, count: number, label = 'yes') => many(`${name}-`, count, label, { research: name });
  const records = [...research('r1', 10), ...research('r2', 10), ...research('r3', 10), ...research('r4', 10)];
  const run = (wrongPer: number) => ['r1', 'r2', 'r3', 'r4'].flatMap((name) => [...answers(`${name}-`, wrongPer, 'no'), ...answers(`${name}-`, 10 - wrongPer, 'yes', 'p1', wrongPer)]);

  it('pairs the two runs on the same items and gives the difference with its bootstrap interval, resampled by research', () => {
    const rows = compareRuns(records, run(6), run(1), { seed: 2 });
    expect(rows.map((row: { id: string }) => row.id)).toEqual(['agreement', 'wrong-no']);
    expect(rows[0]).toMatchObject({ n: 40, clusters: 4, resamples: 2000, a: 0.4, b: 0.9, decided: true });
    expect(rows[0].difference).toBeCloseTo(0.5, 12);
    expect([rows[0].low, rows[0].high]).toEqual([0.5, 0.5]);
    expect(rows[1].difference).toBeCloseTo(-0.5, 12);
    expect(compareRuns(records, run(6), run(1), { seed: 2 })).toEqual(rows);
    const text = compareText(rows);
    expect(text).toContain('agreement with the reference: A 40.0%, B 90.0%, difference B - A 50.0 points, 95% bootstrap interval 50.0 to 50.0 (40 paired items in 4 research(es), 2000 resamples by research): the interval excludes 0');
  });

  it('shows no difference when the interval includes 0, pairs only items both runs answered, and counts an item once', () => {
    const a = [...answers('r1-', 10, 'yes'), ...answers('r2-', 10, 'no'), ...answers('r3-', 5, 'yes'), ...answers('r1-', 1, 'no')];
    const b = [...answers('r1-', 10, 'no'), ...answers('r2-', 10, 'yes'), ...answers('r4-', 10, 'yes')];
    const rows = compareRuns(records, a, b, { seed: 1, resamples: 500 });
    expect(rows[0]).toMatchObject({ n: 20, clusters: 2, decided: false });
    expect(rows[0].difference).toBeCloseTo(0, 12);
    expect(compareText(rows)).toContain('the interval includes 0, no difference shown');
    expect(compareText(compareRuns(records, [], b))).toContain('agreement with the reference: no paired items');
  });
});

describe('measure: the judge baseline on the fixed pages', () => {
  const page = 'This supplier sells sorted goods by the kilogram to shops. The minimum order is one bale. Orders are loaded at the warehouse every weekday.';
  const kind = { label: 'supplier', not: [] };
  const item = (pageKey: string, more: Record<string, unknown>) => ({ task: 'item-check', research: 'r1', url: `https://x.example.org/${pageKey}`, title: pageKey, page: pageKey, quote: null, labeller: null, ...more });
  const records = [
    item('p1', { id: 'J1', check: 'question', clause: 'by weight', question: 'Does it sell by the kilogram?', hard: true, label: 'yes' }),
    item('p1', { id: 'J2', check: 'question', clause: 'returns', question: 'Does it take returns?', hard: false, label: 'not stated' }),
    item('p1', { id: 'J3', check: 'kind', clause: 'kind', question: 'Is this page one supplier offered as asked?', hard: true, kind, label: 'yes' }),
    item('p2', { id: 'J4', check: 'question', clause: 'by weight', question: 'Does it sell by the kilogram?', hard: true, label: 'yes' }),
    item('p2', { id: 'J5', check: 'kind', clause: 'kind', question: 'Is this page one supplier offered as asked?', hard: true, kind, label: null }),
    item('p3', { id: 'J6', check: 'kind', clause: 'kind', question: 'Is this page one supplier offered as asked?', hard: true, kind, label: 'no' }),
    { id: 'J7', task: 'source-relevance', research: 'r1', page: 'p1', label: 'yes' },
  ];
  const router = (provider = 'p1') => {
    const calls: string[] = [];
    return {
      calls,
      async complete(request: { messages: { content: string }[] }) {
        const asked = request.messages[1].content;
        calls.push(asked);
        if (asked.includes('This page offers:')) return { provider, data: asked.includes('This is page three') ? { kind: 'B', span: 'S1' } : { kind: 'A', span: 'S1' } };
        const first = asked.includes('This is page two');
        return { provider: first ? 'p2' : provider, data: [{ id: 'q1', answer: first ? 'no' : 'yes', spans: ['S1'] }, { id: 'q2', answer: 'no', spans: ['S2'] }] };
      },
    };
  };
  const textOf = async (entry: { page: string }) => ({ p1: page, p2: `This is page two. ${page}`, p3: `This is page three. ${page}` })[entry.page] ?? '';

  it('groups the item judgements by page, so one page is judged once', () => {
    expect(judgeGroups(records).map((group: { id: string }[]) => group.map((entry) => entry.id))).toEqual([['J1', 'J2', 'J3'], ['J4', 'J5'], ['J6']]);
  });

  it('re-judges the reference items with the checklist judge and reports the wrong-no rate, the unknown rate and the calls per item', async () => {
    const fake = router();
    const baseline = await judgeBaseline({ records, textOf, router: fake, run: 'run 1' });
    expect(fake.calls).toHaveLength(5);
    expect(baseline).toMatchObject({ run: 'run 1', pages: 3, judgements: 6, calls: 5, labelled: 5 });
    expect(baseline.callsPerItem).toBeCloseTo(5 / 3, 12);
    expect(baseline.answers.map((answer: { id: string; answer: string; provider: string; stage: string }) => [answer.id, answer.answer, answer.provider])).toEqual([['J1', 'yes', 'p1'], ['J2', 'no', 'p1'], ['J3', 'yes', 'p1'], ['J4', 'no', 'mixed'], ['J5', 'yes', 'mixed'], ['J6', 'no', 'p1']]);
    expect(baseline.answers.every((answer: { stage: string }) => answer.stage === JUDGE_STAGE)).toBe(true);
    expect(baseline.wrongNo).toMatchObject({ part: 2, total: 4, rate: 0.5 });
    expect(baseline.unknown).toMatchObject({ part: 0, total: 6 });
    expect(baseline.agreement).toMatchObject({ part: 3, total: 5 });
    const text = baselineText(baseline);
    expect(text).toContain('judge baseline (run 1): 6 judgement(s) on 3 page(s), 5 model call(s)');
    expect(text).toContain('calls per item: 1.67');
    expect(text).toContain('wrong-no rate: 2 of 4 (50.0%, 95% interval');
    expect(text).toContain('unknown rate: 0 of 6 (0.0%');
    expect(text).toContain('on 5 (too few: under 30)');
  });

  it('counts a silent judge as unknown, skips a page without text, honours the page limit, and says when nothing labelled was judged', async () => {
    const silent = { async complete() { throw new Error('no model'); } };
    const baseline = await judgeBaseline({ records, textOf, router: silent });
    expect(baseline.unknown).toMatchObject({ part: 6, total: 6, rate: 1 });
    expect(baseline.wrongNo).toMatchObject({ part: 0, total: 4 });
    expect(baseline.answers.every((answer: { provider: string }) => answer.provider === 'none')).toBe(true);
    const limited = await judgeBaseline({ records, textOf, router: router(), limit: 1 });
    expect([limited.pages, limited.judgements]).toEqual([1, 3]);
    const missing = await judgeBaseline({ records, textOf: async () => '', router: router() });
    expect([missing.pages, missing.calls, missing.callsPerItem]).toEqual([0, 0, null]);
    const unlabelled = await judgeBaseline({ records: records.map((entry) => ({ ...entry, label: null })), textOf, router: router() });
    expect(baselineText(unlabelled)).toContain('wrong-no rate: not measurable: no labelled record was judged');
    expect(spreadText([baseline, limited])).toContain('unknown rate: mean 50.0%, lowest 0.0%, highest 100.0% over 2 run(s)');
  });
});
