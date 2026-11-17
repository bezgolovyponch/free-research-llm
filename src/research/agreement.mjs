export const LABELS = ['yes', 'no', 'not stated'];
export const NOT_STATED = 'not stated';
export const MIN_KAPPA_ITEMS = 30;
export const BOOTSTRAP_RESAMPLES = 2000;
export const INTERVAL_LEVEL = 0.95;
export const WILSON_Z = 1.959964;

const SAME_AS_NOT_STATED = new Set(['unknown', 'not stated', 'not-stated', 'notstated']);

export function labelOf(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (SAME_AS_NOT_STATED.has(text)) return NOT_STATED;
  return LABELS.includes(text) ? text : null;
}

export function confusion(pairs, labels = LABELS) {
  const at = new Map(labels.map((label, index) => [label, index]));
  const matrix = labels.map(() => labels.map(() => 0));
  let n = 0;
  for (const pair of pairs ?? []) {
    if (!at.has(pair.reference) || !at.has(pair.answer)) continue;
    matrix[at.get(pair.reference)][at.get(pair.answer)] += 1;
    n += 1;
  }
  return { labels: [...labels], matrix, n };
}

export function cohenKappa(pairs, labels = LABELS) {
  const { matrix, n } = confusion(pairs, labels);
  if (!n) return { kappa: null, n: 0, observed: null, expected: null };
  const rows = matrix.map((row) => row.reduce((sum, count) => sum + count, 0));
  const columns = labels.map((_, index) => matrix.reduce((sum, row) => sum + row[index], 0));
  const observed = labels.reduce((sum, _, index) => sum + matrix[index][index], 0) / n;
  const expected = labels.reduce((sum, _, index) => sum + (rows[index] * columns[index]) / (n * n), 0);
  return { kappa: expected >= 1 ? null : (observed - expected) / (1 - expected), n, observed, expected };
}

export function wilson(part, total, z = WILSON_Z) {
  if (!total) return { low: null, high: null };
  const p = part / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  const scale = 1 + (z * z) / total;
  return { low: Math.max(0, (centre - margin) / scale), high: Math.min(1, (centre + margin) / scale) };
}

export function rateOf(part, total) {
  return { part, total, rate: total ? part / total : null, ...wilson(part, total) };
}

export function wrongNo(pairs) {
  const open = (pairs ?? []).filter((pair) => pair.reference === 'yes' || pair.reference === NOT_STATED);
  return rateOf(open.filter((pair) => pair.answer === 'no').length, open.length);
}

export function unknownRate(pairs) {
  const list = pairs ?? [];
  return rateOf(list.filter((pair) => pair.answer === NOT_STATED).length, list.length);
}

export function accuracy(pairs) {
  const list = pairs ?? [];
  return rateOf(list.filter((pair) => pair.answer === pair.reference).length, list.length);
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pairRuns(a, b, { keyOf = (entry) => entry.id, clusterOf = (entry) => entry.research ?? '', scoreOf = (entry) => entry.value } = {}) {
  const second = new Map((b ?? []).map((entry) => [keyOf(entry), entry]));
  const seen = new Set();
  const pairs = [];
  for (const entry of a ?? []) {
    const key = keyOf(entry);
    if (seen.has(key) || !second.has(key)) continue;
    seen.add(key);
    const x = scoreOf(entry);
    const y = scoreOf(second.get(key));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pairs.push({ key, cluster: clusterOf(entry), a: x, b: y });
  }
  return pairs;
}

export function bootstrapDifference(pairs, { resamples = BOOTSTRAP_RESAMPLES, seed = 1, level = INTERVAL_LEVEL } = {}) {
  const list = pairs ?? [];
  if (!list.length) return { difference: null, low: null, high: null, n: 0, clusters: 0, resamples: 0 };
  const groups = new Map();
  for (const pair of list) groups.set(pair.cluster, [...(groups.get(pair.cluster) ?? []), pair.b - pair.a]);
  const clusters = [...groups.values()].map((values) => ({ sum: values.reduce((sum, value) => sum + value, 0), count: values.length }));
  const difference = clusters.reduce((sum, cluster) => sum + cluster.sum, 0) / list.length;
  const random = mulberry32(seed);
  const draws = [];
  for (let round = 0; round < resamples; round++) {
    let sum = 0;
    let count = 0;
    for (let pick = 0; pick < clusters.length; pick++) {
      const cluster = clusters[Math.floor(random() * clusters.length)];
      sum += cluster.sum;
      count += cluster.count;
    }
    draws.push(sum / count);
  }
  draws.sort((x, y) => x - y);
  const tail = (1 - level) / 2;
  const at = (share) => draws[Math.min(draws.length - 1, Math.max(0, Math.round(share * (draws.length - 1))))];
  return { difference, low: at(tail), high: at(1 - tail), n: list.length, clusters: clusters.length, resamples };
}

export function excludesZero(interval) {
  return interval?.low !== null && interval?.high !== null && interval !== undefined && (interval.low > 0 || interval.high < 0);
}

export function spreadOf(values) {
  const list = (values ?? []).filter((value) => Number.isFinite(value));
  if (!list.length) return { n: 0, mean: null, min: null, max: null, sd: null };
  const mean = list.reduce((sum, value) => sum + value, 0) / list.length;
  const sd = list.length > 1 ? Math.sqrt(list.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (list.length - 1)) : 0;
  return { n: list.length, mean, min: Math.min(...list), max: Math.max(...list), sd };
}
