#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { familyOf } from '../src/llm/ranking.mjs';
import { buildMatrix, diagnosticRows, pricedIn } from '../src/research/ach.mjs';
import { lowPriceStats } from '../src/research/candidates.mjs';
import { ChecklistJudge, hardenKind, migrateChecks } from '../src/research/checklist.mjs';
import { HostBook, gatherEvidence, identify, subjectKey } from '../src/research/facts.mjs';
import { PURPOSE, buildPurposeTree, conflictGoalOf, openEntries } from '../src/research/purpose.mjs';
import { MIN_KEPT_SOURCES, PAGE_CHARS, composeQueries, judgeSource, relevanceReason, runScoping, screenSources } from '../src/research/scoping.mjs';
import { CallBudget } from '../src/research/semantic.mjs';
import { sentenceSpans } from '../src/research/spans.mjs';
import { verdict } from '../src/research/verdict.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MODES = ['car', 'suppliers', 'plots'];
export const QUESTIONS_FILE = path.join(ROOT, 'scripts', 'purpose-replay.questions.json');
export const FIXTURE_FILE = path.join(ROOT, 'tests', 'fixtures', 'verdict-0c750f.json');
export const SIM_OUT = path.join(ROOT, 'data', 'handoff', 'sim', 'sim-out');
export const JUDGE_SAMPLE = 20;
export const MAX_LANGUAGES = 4;
export const USAGE = 'usage: node scripts/purpose-replay.mjs <car|suppliers|plots|all> --out <dir outside the repo> [--projects <dir>] [--baseline <sim-out dir>]';

export const BASELINE = {
  car: { sources: '1 of 8', notes: '5 of 10', conflict: 'removed', numbers: '10 %, ...', ach: '9 of 17', facts: 'SDI, 1.4 16V, one MOT record', grades: 'all', prices: '1', kind: 'kind yes' },
  suppliers: { sources: 'most', notes: '0 of 14', conflict: 'removed', numbers: '30 %, 30 days, 95 %', direction: 'reversed' },
  plots: { sources: 'mixed', notes: '4 of 14', conflict: 'removed', numbers: '500 m, 3 %, 5 km' },
};

export function insideRepo(dir, root = ROOT) {
  const relative = path.relative(root, path.resolve(dir));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function parseArgs(argv) {
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] ?? null : null);
  const mode = argv[0];
  if (![...MODES, 'all'].includes(mode)) return { error: USAGE };
  const out = value('--out');
  if (!out) return { error: `--out is required\n${USAGE}` };
  if (insideRepo(out)) return { error: `--out must be a folder outside the repository (${ROOT}); nothing was written` };
  return { modes: mode === 'all' ? MODES : [mode], out: path.resolve(out), projects: value('--projects'), baseline: value('--baseline') };
}

export function quoteOfSpans(quote, spans) {
  const texts = spans.map((span) => span.text);
  if (texts.includes(quote)) return true;
  return texts.some((first) => quote.startsWith(`${first} `) && texts.includes(quote.slice(first.length + 1)));
}

export function storedNotes(notes) {
  const list = Array.isArray(notes) ? notes : [];
  return { withQuote: list.filter((note) => note.quoteOnPage === true).length, total: list.length };
}

export function storedMatrix(ach) {
  const hypotheses = (ach?.hypotheses ?? []).map((hypothesis, index) => ({ id: `H${index + 1}`, hypothesis }));
  const rows = (ach?.matrix ?? []).map((row) => ({ evidence: row.evidence, marks: Object.fromEntries(hypotheses.map((hypothesis, index) => [hypothesis.id, row.marks?.[index]])) }));
  const { dropped } = diagnosticRows(hypotheses, rows);
  return { nonDiagnostic: dropped.length, total: rows.length };
}

export async function storedSources(ctx, sources, { purpose, subject, markets = [], regions = [] }) {
  let kept = 0;
  for (const source of sources ?? []) {
    const judged = await judgeSource(ctx, { source: { url: source.url, title: source.title, text: source.text ?? `${source.title}.` }, purpose, subject, markets, regions });
    if (judged.verdict && !relevanceReason(judged.verdict)) kept += 1;
  }
  return { kept, total: (sources ?? []).length };
}

export async function readBaseline(dir, mode) {
  const read = (name) => fs.readFile(path.join(dir, `${mode}-${name}.json`), 'utf8').then(JSON.parse).catch(() => null);
  const notes = await read('0-scope-notes');
  const ach = await read('4-ach');
  const stored = { ...BASELINE[mode] };
  if (notes) {
    const counted = storedNotes(notes);
    stored.notes = `${counted.withQuote} of ${counted.total}`;
  }
  if (ach) {
    const counted = storedMatrix(ach);
    stored.ach = `${counted.nonDiagnostic} of ${counted.total}`;
  }
  return stored;
}

const share = (part, total) => (total ? part / total : 0);
const percent = (part, total) => `${part} of ${total}`;

function treeQuestions(tree) {
  return (tree?.goals ?? []).filter((goal) => goal.state === 'kept').flatMap((goal) => goal.questions ?? []).map((question) => ({ id: question.id, q: question.q, checker: question.checker }));
}

async function secondOpinions(ctx, pages, input) {
  let agreed = 0;
  for (const page of pages) {
    const again = await judgeSource(ctx, { source: page, ...input, avoid: page.judgedBy ? [page.judgedBy] : undefined });
    if (again.verdict && !relevanceReason(again.verdict)) agreed += 1;
  }
  return { agreed, total: pages.length };
}

async function rejudge(ctx, fixture, kind) {
  const judge = new ChecklistJudge({ router: ctx.router, embedder: ctx.embedder });
  const checklist = (fixture.checklist ?? []).map((cluster) => ({ ...cluster, items: cluster.items.filter((item) => !item.numeric) })).filter((cluster) => cluster.items.length);
  let judged = 0;
  let empty = 0;
  for (const item of (fixture.acceptanceResult?.items ?? []).slice(0, JUDGE_SAMPLE)) {
    const page = await ctx.search.readPage(item.url).catch(() => null);
    if (!page?.text) continue;
    judged += 1;
    const checks = await judge.judge(item, page.text, checklist, kind);
    empty += checks.filter((check) => check.answer !== 'unknown' && !String(check.quote ?? '').trim()).length;
  }
  return { judged, empty };
}

async function storedItemCheck(ctx, fixture, kind, url) {
  const project = JSON.parse(JSON.stringify(fixture));
  migrateChecks(project);
  const prices = lowPriceStats(project.acceptanceResult.items);
  const stored = project.acceptanceResult.items.find((entry) => entry.url === url);
  if (stored && prices) {
    const page = await ctx.search.readPage(url).catch(() => null);
    const pageText = page?.text || stored.checks.find((check) => check.clause === 'kind')?.quote || '';
    stored.checks = await hardenKind(stored.checks, stored, { cut: prices.cut, median: prices.median, judge: new ChecklistJudge({ router: ctx.router, embedder: ctx.embedder }), pageText, kind });
  }
  const item = verdict(project.acceptanceResult.items, project.acceptance, project.checklist, kind).items.find((entry) => entry.url === url);
  const check = item?.checks?.find((entry) => entry.clause === 'kind');
  return { url, value: item?.value ?? null, cut: prices?.cut ?? null, median: prices?.median ?? null, kind: check?.answer ?? null, second: check?.second ?? null, tier: item?.tier ?? null };
}

async function carEvidence(ctx, { entry, scoping, tree, fixture, rows, hosts }) {
  const item = fixture.acceptanceResult.items.find((candidate) => candidate.url === entry.item) ?? fixture.acceptanceResult.items[0];
  const page = await ctx.search.readPage(item.url).catch(() => null);
  const identity = await identify(ctx, { levels: scoping.levels, text: String(page?.text ?? '').slice(0, PAGE_CHARS) });
  const subject = subjectKey(identity, scoping.levels).filter(Boolean);
  const label = subject.join(' ') || entry.kind;
  const queries = composeQueries([label], scoping.perspectives);
  const found = queries.length ? await ctx.search.search(queries.map((query) => query.query), { maxSources: 8 }).catch(() => []) : [];
  const screened = await screenSources(ctx, { sources: found, purpose: tree.purpose.text, subject: label, markets: [], regions: [] });
  const evidence = await gatherEvidence(ctx, { questions: treeQuestions(tree), sources: screened.kept, subject, kind: entry.kind, hosts });
  const priced = rows.length ? pricedIn({ ...item, subject }, rows, scoping.levels) : { position: 'unknown', reason: 'no candidate rows' };
  const matrix = await buildMatrix(ctx, { identity, priced, facts: evidence.facts, goal: conflictGoalOf(tree) });
  return { item: item.url, identity, subject, queries, dropped: screened.dropped, evidence, priced, matrix };
}

export function metricRows(mode, run, baseline) {
  const rows = [];
  const add = (id, label, was, value, target, pass) => rows.push({ id, label, baseline: was ?? '-', value, target, pass });
  const tree = run.tree;
  const goals = tree?.goals ?? [];
  const conflict = conflictGoalOf(tree);
  const mechanisms = (conflict?.hypotheses ?? []).filter((hypothesis) => PURPOSE.mechanisms.some((mechanism) => mechanism.id === hypothesis.id)).length;
  add('sources', 'Kept scoping sources judged on subject and market', baseline.sources, `${run.scoping.sources.length} kept, ${run.scoping.dropped.length} dropped`, `>= ${MIN_KEPT_SOURCES} kept`, run.scoping.sources.length >= MIN_KEPT_SOURCES);
  add('second-opinion', 'Kept sources another provider agrees with', 'not measured', percent(run.second.agreed, run.second.total), '>= 80%', run.second.total > 0 && share(run.second.agreed, run.second.total) >= 0.8);
  add('notes', 'Scoping notes with a quote on the page', baseline.notes, percent(run.notesOnPage, run.scoping.notes.length), '100%', run.notesOnPage === run.scoping.notes.length);
  const askedConflict = tree?.conflict?.asked === true;
  add('conflict', '"Why still cheap" goal present only when the question asks for a low price and worth, then with all 5 mechanisms', baseline.conflict, conflict ? `${conflict.state}, ${mechanisms} mechanisms` : tree ? `absent (asked: ${tree.conflict?.asked})` : 'no tree', 'present with 5 when asked, absent otherwise', askedConflict ? Boolean(conflict) && mechanisms === PURPOSE.mechanisms.length : Boolean(tree) && !conflict);
  const thresholds = tree?.thresholds ?? [];
  const invented = goals.flatMap((goal) => [goal, ...(goal.questions ?? []), ...(Array.isArray(goal.obstacles) ? goal.obstacles : [])]).reduce((sum, node) => sum + (node.inventedNumber?.length ?? 0), 0);
  const unlabelled = thresholds.filter((threshold) => !['asked', 'sourced', 'assumption'].includes(threshold.source)).length;
  add('numbers', 'Numbers not in the user words that are unlabelled', baseline.numbers, `${unlabelled} unlabelled; ${thresholds.filter((threshold) => threshold.source === 'assumption').length} assumption, ${thresholds.filter((threshold) => threshold.source === 'sourced').length} sourced; ${invented} in free text`, '0 unlabelled, <= 1 in free text', Boolean(tree) && unlabelled === 0 && invented <= 1);
  const untraced = goals.filter((goal) => goal.state === 'kept' && !goal.trace).length;
  add('trace', 'Goals in state kept without a trace', 'not measured', String(untraced), '0', Boolean(tree) && untraced === 0);
  add('scope', 'Goals proposed or in conflict (read them for scope creep)', 'present as kept', goals.filter((goal) => goal.state !== 'kept').map((goal) => `${goal.id} ${goal.state}: ${goal.goal}`).join(' | ') || 'none', 'read by the lead', null);
  if (mode === 'suppliers') add('direction', 'Implications with direction low, and goals not kept', baseline.direction, (tree?.implications ?? []).filter((entry) => entry.direction === 'low').map((entry) => `${entry.id} ${entry.attribute}`).join(' | ') || 'none', 'read by the lead', null);
  if (run.car) {
    const kept = run.car.matrix.kept;
    const flat = kept.filter((row) => new Set(Object.values(row.marks)).size === 1).length;
    add('ach', 'ACH rows kept that do not discriminate', baseline.ach, percent(flat, kept.length), '0', flat === 0);
    const wrong = run.car.evidence.facts.filter((fact) => fact.scope !== 'A' || !['A', 'B', 'C'].includes(fact.level)).length;
    add('facts', 'Applied facts from another variant or a single unit', baseline.facts, `${wrong} applied; ${run.car.evidence.notApplicable.length} listed as not applicable`, '0', wrong === 0);
    add('grades', 'Source grades taken from a model label', baseline.grades, String(run.car.evidence.facts.filter((fact) => 'sourceType' in fact || 'grade' in fact).length), '0', run.car.evidence.facts.every((fact) => !('sourceType' in fact) && !('grade' in fact)));
    const market = kept.filter((row) => row.kind === 'fact' && run.car.evidence.notApplicable.some((fact) => fact.quote === row.evidence)).length;
    add('prices', 'Prices from another market in the matrix', baseline.prices, `${market}; comparables: ${run.car.priced.position}`, '0', market === 0);
    add('judge', `Judge answers yes or no with an empty quote (${run.car.rejudged.judged} pages)`, 'present', String(run.car.rejudged.empty), '0', run.car.rejudged.empty === 0);
    add('kind', 'The tyres-on-rims item', baseline.kind, `kind ${run.car.tyres.kind}, tier ${run.car.tyres.tier}`, 'kind no or unknown; not confirmed', ['no', 'unknown'].includes(run.car.tyres.kind) && run.car.tyres.tier !== 'confirmed');
  }
  add('banned', 'Calls to a banned family in the ledger', '-', String(run.banned), '0', run.banned === 0);
  const over = Object.entries(run.budget).filter(([, row]) => row.skipped > 0).map(([stage]) => stage);
  add('calls', 'Calls per research', '-', Object.entries(run.budget).map(([stage, row]) => `${stage} ${row.used}/${row.cap}`).join(', '), 'within the caps', over.length === 0);
  return rows;
}

export function tableText(mode, rows) {
  const mark = (pass) => (pass === null ? 'READ' : pass ? 'PASS' : 'FAIL');
  return [`\n== ${mode} ==`, 'result | metric | baseline | new | target', ...rows.map((row) => `${mark(row.pass)} | ${row.label} | ${row.baseline} | ${row.value} | ${row.target}`)].join('\n');
}

export function bannedCalls(ledger, env) {
  const banned = new Set(String(env?.FRL_BANNED_FAMILIES ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean));
  return (ledger ?? []).filter((row) => row.provider !== 'router' && banned.has(familyOf(row.model, row.provider))).length;
}

export async function runReplay({ mode, entry, out, router, search, embedder, fixture = null, rows = [], languages = null, baseline = BASELINE[mode], env = process.env, log = () => {} }) {
  await fs.mkdir(out, { recursive: true });
  const write = (name, value) => fs.writeFile(path.join(out, `${mode}-${name}.json`), JSON.stringify(value, null, 1));
  const budget = new CallBudget();
  const ctx = { router, search, embedder, budget, log };
  const ledgerStart = (router.ledger ?? []).length;
  const spoken = (entry.languages ?? languages ?? ['English']).slice(0, MAX_LANGUAGES);
  const input = { purpose: entry.question, subject: entry.kind, markets: entry.markets ?? [], regions: entry.regions ?? [] };
  const { scoping, pages } = await runScoping(ctx, { question: entry.question, purpose: entry.question, kind: entry.kind, regions: entry.regions ?? [], markets: entry.markets ?? [], languages: spoken, rows, titles: rows.map((row) => row.title).filter(Boolean) });
  await write('0-scope-plan', { levels: scoping.levels, languages: scoping.languages, subjects: scoping.subjects, perspectives: scoping.perspectives, queries: scoping.queries, embedModel: scoping.embedModel });
  await write('0-scope-sources', { kept: scoping.sources, dropped: scoping.dropped, enough: scoping.enough });
  await write('0-scope-notes', scoping.notes);
  const second = await secondOpinions(ctx, pages, input);
  const notesOnPage = scoping.notes.filter((note) => quoteOfSpans(note.quote, sentenceSpans(pages.find((page) => page.url === note.url)?.text ?? '', { limit: PAGE_CHARS }))).length;
  const built = await buildPurposeTree(ctx, { question: entry.question, guidance: entry.guidance ?? '', notes: scoping.notes });
  await write('1-tree', { phase: built.phase, anchors: built.anchors, tree: built.tree, open: openEntries(built.tree) });
  let car = null;
  if (mode === 'car' && fixture && built.tree) {
    const hosts = new HostBook({ file: path.join(out, 'hosts.json') });
    await hosts.load();
    const kind = { label: entry.kind, terms: [entry.kind], not: entry.not ?? [] };
    const table = rows.length ? rows : fixture.acceptanceResult.items.map((item) => ({ url: item.url, value: item.value }));
    car = await carEvidence(ctx, { entry, scoping, tree: built.tree, fixture, rows: table, hosts });
    await hosts.save();
    car.rejudged = await rejudge(ctx, fixture, kind);
    car.tyres = await storedItemCheck(ctx, fixture, { label: 'car listing', terms: ['car'], not: ['wanted', 'parts', 'accessories', 'retail'] }, entry.tyres);
    await write('2-identity', { item: car.item, identity: car.identity, subject: car.subject });
    await write('3-facts', { queries: car.queries, dropped: car.dropped, ...car.evidence });
    await write('4-ach', { priced: car.priced, ...car.matrix, rejudged: car.rejudged, tyres: car.tyres });
  }
  const ledger = (router.ledger ?? []).slice(ledgerStart);
  await write('ledger', ledger);
  const run = { scoping, second, notesOnPage, tree: built.tree, phase: built.phase, car, banned: bannedCalls(ledger, env), budget: budget.report() };
  const metrics = metricRows(mode, run, baseline);
  await write('metrics', { mode, phase: built.phase, enough: scoping.enough, metrics });
  return { run, metrics };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    return 1;
  }
  const { App } = await import('../src/app.mjs');
  const { Embedder } = await import('../src/llm/embedder.mjs');
  const questions = JSON.parse(await fs.readFile(QUESTIONS_FILE, 'utf8'));
  const fixture = JSON.parse(await fs.readFile(FIXTURE_FILE, 'utf8'));
  const app = new App({ dataDir: path.join(args.out, 'data') });
  await app.refreshProviders();
  const embedder = new Embedder({ env: process.env, dir: path.join(args.out, 'embeddings') });
  let failed = 0;
  for (const mode of args.modes) {
    const entry = questions[mode];
    let rows = [];
    if (args.projects && entry.project) {
      const file = (await fs.readdir(args.projects).catch(() => [])).find((name) => name.startsWith(entry.project) && name.endsWith('.json'));
      const project = file ? JSON.parse(await fs.readFile(path.join(args.projects, file), 'utf8')) : null;
      rows = project?.candidates?.kept ?? [];
    }
    const baseline = await readBaseline(args.baseline ?? SIM_OUT, mode);
    const { metrics } = await runReplay({ mode, entry, out: args.out, router: app.router, search: app.search, embedder, fixture, rows, languages: app.engine.conceptLanguages(entry.regions ?? []), baseline, log: (line) => console.log(`  ${line}`) });
    console.log(tableText(mode, metrics));
    failed += metrics.filter((row) => row.pass === false).length;
  }
  console.log(failed ? `\npurpose replay: ${failed} target(s) FAILED` : '\npurpose replay: every measured target PASSED (rows marked READ are judged by the lead)');
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
