import { describe, expect, it } from 'vitest';
import { projectScore, scopeScore, scoredPieces } from '../../../src/research/improve.mjs';
import { blankNode } from '../../../src/research/tree.mjs';

function tree() {
  return {
    nodes: [
      blankNode({ id: 'D1', parentId: 'Q', question: 'demand?', status: 'verified' }),
      blankNode({ id: 'D1.1', parentId: 'D1', question: 'visitors?', status: 'verified' }),
      blankNode({ id: 'D2', parentId: 'Q', question: 'costs?', status: 'weak' }),
      blankNode({ id: 'D2.1', parentId: 'D2', question: 'rent?', status: 'pending' }),
    ],
  };
}

describe('coverage-aware score', () => {
  it('scores the whole tree as the average of all piece grades, uncovered pieces counting 0', () => {
    expect(projectScore(tree()).score).toBe(0.506);
  });

  it('counts a removed piece and its sub-pieces as unsupported instead of dropping them from the average', () => {
    const before = tree();
    const pieces = scoredPieces(before);
    const after = { nodes: before.nodes.filter((n) => !n.id.startsWith('D2')) };
    expect(projectScore(after).score).toBe(0.9);
    expect(projectScore(after, pieces).score).toBe(0.45);
    expect(projectScore(after, pieces).score).toBeLessThan(projectScore(before, pieces).score);
  });

  it('applies the same coverage rule to a scoped loop', () => {
    const before = tree();
    const pieces = scoredPieces(before, ['D2']);
    expect(pieces).toEqual(['D1', 'D2', 'D2.1']);
    const after = { nodes: before.nodes.filter((n) => n.id !== 'D2.1') };
    expect(scopeScore(after, ['D2']).grades).toBe(0.625);
    expect(scopeScore(after, ['D2'], pieces).grades).toBe(0.417);
  });
});
