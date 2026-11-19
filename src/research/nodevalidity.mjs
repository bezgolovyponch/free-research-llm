import { METHODS } from './tree.mjs';
import { isEvidenceGap } from './verify.mjs';

const NON_ANSWER = /(?:not possible|impossible|unable|cannot|can't|could not|couldn't) (?:to )?(?:be )?(?:determine|determined|say|calculate|calculated|establish|established|find|found|identify|verify|confirm|provide|assess|assessed|estimate|estimated)|(?:insufficient|no|missing|lack of) (?:available )?(?:verifiable |reliable |relevant |concrete |specific |explicit )?(?:data|evidence|information|listings|sources|figures|counts)|no verifiable|(?:not|isn't) (?:available|provided|present|found|given|stated|mentioned|included|contained)(?: in| from| within| among)? (?:the )?(?:provided |available |given |retrieved )?(?:evidence|sources|data)|(?:evidence|sources|data) (?:does|do|did) not (?:contain|provide|include|mention|give|state|show)|there (?:is|are) no (?:available )?(?:evidence|data|information|figures)/i;

const SETTLED = new Set(['verified', 'supported', 'covered']);

function isLookupMethod(method) {
  return method === 'lookup' || method === 'data';
}

function hasSearchQueries(node) {
  return Array.isArray(node.searchQueries) && node.searchQueries.length > 0;
}

function hasSourceUrls(node) {
  return Array.isArray(node.sourceUrls) && node.sourceUrls.length > 0;
}

function hasInputs(node) {
  return node.dependsOn && node.dependsOn.length > 0;
}

function hasSourceWithUrl(node) {
  return Array.isArray(node.sources) && node.sources.some((s) => s.url && s.url.startsWith('http'));
}

function findNode(nodes, id) {
  return nodes.find((n) => n.id === id);
}

function hasDependsOn(nodes, node) {
  if (!node.dependsOn || !node.dependsOn.length) return true;
  return node.dependsOn.every((depId) => findNode(nodes, depId));
}

function noDataAnswer(finding, node) {
  if (!finding) return true;
  const answer = String(finding.answer ?? '').trim();
  if (!answer) return true;
  if (NON_ANSWER.test(answer)) return true;
  if (isEvidenceGap(answer)) return true;
  const claims = finding.claims ?? [];
  const hasGaps = Array.isArray(finding.gaps) && finding.gaps.length > 0;
  const hasSources = claims.some((c) => (c.sourceIds ?? []).length > 0);
  const hasAssumptions = claims.some((c) => c.assumption);
  const hasNodeSources = node && Array.isArray(node.sources) && node.sources.some((s) => s.url && s.url.startsWith('http'));
  if (!claims.length && !finding.items?.length && !finding.calculation && !hasGaps) return true;
  if (!hasSources && !hasNodeSources && !hasAssumptions && !hasGaps && claims.length) return true;
  return false;
}

function needsEvidence(node) {
  return isLookupMethod(node.method);
}

export function preconditions(node, project) {
  const failed = [];
  const methodsWithRole = METHODS.includes(node.method);
  if (!methodsWithRole) {
    failed.push({ check: 'role', reason: 'unknown method "' + node.method + '"' });
  }
  if (!hasSearchQueries(node) && !hasSourceUrls(node) && !hasInputs(node)) {
    failed.push({ check: 'inputs', reason: 'no searchQueries, no sourceUrls, no dependsOn inputs' });
  }
  if (!hasDependsOn(project.nodes ?? [], node)) {
    failed.push({ check: 'dependsOn', reason: 'dependsOn references missing node(s)' });
  }
  return failed;
}

function allClaimsAreAssumptions(finding) {
  const claims = finding.claims ?? [];
  if (!claims.length) return false;
  return claims.every((c) => c.assumption);
}

export function effect(node) {
  if (!node.finding) {
    return { broken: true, reason: 'no finding produced' };
  }
  if (noDataAnswer(node.finding, node)) {
    return { broken: true, reason: 'no-data answer (empty, "cannot determine", or claims without sources)' };
  }
  if (needsEvidence(node) && !hasSourceWithUrl(node) && !allClaimsAreAssumptions(node.finding)) {
    return { broken: true, reason: 'lookup/data method but no retrieved source with url' };
  }
  return { broken: false, reason: null };
}

function cosine(a, b) {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < Math.min(a?.length ?? 0, b?.length ?? 0); i++) {
    dot += a[i] * b[i];
    left += a[i] * a[i];
    right += b[i] * b[i];
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

async function embedTexts(texts, embedder) {
  if (!embedder) return null;
  const result = await embedder.embedAll(texts);
  if (!result) return null;
  return result.vectors;
}

function textForTrace(node) {
  return (node.title + ' ' + node.question).trim();
}

function getParentForTrace(project, parentId) {
  const parent = project.nodes?.find((n) => n.id === parentId);
  if (parent) return parent;
  if (parentId === 'Q' || parentId === 'ROOT') {
    return { title: '', question: project.question ?? '' };
  }
  return null;
}

export async function traceOk(node, before, project, embedder) {
  if (!before || !before.question) return { ok: true, reason: null };
  if (before.question === node.question) return { ok: true, reason: null };
  const parentId = node.parentId;
  const parent = getParentForTrace(project, parentId);
  if (!parent || !parent.question) return { ok: true, reason: null };
  const oldText = textForTrace({ ...node, question: before.question });
  const newText = textForTrace(node);
  const parentText = textForTrace(parent);
  if (!embedder) return { ok: true, reason: null };
  const vectors = await embedTexts([oldText, newText, parentText], embedder);
  if (!vectors || vectors.length < 3) return { ok: true, reason: null };
  const [oldVec, newVec, parentVec] = vectors;
  const simToOld = cosine(oldVec, newVec);
  const simToParent = cosine(newVec, parentVec);
  if (simToOld < 0.6) {
    return { ok: false, reason: 'question drift: similarity to previous question ' + (simToOld * 100).toFixed(0) + '% < 60%' };
  }
  if (simToParent < 0.4) {
    return { ok: false, reason: 'question no longer serves parent: similarity ' + (simToParent * 100).toFixed(0) + '% < 40%' };
  }
  return { ok: true, reason: null };
}