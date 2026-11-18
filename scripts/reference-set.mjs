#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LABELS, NOT_STATED, labelOf, mulberry32 } from '../src/research/agreement.mjs';
import { kindCluster } from '../src/research/checklist.mjs';
import { sentenceSpans, spanIds } from '../src/research/spans.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const QUESTIONS_FILE = path.join(ROOT, 'scripts', 'purpose-replay.questions.json');
export const TASKS = ['item-check', 'source-relevance', 'fact-subject'];
export const TYPES = ['located-listings', 'entity-list', 'knowledge', 'valuation', 'comparison'];
export const MIN_TARGET = 150;
export const MAX_TARGET = 300;
export const DEFAULT_TARGET = 240;
export const PER_RESEARCH = 12;
export const BATCH_SIZE = 25;
export const PAGE_CHARS = 40000;
export const MIN_PAGE_CHARS = 200;
export const SET_VERSION = 1;
export const USAGE = [
  'usage:',
  '  node scripts/reference-set.mjs build --projects <dir> --replays <dir> --out data/reference/<name> [--target 240] [--seed 1] [--per-research 12] [--require <id,id>] [--types <file.json>] [--fetch]',
  '  node scripts/reference-set.mjs label-file --set <dir> [--size 25] [--labeller <name>]',
  '  node scripts/reference-set.mjs merge --set <dir> --labels <file> [--labels <file>] [--replace]',
].join('\n');
export const LABEL_RULE = `Label each record with one of: ${LABELS.join(', ')}. "quote" is the id, or the two ids, of the sentences of that record that show it (for example ["S4"]). A label without a sentence id is refused, unless the label is "${NOT_STATED}". Never write the sentence itself.`;

const sha = (text) => crypto.createHash('sha1').update(String(text)).digest('hex');
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

export function pageId(url) {
  return sha(url).slice(0, 16);
}

export function judgementId(entry) {
  return `J${sha([entry.task, entry.research, entry.url, entry.question, entry.fact ?? ''].join('|')).slice(0, 10)}`;
}

export function insideDir(target, dir) {
  const relative = path.relative(dir, path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function parseArgs(argv) {
  const command = argv[0];
  const values = (flag) => argv.flatMap((arg, index) => (arg === flag && argv[index + 1] !== undefined ? [argv[index + 1]] : []));
  const value = (flag) => values(flag)[0] ?? null;
  const number = (flag, fallback) => (value(flag) === null ? fallback : Number(value(flag)));
  if (command === 'build') {
    const out = value('--out');
    if (!out) return { error: `--out is required\n${USAGE}` };
    if (insideDir(out, ROOT) && !insideDir(out, DATA_DIR)) return { error: `--out inside the repository must be under data/ (gitignored): pages never go into git; nothing was written` };
    if (!value('--projects') && !value('--replays')) return { error: `--projects or --replays is required\n${USAGE}` };
    const target = number('--target', DEFAULT_TARGET);
    if (!Number.isInteger(target) || target < MIN_TARGET || target > MAX_TARGET) return { error: `--target must be a whole number from ${MIN_TARGET} to ${MAX_TARGET}` };
    const perResearch = number('--per-research', PER_RESEARCH);
    if (!Number.isInteger(perResearch) || perResearch < 1) return { error: '--per-research must be a whole number of at least 1' };
    return { command, out: path.resolve(out), projects: value('--projects'), replays: value('--replays'), target, seed: number('--seed', 1), perResearch, require: (value('--require') ?? '').split(',').map((id) => id.trim()).filter(Boolean), types: value('--types'), fetch: argv.includes('--fetch') };
  }
  if (command === 'label-file') {
    if (!value('--set')) return { error: `--set is required\n${USAGE}` };
    const size = number('--size', BATCH_SIZE);
    if (!Number.isInteger(size) || size < 1) return { error: '--size must be a whole number of at least 1' };
    return { command, set: path.resolve(value('--set')), size, labeller: value('--labeller') };
  }
  if (command === 'merge') {
    if (!value('--set') || !values('--labels').length) return { error: `--set and --labels are required\n${USAGE}` };
    return { command, set: path.resolve(value('--set')), labels: values('--labels').map((file) => path.resolve(file)), replace: argv.includes('--replace') };
  }
  return { error: USAGE };
}

export function researchType(project) {
  if (project?.valueFacts || project?.listingFacts) return 'valuation';
  if (project?.brief?.located === true || (project?.candidates?.kept ?? []).length > 0) return 'located-listings';
  if (Number(project?.acceptance?.itemCount) > 0) return 'entity-list';
  if ((project?.report?.options ?? []).length >= 2) return 'comparison';
  return 'knowledge';
}

function webSources(project) {
  const lists = [...(project?.nodes ?? []).map((node) => node.sources ?? []), project?.hubSources ?? [], project?.sweep?.pages ?? []];
  return lists.flat().filter((source) => source && /^https?:\/\//.test(String(source.url ?? '')) && String(source.text ?? '').length >= MIN_PAGE_CHARS);
}

export function pagesOf(project) {
  const pages = new Map();
  for (const source of webSources(project)) {
    const held = pages.get(source.url);
    if (!held || String(source.text).length > held.text.length) pages.set(source.url, { url: source.url, title: oneLine(source.title).slice(0, 200), text: String(source.text).slice(0, PAGE_CHARS) });
  }
  return pages;
}

function checklistOf(project) {
  const clusters = project?.checklist ?? project?.decisionModel?.checklist ?? [];
  return clusters.flatMap((cluster) => (cluster.items ?? []).filter((item) => item?.question && !(item.numeric?.measure && item.numeric.value !== null && item.numeric.value !== undefined)).map((item) => ({ clause: cluster.clause, question: item.question, hard: Boolean(item.hard) })));
}

function kindOf(project) {
  const kind = project?.decisionModel?.kind ?? project?.brief?.kind ?? null;
  return kind?.label ? { label: kind.label, not: kind.not ?? [], ...(kind.members ? { members: kind.members } : {}) } : null;
}

function deliveredItems(project) {
  const lists = [project?.acceptanceResult?.items ?? [], project?.candidates?.kept ?? [], ...(project?.nodes ?? []).map((node) => node.finding?.items ?? [])];
  const byUrl = new Map();
  for (const item of lists.flat()) if (item?.url && !byUrl.has(item.url)) byUrl.set(item.url, item);
  return byUrl;
}

export function itemJudgements(project, type = researchType(project)) {
  const pages = pagesOf(project);
  const questions = checklistOf(project);
  const kind = kindOf(project);
  const items = deliveredItems(project);
  const out = [];
  for (const page of pages.values()) {
    const item = items.get(page.url) ?? null;
    const stored = (id) => labelOf(item?.checks?.find((check) => check.id === id)?.answer);
    const base = { task: 'item-check', research: project.id, type, url: page.url, title: item?.title ? oneLine(item.title).slice(0, 200) : page.title, delivered: Boolean(item) };
    if (item) for (const question of questions) out.push({ ...base, check: 'question', clause: question.clause, question: question.question, hard: question.hard, stored: stored(`${question.clause}|${question.question}`) });
    if (kind) {
      const question = kindCluster(kind).items[0].question;
      out.push({ ...base, check: 'kind', clause: 'kind', question, hard: true, kind, stored: stored(`kind|${question}`) });
    }
  }
  return out;
}

function leafNodes(project) {
  return (project?.nodes ?? []).filter((node) => node?.question && (node.sources ?? []).some((source) => /^https?:\/\//.test(String(source.url ?? ''))));
}

export function sourceJudgements(project, type = researchType(project)) {
  const pages = pagesOf(project);
  const out = [];
  for (const node of leafNodes(project)) {
    const cited = new Set((node.finding?.claims ?? []).flatMap((claim) => claim.sourceIds ?? []));
    for (const source of node.sources) {
      const page = pages.get(source.url);
      if (!page) continue;
      out.push({ task: 'source-relevance', research: project.id, type, url: page.url, title: page.title, question: `Does this source help answer: ${oneLine(node.question)}`, context: { purpose: oneLine(project.question), subject: oneLine(node.title ?? node.question) }, stored: cited.has(source.id) ? 'yes' : null });
    }
  }
  return out;
}

export function factJudgements(project, type = researchType(project)) {
  const pages = pagesOf(project);
  const out = [];
  for (const node of leafNodes(project)) {
    const byId = new Map(node.sources.map((source) => [source.id, source]));
    for (const claim of node.finding?.claims ?? []) {
      const quote = oneLine(claim.quote);
      if (!quote) continue;
      const source = (claim.sourceIds ?? []).map((id) => byId.get(id)).find((entry) => entry && pages.has(entry.url) && oneLine(pages.get(entry.url).text).includes(quote));
      if (!source) continue;
      const page = pages.get(source.url);
      out.push({ task: 'fact-subject', research: project.id, type, url: page.url, title: page.title, question: `Does the quoted statement apply to the subject asked: ${oneLine(node.question)}`, fact: quote.slice(0, 600), context: { purpose: oneLine(project.question), subject: oneLine(node.title ?? node.question) }, stored: 'yes' });
    }
  }
  return out;
}

export function replayJudgements(replay) {
  const subject = (replay.plan?.subjects ?? []).map(oneLine).filter(Boolean).join('; ');
  const purpose = oneLine(replay.tree?.tree?.purpose?.text ?? replay.entry?.question ?? '');
  const question = `Is this source about the asked subject: ${subject || oneLine(replay.entry?.kind ?? '')}`;
  const base = { task: 'source-relevance', research: replay.name, type: replay.type, question, context: { purpose, subject } };
  const second = new Map((replay.second?.rows ?? []).map((row) => [row.url, row]));
  const out = [];
  for (const source of replay.sources?.kept ?? []) {
    const again = second.get(source.url);
    const answers = [{ provider: source.judgedBy ?? null, answer: 'yes' }];
    if (again?.second?.by && again.state !== 'same provider' && again.state !== 'not judged') answers.push({ provider: again.second.by, answer: again.reason ? 'no' : 'yes' });
    out.push({ ...base, url: source.url, title: oneLine(source.title).slice(0, 200), stored: 'yes', answers });
  }
  for (const source of replay.sources?.dropped ?? []) {
    const judged = /^off-(subject|market)/.test(String(source.reason ?? ''));
    out.push({ ...base, url: source.url, title: oneLine(source.title ?? '').slice(0, 200), stored: judged ? 'no' : null, answers: judged ? [{ provider: null, answer: 'no' }] : [] });
  }
  return out;
}

function shuffled(list, random) {
  const out = [...list];
  for (let at = out.length - 1; at > 0; at--) {
    const pick = Math.floor(random() * (at + 1));
    [out[at], out[pick]] = [out[pick], out[at]];
  }
  return out;
}

export function roundRobin(lists) {
  const out = [];
  for (let turn = 0; lists.some((list) => list[turn] !== undefined); turn++) for (const list of lists) if (list[turn] !== undefined) out.push(list[turn]);
  return out;
}

export function sampleJudgements(candidates, { target = DEFAULT_TARGET, seed = 1, perResearch = PER_RESEARCH } = {}) {
  const random = mulberry32(seed);
  const seen = new Set();
  const unique = (candidates ?? []).filter((entry) => {
    const id = judgementId(entry);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const ordered = Object.fromEntries(TASKS.map((task) => {
    const strata = TYPES.map((type) => {
      const researches = new Map();
      for (const entry of unique.filter((candidate) => candidate.task === task && candidate.type === type)) researches.set(entry.research, [...(researches.get(entry.research) ?? []), entry]);
      const lists = [...researches.keys()].sort().map((research) => {
        const mixed = shuffled(researches.get(research), random);
        const pages = new Map();
        for (const entry of mixed) pages.set(entry.url, [...(pages.get(entry.url) ?? []), entry]);
        return roundRobin([...pages.values()]).slice(0, perResearch);
      });
      return roundRobin(lists);
    });
    return [task, roundRobin(strata)];
  }));
  const taken = Object.fromEntries(TASKS.map((task) => [task, 0]));
  let left = target;
  for (let open = TASKS.filter((task) => ordered[task].length > 0); left > 0 && open.length; open = open.filter((task) => taken[task] < ordered[task].length)) {
    const share = Math.max(1, Math.floor(left / open.length));
    for (const task of open) {
      const more = Math.min(share, ordered[task].length - taken[task], left);
      taken[task] += more;
      left -= more;
    }
  }
  return TASKS.flatMap((task) => ordered[task].slice(0, taken[task]));
}

export function manifestOf(records, { skipped = {}, required = [] } = {}) {
  const count = (keyOf) => {
    const counts = {};
    for (const record of records) counts[keyOf(record)] = (counts[keyOf(record)] ?? 0) + 1;
    return counts;
  };
  const researches = count((record) => record.research);
  return { judgements: records.length, byTask: count((record) => record.task), byType: count((record) => record.type), byTaskAndType: count((record) => `${record.task} | ${record.type}`), byResearch: researches, researches: Object.keys(researches).length, pages: new Set(records.map((record) => record.page)).size, missingRequired: required.filter((id) => !Object.keys(researches).some((research) => research === id || research.endsWith(`-${id}`))), skipped };
}

async function readJson(file) {
  return fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
}

export async function loadProjects(dir) {
  if (!dir) return [];
  const names = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json')).sort();
  const projects = [];
  for (const name of names) {
    const project = await readJson(path.join(dir, name));
    if (project?.id && typeof project.question === 'string') projects.push(project);
  }
  return projects;
}

export async function loadReplays(dir, questions = {}) {
  if (!dir) return [];
  const replays = [];
  for (const name of (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    const read = (part) => readJson(path.join(dir, name, `${name}-${part}.json`));
    const sources = await read('0-scope-sources');
    if (!sources) continue;
    replays.push({ name, entry: questions[name] ?? null, type: questions[name]?.type ?? 'knowledge', sources, plan: await read('0-scope-plan'), second: await read('0-scope-second'), tree: await read('1-tree') });
  }
  return replays;
}

export async function buildSet({ projects = [], replays = [], out, target = DEFAULT_TARGET, seed = 1, perResearch = PER_RESEARCH, require = [], types = {}, readPage = null, now = () => new Date(), name = path.basename(out) }) {
  const pages = new Map();
  const candidates = [];
  const skipped = {};
  const skip = (reason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  for (const project of projects) {
    const type = TYPES.includes(types[project.id]) ? types[project.id] : researchType(project);
    for (const [url, page] of pagesOf(project)) if (!pages.has(url)) pages.set(url, page);
    candidates.push(...itemJudgements(project, type), ...sourceJudgements(project, type), ...factJudgements(project, type));
  }
  for (const replay of replays) {
    const type = TYPES.includes(types[replay.name]) ? types[replay.name] : TYPES.includes(replay.type) ? replay.type : 'knowledge';
    for (const entry of replayJudgements({ ...replay, type })) {
      if (!pages.has(entry.url) && readPage) {
        const read = await readPage(entry.url).catch(() => null);
        const text = String(read?.text ?? '');
        if (text.length >= MIN_PAGE_CHARS) pages.set(entry.url, { url: entry.url, title: entry.title, text: text.slice(0, PAGE_CHARS) });
      }
      if (pages.has(entry.url)) candidates.push(entry);
      else skip(readPage ? 'replay source: the page could not be read' : 'replay source: no stored page text (run with --fetch)');
    }
  }
  const usable = candidates.filter((entry) => {
    const spans = sentenceSpans(pages.get(entry.url).text, { limit: PAGE_CHARS });
    if (!spans.length) skip('page without a readable sentence');
    return spans.length > 0;
  });
  const picked = sampleJudgements(usable, { target, seed, perResearch });
  const records = picked.map((entry) => {
    const { stored, answers, ...rest } = entry;
    return { id: judgementId(entry), ...rest, page: pageId(entry.url), label: null, quote: null, labeller: null };
  });
  const storedAnswers = picked.flatMap((entry) => (entry.answers ?? (entry.stored ? [{ provider: null, answer: entry.stored }] : [])).map((answer) => ({ id: judgementId(entry), task: entry.task, research: entry.research, provider: answer.provider ?? 'stored', answer: answer.answer })));
  const manifest = manifestOf(records, { skipped, required: require });
  if (manifest.missingRequired.length) return { error: `no judgement from the required research(es) ${manifest.missingRequired.join(', ')}; nothing was written`, manifest };
  await fs.mkdir(path.join(out, 'pages'), { recursive: true });
  for (const key of new Set(records.map((record) => record.url))) await fs.writeFile(path.join(out, 'pages', `${pageId(key)}.txt`), pages.get(key).text);
  await fs.writeFile(path.join(out, 'records.json'), JSON.stringify({ version: SET_VERSION, name, builtAt: now().toISOString(), seed, target, labels: LABELS, records }, null, 1));
  await fs.writeFile(path.join(out, 'answers-stored.json'), JSON.stringify({ run: 'stored', answers: storedAnswers }, null, 1));
  await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return { records, manifest, storedAnswers };
}

export async function readSet(dir) {
  const set = await readJson(path.join(dir, 'records.json'));
  if (!set || !Array.isArray(set.records)) return null;
  return set;
}

export async function pageText(dir, record) {
  return fs.readFile(path.join(dir, 'pages', `${record.page}.txt`), 'utf8').catch(() => '');
}

export async function sentencesOf(dir, record) {
  return sentenceSpans(await pageText(dir, record), { limit: PAGE_CHARS });
}

export async function labelFiles({ set: dir, size = BATCH_SIZE, labeller = null }) {
  const set = await readSet(dir);
  if (!set) return { error: `no reference set in ${dir}` };
  const open = set.records.filter((record) => record.label === null);
  const batches = [];
  await fs.mkdir(path.join(dir, 'batches'), { recursive: true });
  for (let at = 0; at < open.length; at += size) {
    const records = [];
    for (const record of open.slice(at, at + size)) records.push({ id: record.id, task: record.task, research: record.research, title: record.title, url: record.url, question: record.question, ...(record.fact ? { fact: record.fact } : {}), ...(record.context ? { context: record.context } : {}), sentences: await sentencesOf(dir, record), label: null, quote: null, labeller });
    const file = path.join(dir, 'batches', `batch-${String(batches.length + 1).padStart(3, '0')}.json`);
    await fs.writeFile(file, JSON.stringify({ set: set.name, batch: batches.length + 1, of: Math.ceil(open.length / size), labeller, labels: LABELS, rule: LABEL_RULE, records }, null, 1));
    batches.push(file);
  }
  return { batches, open: open.length, labelled: set.records.length - open.length };
}

export function checkLabel(entry, spans, labeller) {
  const label = labelOf(entry?.label);
  if (!label) return { error: `the label must be one of ${LABELS.join(', ')}` };
  if (!labeller) return { error: 'the labeller is not named' };
  const ids = spanIds(entry.quote ?? []);
  const known = new Set(spans.map((span) => span.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) return { error: `the quote names a sentence id that is not on the page: ${unknown.join(', ')}` };
  if (!ids.length && label !== NOT_STATED) return { error: `a label without a sentence id is refused unless it is "${NOT_STATED}"` };
  return { value: { label, quote: ids.length ? ids : null, labeller } };
}

export async function mergeLabels({ set: dir, labels = [], replace = false }) {
  const set = await readSet(dir);
  if (!set) return { error: `no reference set in ${dir}` };
  const byId = new Map(set.records.map((record) => [record.id, record]));
  const merged = [];
  const refused = [];
  for (const file of labels) {
    const data = await readJson(file);
    const entries = Array.isArray(data) ? data : data?.records;
    if (!Array.isArray(entries)) {
      refused.push({ file, id: null, why: 'the file is not a list of labelled records' });
      continue;
    }
    for (const entry of entries) {
      if (entry?.label === null || entry?.label === undefined) continue;
      const record = byId.get(entry.id);
      if (!record) {
        refused.push({ file, id: entry.id ?? null, why: 'no such record in the set' });
        continue;
      }
      const checked = checkLabel(entry, await sentencesOf(dir, record), entry.labeller ?? data?.labeller ?? null);
      if (checked.error) refused.push({ file, id: entry.id, why: checked.error });
      else if (record.label !== null && record.label !== checked.value.label && !replace) refused.push({ file, id: entry.id, why: `already labelled "${record.label}" by ${record.labeller}; use --replace to overwrite` });
      else {
        Object.assign(record, checked.value);
        merged.push(entry.id);
      }
    }
  }
  if (merged.length) await fs.writeFile(path.join(dir, 'records.json'), JSON.stringify(set, null, 1));
  return { merged: merged.length, refused, labelled: set.records.filter((record) => record.label !== null).length, total: set.records.length };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    return 1;
  }
  if (args.command === 'build') {
    const questions = (await readJson(QUESTIONS_FILE)) ?? {};
    const types = args.types ? (await readJson(path.resolve(args.types))) ?? {} : {};
    let readPage = null;
    if (args.fetch) {
      const { SearchService } = await import('../src/search/search.mjs');
      const search = new SearchService({ backends: [], fetchPages: true, jinaReader: false });
      readPage = (url) => search.readPage(url);
    }
    const built = await buildSet({ projects: await loadProjects(args.projects), replays: await loadReplays(args.replays, questions), out: args.out, target: args.target, seed: args.seed, perResearch: args.perResearch, require: args.require, types, readPage });
    if (built.error) {
      console.error(built.error);
      return 1;
    }
    console.log(`reference set: ${built.manifest.judgements} judgement(s) on ${built.manifest.pages} page(s) from ${built.manifest.researches} research(es), written to ${args.out}`);
    console.log(`by task: ${JSON.stringify(built.manifest.byTask)}\nby research type: ${JSON.stringify(built.manifest.byType)}\nskipped: ${JSON.stringify(built.manifest.skipped)}`);
    if (built.manifest.judgements < MIN_TARGET) console.log(`fewer than ${MIN_TARGET} judgements were available: too few for the sample floors of docs/specs/measurement.md`);
    return 0;
  }
  if (args.command === 'label-file') {
    const made = await labelFiles(args);
    if (made.error) {
      console.error(made.error);
      return 1;
    }
    console.log(`${made.batches.length} batch file(s) of up to ${args.size} for ${made.open} unlabelled record(s); ${made.labelled} already labelled`);
    for (const file of made.batches) console.log(`  ${file}`);
    return 0;
  }
  const merged = await mergeLabels(args);
  if (merged.error) {
    console.error(merged.error);
    return 1;
  }
  console.log(`merged ${merged.merged} label(s); ${merged.labelled} of ${merged.total} record(s) labelled; ${merged.refused.length} refused`);
  for (const entry of merged.refused) console.log(`  refused ${entry.id ?? path.basename(entry.file)}: ${entry.why}`);
  return merged.refused.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
