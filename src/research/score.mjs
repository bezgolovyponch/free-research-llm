const WEIGHT = { verified: 1, supported: 0.75, weak: 0.25, unsupported: 0, failed: 0, pending: 0, researching: 0 };

export function scoreProject(project) {
  const nodes = project?.nodes ?? [];
  const counts = { verified: 0, supported: 0, weak: 0, unsupported: 0, failed: 0, pending: 0 };
  for (const n of nodes) counts[n.status in counts ? n.status : 'pending']++;
  const base = nodes.length ? nodes.reduce((s, n) => s + (WEIGHT[n.status] ?? 0), 0) / nodes.length : 0;
  const verdict = String(project?.report?.verdict ?? '');
  const decisive = project?.report && !/INSUFFICIENT DATA/i.test(verdict) ? 0.1 : 0;
  const issues = nodes
    .filter((n) => !['verified', 'supported'].includes(n.status))
    .map((n) => ({ nodeId: n.id, title: n.title, question: n.question, grade: n.status, failures: n.verification?.failures ?? (n.error ? [n.error] : []), sources: (n.sources ?? []).length }));
  return { score: Math.round((base * 0.9 + decisive) * 1000) / 1000, counts, total: nodes.length, verdict, issues };
}
