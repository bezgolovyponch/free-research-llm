import { ROOT_ID } from './tree.mjs';

const RANK = { verified: 3, supported: 2, weak: 1, unsupported: 0, failed: 0, pending: 0, researching: 0 };
export const MIN_GRADES = ['supported', 'verified'];
const MAX_SPECS = 12;

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeSpec(raw, { request = '', desired = '' } = {}) {
  const range = Array.isArray(raw?.valueRange) ? raw.valueRange.map(finite) : [];
  const count = finite(raw?.itemCount);
  return {
    request: text(request, 600),
    desired: text(desired, 600),
    mustMention: (Array.isArray(raw?.mustMention) ? raw.mustMention : []).map((m) => text(m, 60)).filter(Boolean).slice(0, 5),
    needsNumber: Boolean(raw?.needsNumber) || /\d|number|price|cost|rate|percent|%|median|average|how many|how much/i.test(desired),
    valueRange: range.length === 2 && range.every((v) => v !== null) ? [Math.min(...range), Math.max(...range)] : null,
    unit: text(raw?.unit, 20),
    itemCount: count && count > 0 ? Math.min(100, Math.round(count)) : null,
    minGrade: MIN_GRADES.includes(raw?.minGrade) ? raw.minGrade : 'supported',
  };
}

export function targetOf(project, nodeId) {
  if (nodeId === ROOT_ID) {
    const r = project.report;
    const drivers = project.nodes.filter((n) => n.parentId === ROOT_ID);
    const items = project.acceptanceResult?.items ?? [];
    return {
      text: [r?.verdict, r?.summary, ...(r?.keyNumbers ?? []).map((k) => `${k.label} ${k.value} ${k.unit ?? ''}`)].filter(Boolean).join(' '),
      values: [...(r?.keyNumbers ?? []).map((k) => finite(String(k.value).replace(/[^\d.-]/g, ''))), ...items.map((i) => finite(i.value))].filter((v) => v !== null),
      items,
      grade: drivers.length ? drivers.reduce((worst, n) => ((RANK[n.status] ?? 0) < (RANK[worst] ?? 0) ? n.status : worst), 'verified') : 'pending',
    };
  }
  const node = project.nodes.find((n) => n.id === nodeId);
  const f = node?.finding;
  return {
    text: [f?.answer, ...(f?.claims ?? []).map((c) => c.text)].filter(Boolean).join(' '),
    values: [...(f?.claims ?? []).map((c) => finite(c.value)), ...(f?.items ?? []).map((i) => finite(i.value)), finite(f?.calculation?.recomputed ?? f?.calculation?.result)].filter((v) => v !== null),
    items: f?.items ?? [],
    grade: node?.status ?? 'pending',
  };
}

export function evaluateSpec(spec, target) {
  const checks = [];
  const lower = target.text.toLowerCase();
  checks.push({ id: 'grade', label: `Grade at least ${spec.minGrade}`, passed: (RANK[target.grade] ?? 0) >= RANK[spec.minGrade], detail: `grade is ${target.grade}` });
  if (spec.needsNumber) checks.push({ id: 'number', label: 'Gives a number', passed: /\d/.test(target.text) || target.values.length > 0, detail: target.values.length ? `${target.values.length} value(s)` : 'no number in the answer' });
  if (spec.valueRange) {
    const [min, max] = spec.valueRange;
    const hits = target.values.filter((v) => v >= min && v <= max);
    checks.push({ id: 'range', label: `A value within ${min}–${max} ${spec.unit}`.trim(), passed: hits.length > 0, detail: hits.length ? `${hits.length} value(s) in range` : `values: ${target.values.slice(0, 5).join(', ') || 'none'}` });
  }
  if (spec.itemCount) checks.push({ id: 'items', label: `At least ${spec.itemCount} item(s) with links`, passed: target.items.length >= spec.itemCount, detail: `${target.items.length} item(s)` });
  for (const word of spec.mustMention) checks.push({ id: `mention:${word}`, label: `Mentions "${word}"`, passed: lower.includes(word.toLowerCase()), detail: lower.includes(word.toLowerCase()) ? 'found' : 'missing' });
  return { passed: checks.every((c) => c.passed), checks };
}

export function addSpec(project, nodeId, spec) {
  const holder = nodeId === ROOT_ID ? project : project.nodes.find((n) => n.id === nodeId);
  if (!holder) return null;
  const list = holder.specs ?? [];
  let n = list.length + 1;
  while (list.some((s) => s.id === `R${n}`)) n++;
  const record = { id: `R${n}`, ...spec, createdAt: new Date().toISOString(), everPassed: false, last: null };
  holder.specs = [...list, record].slice(-MAX_SPECS);
  return record;
}

export function specHolders(project) {
  return [[ROOT_ID, project], ...project.nodes.map((n) => [n.id, n])].filter(([, h]) => (h.specs ?? []).length);
}

export function evaluateAll(project) {
  const results = [];
  for (const [nodeId, holder] of specHolders(project)) {
    const target = targetOf(project, nodeId);
    for (const spec of holder.specs) {
      const result = evaluateSpec(spec, target);
      const regressed = spec.everPassed && !result.passed;
      spec.last = { passed: result.passed, checks: result.checks, at: new Date().toISOString(), regressed };
      if (result.passed) spec.everPassed = true;
      results.push({ nodeId, specId: spec.id, passed: result.passed, regressed });
    }
  }
  return results;
}

export function passingSpecs(project) {
  const passing = new Set();
  for (const [nodeId, holder] of specHolders(project)) {
    const target = targetOf(project, nodeId);
    for (const spec of holder.specs) if (evaluateSpec(spec, target).passed) passing.add(`${nodeId}/${spec.id}`);
  }
  return passing;
}

export function regressions(before, after) {
  const now = passingSpecs(after);
  return [...passingSpecs(before)].filter((key) => !now.has(key));
}
