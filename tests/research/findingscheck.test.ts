import { describe, expect, it } from 'vitest';
import { checkFindings, conflictQuestions, estimateGrounded, findingsNote, findingsToCheck, lowersConfidence, memoAnswer } from '../../src/research/findingscheck.mjs';
import { fakeRouter } from '../helpers/fakes';

const question = 'How many residential heat pumps were installed in Czechia in 2024? Give the figure with its source.';
const report = { verdict: 'In 2024, approximately 23,338 residential heat pumps were installed in Czechia.', bestEstimate: { value: '23338', unit: 'units', low: '20000', high: '23338', basis: 'D1.1, D1.2' } };
const nodes = [
  { id: 'D1', status: 'weak', finding: { claims: [{ text: 'Over 20,000 residential heat pumps were installed in Czechia in 2024, according to AVTC.' }] } },
  { id: 'D1.1', status: 'supported', finding: { claims: [{ text: 'In 2024, more than 20,000 heat pumps were sold in the Czech Republic according to AVTC.' }] } },
  { id: 'D1.2', status: 'verified', finding: { claims: [{ text: 'The figure of 23,338 heat pumps sold refers to the year 2025, not 2024.' }] } },
];

describe('the memo answer and the findings to check', () => {
  it('reads the answer with its estimate', () => {
    expect(memoAnswer(report)).toBe('In 2024, approximately 23,338 residential heat pumps were installed in Czechia. Estimate: 23338 units (range 20000 to 23338).');
  });
  it('checks every verified finding and the supported findings the estimate rests on', () => {
    expect(findingsToCheck(nodes, ['D1.1', 'D1.2']).map((f) => `${f.nodeId}:${f.grade}`)).toEqual(['D1.1:supported', 'D1.2:verified']);
    expect(findingsToCheck(nodes, []).map((f) => f.nodeId)).toEqual(['D1.2']);
  });
  it('finds an estimate written with thousands separators and flags one no finding carries', () => {
    expect(estimateGrounded({ value: '23338' }, nodes)).toBe(true);
    expect(estimateGrounded({ value: '30410' }, nodes)).toBe(false);
    expect(estimateGrounded({ value: '2338' }, nodes)).toBe(false);
  });
});

describe('checkFindings', () => {
  it('records a verified finding that contradicts the answer, with its quote, and lowers confidence', async () => {
    const router = fakeRouter({ 'memo-consistency': (request: { messages: Array<{ content: string }> }) => (request.messages[1].content.includes('refers to the year 2025') ? { pick: 'contradicts', quote: 'refers to the year 2025, not 2024' } : { pick: 'supports', quote: '' }) });
    const check = await checkFindings({ question, report, nodes, router: router as never });
    expect(check).toEqual({ checked: 2, conflicts: [{ nodeId: 'D1.2', grade: 'verified', claim: 'The figure of 23,338 heat pumps sold refers to the year 2025, not 2024.', quote: 'refers to the year 2025, not 2024' }], ungrounded: false });
    expect(lowersConfidence(check)).toBe(true);
    expect(findingsNote(check)).toBe(' — sources disagree: D1.2 says "refers to the year 2025, not 2024"');
    expect(conflictQuestions(check)).toEqual(['Which is right: the memo answer, or D1.2 ("refers to the year 2025, not 2024")?']);
  });
  it('does not count a contradiction whose quote is not in the finding', async () => {
    const router = fakeRouter({ 'memo-consistency': () => ({ pick: 'contradicts', quote: 'the figure is wrong' }) });
    const check = await checkFindings({ question, report, nodes, router: router as never });
    expect(check?.conflicts).toEqual([]);
  });
  it('keeps confidence when every finding supports the answer, and flags an estimate no finding carries', async () => {
    const router = fakeRouter({ 'memo-consistency': () => ({ pick: 'supports', quote: '' }) });
    const ungroundedReport = { ...report, bestEstimate: { ...report.bestEstimate, value: '30410' } };
    const check = await checkFindings({ question, report: ungroundedReport, nodes, router: router as never });
    expect(check?.conflicts).toEqual([]);
    expect(check?.ungrounded).toBe(true);
    expect(findingsNote(check)).toBe(' — the estimate appears in no finding');
    expect(findingsNote(null)).toBe('');
  });
});
