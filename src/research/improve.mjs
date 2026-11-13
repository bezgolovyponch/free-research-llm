import { looksLikeListing } from './acceptance.mjs';
import { gradeAverage, scoreProject } from './score.mjs';
import { appendAppMessage, loopSummary } from './notify.mjs';
import { variantPrompt, withGuidance } from './prompts.mjs';
import { METHODS, ROOT_ID, blankNode, isLeaf, nextNodeId, urlList } from './tree.mjs';
import { BLOCKING, DEMONYMS, MAX_DRIVERS, auditTree, cleanTitle, countriesIn, duplicateAmong, duplicateOf, modelOf, narrowText } from './treeaudit.mjs';
import { passingSpecs, regressions, specHolders } from './specs.mjs';
import { Mutex } from './lanes.mjs';
import { mergeTrial, trialConflict } from './trialmerge.mjs';
import { gateTrace, pieceType, playbookText, refusedByLedger, similarChange, typeStats } from './playbook.mjs';
import { kindOf, lessonsFromTrials, principlesFrom } from './lessons.mjs';
import { countryByCode, hostCountries, tldCountry } from './brief.mjs';
import { passesEveryHardCriterion, screenCandidate } from './candidates.mjs';

export { similarChange };

export function helpsOnly(principles = []) {
  return principles.filter((p) => p.verdict === 'helps');
}

const GRADE_RANK = { verified: 3, supported: 2, weak: 1, unsupported: 0, failed: 0, pending: 0, researching: 0 };
const MAX_HOURS = 72;
const MAX_TRIALS_KEPT = 200;
const QUOTA_PAUSE_MS = 5 * 60 * 1000;
const MIN_GAIN = 0.001;
const REMOVAL_MIN_GAIN = 0.01;
const DEFAULT_SLICE_MINUTES = 20;
const QUOTA_ERROR = /no model provider|every provider failed|cooling down|rate limit|quota|high demand|unavailable|HTTP 5\d\d/i;

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function strings(value, max) {
  return (Array.isArray(value) ? value : value ? [value] : []).map((v) => String(v).trim()).filter(Boolean).slice(0, max);
}

export function resultsRubric(project) {
  const rows = (project?.candidates?.kept ?? []).filter((r) => r.plan?.checks);
  const target = project?.acceptance?.itemCount;
  if (!rows.length || !target) return null;
  const shares = rows.map((r) => (r.verified?.verdict === 'refuted' ? 0 : r.plan.share ?? 0)).sort((a, b) => b - a).slice(0, target);
  return round(shares.reduce((sum, v) => sum + v, 0) / target);
}

export function purposeScore(project) {
  const rows = (project?.acceptanceResult?.items ?? []).filter((row) => Array.isArray(row.purpose) && row.purpose.length);
  if (!rows.length) return null;
  return round(rows.filter((row) => row.purpose.every((c) => c.passed)).length / rows.length);
}

export function projectScore(project, pieces = []) {
  const base = scoreProject(project, pieces);
  const acceptance = project?.acceptanceResult?.score ?? null;
  const results = resultsRubric(project);
  const purpose = purposeScore(project);
  const measured = [acceptance, results, purpose].filter((v) => v !== null);
  const outcome = measured.length ? round(measured.reduce((sum, v) => sum + v, 0) / measured.length) : null;
  return { ...base, acceptance, results, purpose, score: outcome === null ? base.score : round(0.6 * outcome + 0.4 * base.score) };
}

export const NOISE_SAMPLES = 30;
export const NOISE_MIN_SAMPLES = 5;
export const NOISE_SIGMAS = 2;
export const NOISE_UNMEASURED = 'noise not yet measured';

export function noiseFloor(samples = []) {
  if (samples.length < NOISE_MIN_SAMPLES) return MIN_GAIN;
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const sd = Math.sqrt(samples.reduce((s, v) => s + (v - mean) ** 2, 0) / (samples.length - 1));
  return Math.max(MIN_GAIN, round(NOISE_SIGMAS * sd));
}

function noiseBar(samples = []) {
  return Math.max(noiseFloor(samples), ...samples.map((v) => Math.abs(v)));
}

export function trialVerdict(before, after, removed = [], samples = []) {
  if (samples.length < NOISE_MIN_SAMPLES) return { ok: false, reason: NOISE_UNMEASURED };
  const floor = noiseBar(samples);
  const needed = Math.max(floor, removed.length ? REMOVAL_MIN_GAIN : MIN_GAIN);
  return after > before + needed
    ? { ok: true, reason: `gain ${round(after - before)} clears the noise floor ${floor}` }
    : { ok: false, reason: `gain ${round(after - before)} does not clear the noise floor ${floor}` };
}

export function loopCanImprove(project) {
  const { acceptance, results, purpose } = projectScore(project);
  const purposeMet = purpose === null || purpose >= 0.999;
  if (results === null && purposeMet && (acceptance === null ? purpose !== null : acceptance >= 0.999)) {
    return { ok: false, reason: purpose === null ? 'the expected result is already met and nothing else measures the purpose; improve the purpose checks first' : 'every delivered row already meets the purpose checks and nothing else measures the purpose' };
  }
  return { ok: true, reason: '' };
}

export function distinctResearches(list) {
  const newest = new Map();
  for (const p of list.filter((x) => !x.demo)) {
    const key = String(p.question ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const seen = newest.get(key);
    if (!seen || String(p.updatedAt) > String(seen.updatedAt)) newest.set(key, p);
  }
  return [...newest.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map((p) => p.id);
}

export function inScope(nodes, scope, exclude = []) {
  if (!scope?.length) return new Set(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ids = new Set();
  for (const selected of scope.filter((id) => byId.has(id))) {
    for (let cursor = byId.get(selected); cursor; cursor = byId.get(cursor.parentId)) {
      for (const n of nodes) if (n.parentId === cursor.parentId) ids.add(n.id);
    }
    const below = new Set([selected]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of nodes) if (below.has(n.parentId) && !below.has(n.id)) { below.add(n.id); grew = true; }
    }
    for (const id of below) ids.add(id);
  }
  for (const id of exclude) ids.delete(id);
  return ids;
}

export function scopeScore(project, scope, pieces = [], exclude = []) {
  const ids = inScope(project.nodes, scope, exclude);
  const nodes = project.nodes.filter((n) => ids.has(n.id));
  const grades = gradeAverage(nodes, pieces);
  const keys = specHolders(project).filter(([id]) => ids.has(id)).flatMap(([id, h]) => h.specs.map((s) => `${id}/${s.id}`));
  const passing = passingSpecs(project);
  const specs = keys.length ? keys.filter((k) => passing.has(k)).length / keys.length : null;
  return { score: round(specs === null ? grades : 0.5 * grades + 0.5 * specs), grades: round(grades), specs, nodes: nodes.length };
}

export function scoredPieces(project, scope = [], exclude = []) {
  return [...inScope(project.nodes, scope, exclude)];
}

export function allChecksPass(before, after) {
  const keys = (p) => specHolders(p).flatMap(([id, h]) => h.specs.map((s) => `${id}/${s.id}`));
  const passing = passingSpecs(after);
  return [...new Set([...keys(before), ...keys(after)])].every((k) => passing.has(k));
}

export function acceptsTrial(before, after, removed = [], samples = []) {
  return trialVerdict(before, after, removed, samples).ok;
}

const FUTILE = new Set(['repeat', 'reverted-noise', 'reverted-whole', 'reverted-piece', 'reverted-regression', 'no-change', 'no-gain', 'no-new-evidence', 'reverted-structure']);
export const GAIN_OUTCOMES = new Set(['kept', 'kept-data']);
export const REST_AFTER_FUTILE = 3;
export const ROOT_EVERY = 3;

export function nextTarget(targets, { tried = new Set(), resting = new Set(), root = ROOT_ID, piecesThisPass = 0 } = {}) {
  const free = (t) => targets.includes(t) && !tried.has(t) && !resting.has(t);
  if (piecesThisPass >= ROOT_EVERY && free(root)) return root;
  const piece = targets.find((t) => t !== root && free(t));
  if (piece) return piece;
  return free(root) ? root : undefined;
}
export const REST_HOURS = 6;

export function restEnds(trials = []) {
  const streak = new Map();
  const lastAt = new Map();
  for (const t of trials) {
    if (GAIN_OUTCOMES.has(t.outcome)) streak.set(t.nodeId, 0);
    else if (FUTILE.has(t.outcome)) streak.set(t.nodeId, (streak.get(t.nodeId) ?? 0) + 1);
    if (FUTILE.has(t.outcome) || GAIN_OUTCOMES.has(t.outcome)) lastAt.set(t.nodeId, Date.parse(t.at));
  }
  return new Map([...streak].filter(([, n]) => n >= REST_AFTER_FUTILE).map(([id]) => [id, (lastAt.get(id) ?? 0) + REST_HOURS * 3600000]));
}

export function restingPieces(trials = [], now = Date.now()) {
  return new Set([...restEnds(trials)].filter(([, until]) => until > now).map(([id]) => id));
}

export function restRotation(targets, trials = []) {
  const ends = restEnds(trials);
  return [...targets].sort((a, b) => (ends.get(a) ?? 0) - (ends.get(b) ?? 0))[0];
}

export const STALL_TRIALS = 20;
export const PLATEAU_TRIALS = 12;

const PIECE_PASSING = new Set(['verified', 'supported']);

export function failingPieces(project) {
  if (!Array.isArray(project.nodes)) return [];
  const passing = passingSpecs(project);
  return project.nodes.filter((n) => !PIECE_PASSING.has(n.status) || (n.specs ?? []).some((s) => !passing.has(`${n.id}/${s.id}`))).map((n) => n.id);
}

export function nothingLeftToGain(project) {
  const checks = project.acceptanceResult?.checks ?? [];
  const failing = failingPieces(project);
  if (checks.length && checks.every((c) => c.value >= 0.999) && !failing.length) {
    return { ok: true, reason: 'nothing left to gain: every expected-result check is at 100% and every piece passes' };
  }
  return { ok: false, checksBelowFull: checks.filter((c) => c.value < 0.999).map((c) => c.label), failingPieces: failing };
}

export function stallCheck(project, now = Date.now()) {
  const trials = project.improve?.trials ?? [];
  const outcomes = trials.map((t) => t.outcome);
  const lastKept = Math.max(outcomes.lastIndexOf('kept'), outcomes.lastIndexOf('kept-data'));
  const since = trials.slice(lastKept + 1).filter((t) => t.outcome !== 'provider-outage');
  const firstSeen = Math.min(...[since[0]?.at, project.improve?.startedAt].filter(Boolean).map(Date.parse), now);
  const from = lastKept >= 0 ? Date.parse(trials[lastKept].at) : firstSeen;
  const belowFull = [...(project.acceptanceResult?.checks ?? [])].filter((c) => c.value < 0.999).sort((a, b) => a.value - b.value);
  const weakest = belowFull[0] ? { label: belowFull[0].label, value: belowFull[0].value } : null;
  const failing = failingPieces(project);
  const refusedRemovals = [...new Set(since.filter((t) => t.removedPieceId && FUTILE.has(t.outcome)).flatMap((t) => t.removedPieceId.split(', ')))];
  return {
    stalled: since.length >= STALL_TRIALS,
    trialsSinceKept: since.length,
    hoursSinceKept: Math.round(((now - from) / 3600000) * 10) / 10,
    weakest,
    failingPieces: weakest ? [] : failing.slice(0, 8),
    refusedRemovals,
  };
}

export function stallMessage(stall) {
  const target = stall.weakest
    ? `the lowest expected-result check below 100% is "${stall.weakest.label}" at ${Math.round(stall.weakest.value * 100)}%`
    : stall.failingPieces?.length
      ? `every expected-result check is at 100% but these pieces do not pass: ${stall.failingPieces.join(', ')}`
      : 'no expected-result check is below 100%';
  return `The self-improving loop is stalled: ${stall.trialsSinceKept} trials in ${stall.hoursSinceKept} h without a kept change; ${target}. It now steers every proposal toward what can still gain and refuses repeats${stall.refusedRemovals.length ? ` (removals already refused: ${stall.refusedRemovals.join(', ')})` : ''}.`;
}

const NOT_A_MEASURED_TRIAL = new Set(['provider-outage', 'error', 'reverted-stopped', 'conflict']);

export function plateauCheck(trials = [], startedAt = null) {
  const sinceKept = [];
  const start = startedAt ? Date.parse(startedAt) : -Infinity;
  for (const t of trials) {
    if (t.at && Date.parse(t.at) < start) continue;
    if (GAIN_OUTCOMES.has(t.outcome)) sinceKept.length = 0;
    else if (NOT_A_MEASURED_TRIAL.has(t.outcome)) continue;
    else sinceKept.push(t);
  }
  const plateaued = sinceKept.length >= PLATEAU_TRIALS;
  return { plateaued, trialsSinceKept: sinceKept.length };
}

export const REPEAT_SIMILARITY = 0.85;

export function repeatOf(trials = [], { nodeId, change, removedPieceId }) {
  return trials.find((t) => t.nodeId === nodeId && FUTILE.has(t.outcome) && t.outcome !== 'repeat' && ((removedPieceId && t.removedPieceId === removedPieceId) || similarChange(t.change, change) >= REPEAT_SIMILARITY)) ?? null;
}

function itemKeys(node) {
  return new Set((node?.finding?.items ?? []).map((i) => `${i.url}|${i.value ?? ''}`));
}

export function citedUrls(project) {
  const urls = new Set();
  for (const node of project?.nodes ?? []) {
    for (const source of node.sources ?? []) if (source.url) urls.add(source.url);
    for (const item of node.finding?.items ?? []) if (item.url) urls.add(item.url);
  }
  return urls;
}

export function newEvidence(before, after) {
  const known = citedUrls(before);
  return [...citedUrls(after)].filter((url) => !known.has(url));
}

function hostOf(url) {
  try {
    return new URL(String(url ?? '')).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function trimProposalRegions(variant, regions = []) {
  if (!variant || !Array.isArray(regions) || !regions.length) return { variant, trimmed: [] };
  const trimmed = new Set();
  const allowedNamed = regions.map((c) => countryByCode(c)?.name).filter(Boolean);
  const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const noteOutside = (text) => {
    const outside = countriesIn(text).filter((c) => !regions.includes(c));
    for (const c of outside) trimmed.add(countryByCode(c)?.name ?? c);
    return outside;
  };
  const cleanUp = (out) => out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/,\s*,/g, ',').replace(/,\s*(?:and\s*)?$/g, '').replace(/\(\s*\)/g, '').trim();
  const fixText = (text) => {
    const value = String(text ?? '');
    if (!value || !noteOutside(value).length) return value;
    let out = narrowText(value, regions);
    for (const code of countriesIn(value).filter((c) => !regions.includes(c))) {
      for (const [word, wordCode] of Object.entries(DEMONYMS)) {
        if (wordCode !== code) continue;
        out = out.replace(new RegExp(`\\b${word}\\b`, 'gi'), '');
      }
    }
    return cleanUp(out);
  };
  const fixShort = (text) => {
    const value = String(text ?? '');
    const outside = noteOutside(value);
    if (!value || !outside.length) return value;
    let out = value;
    for (const code of outside) {
      const country = countryByCode(code);
      for (const name of country ? [country.name, ...country.aliases] : []) {
        const n = escapeRe(name);
        out = out.replace(new RegExp(`\\s*,\\s*(?:and\\s+)?${n}\\b`, 'gi'), '').replace(new RegExp(`\\b${n}\\s*(?:,\\s*|\\s+and\\s+)`, 'gi'), '').replace(new RegExp(`\\s+and\\s+${n}\\b`, 'gi'), '').replace(new RegExp(`\\b${n}\\b`, 'gi'), '');
      }
      for (const [word, wordCode] of Object.entries(DEMONYMS)) {
        if (wordCode !== code) continue;
        out = out.replace(new RegExp(`\\b${word}\\b`, 'gi'), '');
      }
    }
    out = cleanUp(out).replace(/\s+(?:in|from|of|at|near|across|within|for|to|and|or)\s*$/i, '');
    if (allowedNamed.length && !countriesIn(out).some((c) => regions.includes(c))) out = `${out ? `${out} ` : ''}in ${allowedNamed.join(' and ')}`.trim();
    return out || allowedNamed.join(' and ');
  };
  const fixUrls = (urls) => (Array.isArray(urls) ? urls : []).filter((u) => {
    const url = String(u ?? '');
    const byTld = tldCountry(url);
    const outside = [...new Set([...hostCountries(url), ...(byTld ? [byTld] : [])])].filter((c) => !regions.includes(c));
    if (!outside.length) return true;
    for (const c of outside) trimmed.add(countryByCode(c)?.name ?? c);
    return false;
  });
  const fixEntry = (entry) => (entry && typeof entry === 'object'
    ? {
        ...entry,
        title: fixShort(entry.title),
        question: fixText(entry.question),
        searchQueries: Array.isArray(entry.searchQueries) ? entry.searchQueries.map(fixShort) : entry.searchQueries,
        sourceUrls: fixUrls(entry.sourceUrls),
      }
    : entry);
  const proposal = {
    ...variant,
    change: fixText(variant.change),
    question: typeof variant.question === 'string' ? fixText(variant.question) : variant.question,
    instructions: typeof variant.instructions === 'string' ? fixText(variant.instructions) : variant.instructions,
    searchQueries: Array.isArray(variant.searchQueries) ? variant.searchQueries.map(fixShort) : variant.searchQueries,
    sourceUrls: fixUrls(variant.sourceUrls),
    split: Array.isArray(variant.split) ? variant.split.map(fixEntry) : variant.split,
    add: Array.isArray(variant.add) ? variant.add.map(fixEntry) : variant.add,
  };
  return { variant: proposal, trimmed: [...trimmed] };
}

function listingRowsOf(project) {
  const rows = [];
  for (const node of project?.nodes ?? []) {
    for (const source of node.sources ?? []) {
      for (const listing of source.listings ?? []) rows.push({ ...listing, source, nodeId: node.id });
    }
    for (const item of node.finding?.items ?? []) {
      rows.push({ ...item, source: (node.sources ?? []).find((s) => s.id === item.sourceId) ?? null, nodeId: node.id });
    }
  }
  return rows;
}

export function newListingRows(before, after) {
  const known = citedUrls(before);
  const seen = new Set();
  const rows = [];
  for (const row of listingRowsOf(after)) {
    if (!row?.url || known.has(row.url) || seen.has(row.url)) continue;
    seen.add(row.url);
    rows.push(row);
  }
  return rows;
}

export function passingHardRows(rows, brief) {
  if (!brief?.kind || !brief?.regions?.length) return [];
  const out = [];
  for (const row of rows ?? []) {
    const verdict = screenCandidate(row, brief, {});
    if (looksLikeListing(row.url) && passesEveryHardCriterion(row, verdict, brief)) out.push(row);
  }
  return out;
}

export function dataGain(before, after, brief) {
  const fresh = newListingRows(before, after);
  const passing = passingHardRows(fresh, brief);
  const hosts = [...new Set(fresh.map((r) => hostOf(r.url)).filter(Boolean))].sort();
  return {
    found: fresh.length,
    passing,
    detail: `+${fresh.length} listings from ${hosts.join(', ') || 'new sources'}, ${passing.length} pass every hard criterion`,
  };
}

export function mergeDataRows(project, rows, fallbackNodeId) {
  const merged = [];
  for (const row of rows ?? []) {
    if (!row?.url) continue;
    const node = project.nodes.find((n) => n.id === row.nodeId) ?? (fallbackNodeId ? project.nodes.find((n) => n.id === fallbackNodeId) : null);
    if (!node) continue;
    node.finding ??= { answer: '', items: [] };
    node.finding.items ??= [];
    if (node.finding.items.some((i) => i.url === row.url)) continue;
    node.finding.items.push({ title: String(row.title ?? row.url).slice(0, 160), url: row.url, value: row.value ?? null, unit: row.unit ?? '', sourceId: row.sourceId ?? row.source?.id ?? '', harvested: true });
    merged.push(row.url);
  }
  return merged;
}

export function usedQueries(trials = [], nodeId) {
  const used = [];
  for (const t of trials ?? []) {
    if (t.nodeId !== nodeId) continue;
    for (const q of t.queries ?? []) if (typeof q === 'string' && !used.includes(q)) used.push(q);
  }
  return used;
}

export function sameQueriesAgain(variant, node, trials = [], nodeId) {
  const proposed = strings(variant?.searchQueries, 3);
  if (!proposed.length) return false;
  const known = [...usedQueries(trials, nodeId), ...(node?.searchQueries ?? []).map(String)];
  const freshUrls = (Array.isArray(variant?.sourceUrls) ? variant.sourceUrls : []).filter((u) => !(node?.sourceUrls ?? []).includes(u));
  return proposed.every((q) => known.includes(q)) && !freshUrls.length;
}

export function structuralIssues(project) {
  return auditTree(project.nodes, project.question, modelOf(project)).filter((i) => BLOCKING.has(i.code)).map((i) => `${i.code}:${i.nodeId}`);
}

export function cannotGain(oldNode, newNode) {
  if (!oldNode || !newNode) return false;
  if ((GRADE_RANK[newNode.status] ?? 0) > (GRADE_RANK[oldNode.status] ?? 0)) return false;
  if ((oldNode.specs ?? []).some((spec) => !spec.last?.passed)) return false;
  const before = itemKeys(oldNode);
  return [...itemKeys(newNode)].every((k) => before.has(k));
}

function canGain(project, node) {
  if (node.status !== 'verified') return true;
  if ((node.specs ?? []).some((spec) => !spec.last?.passed)) return true;
  const expectedUnmet = Boolean(project.acceptanceResult) && project.acceptanceResult.score < 0.999;
  return expectedUnmet && (node.finding?.items ?? []).length > 0;
}

export function improvementTargets(project, scope = [], exclude = []) {
  const ids = inScope(project.nodes, scope, exclude);
  const leaves = project.nodes
    .filter((n) => ids.has(n.id) && isLeaf(project.nodes, n) && canGain(project, n))
    .sort((a, b) => (GRADE_RANK[a.status] ?? 0) - (GRADE_RANK[b.status] ?? 0) || b.impact * b.uncertainty - a.impact * a.uncertainty);
  return [...leaves.map((n) => n.id), ...(exclude.includes(ROOT_ID) ? [] : [ROOT_ID])];
}

function nodeFields(raw, id, parentId) {
  const question = String(raw?.question ?? '').trim().slice(0, 400);
  if (!question) return null;
  return blankNode({
    id,
    parentId,
    title: cleanTitle(String(raw?.title || question)).slice(0, 90),
    question,
    method: METHODS.includes(raw?.method) ? raw.method : 'lookup',
    searchQueries: strings(raw?.searchQueries, 3),
    sourceUrls: urlList(raw?.sourceUrls),
  });
}

export function applyVariant(project, nodeId, variant) {
  const touched = [];
  if (nodeId === ROOT_ID) {
    for (const raw of (Array.isArray(variant?.add) ? variant.add : []).slice(0, 2)) {
      if (project.nodes.filter((n) => n.parentId === ROOT_ID).length >= MAX_DRIVERS) break;
      const node = nodeFields(raw, nextNodeId(project.nodes, ROOT_ID), ROOT_ID);
      if (node && !duplicateOf(node, project.nodes, project.question)) {
        project.nodes.push(node);
        touched.push(node.id);
      }
    }
    const remove = new Set(strings(variant?.remove, 2).filter((id) => project.nodes.some((n) => n.id === id && n.parentId === ROOT_ID)));
    if (remove.size && project.nodes.filter((n) => n.parentId === ROOT_ID).length - remove.size >= 2) {
      const doomed = new Set(remove);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of project.nodes) if (doomed.has(n.parentId) && !doomed.has(n.id)) { doomed.add(n.id); grew = true; }
      }
      project.nodes = project.nodes.filter((n) => !doomed.has(n.id));
      for (const n of project.nodes) n.dependsOn = n.dependsOn.filter((d) => !doomed.has(d));
      touched.push(...remove);
    }
    return touched;
  }
  const node = project.nodes.find((n) => n.id === nodeId);
  if (!node) return touched;
  if (typeof variant?.question === 'string' && variant.question.trim()) node.question = variant.question.trim().slice(0, 400);
  if (Array.isArray(variant?.searchQueries) && strings(variant.searchQueries, 3).length) node.searchQueries = strings(variant.searchQueries, 3);
  if (Array.isArray(variant?.sourceUrls) && urlList(variant.sourceUrls).length) node.sourceUrls = urlList(variant.sourceUrls);
  if (METHODS.includes(variant?.method)) node.method = variant.method;
  if (typeof variant?.instructions === 'string' && variant.instructions.trim()) node.instructions = variant.instructions.trim().slice(0, 2000);
  touched.push(node.id);
  for (const raw of (Array.isArray(variant?.split) ? variant.split : []).slice(0, 3)) {
    const child = nodeFields(raw, nextNodeId(project.nodes, node.id), node.id);
    if (child && !duplicateAmong(child, [node, ...project.nodes.filter((n) => n.parentId === node.id)])) {
      project.nodes.push(child);
      touched.push(child.id);
    }
  }
  return touched;
}

export class ProjectImprover {
  constructor({ engine, lessons = null, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), checkpoint = async () => {} }) {
    this.engine = engine;
    this.lessons = lessons;
    this.checkpoint = checkpoint;
    this.now = now;
    this.sleep = sleep;
    this.active = new Map();
  }

  isActive(id) {
    return this.active.has(id);
  }

  scopeOf(id) {
    return this.active.get(id)?.scope ?? [];
  }

  excludeOf(id) {
    return this.active.get(id)?.exclude ?? [];
  }

  remainingHours(id) {
    const state = this.active.get(id);
    return state ? Math.max(0, (state.deadline - this.now()) / 3600000) : 0;
  }

  async saveHandoff(id, reason, resume = {}) {
    try {
      const project = await this.engine.load(id);
      await this.engine.onStop(project, { reason, resume });
      await this.engine.store.save(project, { reason: `loop handoff: ${reason}` });
    } catch {
      return;
    }
  }

  async shutdown() {
    for (const [id, state] of this.active) {
      const byUser = Boolean(this.stopped(state));
      state.stopped = true;
      state.shutdown = true;
      if (state.before) await this.restore(id, state.before).catch(() => {});
      if (byUser) await this.saveHandoff(id, 'loop stopped by user');
      else await this.saveHandoff(id, 'app stopped', { loopHoursLeft: Math.max(0, (state.deadline - this.now()) / 3600000), loopScope: state.scope ?? [], loopExclude: state.exclude ?? [] });
    }
  }

  async restore(id, before) {
    const current = await this.engine.load(id);
    await this.engine.store.save({ ...before, chats: current.chats, log: current.log, improve: current.improve, guidance: current.guidance }, { reason: 'loop: trial reverted to the research as it was before it', userAction: 'loop' });
  }

  stopped(state) {
    return state.stopped || this.all?.stopped;
  }

  start(id, { hours = 1, nodes = [], exclude = [] } = {}) {
    if (this.active.has(id)) throw new Error('the self-improving loop is already running for this project');
    const cached = this.engine.store?.cache?.get?.(id);
    if (cached) {
      const can = loopCanImprove(cached);
      if (!can.ok) {
        this.engine.emit(cached, 'improve-state', `loop not started: ${can.reason}`);
        void this.engine.store.save(cached, { reason: 'loop not started' }).catch(() => {});
        return { ok: false, reason: can.reason };
      }
    }
    const h = Math.min(MAX_HOURS, Math.max(0.05, Number(hours) || 1));
    const scope = (Array.isArray(nodes) ? nodes : []).map(String).filter((n) => n && n !== ROOT_ID).slice(0, 60);
    const skipped = scope.length ? (Array.isArray(exclude) ? exclude : []).map(String).filter((n) => n && !scope.includes(n)).slice(0, 120) : [];
    const state = { stopped: false, deadline: this.now() + h * 3600 * 1000, hours: h, scope, exclude: skipped };
    this.active.set(id, state);
    void (async () => {
      this.engine.quiet.add(id);
      try {
        await this.loop(id, state);
      } catch (error) {
        await this.record(id, { active: false, error: error.message });
      } finally {
        this.active.delete(id);
        this.engine.quiet.delete(id);
        this.engine.cancelled.delete(id);
        if (!state.shutdown) await this.saveHandoff(id, state.stopped ? 'loop stopped by user' : 'loop ended');
      }
    })();
    return { ok: true, deadline: new Date(state.deadline).toISOString() };
  }

  startAll({ hours = 8, sliceMinutes = DEFAULT_SLICE_MINUTES } = {}) {
    if (this.all) throw new Error('the loop over all researches is already running');
    const h = Math.min(MAX_HOURS, Math.max(0.05, Number(hours) || 8));
    const sliceMs = Math.max(1, Number(sliceMinutes) || DEFAULT_SLICE_MINUTES) * 60 * 1000;
    const state = { stopped: false, deadline: this.now() + h * 3600 * 1000, hours: h, current: null, rounds: 0 };
    this.all = state;
    void (async () => {
      try {
        await this.cycle(state, sliceMs);
      } finally {
        this.all = null;
      }
    })();
    return { ok: true, deadline: new Date(state.deadline).toISOString() };
  }

  stopAll() {
    if (!this.all) return { ok: false };
    this.all.stopped = true;
    for (const id of this.active.keys()) this.stop(id);
    return { ok: true };
  }

  allStatus() {
    return this.all ? { active: true, deadline: new Date(this.all.deadline).toISOString(), current: this.all.current, rounds: this.all.rounds } : { active: false };
  }

  async cycle(state, sliceMs) {
    while (this.live(state)) {
      const ids = distinctResearches(await this.engine.store.list());
      if (!ids.length) break;
      for (const id of ids) {
        if (!this.live(state)) break;
        if (this.active.has(id) || this.engine.running.has(id)) continue;
        const slice = { stopped: false, deadline: Math.min(state.deadline, this.now() + sliceMs), hours: round(sliceMs / 3600000) };
        state.current = id;
        this.active.set(id, slice);
        this.engine.quiet.add(id);
        try {
          await this.loop(id, slice);
        } catch (error) {
          await this.record(id, { active: false, error: error.message });
        } finally {
          this.active.delete(id);
          this.engine.quiet.delete(id);
          this.engine.cancelled.delete(id);
          if (!slice.shutdown) await this.saveHandoff(id, 'improve-all slice ended');
        }
      }
      state.rounds += 1;
    }
    state.current = null;
  }

  stop(id) {
    const state = this.active.get(id);
    if (!state) return { ok: false };
    state.stopped = true;
    this.engine.cancel(id);
    return { ok: true };
  }

  async record(id, patch, trial) {
    const project = await this.engine.load(id);
    const wasStalled = Boolean(project.improve?.stall?.stalled);
    const improve = { trials: [], ...(project.improve ?? {}), ...patch };
    if (trial) trial = { ...trial, scoreDelta: round(trial.score - trial.before) };
    if (trial) improve.trials = [...improve.trials, trial].slice(-MAX_TRIALS_KEPT);
    if (trial) improve.byType = typeStats(improve.trials, project.nodes);
    if (trial && this.lessons) await this.lessons.add(lessonsFromTrials([trial], { researchId: id, type: trial.type, kind: kindOf(project) }));
    project.improve = improve;
    if ('active' in patch) appendAppMessage(project, loopSummary(improve, !patch.active));
    if (patch.stall?.stalled && !wasStalled) {
      appendAppMessage(project, stallMessage(patch.stall));
      this.engine.emit(project, 'improve-state', stallMessage(patch.stall));
    }
    if (trial?.outcome === 'kept') appendAppMessage(project, `Kept a change on ${trial.nodeId}: ${trial.change}. Score ${trial.before} → ${trial.score}.`);
    if (trial?.outcome === 'kept-data') appendAppMessage(project, `Kept new data on ${trial.nodeId}: ${trial.detail}. The text change itself was reverted; the score stayed ${trial.score}.`);
    if ('active' in patch) this.engine.emit(project, 'improve-state', patch.active ? `self-improving loop started for ${Math.round(improve.hours * 10) / 10} h` : `self-improving loop ended: ${patch.stopReason ?? patch.error ?? 'stopped'} · baseline ${improve.baseline} → best ${improve.best}`);
    if (trial) this.engine.emit(project, 'improve', `${trial.nodeId}: ${trial.outcome} (${trial.score}) — ${trial.change}${trial.detail ? ` · ${trial.detail}` : ''}${trial.diagnosis ? ` · diagnosis: ${trial.diagnosis}` : ''}${trial.guided ? ' · guided by kept changes or verified pieces of its type' : ''}`, { nodeId: trial.nodeId });
    await this.engine.store.save(project, { reason: trial ? `loop: trial ${trial.outcome} on ${trial.nodeId}` : 'loop: state recorded' });
    return improve;
  }

  live(state) {
    return !state.stopped && this.now() < state.deadline;
  }

  async loop(id, state) {
    let project = await this.engine.load(id);
    const can = loopCanImprove(project);
    if (!can.ok) {
      this.engine.emit(project, 'improve-state', `loop not started: ${can.reason}`);
      await this.engine.store.save(project, { reason: 'loop not started' });
      return;
    }
    this.engine.rejoinTeam(id, (clientId) => this.join(id, clientId));
    const scope = state.scope ?? [];
    const exclude = state.exclude ?? [];
    state.pieces = new Set();
    state.pages = new Map();
    state.lock = new Mutex();
    state.measure = (p) => (scope.length ? scopeScore(p, scope, [...state.pieces], exclude) : projectScore(p, [...state.pieces]));
    await this.record(id, { active: true, startedAt: new Date(this.now()).toISOString(), deadline: new Date(state.deadline).toISOString(), hours: state.hours, scope, exclude, error: null, finishedAt: null, stopReason: null });
    project = await this.whenModelsAnswer(id, state, () => (project.phase !== 'done' ? this.engine.run(id, { sweep: true, pages: state.pages }) : this.engine.regroundAndRescore(id, { sweep: true, pages: state.pages })));
    if (!project) return this.record(id, { active: false, finishedAt: new Date(this.now()).toISOString(), stopReason: state.stopped ? 'stopped by user' : 'time limit reached' });
    state.pieces = new Set(scoredPieces(project, scope, exclude));
    state.best = state.measure(project);
    await this.record(id, { baseline: state.best.score, best: state.best.score });
    let quiet = 0;
    let stopReason = state.stopped ? 'stopped by user' : 'time limit reached';
    await this.saveCheckpoint(id, state);
    while (this.live(state)) {
      if (!improvementTargets(await this.engine.load(id), scope, exclude).length) {
        stopReason = 'nothing left to improve in the selection';
        break;
      }
      const improved = await this.whenModelsAnswer(id, state, () => this.pass(id, state));
      await this.saveCheckpoint(id, state);
      if (this.engine.siteWarm?.get(id)?.ready) await this.rebase(id, state);
      quiet = improved ? 0 : quiet + 1;
      let done = null;
      await state.lock.run(async () => {
        const current = await this.engine.load(id);
        const stall = stallCheck(current, this.now());
        const plateau = plateauCheck(current.improve?.trials ?? [], current.improve?.startedAt);
        const gain = nothingLeftToGain(current);
        await this.record(id, { passes: (current.improve?.passes ?? 0) + 1, quietPasses: quiet, stall: { ...stall, stalled: stall.stalled || plateau.plateaued } });
        if (gain.ok) done = gain.reason;
      });
      if (done) {
        stopReason = done;
        break;
      }
    }
    state.spawn = null;
    this.engine.leave(id);
    await this.record(id, { active: false, finishedAt: new Date(this.now()).toISOString(), stopReason });
  }

  async rebase(id, state) {
    await state.lock.run(async () => {
      const project = await this.engine.applyWarmed(id);
      if (!project) return;
      const before = state.best.score;
      state.best = state.measure(project);
      await this.record(id, { best: state.best.score, rebased: { at: new Date(this.now()).toISOString(), from: before, to: state.best.score } });
      this.engine.emit(project, 'improve-state', `baseline re-measured after new site measurements: ${before} → ${state.best.score}; trials compare against this`);
    });
  }

  async whenModelsAnswer(id, state, step) {
    while (this.live(state)) {
      try {
        return await step();
      } catch (error) {
        if (!QUOTA_ERROR.test(error.message)) throw error;
        await this.record(id, { lastPause: { at: new Date(this.now()).toISOString(), reason: error.message.slice(0, 200) } });
        this.engine.emit(await this.engine.load(id), 'improve-state', `loop paused ${Math.round(QUOTA_PAUSE_MS / 60000)} min: models are busy or out of quota (${error.message.slice(0, 120)}); it continues by itself`);
        await this.sleep(Math.min(QUOTA_PAUSE_MS, Math.max(0, state.deadline - this.now())));
      }
    }
    return null;
  }

  async saveCheckpoint(id, state) {
    if (!state.hours || state === this.all) return;
    try {
      await this.checkpoint(id, { loopHoursLeft: Math.max(0, (state.deadline - this.now()) / 3600000), loopScope: state.scope ?? [], loopExclude: state.exclude ?? [] });
    } catch {
      return;
    }
  }

  async pass(id, state) {
    const tried = new Set();
    const claimed = new Set();
    let improved = false;
    const lanes = new Set();
    const lane = async () => {
      while (this.live(state)) {
        const current = await this.engine.load(id);
        const targets = improvementTargets(current, state.scope ?? [], state.exclude ?? []).filter((t) => !tried.has(t) && !claimed.has(t));
        const resting = restingPieces(current.improve?.trials, this.now());
        const piecesThisPass = [...tried].filter((t) => t !== ROOT_ID).length;
        const nodeId = nextTarget(targets, { tried, resting, piecesThisPass }) ?? (tried.size ? undefined : restRotation(targets, current.improve?.trials));
        if (!nodeId) return;
        tried.add(nodeId);
        claimed.add(nodeId);
        try {
          if ((await this.trial(id, nodeId, state)).kept) improved = true;
        } finally {
          claimed.delete(nodeId);
        }
      }
    };
    const spawn = () => {
      const running = lane().finally(() => lanes.delete(running));
      lanes.add(running);
    };
    for (let i = 0; i < this.engine.lanesFor(id); i++) spawn();
    state.spawn = () => {
      if (lanes.size && lanes.size < this.engine.lanesFor(id)) spawn();
    };
    while (lanes.size) await Promise.race(lanes);
    return improved;
  }

  join(id, clientId = '') {
    const state = this.active.get(id);
    const joined = this.engine.join(id, clientId);
    state?.spawn?.();
    return joined;
  }

  async propose(project, nodeId, best) {
    const node = nodeId === ROOT_ID ? { id: ROOT_ID } : project.nodes.find((n) => n.id === nodeId);
    const trials = (project.improve?.trials ?? []).filter((t) => t.nodeId === nodeId);
    const others = this.lessons ? await this.lessons.forType(pieceType(node), { excludeResearch: project.id, kind: kindOf(project) }) : [];
    const playbook = playbookText(project, node, { principles: helpsOnly(principlesFrom(others, pieceType(node))) });
    const reply = await this.engine.router.complete({ purpose: 'improve', tier: 'deep', messages: withGuidance(variantPrompt({ project, node, score: best, trials, stall: stallCheck(project, this.now()), playbook: playbook.text, trace: nodeId === ROOT_ID ? [] : gateTrace(node) }), project.guidance) });
    return { ...(reply.data ?? {}), guided: playbook.lessons + playbook.demos > 0, type: pieceType(node) };
  }

  async trial(id, nodeId, state) {
    const snapshot = structuredClone(await this.engine.load(id));
    const base = { at: new Date(this.now()).toISOString(), nodeId, before: state.best.score };
    const note = (trial) => state.lock.run(() => this.record(id, {}, trial));
    try {
      const raw = await this.propose(snapshot, nodeId, state.best);
      const regions = modelOf(snapshot).regions;
      const { variant, trimmed } = trimProposalRegions(raw, regions);
      const change = String(variant.change ?? 'variant').slice(0, 240);
      const queries = strings(variant.searchQueries, 3);
      Object.assign(base, { type: variant.type, guided: variant.guided, ...(variant.diagnosis ? { diagnosis: String(variant.diagnosis).slice(0, 240) } : {}), ...(trimmed.length ? { trimmedRegions: trimmed } : {}), ...(queries.length ? { queries } : {}) });
      const project = structuredClone(snapshot);
      if (this.stopped(state)) return { kept: false };
      const touched = applyVariant(project, nodeId, variant);
      const removed = touched.filter((t) => !project.nodes.some((n) => n.id === t));
      if (removed.length) base.removedPieceId = removed.join(', ');
      const earlier = repeatOf(snapshot.improve?.trials, { nodeId, change, removedPieceId: base.removedPieceId });
      if (earlier) {
        await note({ ...base, change, outcome: 'repeat', score: state.best.score, detail: `same change as the ${earlier.outcome} trial at ${earlier.at}; not re-researched` });
        return { kept: false };
      }
      const failing = removed.length ? null : refusedByLedger(snapshot.improve?.trials, snapshot.nodes, variant.type, change);
      if (failing) {
        await note({ ...base, change, outcome: 'repeat', score: state.best.score, detail: `like a change tested ${failing.harmful} times on ${failing.pieces.length} pieces of this type (${failing.pieces.slice(0, 4).join(', ')}) and never kept; not re-researched` });
        return { kept: false };
      }
      const oldNode = snapshot.nodes.find((n) => n.id === nodeId);
      if (sameQueriesAgain(variant, oldNode, snapshot.improve?.trials, nodeId)) {
        await note({ ...base, change, outcome: 'repeat', score: state.best.score, detail: `the same queries were already used on ${nodeId} (${queries.join(' | ')}); different sources or queries are required, never the same queries again` });
        return { kept: false };
      }
      if (!touched.length) {
        await note({ ...base, change, outcome: 'no-change', score: state.best.score });
        return { kept: false };
      }
      const before = new Set(structuralIssues(snapshot));
      const added = structuralIssues(project).filter((i) => !before.has(i));
      if (added.length) {
        await note({ ...base, change, outcome: 'reverted-structure', score: state.best.score, detail: `would add tree problems: ${added.join(', ')}` });
        return { kept: false };
      }
      for (const t of touched) if (project.nodes.some((n) => n.id === t)) this.engine.resetWithAncestors(project, t);
      const researched = nodeId !== ROOT_ID && oldNode && isLeaf(project.nodes, project.nodes.find((n) => n.id === nodeId));
      if (researched) {
        const node = project.nodes.find((n) => n.id === nodeId);
        await this.engine.researchLeaf(project, node);
        if (this.stopped(state)) {
          await note({ ...base, change, outcome: 'reverted-stopped', score: state.best.score });
          return { kept: false };
        }
        if ((GRADE_RANK[node.status] ?? 0) < (GRADE_RANK[oldNode.status] ?? 0)) {
          const gain = dataGain(snapshot, project, snapshot.brief);
          const keptData = gain.passing.length ? await this.keepData(id, base, change, snapshot, project, gain, state) : null;
          if (keptData) return keptData;
          await note({ ...base, change, outcome: 'reverted-piece', score: state.best.score, detail: `${nodeId} fell from ${oldNode.status} to ${node.status}` });
          return { kept: false };
        }
        const broken = regressions(snapshot, project).filter((k) => k.startsWith(`${nodeId}/`));
        if (broken.length) {
          await note({ ...base, change, outcome: 'reverted-regression', score: state.best.score, detail: `breaks passing check(s): ${broken.join(', ')}` });
          return { kept: false };
        }
        if (touched.length === 1 && !removed.length && cannotGain(oldNode, node)) {
          const gain = dataGain(snapshot, project, snapshot.brief);
          const keptData = gain.passing.length ? await this.keepData(id, base, change, snapshot, project, gain, state) : null;
          if (keptData) return keptData;
          await note({ ...base, change, outcome: 'no-gain', score: state.best.score, detail: `${nodeId} kept its grade (${node.status}) and found nothing new, so the score could not rise; the whole research was not re-rolled` });
          return { kept: false };
        }
      }
      return await state.lock.run(() => this.commit(id, { snapshot, project, touched, removed, researched, nodeId, base, change }, state));
    } catch (error) {
      const isQuota = QUOTA_ERROR.test(error.message);
      await note({ ...base, change: 'trial failed', outcome: isQuota ? 'provider-outage' : 'error', score: state.best.score, detail: error.message.slice(0, 200) });
      if (isQuota && this.live(state)) await this.sleep(Math.min(QUOTA_PAUSE_MS, Math.max(0, state.deadline - this.now())));
      return { kept: false };
    }
  }

  async keepData(id, base, change, before, after, gain, state) {
    const current = await this.engine.load(id);
    const target = structuredClone(current);
    const keptRows = mergeDataRows(target, gain.passing, base.nodeId);
    if (!keptRows.length) return null;
    await this.engine.store.save({ ...target, chats: current.chats, log: current.log, improve: current.improve }, { reason: `loop: trial on ${base.nodeId} kept ${keptRows.length} new listing(s) that pass every hard criterion`, userAction: 'loop' });
    await this.record(id, {}, { ...base, before: state.best.score, change, outcome: 'kept-data', score: state.best.score, detail: gain.detail, keptRows });
    return { kept: true, data: true };
  }

  async commit(id, { snapshot, project, touched, removed, researched, nodeId, base, change }, state) {
    const best = state.best;
    const current = await this.engine.load(id);
    const before = structuredClone(current);
    const reject = async (outcome, detail, score = best.score, data = null) => {
      const restored = structuredClone(before);
      const keptRows = data?.passing?.length ? mergeDataRows(restored, data.passing, nodeId) : [];
      if (keptRows.length) {
        await this.engine.store.save({ ...restored, chats: current.chats, log: current.log, improve: current.improve }, { reason: `loop: trial reverted on ${nodeId} but kept ${keptRows.length} new listing(s) that pass every hard criterion`, userAction: 'loop' });
        await this.record(id, {}, { ...base, before: best.score, change, outcome: 'kept-data', score, detail: data.detail, keptRows });
        return { kept: true, data: true };
      }
      await this.restore(id, before);
      await this.record(id, {}, { ...base, before: best.score, change, outcome, score, ...(detail ? { detail } : {}) });
      return { kept: false };
    };
    if (this.stopped(state)) {
      await this.record(id, {}, { ...base, change, outcome: 'reverted-stopped', score: best.score });
      return { kept: false };
    }
    const conflict = trialConflict(snapshot, current, project, touched);
    if (conflict) {
      await this.record(id, {}, { ...base, change, outcome: 'conflict', score: best.score, detail: `${conflict}; tried again in the next pass` });
      return { kept: false };
    }
    state.before = before;
    const pages = state.pages ?? (state.pages = new Map());
    try {
      const beforePending = new Set(before.nodes.filter((n) => n.status === 'pending' || n.status === 'failed').map((n) => n.id));
      const merged = mergeTrial(current, snapshot, project, touched);
      for (const t of touched) if (merged.nodes.some((n) => n.id === t)) this.engine.resetWithAncestors(merged, t);
      if (researched) merged.nodes[merged.nodes.findIndex((n) => n.id === nodeId)] = structuredClone(project.nodes.find((n) => n.id === nodeId));
      const pieces = [...new Set([...touched, ...merged.nodes.filter((n) => n.status === 'pending' && !beforePending.has(n.id)).map((n) => n.id)])];
      await this.engine.store.save({ ...merged, chats: current.chats, log: current.log, improve: current.improve }, { reason: `loop: trial applied on ${nodeId}: ${String(change).slice(0, 160)}`, userAction: removed.length ? 'loop' : null });
      const outageOf = (run) => run.nodes.find((n) => n.status === 'failed' && QUOTA_ERROR.test(n.error ?? ''));
      const rejectOutage = async (outage) => {
        const result = await reject('provider-outage', `${outage.id}: ${String(outage.error).slice(0, 160)}; not counted against the change`);
        await this.sleep(Math.min(QUOTA_PAUSE_MS, Math.max(0, state.deadline - this.now())));
        return result;
      };
      const after = await this.engine.run(id, { memo: false, pieces, reuse: true, pages });
      if (this.stopped(state) || after.phase === 'cancelled') return await reject('reverted-stopped');
      if (outageOf(after)) return await rejectOutage(outageOf(after));
      const broken = regressions(before, after);
      const gain = dataGain(before, after, before.brief ?? current.brief);
      if (broken.length) return await reject('reverted-regression', `breaks passing check(s): ${broken.join(', ')}`, best.score, gain);
      if (removed.length && !allChecksPass(before, after)) return await reject('reverted-regression', `removing ${base.removedPieceId} needs every regression check to pass`, best.score, gain);
      if (!removed.length && !newEvidence(before, after).length) return await reject('no-new-evidence', 'the trial cites no source URL the tree did not already have; a kept change has to bring new evidence');
      const measure = state.measure ?? projectScore;
      const score = measure(after);
      const minGain = removed.length ? REMOVAL_MIN_GAIN : MIN_GAIN;
      if (score.score - best.score > minGain) {
        const fresh = await this.engine.load(id);
        for (const t of touched) if (fresh.nodes.some((n) => n.id === t)) this.engine.resetWithAncestors(fresh, t);
        await this.engine.store.save(fresh, { reason: `loop: second measurement of the trial on ${nodeId}` });
        const second = await this.engine.run(id, { memo: false, pieces, reuse: true });
        if (this.stopped(state) || second.phase === 'cancelled') return await reject('reverted-stopped');
        if (outageOf(second)) return await rejectOutage(outageOf(second));
        const brokenAgain = regressions(before, second);
        if (brokenAgain.length) return await reject('reverted-regression', `breaks passing check(s) when researched again: ${brokenAgain.join(', ')}`);
        const again = measure(second);
        const remeasureNoise = [...(current.improve?.remeasureNoise ?? []), round(again.score - score.score)].slice(-NOISE_SAMPLES);
        await this.record(id, { remeasureNoise });
        const verdict = trialVerdict(best.score, Math.min(score.score, again.score), removed, remeasureNoise);
        if (!verdict.ok) return await reject('reverted-noise', `measured ${score.score}, re-measured ${again.score} after researching the same pieces again; ${verdict.reason}`, Math.min(score.score, again.score), gain);
        const kept = again;
        for (const piece of scoredPieces(after, state.scope ?? [], state.exclude ?? [])) state.pieces?.add(piece);
        state.best = kept;
        await this.record(id, { best: kept.score }, { ...base, before: best.score, change, outcome: 'kept', score: kept.score, remeasured: again.score });
        await this.engine.resynthesize(id, { pages });
        return { kept: true, score: kept };
      }
      return await reject('reverted-whole', '', score.score, gain);
    } catch (error) {
      return await reject('error', error.message.slice(0, 200));
    } finally {
      state.before = null;
    }
  }
}
