import { ROOT_ID } from './tree.mjs';

export const SETTLED = new Set(['verified', 'supported']);
const OPEN = new Set(['pending', 'researching']);
const GRADE_GAP = { verified: 0, supported: 0.25, weak: 0.6, unsupported: 0.85, failed: 1, pending: 1, researching: 1 };
const FIX_CHECKS = new Set(['answer', 'citations', 'calculation']);
const RESEARCH_CHECKS = new Set(['concrete', 'numbers-sourced', 'critique']);
const NEEDS_USER = /\b(owner input|your|you|user'?s?|budget|preference|which (?:one|model|option)|depends on (?:the|your)|not specified|unspecified|define|definition|ambiguous|clarify|assum(?:e|ption)s? (?:about|on) (?:the )?(?:buyer|seller|owner|company|business))\b/i;

function failures(node) {
  return (node.verification?.checks ?? []).filter((c) => !c.passed);
}

function assumptionsOf(node) {
  return (node.finding?.claims ?? []).filter((c) => c.assumption).map((c) => c.text);
}

export function nodeAction(node) {
  if (SETTLED.has(node.status)) return null;
  const failed = failures(node);
  const ids = new Set(failed.map((c) => c.id));
  const gaps = node.finding?.gaps ?? [];
  const assumptions = assumptionsOf(node);
  const userText = [node.question, ...gaps, ...failed.map((c) => c.detail)].join(' ');
  let action;
  let why;
  let next;
  if (OPEN.has(node.status)) {
    action = 'research';
    why = 'not researched yet';
    next = 'Press ▶ Run at the top of the research. Pending pieces are researched first';
  } else if (node.status === 'failed' || node.error || [...ids].some((id) => FIX_CHECKS.has(id))) {
    action = 'fix';
    const broken = failed.filter((c) => FIX_CHECKS.has(c.id));
    why = node.error ? `run failed: ${node.error}` : broken.map((c) => `${c.label}: ${c.detail}`).join('; ') || 'a critical check failed';
    next = ids.has('calculation') ? `Press Re-research on this row (or open ${node.id} → ↻ Re-research): the formula did not recompute, so it is re-asked with the inputs and the formula step by step` : ids.has('citations') ? `Press Re-research on this row (or open ${node.id} → ↻ Re-research): the answer cited sources that were never retrieved` : `Press Re-research on this row. If it fails again, open ${node.id} → Split further`;
  } else if (NEEDS_USER.test(userText) || (assumptions.length && !ids.has('numbers-sourced'))) {
    action = 'clarify';
    why = assumptions.length ? `rests on assumptions: ${assumptions.slice(0, 3).join(' | ')}` : `needs an input only you can give: ${gaps[0] ?? node.question}`;
    next = `Press Clarify in chat: type the missing input as the request (e.g. your target margin) and the result you expect as the desired output, or attach your data with 📎`;
  } else {
    action = 'research';
    const soft = failed.filter((c) => RESEARCH_CHECKS.has(c.id));
    why = soft.map((c) => `${c.label}: ${c.detail}`).join('; ') || gaps.join('; ') || `graded ${node.status}`;
    next = gaps.length ? `Search for: ${gaps.slice(0, 3).join('; ')}. Press Re-research on this row; it uses these searches` : (node.sources ?? []).length < 2 ? `Open ${node.id} → Instructions & pages to read, paste the exact pages to read in the URL box (one per line), press Save, then ↻ Re-research` : `Press Re-research on this row. If it stays weak, open ${node.id} → Split further`;
  }
  const priority = Math.round(((node.impact ?? 3) * (node.uncertainty ?? 3) * (GRADE_GAP[node.status] ?? 1)) / 25 * 100) / 100;
  return { nodeId: node.id, title: node.title, status: node.status, action, why: why.slice(0, 400), next: next.slice(0, 300), priority, gaps: gaps.slice(0, 5), assumptions: assumptions.slice(0, 5) };
}

function citedInMemo(report) {
  const text = JSON.stringify([report?.keyNumbers ?? [], report?.sensitivity ?? [], report?.summary ?? '', report?.verdict ?? '']);
  return new Set(text.match(/\bD\d+(?:\.\d+)*\b/g) ?? []);
}

export function actionPlan(project) {
  const cited = citedInMemo(project.report);
  return project.nodes
    .map(nodeAction)
    .filter(Boolean)
    .map((a) => ({ ...a, decisive: cited.has(a.nodeId), priority: cited.has(a.nodeId) ? Math.min(1, Math.round(a.priority * 1.5 * 100) / 100) : a.priority }))
    .sort((a, b) => b.priority - a.priority || a.nodeId.localeCompare(b.nodeId, undefined, { numeric: true }));
}

export function resultStatus(project) {
  const nodes = project.nodes ?? [];
  const drivers = nodes.filter((n) => n.parentId === ROOT_ID);
  const settled = nodes.filter((n) => SETTLED.has(n.status)).length;
  const plan = actionPlan(project);
  const blocking = plan.filter((a) => a.decisive || drivers.some((d) => d.id === a.nodeId)).map((a) => a.nodeId);
  const coverage = nodes.length ? Math.round((settled / nodes.length) * 100) / 100 : 0;
  const confidence = coverage >= 0.85 && !blocking.length ? 'high' : coverage >= 0.6 ? 'medium' : 'low';
  return { provisional: plan.length > 0, coverage, confidence, blocking, counts: { fix: plan.filter((a) => a.action === 'fix').length, research: plan.filter((a) => a.action === 'research').length, clarify: plan.filter((a) => a.action === 'clarify').length }, plan };
}

export function provisionalVerdict(verdict, status) {
  const text = String(verdict ?? '').trim();
  const insufficient = /^INSUFFICIENT DATA\s*[—-]?\s*/i;
  if (!status.provisional) return text.replace(/^PROVISIONAL\s*[—:-]?\s*/i, '');
  const base = insufficient.test(text) ? `best current estimate — ${text.replace(insufficient, '') || 'see the action plan'}` : text.replace(/^PROVISIONAL\s*[—:-]?\s*/i, '');
  return `PROVISIONAL (${status.confidence} confidence; ${status.plan.length} piece${status.plan.length === 1 ? '' : 's'} to fix, research or clarify) — ${base}`;
}
