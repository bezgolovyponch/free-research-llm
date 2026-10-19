import { templateById } from './research/templates.mjs';
import { ROOT_ID, childrenOf } from './research/tree.mjs';
import { actionPlan, resultStatus } from './research/gaps.mjs';

function bullets(items) {
  return items?.length ? items.map((i) => `- ${i}`).join('\n') : '- none';
}

function nodeSection(project, node, depth) {
  const f = node.finding;
  const lines = [`${'#'.repeat(Math.min(depth + 2, 6))} ${node.id} · ${node.title} — \`${node.status}\``, '', `**Question:** ${node.question}`, ''];
  if (f) {
    lines.push(`**Answer:** ${f.answer}`, '');
    if (f.calculation) lines.push(`**Calculation:** \`${f.calculation.formula}\` = ${f.calculation.recomputed ?? f.calculation.result} ${f.calculation.unit} (machine-recomputed)`, '');
    if (f.claims.length) {
      lines.push('| Claim | Sources | Assumption |', '|---|---|---|');
      for (const c of f.claims) lines.push(`| ${c.text.replace(/\|/g, '/')} | ${c.sourceIds.join(', ') || '—'} | ${c.assumption ? 'yes' : ''} |`);
      lines.push('');
    }
    if (f.gaps.length) lines.push(`**Gaps:** ${f.gaps.join('; ')}`, '');
  } else if (node.error) {
    lines.push(`**Error:** ${node.error}`, '');
  }
  if (node.verification?.checks?.length) lines.push(`**Checks:** ${node.verification.checks.map((c) => `${c.passed ? '✔' : '✘'} ${c.label}`).join(' · ')}`, '');
  const web = (node.sources ?? []).filter((s) => s.url);
  if (web.length) lines.push(...web.map((s) => `- [${s.id}] [${s.title}](${s.url})`), '');
  for (const child of childrenOf(project.nodes, node.id)) lines.push(nodeSection(project, child, depth + 1));
  return lines.join('\n');
}

export const ACTION_LABEL = { fix: 'Fix', research: 'Research further', clarify: 'Clarify' };

function cell(text) {
  return String(text ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

export function csvField(value) {
  const text = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csv(rows) {
  return `${rows.map((r) => r.map(csvField).join(',')).join('\r\n')}\r\n`;
}

function roleOf(project, node) {
  if (node.parentId === ROOT_ID) return 'driver';
  return childrenOf(project.nodes, node.id).length ? 'sub-driver' : 'sub-question';
}

export function piecesCsv(project) {
  const plan = new Map(actionPlan(project).map((a) => [a.nodeId, a]));
  const rows = [['piece', 'title', 'role', 'grade', 'answer', 'action', 'why', 'next step', 'priority', 'moves the verdict', 'sources', 'first source']];
  for (const n of project.nodes) {
    const a = plan.get(n.id);
    const web = (n.sources ?? []).filter((x) => x.url);
    rows.push([n.id, n.title, roleOf(project, n), n.status, n.finding?.answer ?? '', a ? ACTION_LABEL[a.action] : 'Done', a?.why ?? '', a?.next ?? '', a?.priority ?? '', a?.decisive ? 'yes' : '', web.length, web[0]?.url ?? '']);
  }
  return csv(rows);
}

export function itemsCsv(project) {
  const items = project.acceptanceResult?.items ?? project.report?.deliverables ?? [];
  return csv([['title', 'value', 'currency', 'url', 'piece', 'link live', 'in range'], ...items.map((i) => [i.title ?? '', i.value ?? '', i.currency ?? '', i.url ?? '', i.nodeId ?? '', i.live ?? i.alive ?? '', i.inRange ?? ''])]);
}

export function resultsJson(project) {
  const status = resultStatus(project);
  return {
    question: project.question,
    expected: project.acceptance?.expected ?? null,
    exportedAt: new Date().toISOString(),
    verdict: project.report?.verdict ?? null,
    bestEstimate: project.report?.bestEstimate ?? null,
    confidence: { model: project.report?.confidence ?? null, byChecks: status.confidence, coverage: status.coverage, provisional: status.provisional },
    expectedResult: project.acceptanceResult ? { score: project.acceptanceResult.score, checks: project.acceptanceResult.checks } : null,
    actions: status.plan,
    pieces: project.nodes.map((n) => ({ id: n.id, parentId: n.parentId, title: n.title, question: n.question, grade: n.status, answer: n.finding?.answer ?? null, claims: n.finding?.claims ?? [], gaps: n.finding?.gaps ?? [], sources: (n.sources ?? []).filter((x) => x.url).map((x) => ({ id: x.id, title: x.title, url: x.url })) })),
    items: project.acceptanceResult?.items ?? project.report?.deliverables ?? [],
    memo: project.report ? { summary: project.report.summary, keyNumbers: project.report.keyNumbers, scenarios: project.report.scenarios, sensitivity: project.report.sensitivity, risks: project.report.risks, nextSteps: project.report.nextSteps } : null,
  };
}

export function toMarkdown(project) {
  const r = project.report;
  const out = [`# ${project.question}`, '', `_Template: ${templateById(project.templateId).label} · phase: ${project.phase} · updated ${project.updatedAt ?? ''}_${project.demo ? ' · **DEMO MODE — scripted model, not real research**' : ''}`, ''];
  if (project.decision) out.push(`**Decision:** ${project.decision}`, '', `**Success criteria:** ${project.successCriteria || '—'}`, '');
  if (r) {
    out.push('## Verdict', '', `**${r.verdict}** (confidence: ${r.confidence})`, '', r.summary, '');
    if (r.keyNumbers.length) {
      out.push('## Key numbers', '', '| Metric | Value | Node |', '|---|---|---|');
      for (const k of r.keyNumbers) out.push(`| ${k.label} | ${k.value} ${k.unit ?? ''} | ${k.nodeId ?? ''} |`);
      out.push('');
    }
    if (r.scenarios.length) out.push('## Scenarios', '', ...r.scenarios.map((s) => `- **${s.name}:** ${s.outcome} _(assumes ${s.assumptions})_`), '');
    if (r.sensitivity.length) out.push('## What flips the decision', '', ...r.sensitivity.map((s) => `- **${s.variable}:** ${s.effect}`), '');
    out.push('## Risks', '', bullets(r.risks), '', '## Open questions', '', bullets(r.openQuestions), '');
    if (r.nextSteps.length) out.push('## Next steps', '', ...r.nextSteps.map((s, i) => `${i + 1}. **${s.step}** — ${s.why}${s.how ? ` _How:_ ${s.how}` : ''}`), '');
    out.push(`_Evidence quality: ${r.evidenceQuality.verified}/${r.evidenceQuality.total} nodes verified or supported; weak: ${r.evidenceQuality.weak.join(', ') || 'none'}._`, '');
  }
  const plan = actionPlan(project);
  if (r?.bestEstimate) out.splice(out.indexOf('## Verdict') + 4, 0, `**Best estimate:** ${r.bestEstimate.value} ${r.bestEstimate.unit}${r.bestEstimate.low || r.bestEstimate.high ? ` (range ${r.bestEstimate.low || '?'}–${r.bestEstimate.high || '?'})` : ''}${r.bestEstimate.basis ? ` · rests on ${r.bestEstimate.basis}` : ''}`, '');
  if (plan.length) {
    out.push('## What to fix, research further or clarify', '', '| Piece | Action | Why | Next step | Priority |', '|---|---|---|---|---|');
    for (const a of plan) out.push(`| ${a.nodeId} · ${cell(a.title)} | ${ACTION_LABEL[a.action]}${a.decisive ? ' (moves the verdict)' : ''} | ${cell(a.why)} | ${cell(a.next)} | ${a.priority} |`);
    out.push('');
  }
  if (project.assumptionsToConfirm?.length) out.push('## Assumptions to confirm', '', bullets(project.assumptionsToConfirm), '');
  out.push('## Research tree', '');
  for (const driver of childrenOf(project.nodes, ROOT_ID)) out.push(nodeSection(project, driver, 1));
  return out.join('\n');
}
