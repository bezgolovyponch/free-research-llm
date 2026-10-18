import { describe, expect, it } from 'vitest';
import { scoreProject } from '../../src/research/score.mjs';

describe('scoreProject', () => {
  it('weights grades, rewards a decisive memo and lists the failing nodes', () => {
    const project = {
      nodes: [
        { id: 'D1', status: 'verified', sources: [] },
        { id: 'D2', status: 'weak', question: 'VAT?', sources: [{}], verification: { failures: ['no number'] } },
      ],
      report: { verdict: 'GO-IF spread > €7,500' },
    };
    const s = scoreProject(project);
    expect(s.score).toBe(0.663);
    expect(s.issues).toEqual([{ nodeId: 'D2', title: undefined, question: 'VAT?', grade: 'weak', failures: ['no number'], sources: 1 }]);
    expect(scoreProject({ ...project, report: { verdict: 'INSUFFICIENT DATA — prices' } }).score).toBeCloseTo(0.5625, 3);
  });
});
