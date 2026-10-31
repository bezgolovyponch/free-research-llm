import { createHash } from 'node:crypto';
import { noiseFloor } from './improve.mjs';

export const GRADE_RANK = { verified: 3, supported: 2, weak: 1, unsupported: 0, failed: 0, pending: 0, researching: 0 };
export const SETTLED = new Set(['verified', 'supported']);
export const DRIFT_WARN = 0.25;
export const DRIFT_DOWNGRADE = 0.40;
export const KS_ALPHA = 0.05;
export const RESEARCH_NOISE_FLOOR = 0.05;
export const MAX_DRIFT_SAMPLES = 24;
export const MAX_VERSIONS = 20;
export const MAX_DRIFT_RESEARCHES = 2;

const NUMBER_RE = /(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])/g;
const VERSION_STAMP = /^[0-9a-f]{12}@/;

function round(value, digits = 4) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function numericSignature(node) {
  const out = [];
  const finding = node && node.finding ? node.finding : node;
  if (!finding) return out;
  for (const c of finding.claims ?? []) {
    if (typeof c.value === 'number') out.push(c.value);
    else out.push(...numbersIn(c.text));
  }
  if (finding.calculation && finding.calculation.result != null) out.push(...numbersIn(String(finding.calculation.result)));
  for (const i of finding.items ?? []) if (typeof i.value === 'number') out.push(i.value);
  return out;
}

export function numbersIn(text) {
  const out = [];
  if (!text) return out;
  NUMBER_RE.lastIndex = 0;
  let match;
  while ((match = NUMBER_RE.exec(text)) !== null) out.push(Number(match[1]));
  return out;
}

function quantile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const pos = p * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summaryStats(values) {
  const n = values.length;
  if (!n) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const mean = sum / n;
  const median = quantile(sorted, 0.5);
  const variance = n > 1 ? sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
  return {
    n,
    min: round(sorted[0]),
    max: round(sorted[n - 1]),
    mean: round(mean),
    median: round(median),
    variance: round(variance),
    q5: round(quantile(sorted, 0.05)),
    q25: round(quantile(sorted, 0.25)),
    q75: round(quantile(sorted, 0.75)),
    q95: round(quantile(sorted, 0.95)),
  };
}

export function ksTest(a, b) {
  const n1 = a.length;
  const n2 = b.length;
  if (!n1 || !n2) return { D: 0, p: 1, significant: false, n1, n2 };
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  let i = 0;
  let j = 0;
  let D = 0;
  while (i < n1 || j < n2) {
    const va = i < n1 ? sa[i] : Infinity;
    const vb = j < n2 ? sb[j] : Infinity;
    const x = Math.min(va, vb);
    while (i < n1 && sa[i] <= x) i++;
    while (j < n2 && sb[j] <= x) j++;
    const f1 = i / n1;
    const f2 = j / n2;
    D = Math.max(D, Math.abs(f1 - f2));
  }
  const nEff = (n1 * n2) / (n1 + n2);
  const lambda = D * Math.sqrt(nEff);
  const p = 2 * Math.exp(-2 * lambda * lambda);
  return { D: round(D), p: round(p), significant: p < KS_ALPHA, n1, n2 };
}

export function slidingWindows(samples, { windowSize = 7, step = 1 } = {}) {
  const windows = [];
  for (let start = 0; start + windowSize <= samples.length; start += step) {
    windows.push(samples.slice(start, start + windowSize));
  }
  return windows;
}

export function driftScore(baseline, current) {
  if (!baseline.length || !current.length) return 0;
  const a = summaryStats(baseline);
  const b = summaryStats(current);
  const ks = ksTest(baseline, current);
  const relMean = a.mean === 0 ? Math.abs(b.mean) : Math.abs(b.mean - a.mean) / Math.max(Math.abs(a.mean), 1e-9);
  const relMedian = a.median === 0 ? Math.abs(b.median) : Math.abs(b.median - a.median) / Math.max(Math.abs(a.median), 1e-9);
  const varRatio = a.variance === 0 ? (b.variance === 0 ? 0 : 1) : Math.abs(b.variance - a.variance) / Math.max(a.variance, 1e-9);
  const summary = clamp(0.5 * Math.min(1, relMean) + 0.3 * Math.min(1, relMedian) + 0.2 * Math.min(1, varRatio));
  return round(0.4 * summary + 0.6 * ks.D);
}

export function captureBaseline(node, { at = new Date().toISOString() } = {}) {
  const values = numericSignature(node);
  if (!values.length) return null;
  const baseline = { at, values, stats: summaryStats(values) };
  node.drift = { ...(node.drift ?? {}), baseline };
  return baseline;
}

export function recordSample(node, { at = new Date().toISOString(), values } = {}) {
  const sampleValues = values ?? numericSignature(node);
  if (!sampleValues.length) return null;
  const baseline = node.drift?.baseline;
  const stats = summaryStats(sampleValues);
  const test = baseline ? ksTest(baseline.values, sampleValues) : null;
  const score = baseline ? driftScore(baseline.values, sampleValues) : 0;
  const sample = { at, values: sampleValues, stats, test, score };
  node.drift = { ...(node.drift ?? {}), samples: [...(node.drift?.samples ?? []), sample].slice(-MAX_DRIFT_SAMPLES) };
  return sample;
}

export function driftCheck(node) {
  const drift = node.drift;
  if (!drift?.baseline || !drift?.samples?.length) return null;
  const latest = drift.samples[drift.samples.length - 1];
  const baseline = drift.baseline;
  const score = driftScore(baseline.values, latest.values);
  const test = ksTest(baseline.values, latest.values);
  const summary = [];
  if (test.significant) summary.push(`KS test significant (D=${test.D}, p=${test.p})`);
  if (score >= DRIFT_DOWNGRADE) summary.push(`drift score ${score} >= ${DRIFT_DOWNGRADE}`);
  else if (score >= DRIFT_WARN) summary.push(`drift score ${score} >= ${DRIFT_WARN} (warn)`);
  return {
    score,
    baselineAt: baseline.at,
    sampleAt: latest.at,
    baseline: baseline.stats,
    sample: latest.stats,
    test,
    summary: summary.join('; ') || `no significant shift (score ${score}, p ${test.p})`,
  };
}

export function lineageFor(node, { previous, at = new Date().toISOString() } = {}) {
  const finding = node && node.finding ? node.finding : node;
  if (!finding) return null;
  const basis = createHash('sha1').update(JSON.stringify({
    answer: finding.answer,
    claims: (finding.claims ?? []).map((c) => c.text),
    calculation: finding.calculation?.formula ?? '',
  })).digest('hex').slice(0, 12);
  const lineage = { id: `${node.id}@${at}`, ...(previous ? { parentId: previous.id } : {}), basis, capturedAt: at };
  finding.lineage = lineage;
  return lineage;
}

export function findingBasis(finding) {
  if (!finding) return null;
  return createHash('sha1').update(JSON.stringify({
    answer: finding.answer,
    claims: (finding.claims ?? []).map((c) => c.text),
    calculation: finding.calculation?.formula ?? '',
  })).digest('hex').slice(0, 12);
}

export function findingQuality(finding, verification) {
  const grade = (verification?.grade ?? finding?.grade ?? 'unsupported');
  const gradeScore = (GRADE_RANK[grade] ?? 0) / 3;
  const verifyScore = typeof verification?.score === 'number' ? verification.score / 100 : 0;
  return round(0.6 * verifyScore + 0.4 * gradeScore);
}

export function researchNoiseFloor(node) {
  const kept = (node.drift?.samples ?? []).filter((s) => s.championKept).map((s) => s.score);
  return noiseFloor(kept.length ? kept : []);
}

export function championChallenger(champion, challenger, { noiseFloor = RESEARCH_NOISE_FLOOR } = {}) {
  const before = findingQuality(champion.finding, champion.verification);
  const after = findingQuality(challenger.finding, challenger.verification);
  const gain = after - before;
  const accept = gain >= noiseFloor;
  return {
    accept,
    before: round(before),
    after: round(after),
    gain: round(gain),
    noiseFloor: round(noiseFloor),
    reason: accept
      ? `challenger measured ${round(after)} vs champion ${round(before)} (gain ${round(gain)} >= noise floor ${round(noiseFloor)})`
      : `challenger measured ${round(after)} vs champion ${round(before)} (gain ${round(gain)} below noise floor ${round(noiseFloor)}); champion kept`,
  };
}

export function regradeSettled(nodes, { isLeaf, isSettled, now = Date.now, downgradeTo = 'weak' } = {}) {
  const changed = [];
  for (const node of nodes) {
    if (!isLeaf(nodes, node)) continue;
    if (!isSettled(node)) continue;
    const drift = driftCheck(node);
    if (!drift || drift.score < DRIFT_DOWNGRADE) continue;
    if ((node.driftResearches ?? 0) >= MAX_DRIFT_RESEARCHES) continue;
    node.driftResearches = (node.driftResearches ?? 0) + 1;
    node.status = downgradeTo;
    node.verification = { ...(node.verification ?? {}), grade: downgradeTo, drift };
    changed.push({ nodeId: node.id, drift: drift.score, reason: drift.summary, at: new Date(now()).toISOString() });
  }
  return changed;
}
