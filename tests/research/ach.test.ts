import { describe, expect, it } from 'vitest';
import { buildMatrix, diagnosticRows, evidenceRows, markRow, pricedIn } from '../../src/research/ach.mjs';
import { fakeRouter, seq } from '../helpers/fakes';

const hypotheses = [{ id: 'M1', key: 'a', hypothesis: 'hidden defect' }, { id: 'M2', key: 'b', hypothesis: 'high real mileage' }, { id: 'M3', key: 'c', hypothesis: 'seller urgency' }];

describe('competing hypotheses keep only diagnostic evidence', () => {
  it('drops rows that mark every hypothesis the same, and ranks by fewest inconsistencies', () => {
    const rows = [
      { evidence: 'rear arms renewed', marks: { M1: 'I', M2: 'C', M3: 'C' }, weight: 3 },
      { evidence: 'price below comparables', marks: { M1: 'C', M2: 'C', M3: 'C' } },
      { evidence: 'service book', marks: { M1: 'N', M2: 'i', M3: 'n' }, weight: 1 },
      { evidence: 'half marked', marks: { M1: 'C' } },
    ];
    const { kept, dropped, ranking } = diagnosticRows(hypotheses, rows);
    expect(kept.map((r: { evidence: string }) => r.evidence)).toEqual(['rear arms renewed', 'service book']);
    expect(dropped.map((r: { evidence: string; reason: string }) => `${r.evidence}: ${r.reason.split(',')[0]}`)).toEqual(['price below comparables: the same mark for every hypothesis', 'half marked: a hypothesis has no mark']);
    expect(ranking.map((r: { id: string; inconsistent: number; weighted: number }) => [r.id, r.inconsistent, r.weighted])).toEqual([['M3', 0, 0], ['M2', 1, 1], ['M1', 1, 3]]);
  });

  it('lists the conflict questions no kept row answers', () => {
    const questions = [{ id: 'Q1', q: 'priced in?', checker: 'official' }, { id: 'Q2', q: 'known to few?', checker: 'consensus' }];
    const rows = [{ evidence: 'x', for: 'Q1', marks: { M1: 'I', M2: 'C', M3: 'N' } }, { evidence: 'y', for: 'Q2', marks: { M1: 'N', M2: 'N', M3: 'N' } }];
    expect(diagnosticRows(hypotheses, rows, { questions }).needed).toEqual([{ id: 'Q2', q: 'known to few?', checker: 'consensus' }]);
  });
});

describe('marks come from votes, cell by cell', () => {
  it('takes two agreeing votes, and a cell without a majority is N', async () => {
    const agree = fakeRouter({ 'ach-row': { marks: { M1: 'I', M2: 'C', M3: 'N' } } });
    expect((await markRow({ router: agree }, { evidence: 'e' }, hypotheses)).marks).toEqual({ M1: 'I', M2: 'C', M3: 'N' });
    expect(agree.calls).toHaveLength(2);
    const split = fakeRouter({ 'ach-row': seq({ marks: { M1: 'I', M2: 'C', M3: 'C' } }, { marks: { M1: 'I', M2: 'I', M3: 'N' } }, { marks: { M1: 'C', M2: 'C', M3: 'I' } }) });
    const row = await markRow({ router: split }, { evidence: 'e' }, hypotheses);
    expect(row.marks).toEqual({ M1: 'I', M2: 'C', M3: 'N' });
    expect(split.calls).toHaveLength(3);
  });

  it('rejects a reply that leaves a hypothesis unmarked', async () => {
    const router = fakeRouter({ 'ach-row': { marks: { M1: 'I' } } });
    const row = await markRow({ router }, { evidence: 'e' }, hypotheses);
    expect(row.marks).toEqual({ M1: '', M2: '', M3: '' });
    expect(router.calls[1].messages[2].content).toContain('needs C, I or N for each of M1, M2, M3');
    const { kept, dropped } = diagnosticRows(hypotheses, [row]);
    expect(kept).toEqual([]);
    expect(dropped[0].reason).toBe('not marked: too few votes answered');
    const one = await markRow({ router: fakeRouter({ 'ach-row': seq({ marks: { M1: 'I', M2: 'C', M3: 'N' } }, { marks: {} }) }) }, { evidence: 'e' }, hypotheses);
    expect(one.marks).toEqual({ M1: '', M2: '', M3: '' });
  });
});

describe('the priced-in check uses only the candidate rows of the research', () => {
  const rows = [20000, 22000, 24000, 25000, 26000, 28000, 30000].map((value, i) => ({ url: `u${i}`, value, subject: ['Alpha', i < 5 ? '1.2' : '1.4'] }));

  it('needs 5 comparables and falls back to a coarser subject level', () => {
    expect(pricedIn({ url: 'x', value: 2000, subject: ['Alpha', '1.2'] }, rows, ['make', 'engine'])).toMatchObject({ position: 'below', level: 2, comparables: 5 });
    expect(pricedIn({ url: 'x', value: 24500, subject: ['Alpha', '1.4'] }, rows, ['make', 'engine'])).toMatchObject({ position: 'within', level: 1, comparables: 7 });
    expect(pricedIn({ url: 'x', value: 900000, subject: ['Gamma'] }, rows, ['make', 'engine'])).toMatchObject({ position: 'above', level: 0, comparables: 7 });
    expect(pricedIn({ url: 'x', value: 2000 }, rows.slice(0, 4), [])).toEqual({ position: 'unknown', reason: 'fewer than 5 comparable rows with a spread of prices' });
    expect(pricedIn({ url: 'x' }, rows, []).position).toBe('unknown');
  });

  it('leaves the item itself out of its comparables', () => {
    const own = pricedIn({ url: 'u0', value: 20000, subject: ['Alpha', '1.2'] }, rows.slice(0, 5), ['make', 'engine']);
    expect(own).toEqual({ position: 'unknown', reason: 'fewer than 5 comparable rows with a spread of prices' });
  });
});

describe('the matrix', () => {
  it('takes identity fields, the priced-in row and facts of credibility 1 to 3, never a market figure or a doubtful fact', async () => {
    const identity = { fields: { L1: { level: 'make', value: 'Alpha', quote: 'Alpha for sale.' }, L2: null } };
    const priced = { position: 'within', level: 1, comparables: 7, median: 25000, low: 15000, high: 40000 };
    const facts = [{ quote: 'rear arms were renewed', for: 'Q1', direction: '+', credibility: 2, admiralty: 'F2', url: 'u' }, { quote: 'doubtful', for: 'Q2', direction: '-', credibility: 4 }];
    const rows = evidenceRows({ identity, priced, facts });
    expect(rows.map((r: { kind: string; evidence: string }) => [r.kind, r.evidence])).toEqual([
      ['identity', 'make: Alpha'],
      ['priced-in', 'the price is within the range of 7 comparable items (15000 to 40000, median 25000)'],
      ['fact', 'rear arms were renewed'],
    ]);
    expect(evidenceRows({ priced: { position: 'unknown' } })).toEqual([]);
    const router = fakeRouter({ 'ach-row': (request: { messages: { content: string }[] }) => ({ marks: request.messages[1].content.includes('rear arms') ? { M1: 'I', M2: 'N', M3: 'N' } : { M1: 'N', M2: 'N', M3: 'N' } }) });
    const goal = { hypotheses, questions: [{ id: 'Q1', q: 'a', checker: 'consensus' }, { id: 'Q2', q: 'b', checker: 'official' }] };
    const matrix = await buildMatrix({ router }, { identity, priced, facts, goal });
    expect(matrix.kept.map((r: { evidence: string }) => r.evidence)).toEqual(['rear arms were renewed']);
    expect(matrix.dropped).toHaveLength(2);
    expect(matrix.ranking[2].id).toBe('M1');
    expect(matrix.needed.map((q: { id: string }) => q.id)).toEqual(['Q2']);
  });
});
