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

describe('listingSpec', () => {
  it('normalizes single-model and scan listing requests', async () => {
    const { listingSpec } = await import('../../src/research/tree.mjs');
    expect(listingSpec({ countries: ['de', 'xx1'], make: 'Skoda', model: 'Octavia', minEur: '2000', maxEur: 4000 })).toEqual({ countries: ['DE'], make: 'Skoda', model: 'Octavia', minEur: 2000, maxEur: 4000 });
    expect(listingSpec({ scan: true, minEur: 2000, maxEur: 4000 })).toMatchObject({ scan: true, from: 'DE', to: 'CZ' });
    expect(listingSpec({})).toBeNull();
    expect(listingSpec(null)).toBeNull();
  });
});

describe('moveListingsToLeaves', () => {
  it('moves a listings request off a parent into a new data leaf so it actually runs', async () => {
    const { normalizeTree } = await import('../../src/research/tree.mjs');
    const tree = normalizeTree({ nodes: [
      { id: 'D1', parentId: null, question: 'gap?', listings: { scan: true, minEur: 2000, maxEur: 4000 } },
      { id: 'D1.1', parentId: 'D1', question: 'trend?' },
    ] }, 'q');
    const parent = tree.nodes.find((n) => n.id === 'D1');
    const leaf = tree.nodes.find((n) => n.id === 'D1.0');
    expect(parent.listings).toBeNull();
    expect(leaf).toMatchObject({ parentId: 'D1', method: 'data', listings: { scan: true, from: 'DE', to: 'CZ' } });
  });
});

