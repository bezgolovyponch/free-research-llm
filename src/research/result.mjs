import { createHash } from 'node:crypto';
import { isEvidenceGap } from './verify.mjs';
import { ROOT_ID } from './tree.mjs';

export const GRADE_PROBABILITY = { verified: 0.9, supported: 0.75, weak: 0.4, unsupported: 0.15 };
export const EXTREMIZE = 1.5;
const NO_INFO = 0.5;
const CLAMP = 0.02;

const clamp = (p) => Math.min(1 - CLAMP, Math.max(CLAMP, p));
const logit = (p) => Math.log(clamp(p) / (1 - clamp(p)));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const round = (x) => Math.round(x * 100) / 100;

export function aggregate(items, a = EXTREMIZE) {
  const known = items.filter((i) => Number.isFinite(i.p));
  const total = known.reduce((s, i) => s + (i.weight ?? 1), 0);
  if (!total) return NO_INFO;
  if (known.length === 1) return clamp(known[0].p);
  return sigmoid((a * known.reduce((s, i) => s + (i.weight ?? 1) * logit(i.p), 0)) / total);
}

export function effectiveGrade(node) {
  if (['verified', 'supported'].includes(node.status) && isEvidenceGap(node.finding?.answer)) return 'weak';
  return node.status;
}

export function nodeProbabilities(nodes) {
  const kids = new Map();
  for (const n of nodes) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  const memo = new Map();
  const of = (node) => {
    if (memo.has(node.id)) return memo.get(node.id);
    const own = GRADE_PROBABILITY[effectiveGrade(node)];
    const children = kids.get(node.id) ?? [];
    const p = children.length ? aggregate([...children.map((c) => ({ p: of(c), weight: c.impact ?? 3 })), ...(own === undefined ? [] : [{ p: own, weight: 1 }])], 1) : own ?? NO_INFO;
    memo.set(node.id, p);
    return p;
  };
  for (const n of nodes) of(n);
  return memo;
}

const KINDS = [
  ['plan', /\b(action plan|plan of actions|plan|actions?|strategy|strategies|roadmap|how (?:can|could|should|to|do)|steps to|improve|increase|grow|raise|boost|reduce)\b/i],
  ['estimate', /\b(how (?:much|many)|market size|size of|tam|sam|price|cost|forecast|estimate|value of)\b/i],
  ['list', /\b(which|find|list|shortlist|candidates?|items?|options available)\b/i],
];

export function questionKind(project) {
  const text = `${project.question ?? ''} ${project.decision ?? ''}`;
  return KINDS.find(([, re]) => re.test(text))?.[0] ?? 'decision';
}

export function nodeIdsIn(value) {
  return [...new Set(JSON.stringify(value ?? '').match(/\bD\d+(?:\.\d+)*\b/g) ?? [])];
}

export function basisOf(nodes) {
  return Object.fromEntries(nodes.map((n) => [n.id, createHash('sha1').update(`${n.status}|${n.finding?.answer ?? ''}`).digest('hex').slice(0, 10)]));
}

export function changedSince(report, nodes) {
  if (!report?.basis) return [];
  const now = basisOf(nodes);
  return [...new Set([...Object.keys(now), ...Object.keys(report.basis)])].filter((id) => now[id] !== report.basis[id]).sort();
}

export function sanitizeVerdict(text) {
  return String(text ?? '').replace(/<([^<>]{1,200})>/g, '$1').replace(/\s+/g, ' ').trim();
}

function supportOf(ids, probs, fallback) {
  const known = ids.filter((id) => probs.has(id));
  return known.length ? aggregate(known.map((id) => ({ p: probs.get(id) }))) : fallback;
}

export function resultModel(project) {
  const nodes = project.nodes ?? [];
  const probs = nodeProbabilities(nodes);
  const drivers = nodes.filter((n) => n.parentId === ROOT_ID).map((d) => ({ id: d.id, title: d.title, grade: effectiveGrade(d), probability: round(probs.get(d.id) ?? NO_INFO), weight: d.impact ?? 3 }));
  const overall = round(aggregate(drivers.map((d) => ({ p: d.probability, weight: d.weight }))));
  const regraded = nodes.filter((n) => effectiveGrade(n) !== n.status).map((n) => n.id);
  const report = project.report ?? null;
  const kind = questionKind(project);
  const base = { kind, probability: overall, drivers, regraded, memoAt: report?.generatedAt ?? null, changedSince: changedSince(report, nodes) };
  if (kind === 'plan') {
    const raw = report?.actionItems?.length ? report.actionItems : (report?.nextSteps ?? []).map((s) => ({ action: s.step, why: s.why, nodeIds: nodeIdsIn(s), impact: 3 }));
    const actions = raw.map((a) => {
      const ids = (a.nodeIds?.length ? a.nodeIds : nodeIdsIn(a)).filter((id) => probs.has(id));
      const p = round(supportOf(ids, probs, overall));
      const impact = Math.min(5, Math.max(1, Number(a.impact) || 3));
      return { action: String(a.action ?? '').slice(0, 300), why: String(a.why ?? '').slice(0, 300), horizon: String(a.horizon ?? '').slice(0, 60), nodeIds: ids, impact, probability: p, expected: round((p * impact) / 5) };
    }).filter((a) => a.action).sort((x, y) => y.expected - x.expected || y.probability - x.probability);
    return { ...base, actions };
  }
  if (kind === 'decision' && report?.options?.length) {
    const options = report.options.map((o) => {
      const support = (o.support ?? []).filter((id) => probs.has(id));
      const against = (o.against ?? []).filter((id) => probs.has(id));
      const score = support.reduce((s, id) => s + logit(probs.get(id)), 0) - against.reduce((s, id) => s + logit(probs.get(id)), 0);
      return { option: String(o.option ?? '').slice(0, 160), support, against, score };
    });
    const z = options.map((o) => Math.exp(o.score / Math.max(1, options.length)));
    const sum = z.reduce((a, b) => a + b, 0) || 1;
    return { ...base, options: options.map((o, i) => ({ option: o.option, support: o.support, against: o.against, probability: round(z[i] / sum) })).sort((a, b) => b.probability - a.probability) };
  }
  return { ...base, estimate: report?.bestEstimate ? { ...report.bestEstimate, probability: round(supportOf(nodeIdsIn(report.bestEstimate.basis), probs, overall)) } : null };
}
