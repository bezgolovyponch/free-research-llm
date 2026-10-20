import { describe, expect, it } from 'vitest';
import { ROOT_ID, isLeaf, normalizeTree, priority, progress, researchOrder } from '../../src/research/tree.mjs';

const raw = {
  decision: 'Buy in DE, sell in PL?',
  nodes: [
    { id: 'D1', parentId: null, title: 'Prices', impact: 5, uncertainty: 4 },
    { id: 'D1.1', parentId: 'D1', question: 'DE price', impact: 5, uncertainty: 5 },
    { id: 'D1.2', parentId: 'D1', question: 'PL price', impact: 4, uncertainty: 2 },
    { id: 'D2', parentId: null, title: 'Margin', method: 'calculation', dependsOn: ['D1.1', 'D1.2', 'ghost'] },
    { id: 'D1', parentId: null, title: 'duplicate id' },
    { id: 'X', parentId: 'nowhere', dependsOn: ['X'], impact: 99, method: 'magic' },
  ],
};

describe('normalizeTree', () => {
  const tree = normalizeTree(raw, 'q');

  it('deduplicates ids, re-roots orphans and clamps scores', () => {
    const ids = tree.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    const x = tree.nodes.find((n) => n.id === 'X')!;
    expect(x.parentId).toBe(ROOT_ID);
    expect(x.impact).toBe(5);
    expect(x.method).toBe('lookup');
    expect(x.dependsOn).toEqual([]);
  });

  it('drops dependencies on unknown nodes', () => {
    expect(tree.nodes.find((n) => n.id === 'D2')!.dependsOn).toEqual(['D1.1', 'D1.2']);
  });

  it('orders leaves and dependencies before the nodes that need them, highest priority first', () => {
    const order = researchOrder(tree.nodes);
    expect(order.indexOf('D1.1')).toBeLessThan(order.indexOf('D1'));
    expect(order.indexOf('D1.2')).toBeLessThan(order.indexOf('D2'));
    expect(order.indexOf('D1.1')).toBeLessThan(order.indexOf('D1.2'));
    expect(order).toHaveLength(tree.nodes.length);
  });

  it('reports leaves, priority and progress', () => {
    const d1 = tree.nodes.find((n) => n.id === 'D1')!;
    expect(isLeaf(tree.nodes, d1)).toBe(false);
    expect(priority(d1)).toBe(20);
    expect(progress(tree.nodes)).toEqual({ total: tree.nodes.length, finished: 0, verified: 0 });
  });

  it('breaks dependency cycles instead of looping forever', () => {
    const cyclic = normalizeTree({ nodes: [{ id: 'A', dependsOn: ['B'] }, { id: 'B', dependsOn: ['A'] }] }, 'q');
    expect(researchOrder(cyclic.nodes)).toHaveLength(2);
  });
});
