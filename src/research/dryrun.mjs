import { compactProject } from './compact.mjs';
import { repairTree } from './treeaudit.mjs';

function snapshot(project) {
  return new Map(project.nodes.map((n) => [n.id, { parentId: n.parentId, title: n.title, status: n.status, items: (n.finding?.items ?? []).map((i) => i.url) }]));
}

export async function previewMaintenance(engine, original) {
  const project = structuredClone(original);
  const before = snapshot(project);
  const compacted = compactProject(project);
  const repairs = repairTree(project.nodes, project.question);
  const regrounded = engine.reground(project);
  const rescreened = await engine.rescreenItems(project);
  const harvested = await engine.harvestAll(project);
  const regraded = engine.regrade(project);
  const after = snapshot(project);
  const changes = { moved: [], retitled: [], regraded: [], removedItems: [] };
  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was) continue;
    if (was.parentId !== now.parentId) changes.moved.push(`${id}: ${was.parentId} → ${now.parentId}`);
    if (was.title !== now.title) changes.retitled.push(`${id}: "${was.title}" → "${now.title}"`);
    if (was.status !== now.status) changes.regraded.push(`${id}: ${was.status} → ${now.status}`);
    const gone = was.items.filter((u) => !now.items.includes(u));
    if (gone.length) {
      const node = project.nodes.find((n) => n.id === id);
      for (const url of gone) changes.removedItems.push(`${id}: ${url} (${(node.finding.rejected ?? []).find((r) => r.url === url)?.reasons.join('; ') ?? 'removed'})`);
    }
  }
  const kept = project.nodes.flatMap((n) => n.finding?.items ?? []).length;
  return { compacted, repairs: repairs.map((r) => `${r.nodeId} ${r.code}`), regrounded, rescreened, harvested, regradedIds: regraded, changes, itemsKept: kept, project };
}
