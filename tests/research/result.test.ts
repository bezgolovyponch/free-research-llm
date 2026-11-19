import { describe, expect, it } from 'vitest';
import { aggregate, basisOf, changedSince, effectiveGrade, nodeIdsIn, nodeProbabilities, questionKind, resultModel, sanitizeVerdict } from '../../src/research/result.mjs';

const node = (id: string, parentId: string, status: string, answer = 'A concrete answer: 12 firms.', impact = 3) => ({ id, parentId, status, impact, finding: { answer } });

function plan() {
  const nodes = [
    node('D1', 'Q', 'supported', 'Rollup', 5),
    node('D1.1', 'D1', 'verified', 'EU TAM is 1.2 bn EUR (2 sources).'),
    node('D1.2', 'D1', 'supported', 'The 2026 CAGR is not established by the supplied evidence.'),
    node('D2', 'Q', 'weak', 'Rollup', 3),
    node('D2.1', 'D2', 'unsupported', 'No partners found.'),
  ];
  return {
    question: 'Create an action plan to increase market share of DeepMedChem',
    nodes,
    report: { generatedAt: '2026-10-19T19:20:00Z', basis: basisOf(nodes), actionItems: [{ action: 'Publish benchmark results', why: 'D1.1 shows demand', nodeIds: ['D1.1'], impact: 5 }, { action: 'Sign a UK distributor', why: 'D2.1', nodeIds: ['D2.1'], impact: 5 }, { action: 'Cut prices', nodeIds: [], impact: 2 }] },
  };
}

describe('computed result from the current pieces', () => {
  it('aggregates probabilities by weighted, extremized log-odds', () => {
    expect(aggregate([{ p: 0.5 }, { p: 0.5 }])).toBeCloseTo(0.5);
    expect(aggregate([{ p: 0.8 }, { p: 0.8 }])).toBeGreaterThan(0.8);
    expect(aggregate([{ p: 0.9, weight: 3 }, { p: 0.2, weight: 1 }], 1)).toBeGreaterThan(0.6);
    expect(aggregate([])).toBe(0.5);
    expect(aggregate([{ p: 0.9 }])).toBe(0.9);
  });

  it('never counts a "not established by the evidence" answer as verified or supported', () => {
    const p = plan();
    expect(effectiveGrade(p.nodes[2])).toBe('weak');
    expect(effectiveGrade(p.nodes[1])).toBe('verified');
    const probs = nodeProbabilities(p.nodes);
    expect(probs.get('D1.1')).toBe(0.9);
    expect(probs.get('D1.2')).toBe(0.4);
    expect(probs.get('D1')).toBeGreaterThan(0.6);
  });

  it('ranks the actions of a plan by probability × impact, from the pieces each one rests on', () => {
    const m = resultModel(plan());
    expect(m.kind).toBe('plan');
    expect(m.regraded).toEqual(['D1.2']);
    expect(m.actions.map((a: { action: string }) => a.action)).toEqual(['Publish benchmark results', 'Cut prices', 'Sign a UK distributor']);
    expect(m.actions[0]).toMatchObject({ probability: 0.9, impact: 5, nodeIds: ['D1.1'] });
    expect(m.actions[2].probability).toBeLessThan(0.2);
    expect(m.actions[1]).toMatchObject({ nodeIds: [], probability: m.probability });
    expect(m.drivers.map((d: { id: string }) => d.id)).toEqual(['D1', 'D2']);
  });

  it('scores the options of a decision by consistent minus inconsistent evidence', () => {
    const p = { question: 'Should we enter the Czech market?', nodes: plan().nodes, report: { options: [{ option: 'GO', support: ['D1.1'], against: ['D2.1'] }, { option: 'NO-GO', support: ['D2.1'], against: ['D1.1'] }] } };
    const m = resultModel(p);
    expect(m.kind).toBe('decision');
    expect(m.options[0].option).toBe('GO');
    expect(m.options[0].probability).toBeGreaterThan(m.options[1].probability);
    expect(m.options[0].probability + m.options[1].probability).toBeCloseTo(1, 1);
  });

  it('knows when the memo is out of date, and names the pieces that changed since', () => {
    const p = plan();
    expect(changedSince(p.report, p.nodes)).toEqual([]);
    p.nodes[4].status = 'supported';
    expect(resultModel(p).changedSince).toEqual(['D2.1']);
    expect(changedSince(null, p.nodes)).toEqual([]);
  });

  it('tells the question type, finds piece ids, and removes copied placeholders', () => {
    expect([questionKind({ question: 'How much does transport DE→CZ cost?' }), questionKind({ question: 'Which used vans resell best?' }), questionKind({ question: 'Should I open a kiosk in Brno?' }), questionKind({ question: 'Create an action plan for value increase' })]).toEqual(['estimate', 'list', 'decision', 'plan']);
    expect(nodeIdsIn({ a: 'rests on D2.1 and D10', b: ['D3'] })).toEqual(['D2.1', 'D10', 'D3']);
    expect(sanitizeVerdict('GO-IF <market share rises 10% within 6 months>')).toBe('GO-IF market share rises 10% within 6 months');
  });
});

describe('question type of a list research (audit 2026-11-12)', () => {
  it('a question with an item count is a list', () => {
    const cars = { question: 'Find accurate and verified car listings on available marketplaces for at least 20 cars as fit and up to 80 as a trade off to purchase within 300km from prague, hatchback, with highest price/value ratio, considering the engines informations, usage trends and empirical data and all important details of the particular car, considering the professional and car enthusiast trustful sources and communities, with all the crucial metrics considered, price up to 65000CZK or equivalent', decision: 'Identify 20–80 verified hatchback listings within 300 km of Prague priced ≤ 65 000 CZK', acceptance: { itemCount: 20 } };
    const plots = { question: 'Find appropriate plots to buy for glamping business, but also with the strong price increase trend, very low enterance investments, 20000EUR max, 10 month a year, mild climate to have Glampings so no air condition, nearby sea or the ocean accessible by ebike', acceptance: { itemCount: 50 } };
    const suppliers = { question: 'Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren, Monclair, North face, Barbour with highest price/value ratio , proven good quality, assortiment for the appropriate retail second hand shop business in Czech Republic', decision: 'Select wholesale branded second‑hand clothing suppliers for a Prague boutique', acceptance: { itemCount: 20 } };
    expect([cars, plots, suppliers].map(questionKind)).toEqual(['list', 'list', 'list']);
    expect([cars, plots, suppliers].map((p) => questionKind({ ...p, acceptance: {} }))).toEqual(['estimate', 'plan', 'estimate']);
  });
});

describe('evidence probability of pieces that failed or never ran (audit 2026-11-12, supplier research b2f5b7)', () => {
  const tree = (d61: string, d62: string) => [
    ['D1', 'Q', 'weak', 4], ['D1.1', 'D1', 'weak', 3], ['D1.2', 'D1', 'supported', 3],
    ['D2', 'Q', 'weak', 5], ['D2.1', 'D2', 'weak', 4], ['D2.2', 'D2', 'weak', 3],
    ['D3', 'Q', 'supported', 5], ['D3.1', 'D3', 'supported', 4], ['D3.2', 'D3', 'supported', 3],
    ['D4', 'Q', 'supported', 4], ['D4.1', 'D4', 'supported', 4], ['D4.2', 'D4', 'supported', 3],
    ['D5', 'Q', 'weak', 4], ['D5.1', 'D5', 'weak', 3], ['D5.2', 'D5', 'weak', 3],
    ['D6', 'Q', 'unsupported', 5], ['D6.1', 'D6', d61, 5], ['D6.2', 'D6', d62, 5],
  ].map(([id, parentId, status, impact]) => ({ id, parentId, status, impact, finding: { answer: 'Suppliers stock the target brands.' } }));
  const overall = (nodes: object[]) => resultModel({ question: 'Select wholesale suppliers', nodes }).probability;

  it('a failed piece never raises the probability', () => {
    const stored = overall(tree('weak', 'unsupported'));
    expect(overall(tree('weak', 'failed'))).toBeLessThanOrEqual(stored);
    expect(overall(tree('failed', 'failed'))).toBeLessThanOrEqual(stored);
    expect(nodeProbabilities(tree('weak', 'failed')).get('D6.2')).toBe(0.15);
  });

  it('a piece that never ran is left out instead of counting as an even chance', () => {
    const probs = nodeProbabilities(tree('weak', 'pending'));
    expect(probs.get('D6.2')).toBeNull();
    expect(probs.get('D6')).toBeLessThanOrEqual(0.4);
    const unstarted = tree('pending', 'pending').map((n) => ({ ...n, status: 'pending' }));
    expect(resultModel({ question: 'Select wholesale suppliers', nodes: unstarted })).toMatchObject({ probability: 0.5 });
  });
});
