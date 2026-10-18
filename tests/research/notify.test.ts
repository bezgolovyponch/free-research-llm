import { describe, expect, it } from 'vitest';
import { MAX_THREAD, appendAppMessage, loopSummary, runSummary } from '../../src/research/notify.mjs';

describe('app messages in the project chat', () => {
  it('appends app reports to the root thread and caps its length', () => {
    const project: { chats?: Record<string, Array<{ role: string }>> } = {};
    for (let i = 0; i < MAX_THREAD + 5; i++) appendAppMessage(project, `m${i}`);
    expect(project.chats!.Q).toHaveLength(MAX_THREAD);
    expect(project.chats!.Q[0]).toMatchObject({ role: 'app', content: 'm5' });
  });

  it('summarises a finished run with grades, engines, expected result and working links', () => {
    const text = runSummary({
      report: { verdict: 'GO-IF price gap holds' },
      nodes: [
        { id: 'D1', status: 'verified', sources: [{ provider: 'langsearch' }, { provider: 'direct' }] },
        { id: 'D2', status: 'weak', sources: [{ provider: 'langsearch' }] },
      ],
      acceptanceResult: { score: 0.5, checks: [{ label: 'At least 5 items', value: 0.4 }], items: [{ title: 'Golf', url: 'https://m.example/ad/1', live: true, inRange: true }, { url: 'https://m.example/x', live: false }] },
    });
    expect(text).toContain('Verdict: GO-IF price gap holds');
    expect(text).toContain('Nodes passing the checks: 1/2 · still weak: D2');
    expect(text).toContain('langsearch 2, direct 1');
    expect(text).toContain('Expected result met: 50% — At least 5 items 40%');
    expect(text).toContain('- Golf https://m.example/ad/1 (price in range)');
    expect(text).not.toContain('m.example/x');
  });

  it('summarises the loop at start and end', () => {
    expect(loopSummary({ hours: 12, deadline: '2026-10-19T07:29:00Z' }, false)).toContain('until 2026-10-19 07:29');
    const end = loopSummary({ stopReason: 'time limit reached', baseline: 0.2, best: 0.35, trials: [{ outcome: 'kept', nodeId: 'D1.1', change: 'sharper query', before: 0.2, score: 0.35 }, { outcome: 'reverted-whole' }] }, true);
    expect(end).toContain('Score 0.2 → 0.35; 1 of 2 changes kept.');
    expect(end).toContain('- D1.1: sharper query (0.2 → 0.35)');
  });
});
