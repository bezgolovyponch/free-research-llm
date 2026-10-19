import { describe, expect, it } from 'vitest';
import { addSpec, evaluateAll, evaluateSpec, normalizeSpec, regressions, targetOf } from '../../src/research/specs.mjs';

function project(answer: string, status = 'verified', value = 2250) {
  return {
    question: 'Golf DE vs CZ',
    nodes: [
      { id: 'D1', parentId: 'Q', status, finding: { answer: 'roll-up', claims: [] } },
      { id: 'D1.1', parentId: 'D1', status, finding: { answer, claims: [{ text: 'median', value }], items: [{ url: 'https://k.de/1', value }] } },
    ],
    report: { verdict: 'GO-IF transport stays under 400 EUR', summary: 'Golf gap +23%', keyNumbers: [{ label: 'gap', value: '23.3', unit: '%' }] },
    acceptanceResult: { items: [{ url: 'https://k.de/1', value: 2250 }] },
  };
}

describe('regression checks from a desired output', () => {
  it('turns a desired output into checks: grade, number, range, items, words', () => {
    const spec = normalizeSpec({ valueRange: [4000, 2000], unit: 'EUR', itemCount: 1, mustMention: ['Golf'], minGrade: 'verified' }, { request: 'read Golf listings', desired: 'median Golf price in EUR with links' });
    expect(spec).toMatchObject({ valueRange: [2000, 4000], needsNumber: true, itemCount: 1, minGrade: 'verified', mustMention: ['Golf'] });
    const good = evaluateSpec(spec, targetOf(project('Golf median 2250 EUR'), 'D1.1'));
    expect(good.passed).toBe(true);
    const bad = evaluateSpec(spec, targetOf(project('median unknown', 'weak', 9000), 'D1.1'));
    expect(bad.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(['grade', 'range', 'mention:Golf']);
    expect(normalizeSpec(null, { desired: 'a list of sources' })).toMatchObject({ needsNumber: false, minGrade: 'supported', valueRange: null });
  });

  it('evaluates the whole research against the memo and delivered items', () => {
    const t = targetOf(project('x'), 'Q');
    expect(t.grade).toBe('verified');
    expect(t.values).toEqual(expect.arrayContaining([23.3, 2250]));
    expect(evaluateSpec(normalizeSpec({ mustMention: ['transport'] }, { desired: 'verdict that names transport' }), t).passed).toBe(true);
  });

  it('remembers which checks ever passed, so a later failure is a regression', () => {
    const p = project('Golf median 2250 EUR');
    addSpec(p, 'D1.1', normalizeSpec({ mustMention: ['Golf'] }, { request: 'r', desired: 'Golf price' }));
    addSpec(p, 'Q', normalizeSpec({}, { request: 'r', desired: 'a verdict' }));
    expect(addSpec(p, 'nope', normalizeSpec({}, {}))).toBeNull();
    expect(evaluateAll(p).map((r) => [r.nodeId, r.specId, r.passed, r.regressed])).toEqual([['Q', 'R1', true, false], ['D1.1', 'R1', true, false]]);
    const after = structuredClone(p);
    after.nodes[1].finding.answer = 'no data';
    after.nodes[1].finding.claims = [];
    after.nodes[1].status = 'weak';
    expect(regressions(p, after)).toEqual(['D1.1/R1']);
    expect(evaluateAll(after).find((r) => r.nodeId === 'D1.1')).toMatchObject({ passed: false, regressed: true });
  });
});
