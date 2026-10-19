const WEIGHT = { verified: 1, supported: 0.75, weak: 0.25, unsupported: 0, failed: 0, pending: 0, researching: 0 };

export function gradeAverage(nodes, pieces = []) {
  const present = new Map(nodes.map((n) => [n.id, n]));
  const ids = new Set([...pieces, ...present.keys()]);
  return ids.size ? [...ids].reduce((s, id) => s + (WEIGHT[present.get(id)?.status] ?? 0), 0) / ids.size : 0;
}

export function scoreProject(project, pieces = []) {
  const nodes = project?.nodes ?? [];
  const counts = { verified: 0, supported: 0, weak: 0, unsupported: 0, failed: 0, pending: 0 };
  for (const n of nodes) counts[n.status in counts ? n.status : 'pending']++;
  const base = gradeAverage(nodes, pieces);
  const verdict = String(project?.report?.verdict ?? '');
  const decisive = !project?.report || /INSUFFICIENT DATA/i.test(verdict) ? 0 : /^PROVISIONAL/i.test(verdict) ? 0.05 : 0.1;
  const issues = nodes
    .filter((n) => !['verified', 'supported'].includes(n.status))
    .map((n) => ({ nodeId: n.id, title: n.title, question: n.question, grade: n.status, failures: n.verification?.failures ?? (n.error ? [n.error] : []), sources: (n.sources ?? []).length }));
  return { score: Math.round((base * 0.9 + decisive) * 1000) / 1000, counts, total: nodes.length, verdict, issues };
}
