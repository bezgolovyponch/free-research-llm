import { asksForItems } from './deliverable.mjs';
import { ROOT_ID } from './tree.mjs';

export const FRONTIER_SHOWN = 4;
export const DEMOS_SHOWN = 2;
export const MIN_GAIN = 0.001;

export function pieceType(node) {
  if (!node || node.id === ROOT_ID) return 'root';
  return `${node.parentId === ROOT_ID ? 'driver' : 'sub-question'}|${node.method || 'lookup'}|${asksForItems(node) ? 'list' : 'fact'}`;
}

function typeOf(nodes, nodeId) {
  if (nodeId === ROOT_ID) return 'root';
  const node = nodes.find((n) => n.id === nodeId);
  return node ? pieceType(node) : '';
}

export function frontier(trials = [], nodes = [], type = null) {
  const best = new Map();
  for (const t of trials) {
    const gain = Number(t.score) - Number(t.before);
    if (t.outcome !== 'kept' || !(gain >= MIN_GAIN)) continue;
    const kind = t.type ?? typeOf(nodes, t.nodeId);
    if (type && kind !== type) continue;
    const held = best.get(t.nodeId);
    if (!held || gain > held.gain) best.set(t.nodeId, { nodeId: t.nodeId, type: kind, change: t.change, diagnosis: t.diagnosis ?? '', gain: Math.round(gain * 1000) / 1000, at: t.at });
  }
  return [...best.values()].sort((a, b) => b.gain - a.gain);
}

export function demonstrations(project, node, k = DEMOS_SHOWN) {
  const type = pieceType(node);
  return (project.nodes ?? []).filter((n) => n.id !== node.id && n.status === 'verified' && pieceType(n) === type && ((n.searchQueries ?? []).length || (n.sourceUrls ?? []).length))
    .slice(0, k)
    .map((n) => {
      const read = new Set((n.sources ?? []).filter((x) => x.url && (x.text || x.snippet)).map((x) => x.url));
      return { id: n.id, question: n.question, searchQueries: (n.searchQueries ?? []).slice(0, 4), sourceUrls: (n.sourceUrls ?? []).filter((u) => read.has(u)).slice(0, 3) };
    });
}

export function gateTrace(node) {
  if (!node) return [];
  const checks = (node.verification?.checks ?? []).filter((c) => c.passed === false).map((c) => `${c.label ?? c.id}: ${c.detail ?? 'failed'}`);
  return [...new Set([...(node.verification?.failures ?? []), ...checks]), ...(node.critique?.issues ?? []).map((i) => `reviewer: ${i}`), ...(node.finding?.gaps ?? []).map((g) => `gap: ${g}`)].slice(0, 10);
}

export function playbookText(project, node) {
  const type = pieceType(node);
  const lessons = frontier(project.improve?.trials, project.nodes, type).filter((l) => l.nodeId !== node.id).slice(0, FRONTIER_SHOWN);
  const demos = node.id === ROOT_ID ? [] : demonstrations(project, node);
  const lines = [];
  if (lessons.length) lines.push(`CHANGES THAT RAISED THE MEASURED SCORE ON OTHER PIECES OF THIS TYPE (best one per piece; adapt one if it fits this piece):\n${lessons.map((l) => `- ${l.nodeId} +${l.gain}: ${l.change}${l.diagnosis ? ` (diagnosis: ${l.diagnosis})` : ''}`).join('\n')}`);
  if (demos.length) lines.push(`VERIFIED PIECES OF THIS TYPE (their queries and pages passed every gate):\n${demos.map((d) => `- ${d.id}: ${d.question} · queries: ${d.searchQueries.join(' | ') || 'none'}${d.sourceUrls.length ? ` · pages: ${d.sourceUrls.join(' ')}` : ''}`).join('\n')}`);
  return { text: lines.join('\n\n'), lessons: lessons.length, demos: demos.length };
}

export function typeStats(trials = [], nodes = []) {
  const stats = {};
  for (const t of trials) {
    if (!['kept', 'reverted-whole', 'reverted-piece', 'no-gain', 'reverted-regression'].includes(t.outcome)) continue;
    const kind = t.type ?? typeOf(nodes, t.nodeId);
    if (!kind) continue;
    const s = (stats[kind] ??= { tested: 0, kept: 0, guided: { tested: 0, kept: 0 }, unguided: { tested: 0, kept: 0 } });
    const arm = t.guided ? s.guided : s.unguided;
    s.tested++;
    arm.tested++;
    if (t.outcome === 'kept') {
      s.kept++;
      arm.kept++;
    }
  }
  return stats;
}
