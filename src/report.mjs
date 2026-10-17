import { templateById } from './research/templates.mjs';
import { ROOT_ID, childrenOf } from './research/tree.mjs';

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
  if (project.assumptionsToConfirm?.length) out.push('## Assumptions to confirm', '', bullets(project.assumptionsToConfirm), '');
  out.push('## Research tree', '');
  for (const driver of childrenOf(project.nodes, ROOT_ID)) out.push(nodeSection(project, driver, 1));
  return out.join('\n');
}
