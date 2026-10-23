export const MAX_THREAD = 100;
const GOOD = new Set(['verified', 'supported']);

export function appendAppMessage(project, content, key = 'Q') {
  const thread = project.chats?.[key] ?? [];
  project.chats = { ...(project.chats ?? {}), [key]: [...thread, { role: 'app', content, at: new Date().toISOString() }].slice(-MAX_THREAD) };
  return project;
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

export function runSummary(project) {
  const nodes = project.nodes ?? [];
  const good = nodes.filter((n) => GOOD.has(n.status)).length;
  const weak = nodes.filter((n) => !GOOD.has(n.status)).map((n) => n.id);
  const engines = {};
  for (const n of nodes) for (const s of n.sources ?? []) if (s.provider) engines[s.provider] = (engines[s.provider] ?? 0) + 1;
  const lines = [
    `Research finished. Verdict: ${project.report?.verdict || 'none'}`,
    `Nodes passing the checks: ${good}/${nodes.length}${weak.length ? ` · still weak: ${weak.slice(0, 8).join(', ')}${weak.length > 8 ? '…' : ''}` : ''}`,
    `Sources by search engine: ${Object.entries(engines).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
  ];
  const ar = project.acceptanceResult;
  if (ar) {
    lines.push(`Expected result met: ${percent(ar.score)} — ${ar.checks.map((c) => `${c.label} ${percent(c.value)}`).join(' · ')}`);
    const live = ar.items.filter((i) => i.live).slice(0, 10);
    if (live.length) lines.push(`Working links:\n${live.map((i) => `- ${i.title || i.url} ${i.url}${i.inRange ? ' (price in range)' : ''}`).join('\n')}`);
  }
  return lines.join('\n');
}

export function loopSummary(improve, ended) {
  const trials = improve.trials ?? [];
  const kept = trials.filter((t) => t.outcome === 'kept');
  if (!ended) return `Self-improving loop started for ${Math.round(improve.hours * 10) / 10} h (until ${String(improve.deadline ?? '').slice(0, 16).replace('T', ' ')}). I will post here every change that raises the score.`;
  return `Self-improving loop ended (${improve.stopReason ?? improve.error ?? 'stopped'}). Score ${improve.baseline} → ${improve.best}; ${kept.length} of ${trials.length} changes kept.${kept.length ? `\nKept:\n${kept.slice(-10).map((t) => `- ${t.nodeId}: ${t.change} (${t.before} → ${t.score})`).join('\n')}` : ''}`;
}
