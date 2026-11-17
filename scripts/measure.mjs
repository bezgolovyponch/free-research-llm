#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BOOTSTRAP_RESAMPLES, LABELS, MIN_KAPPA_ITEMS, NOT_STATED, accuracy, bootstrapDifference, cohenKappa, confusion, excludesZero, labelOf, pairRuns, spreadOf, unknownRate, wrongNo } from '../src/research/agreement.mjs';
import { ChecklistJudge } from '../src/research/checklist.mjs';
import { pageText, readSet } from './reference-set.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const JUDGE_TASK = 'item-check';
export const JUDGE_STAGE = 'checklist-judge';
export const MIXED = 'mixed';
export const USAGE = [
  'usage:',
  '  node scripts/measure.mjs score --reference <set dir> --answers <file> [--answers <file>]',
  '  node scripts/measure.mjs compare --reference <set dir> --a <answers file> --b <answers file> [--seed 1] [--resamples 2000]',
  '  node scripts/measure.mjs judge --reference <set dir> --out <dir> [--runs 1] [--limit <pages>]',
].join('\n');

export function parseArgs(argv) {
  const command = argv[0];
  const values = (flag) => argv.flatMap((arg, index) => (arg === flag && argv[index + 1] !== undefined ? [argv[index + 1]] : []));
  const value = (flag) => values(flag)[0] ?? null;
  const whole = (flag, fallback) => (value(flag) === null ? fallback : Number(value(flag)));
  if (!['score', 'compare', 'judge'].includes(command)) return { error: USAGE };
  if (!value('--reference')) return { error: `--reference is required\n${USAGE}` };
  const reference = path.resolve(value('--reference'));
  if (command === 'score') return values('--answers').length ? { command, reference, answers: values('--answers').map((file) => path.resolve(file)) } : { error: `--answers is required\n${USAGE}` };
  if (command === 'compare') {
    if (!value('--a') || !value('--b')) return { error: `--a and --b are required\n${USAGE}` };
    const resamples = whole('--resamples', BOOTSTRAP_RESAMPLES);
    if (!Number.isInteger(resamples) || resamples < 100) return { error: '--resamples must be a whole number of at least 100' };
    return { command, reference, a: path.resolve(value('--a')), b: path.resolve(value('--b')), seed: whole('--seed', 1), resamples };
  }
  const out = value('--out');
  if (!out) return { error: `--out is required\n${USAGE}` };
  const relative = (dir) => path.relative(dir, path.resolve(out));
  const inside = (dir) => relative(dir) === '' || (!relative(dir).startsWith('..') && !path.isAbsolute(relative(dir)));
  if (inside(ROOT) && !inside(DATA_DIR)) return { error: '--out inside the repository must be under data/ (gitignored); nothing was written' };
  const runs = whole('--runs', 1);
  if (!Number.isInteger(runs) || runs < 1 || runs > 9) return { error: '--runs must be a whole number from 1 to 9' };
  const limit = whole('--limit', null);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) return { error: '--limit must be a whole number of at least 1' };
  return { command, reference, out: path.resolve(out), runs, limit };
}

export function answersOf(data) {
  const list = Array.isArray(data) ? data : data?.answers;
  return (Array.isArray(list) ? list : []).map((entry) => ({ ...entry, answer: labelOf(entry?.answer) })).filter((entry) => entry.id && entry.answer);
}

export function pairsOf(records, answers) {
  const byId = new Map((records ?? []).filter((record) => labelOf(record.label)).map((record) => [record.id, record]));
  return (answers ?? []).filter((answer) => byId.has(answer.id)).map((answer) => {
    const record = byId.get(answer.id);
    return { id: answer.id, task: record.task, research: record.research, provider: answer.provider ?? 'unknown', reference: labelOf(record.label), answer: answer.answer };
  });
}

export function scoreRow(task, provider, pairs) {
  const kappa = cohenKappa(pairs);
  return { task, provider, n: pairs.length, kappa: kappa.kappa, enough: pairs.length >= MIN_KAPPA_ITEMS, accuracy: accuracy(pairs), confusion: confusion(pairs), unknown: unknownRate(pairs), ...(task === JUDGE_TASK ? { wrongNo: wrongNo(pairs) } : {}) };
}

export function scoreAnswers(records, answers) {
  const pairs = pairsOf(records, answers);
  const rows = [];
  for (const task of [...new Set(pairs.map((pair) => pair.task))].sort()) {
    const ofTask = pairs.filter((pair) => pair.task === task);
    const providers = [...new Set(ofTask.map((pair) => pair.provider))].sort();
    for (const provider of providers) rows.push(scoreRow(task, provider, ofTask.filter((pair) => pair.provider === provider)));
    if (providers.length > 1) rows.push(scoreRow(task, 'all', ofTask));
  }
  return { rows, labelled: (records ?? []).filter((record) => labelOf(record.label)).length, answered: pairs.length };
}

const percent = (value) => (value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const rateText = (rate) => (rate.total ? `${rate.part} of ${rate.total} (${percent(rate.rate)}, 95% interval ${percent(rate.low)} to ${percent(rate.high)})` : '0 of 0');
const kappaText = (row) => `${row.kappa === null ? 'n/a' : row.kappa.toFixed(2)} on ${row.n}${row.enough ? '' : ` (too few: under ${MIN_KAPPA_ITEMS})`}`;

export function scoreText(score) {
  const lines = [`labelled records: ${score.labelled}; answers on labelled records: ${score.answered}`];
  for (const row of score.rows) {
    lines.push(`\n== ${row.task} · ${row.provider} ==`, `Cohen's kappa: ${kappaText(row)}`, `agreement: ${rateText(row.accuracy)}`, `not stated: ${rateText(row.unknown)}`);
    if (row.wrongNo) lines.push(`wrong no (a "no" where the reference says yes or not stated): ${rateText(row.wrongNo)}`);
    lines.push(`confusion (rows reference, columns answer: ${LABELS.join(' | ')})`, ...row.confusion.matrix.map((counts, index) => `  ${LABELS[index].padEnd(10)} ${counts.join(' | ')}`));
  }
  return lines.join('\n');
}

export const METRICS = {
  agreement: { label: 'agreement with the reference', valueOf: (pair) => (pair.answer === pair.reference ? 1 : 0), keep: () => true },
  'wrong-no': { label: 'wrong no', valueOf: (pair) => (pair.answer === 'no' ? 1 : 0), keep: (pair) => pair.task === JUDGE_TASK && (pair.reference === 'yes' || pair.reference === NOT_STATED) },
};

export function compareRuns(records, a, b, { seed = 1, resamples = BOOTSTRAP_RESAMPLES } = {}) {
  const once = (answers) => {
    const seen = new Set();
    return pairsOf(records, answers).filter((pair) => !seen.has(pair.id) && seen.add(pair.id));
  };
  const first = once(a);
  const second = once(b);
  return Object.entries(METRICS).map(([id, metric]) => {
    const paired = pairRuns(first.filter(metric.keep), second.filter(metric.keep), { scoreOf: metric.valueOf });
    const interval = bootstrapDifference(paired, { seed, resamples });
    return { id, label: metric.label, ...interval, a: spreadOf(paired.map((pair) => pair.a)).mean, b: spreadOf(paired.map((pair) => pair.b)).mean, decided: excludesZero(interval) };
  });
}

export function compareText(rows) {
  return rows.map((row) => (row.n ? `${row.label}: A ${percent(row.a)}, B ${percent(row.b)}, difference B - A ${(row.difference * 100).toFixed(1)} points, 95% bootstrap interval ${(row.low * 100).toFixed(1)} to ${(row.high * 100).toFixed(1)} (${row.n} paired items in ${row.clusters} research(es), ${row.resamples} resamples by research): ${row.decided ? 'the interval excludes 0' : 'the interval includes 0, no difference shown'}` : `${row.label}: no paired items`)).join('\n');
}

function countingRouter(router) {
  const seen = { calls: 0, providers: [] };
  const counted = {
    seen,
    ledger: router.ledger,
    async complete(request) {
      seen.calls += 1;
      const reply = await router.complete(request);
      if (reply?.provider) seen.providers.push(reply.provider);
      return reply;
    },
    recordOutcome: (outcome) => router.recordOutcome?.(outcome),
    ...(router.families ? { families: (query) => router.families(query) } : {}),
    ...(router.familyOf ? { familyOf: (id, more) => router.familyOf(id, more) } : {}),
  };
  return counted;
}

export function judgeGroups(records) {
  const groups = new Map();
  for (const record of (records ?? []).filter((entry) => entry.task === JUDGE_TASK)) {
    const key = `${record.research}|${record.page}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()];
}

export async function judgeBaseline({ records, textOf, router, embedder = null, limit = null, run = 'judge' }) {
  const groups = judgeGroups(records).slice(0, limit ?? undefined);
  const answers = [];
  let calls = 0;
  let pages = 0;
  for (const group of groups) {
    const text = await textOf(group[0]);
    if (!text) continue;
    pages += 1;
    const counted = countingRouter(router);
    const judge = new ChecklistJudge({ router: counted, embedder });
    const questions = group.filter((record) => record.check !== 'kind');
    const kindRecord = group.find((record) => record.check === 'kind') ?? null;
    const checklist = questions.map((record) => ({ clause: record.clause, items: [{ clause: record.clause, question: record.question, hard: Boolean(record.hard), numeric: null }] }));
    const checks = await judge.judge({ url: group[0].url, title: group[0].title }, text, checklist, kindRecord?.kind ?? null);
    calls += counted.seen.calls;
    const providers = [...new Set(counted.seen.providers)];
    const provider = providers.length === 1 ? providers[0] : providers.length ? MIXED : 'none';
    for (const record of group) {
      const check = checks.find((entry) => (record.check === 'kind' ? entry.clause === 'kind' : entry.id === `${record.clause}|${record.question}`));
      answers.push({ id: record.id, task: record.task, research: record.research, provider, stage: JUDGE_STAGE, answer: labelOf(check?.answer) ?? NOT_STATED, quote: check?.quote ?? '' });
    }
  }
  const labelled = pairsOf(records, answers);
  return { run, pages, judgements: answers.length, calls, callsPerItem: pages ? calls / pages : null, unknown: unknownRate(answers), wrongNo: wrongNo(labelled), agreement: accuracy(labelled), kappa: cohenKappa(labelled), labelled: labelled.length, answers };
}

export function baselineText(baseline) {
  return [
    `judge baseline (${baseline.run}): ${baseline.judgements} judgement(s) on ${baseline.pages} page(s), ${baseline.calls} model call(s)`,
    `calls per item: ${baseline.callsPerItem === null ? 'n/a' : baseline.callsPerItem.toFixed(2)}`,
    `unknown rate: ${rateText(baseline.unknown)}`,
    `wrong-no rate: ${baseline.labelled ? rateText(baseline.wrongNo) : 'not measurable: no labelled record was judged'}`,
    `agreement with the reference: ${baseline.labelled ? rateText(baseline.agreement) : 'n/a'}; Cohen's kappa ${baseline.kappa.kappa === null ? 'n/a' : baseline.kappa.kappa.toFixed(2)} on ${baseline.kappa.n}${baseline.kappa.n < MIN_KAPPA_ITEMS ? ` (too few: under ${MIN_KAPPA_ITEMS})` : ''}`,
  ].join('\n');
}

export function spreadText(baselines) {
  const row = (label, values) => {
    const spread = spreadOf(values);
    return `${label}: mean ${percent(spread.mean)}, lowest ${percent(spread.min)}, highest ${percent(spread.max)} over ${spread.n} run(s)`;
  };
  return [row('unknown rate', baselines.map((baseline) => baseline.unknown.rate)), row('wrong-no rate', baselines.map((baseline) => baseline.wrongNo.rate))].join('\n');
}

async function readJson(file) {
  return fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    return 1;
  }
  const set = await readSet(args.reference);
  if (!set) {
    console.error(`no reference set in ${args.reference}`);
    return 1;
  }
  if (args.command === 'score') {
    const answers = [];
    for (const file of args.answers) answers.push(...answersOf(await readJson(file)));
    console.log(scoreText(scoreAnswers(set.records, answers)));
    return 0;
  }
  if (args.command === 'compare') {
    console.log(compareText(compareRuns(set.records, answersOf(await readJson(args.a)), answersOf(await readJson(args.b)), { seed: args.seed, resamples: args.resamples })));
    return 0;
  }
  const { App } = await import('../src/app.mjs');
  await fs.mkdir(args.out, { recursive: true });
  const app = new App({ dataDir: path.join(args.out, 'data') });
  await app.refreshProviders();
  const baselines = [];
  for (let run = 1; run <= args.runs; run++) {
    const baseline = await judgeBaseline({ records: set.records, textOf: (record) => pageText(args.reference, record), router: app.router, limit: args.limit, run: `run ${run}` });
    await fs.writeFile(path.join(args.out, `judge-answers-run${run}.json`), JSON.stringify({ run: baseline.run, answers: baseline.answers }, null, 1));
    console.log(`${baselineText(baseline)}\n`);
    baselines.push(baseline);
  }
  if (baselines.length > 1) console.log(spreadText(baselines));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
