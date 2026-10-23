const DEFINITION = ['parentId', 'title', 'question', 'searchQueries', 'sourceUrls', 'method', 'instructions', 'dependsOn', 'attachments'];

function definitionOf(node) {
  return JSON.stringify(DEFINITION.map((key) => node?.[key] ?? null));
}

function byId(project) {
  return new Map(project.nodes.map((n) => [n.id, n]));
}

export function removedBy(snapshot, trial) {
  const next = byId(trial);
  return snapshot.nodes.map((n) => n.id).filter((id) => !next.has(id));
}

export function trialConflict(snapshot, current, trial, touched) {
  const before = byId(snapshot);
  const now = byId(current);
  for (const node of trial.nodes) {
    if (!before.has(node.id) && now.has(node.id)) return `${node.id} was added by another change meanwhile`;
    if (!before.has(node.id) && node.parentId && node.parentId !== 'Q' && !now.has(node.parentId)) return `${node.parentId} was removed meanwhile`;
  }
  for (const id of [...new Set([...touched, ...removedBy(snapshot, trial)])]) {
    if (!before.has(id)) continue;
    if (!now.has(id)) return `${id} was removed meanwhile`;
    if (definitionOf(now.get(id)) !== definitionOf(before.get(id))) return `${id} was changed meanwhile`;
  }
  return null;
}

export function mergeTrial(current, snapshot, trial, touched) {
  const removed = new Set(removedBy(snapshot, trial));
  const next = byId(trial);
  const merged = structuredClone(current);
  merged.nodes = merged.nodes.filter((n) => !removed.has(n.id));
  for (const id of touched) {
    const node = next.get(id);
    if (!node) continue;
    const index = merged.nodes.findIndex((n) => n.id === id);
    if (index >= 0) merged.nodes[index] = structuredClone(node);
    else merged.nodes.push(structuredClone(node));
  }
  const present = new Set(merged.nodes.map((n) => n.id));
  for (const n of merged.nodes) n.dependsOn = (n.dependsOn ?? []).filter((d) => present.has(d));
  return merged;
}
