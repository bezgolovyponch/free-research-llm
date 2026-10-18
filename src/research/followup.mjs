const MAX_QUERY_WORDS = 12;
const MAX_FOLLOW_UPS = 3;

function asQuery(text) {
  return String(text ?? '')
    .replace(/[^\p{L}\p{N}%€$.,\-\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_QUERY_WORDS)
    .join(' ')
    .replace(/[.,\-]+$/, '');
}

export function followUpQueries(node, finding, alreadyAsked = []) {
  const asked = new Set(alreadyAsked.map((q) => q.toLowerCase()));
  const candidates = [...(finding?.gaps ?? []), node.metric && `${node.metric} ${node.title}`].map(asQuery);
  return [...new Set(candidates.filter((q) => q.length > 8 && !asked.has(q.toLowerCase())))].slice(0, MAX_FOLLOW_UPS);
}

export function mergeSources(existing, found) {
  const web = existing.filter((s) => s.kind !== 'data');
  const data = existing.filter((s) => s.kind === 'data');
  const highest = Math.max(0, ...existing.map((s) => Number(String(s.id).match(/^S(\d+)$/)?.[1] ?? 0)));
  const added = found.map((s, i) => ({ ...s, id: `S${highest + i + 1}` }));
  return { sources: [...web, ...added, ...data], added };
}
