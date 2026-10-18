import fs from 'node:fs/promises';
import path from 'node:path';

const GOOD = new Set(['verified', 'supported']);
const MAX_ITEMS = 12;

function pct(value) {
  return value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`;
}

export function handoffRecord(project, { reason, resume = {} } = {}) {
  const nodes = project.nodes ?? [];
  const trials = project.improve?.trials ?? [];
  const weak = nodes.filter((n) => !GOOD.has(n.status)).map((n) => ({
    id: n.id,
    title: n.title,
    status: n.status,
    failures: (n.verification?.failures ?? (n.error ? [n.error] : [])).slice(0, 3),
    gaps: (n.finding?.gaps ?? []).slice(0, 3),
  }));
  const tried = {};
  for (const t of trials) (tried[t.nodeId] ??= []).push(`${t.outcome}: ${t.change}`);
  return {
    projectId: project.id,
    question: project.question,
    expected: project.acceptance?.expected ?? '',
    reason,
    at: new Date().toISOString(),
    phase: project.phase,
    verdict: project.report?.verdict ?? null,
    progress: { total: nodes.length, passing: nodes.filter((n) => GOOD.has(n.status)).length, pending: nodes.filter((n) => n.status === 'pending').length },
    expectedResult: project.acceptanceResult ? { score: project.acceptanceResult.score, checks: project.acceptanceResult.checks.map((c) => `${c.label}: ${pct(c.value)}`) } : null,
    loop: project.improve ? { baseline: project.improve.baseline ?? null, best: project.improve.best ?? null, trials: trials.length, kept: trials.filter((t) => t.outcome === 'kept').length } : null,
    insights: [
      ...nodes.filter((n) => GOOD.has(n.status) && n.finding?.answer).slice(0, MAX_ITEMS).map((n) => `${n.id} [${n.status}] ${n.finding.answer}`),
    ],
    fixesKept: trials.filter((t) => t.outcome === 'kept').map((t) => `${t.nodeId}: ${t.change} (${t.before} → ${t.score})`),
    fixesTried: Object.entries(tried).map(([nodeId, list]) => ({ nodeId, attempts: list.length, last: list.slice(-3) })),
    deliverables: (project.acceptanceResult?.items ?? []).filter((i) => i.live).slice(0, MAX_ITEMS).map((i) => ({ title: i.title, url: i.url, inRange: i.inRange })),
    weak,
    nextSteps: [
      ...weak.filter((w) => w.status !== 'pending').slice(0, 5).map((w) => `Fix ${w.id} (${w.status}): ${w.failures[0] ?? w.gaps[0] ?? 'no evidence yet'}`),
      ...(project.report?.openQuestions ?? []).slice(0, 3),
      ...(weak.some((w) => w.status === 'pending') ? ['Press Run (or start the loop): some pieces are not researched yet'] : []),
    ],
    resume,
  };
}

export function handoffMarkdown(r) {
  const list = (items) => (items.length ? items.map((x) => `- ${x}`).join('\n') : '- none');
  return `# Handoff: ${r.question}

Saved ${r.at} · reason: **${r.reason}** · phase: ${r.phase}
Expected result: ${r.expected || 'not set'}${r.expectedResult ? ` · met ${pct(r.expectedResult.score)}` : ''}
Verdict: ${r.verdict ?? 'none yet'}
Progress: ${r.progress.passing}/${r.progress.total} pieces pass the checks, ${r.progress.pending} not researched
${r.loop ? `Loop: score ${r.loop.baseline} → ${r.loop.best}, ${r.loop.kept} of ${r.loop.trials} changes kept\n` : ''}
## Expected-result checks
${list(r.expectedResult?.checks ?? [])}

## Delivered (live links)
${list(r.deliverables.map((d) => `${d.title || d.url} — ${d.url}${d.inRange ? ' (in range)' : ''}`))}

## Insights (pieces that pass the checks)
${list(r.insights)}

## Fixes kept by the loop
${list(r.fixesKept)}

## Fixes tried per piece
${list(r.fixesTried.map((f) => `${f.nodeId}: ${f.attempts} tries — last: ${f.last.join(' | ')}`))}

## Still weak, and why
${list(r.weak.map((w) => `${w.id} [${w.status}] ${w.title}: ${[...w.failures, ...w.gaps].join('; ') || 'not researched yet'}`))}

## Next steps
${list(r.nextSteps)}

## Resume
${r.resume.loopHoursLeft ? `The self-improving loop had ${r.resume.loopHoursLeft.toFixed(1)} h left; the app restarts it automatically on its next start.` : r.resume.wasRunning ? 'A research run was interrupted; the app resumes it automatically on its next start (finished pieces are kept).' : 'Nothing was interrupted. Open the research and press Run or start the loop to continue.'}
`;
}

export class HandoffWriter {
  constructor({ dir }) {
    this.dir = dir;
  }

  async write(project, options) {
    const record = handoffRecord(project, options);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, `${project.id}.json`), JSON.stringify(record, null, 2));
    await fs.writeFile(path.join(this.dir, `${project.id}.md`), handoffMarkdown(record));
    return record;
  }

  async read(id) {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  async markdown(id) {
    try {
      return await fs.readFile(path.join(this.dir, `${id}.md`), 'utf8');
    } catch {
      return null;
    }
  }

  async resumable() {
    const files = await fs.readdir(this.dir).catch(() => []);
    const records = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => this.read(f.slice(0, -5))));
    return records.filter((r) => r && (r.resume?.loopHoursLeft > 0.05 || r.resume?.wasRunning));
  }

  async clearResume(id) {
    const record = await this.read(id);
    if (!record?.resume || (!record.resume.loopHoursLeft && !record.resume.wasRunning)) return;
    record.resume = { resumedAt: new Date().toISOString() };
    await fs.writeFile(path.join(this.dir, `${id}.json`), JSON.stringify(record, null, 2));
  }
}
