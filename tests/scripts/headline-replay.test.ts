import { describe, expect, it } from 'vitest';
import { replayLines } from '../../scripts/headline-replay.mjs';

describe('headline replay of a stored project', () => {
  const id = 'bulk|Does it sell in bulk?';
  const checklist = [{ clause: 'bulk', items: [{ clause: 'bulk', question: 'Does it sell in bulk?', hard: true }] }];
  const item = (url: string, answer: string) => ({ url, live: true, listing: true, purpose: [], checks: [{ id, clause: 'bulk', answer, quote: answer === 'yes' ? 'we sell in bulk' : '' }] });

  it('prints the stored summary, the old mean of the checks and the counted headline side by side, with the tiers and the counts of criteria and must-haves', () => {
    const project = { acceptance: { itemCount: 2 }, checklist, decisionModel: { criteria: [] }, acceptanceResult: { totalAsked: 2, checks: [{ id: 'count', value: 0.5 }, { id: `checklist-${id}`, value: 1 }], items: [item('a', 'yes'), item('b', 'unknown')] } };
    expect(replayLines(project, 'p1')).toEqual([
      '--- p1 ---',
      'stored summary : 1 of 2 confirmed · 1 to confirm (open: bulk)',
      'old headline   : 75% met (mean of 2 checks)',
      'new headline   : 1 of 2 meet every must-have; up to 2 of 2 could meet every must-have (1 confirmed + 1 to confirm)',
      'tiers          : confirmed 1 · to-confirm 1 · rejected 0 · not-judged 0',
      'criteria       : 0',
      'must-have items: 1 of 1',
    ]);
  });

  it('says so when no acceptance result is stored', () => {
    expect(replayLines({}, 'p2')).toEqual(['p2: no acceptance result stored']);
  });
});
