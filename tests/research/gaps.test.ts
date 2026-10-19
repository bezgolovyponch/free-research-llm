import { describe, expect, it } from 'vitest';
import { actionPlan, nodeAction, provisionalVerdict, resultStatus } from '../../src/research/gaps.mjs';

const check = (id: string, passed: boolean, detail = '') => ({ id, label: id, passed, detail });

function project() {
  return {
    report: { verdict: 'GO-IF transport stays under 400 EUR', keyNumbers: [{ label: 'transport', value: '350', nodeId: 'D2.1' }], sensitivity: [], summary: 'rests on D2.1' },
    nodes: [
      { id: 'D1', parentId: 'Q', title: 'Prices', question: 'Golf prices?', status: 'verified', impact: 5, uncertainty: 2 },
      { id: 'D2', parentId: 'Q', title: 'Costs', question: 'landed cost?', status: 'weak', impact: 4, uncertainty: 4 },
      { id: 'D2.1', parentId: 'D2', title: 'Transport', question: 'transport cost DE→CZ?', status: 'weak', impact: 5, uncertainty: 5, sources: [{ id: 'S1', url: 'https://a' }], finding: { answer: 'about 300-450', claims: [], gaps: ['quotes from 3 carriers'] }, verification: { checks: [check('concrete', false, 'no number given')] } },
      { id: 'D2.2', parentId: 'D2', title: 'Fees', question: 'registration fee?', status: 'failed', error: 'every provider failed', impact: 3, uncertainty: 3 },
      { id: 'D2.3', parentId: 'D2', title: 'Margin', question: 'what margin does your business need?', status: 'unsupported', impact: 4, uncertainty: 3, finding: { answer: '15% assumed', claims: [{ text: '15% target', assumption: true }], gaps: [] }, verification: { checks: [check('critique', false, 'depends on the buyer')] } },
      { id: 'D3', parentId: 'Q', title: 'Calc', question: 'net margin?', status: 'weak', impact: 3, uncertainty: 3, finding: { answer: 'x', claims: [], gaps: [] }, verification: { checks: [check('calculation', false, 'stated 20, recomputed 12')] } },
      { id: 'D4', parentId: 'Q', title: 'New', question: 'demand?', status: 'pending', impact: 2, uncertainty: 2 },
    ],
  };
}

describe('action plan for an insufficient result', () => {
  it('names every piece that is not settled, with fix, research further or clarify, why and the next step', () => {
    const p = project();
    const byId = Object.fromEntries(actionPlan(p).map((a: { nodeId: string }) => [a.nodeId, a]));
    expect(Object.keys(byId).sort()).toEqual(['D2', 'D2.1', 'D2.2', 'D2.3', 'D3', 'D4']);
    expect(byId['D2.1']).toMatchObject({ action: 'research', decisive: true, next: 'Search for: quotes from 3 carriers' });
    expect(byId['D2.2']).toMatchObject({ action: 'fix', why: 'run failed: every provider failed' });
    expect(byId['D3']).toMatchObject({ action: 'fix', next: expect.stringContaining('formula did not recompute') });
    expect(byId['D2.3']).toMatchObject({ action: 'clarify', assumptions: ['15% target'] });
    expect(byId['D4']).toMatchObject({ action: 'research', why: 'not researched yet' });
    expect(nodeAction(p.nodes[0])).toBeNull();
  });

  it('ranks the pieces the memo relies on and the most uncertain ones first', () => {
    const plan = actionPlan(project());
    expect(plan[0].nodeId).toBe('D2.1');
    expect(plan.at(-1).nodeId).toBe('D4');
  });

  it('always keeps a computed verdict, marked provisional with what is still open', () => {
    const status = resultStatus(project());
    expect(status).toMatchObject({ provisional: true, confidence: 'low', counts: { fix: 2, research: 3, clarify: 1 } });
    expect(status.blocking).toEqual(expect.arrayContaining(['D2.1', 'D2', 'D3', 'D4']));
    expect(provisionalVerdict('GO-IF transport stays under 400 EUR', status)).toBe('PROVISIONAL (low confidence; 6 pieces to fix, research or clarify) — GO-IF transport stays under 400 EUR');
    expect(provisionalVerdict('INSUFFICIENT DATA — transport quotes', status)).toContain('best current estimate — transport quotes');
    const settled = { report: { verdict: 'PROVISIONAL (low) — GO' }, nodes: [{ id: 'D1', parentId: 'Q', status: 'verified' }] };
    const done = resultStatus(settled);
    expect(done).toMatchObject({ provisional: false, confidence: 'high', coverage: 1 });
    expect(provisionalVerdict('PROVISIONAL — GO', done)).toBe('GO');
  });
});
