const KIND_BY_STATUS = { verified: 'fact', supported: 'claim', weak: 'hypothesis', unsupported: 'hypothesis', failed: 'hypothesis' };

function evidenceOf(node) {
  const cited = new Set((node.finding?.claims ?? []).flatMap((c) => c.sourceIds ?? []));
  return (node.sources ?? []).filter((s) => cited.has(s.id)).map((s) => ({ id: s.id, title: s.title, url: s.url || null, kind: s.kind }));
}

export function knowledgeRecord(project) {
  const entries = project.nodes
    .filter((n) => n.finding && KIND_BY_STATUS[n.status])
    .map((n) => ({
      kind: KIND_BY_STATUS[n.status],
      nodeId: n.id,
      question: n.question,
      statement: n.finding.answer,
      grade: n.status,
      checks: (n.verification?.checks ?? []).map((c) => ({ id: c.id, passed: c.passed })),
      evidence: evidenceOf(n),
      assumptions: n.finding.assumptions ?? [],
      model: n.model ?? null,
    }));
  return {
    projectId: project.id,
    question: project.question,
    expected: project.acceptance?.expected ?? '',
    generatedAt: new Date().toISOString(),
    verdict: project.report?.verdict ?? null,
    expectedResultScore: project.acceptanceResult?.score ?? null,
    facts: entries.filter((e) => e.kind === 'fact'),
    claims: entries.filter((e) => e.kind === 'claim'),
    hypotheses: entries.filter((e) => e.kind === 'hypothesis'),
  };
}
