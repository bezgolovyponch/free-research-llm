import { describe, expect, it } from 'vitest';
import { gradeAverage, scoreProject } from '../../src/research/score.mjs';

describe('scoreProject', () => {
  it('weights grades only, never rewards a verdict, and lists the failing nodes', () => {
    const project = {
      nodes: [
        { id: 'D1', status: 'verified', sources: [] },
        { id: 'D2', status: 'weak', question: 'VAT?', sources: [{}], verification: { failures: ['no number'] } },
      ],
      report: { verdict: 'GO-IF spread > €7,500' },
    };
    const s = scoreProject(project);
    expect(s.score).toBe(0.563);
    expect(s.verdict).toBe('GO-IF spread > €7,500');
    expect(s.issues).toEqual([{ nodeId: 'D2', title: undefined, question: 'VAT?', grade: 'weak', failures: ['no number'], sources: 1 }]);
    expect(scoreProject({ ...project, report: { verdict: 'PROVISIONAL — prices' } }).score).toBe(0.563);
    expect(scoreProject({ ...project, report: { verdict: 'INSUFFICIENT DATA — prices' } }).score).toBe(0.563);
    expect(scoreProject({ ...project, report: null }).score).toBe(0.563);
  });

  it('counts covered pieces as covered, not as weak or missing', () => {
    const s = scoreProject({ nodes: [{ id: 'D1', status: 'verified' }, { id: 'D2', status: 'covered', coveredBy: 'candidate-table' }, { id: 'D3', status: 'weak', question: 'VAT?' }], report: null });
    expect(s.counts).toMatchObject({ verified: 1, covered: 1, weak: 1, pending: 0 });
    expect(s.issues.map((i: { nodeId: string }) => i.nodeId)).toEqual(['D3']);
    expect(s.score).toBe(Math.round(((1 + 0.75 + 0.25) / 3) * 0.9 * 1000) / 1000);
  });
});

describe('gradeAverage', () => {
  it('counts expected pieces that are missing from the tree as 0', () => {
    const nodes = [{ id: 'D1', status: 'verified' }, { id: 'D2', status: 'supported' }];
    expect(gradeAverage(nodes)).toBe(0.875);
    expect(gradeAverage(nodes, ['D1', 'D2', 'D3', 'D3.1'])).toBe(0.4375);
    expect(gradeAverage([], [])).toBe(0);
    expect(scoreProject({ nodes }, ['D3']).score).toBeCloseTo(0.5833 * 0.9, 3);
  });
});
