import { describe, expect, it } from 'vitest';
import { knowledgeRecord } from '../../src/research/knowledge.mjs';

describe('knowledgeRecord', () => {
  it('splits findings into facts, claims and hypotheses with re-checkable evidence', () => {
    const finding = (answer: string) => ({ answer, claims: [{ text: 'x', sourceIds: ['S1'] }], assumptions: [] });
    const sources = [{ id: 'S1', title: 'Stat office', url: 'https://stat.example', kind: 'web' }, { id: 'S2', title: 'Unused', url: 'https://u.example', kind: 'web' }];
    const project = {
      id: 'p', question: 'q', acceptance: { expected: 'memo' }, report: { verdict: 'GO' }, acceptanceResult: null,
      nodes: [
        { id: 'A', question: 'a?', status: 'verified', finding: finding('fact A'), sources, verification: { checks: [{ id: 'citations', passed: true }] } },
        { id: 'B', question: 'b?', status: 'supported', finding: finding('claim B'), sources },
        { id: 'C', question: 'c?', status: 'weak', finding: finding('guess C'), sources },
        { id: 'D', question: 'd?', status: 'pending', finding: null, sources: [] },
      ],
    };
    const record = knowledgeRecord(project);
    expect(record.facts.map((f: { statement: string }) => f.statement)).toEqual(['fact A']);
    expect(record.claims).toHaveLength(1);
    expect(record.hypotheses).toHaveLength(1);
    expect(record.facts[0].evidence).toEqual([{ id: 'S1', title: 'Stat office', url: 'https://stat.example', kind: 'web' }]);
    expect(record.facts[0].checks).toEqual([{ id: 'citations', passed: true }]);
  });
});
