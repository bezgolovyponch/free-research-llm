import { describe, expect, it } from 'vitest';
import { variantPrompt } from '../../src/research/prompts.mjs';

const project = { question: 'Find glamping plots under 20000 EUR', acceptance: { expected: '50 plots' }, acceptanceResult: null, nodes: [{ id: 'D4', parentId: 'Q', status: 'weak', question: 'zoning?' }] };
const text = (stall: object | null) => variantPrompt({ project, node: { id: 'Q' }, score: { score: 0.28, acceptance: 0.1 }, trials: [], stall } as never)[1].content;

describe('variantPrompt', () => {
  it('asks for removals only when a piece duplicates another, not first', () => {
    expect(text(null)).not.toMatch(/First remove/);
    expect(text(null)).toMatch(/Remove \("remove"\) a top-level piece only if it duplicates another/);
    expect(text(null)).not.toMatch(/STALLED|REFUSED/);
  });

  it('steers a stalled loop toward new evidence for the weakest check and lists refused removals', () => {
    const prompt = text({ stalled: true, trialsSinceKept: 200, hoursSinceKept: 11.2, weakest: { label: 'At least 50 valid items', value: 0.1 }, refusedRemovals: ['D4', 'D5'] });
    expect(prompt).toMatch(/THE LOOP IS STALLED: 200 trials in 11.2 h kept nothing\. The weakest expected-result check is "At least 50 valid items" at 10%\./);
    expect(prompt).toMatch(/NEW evidence for that check/);
    expect(prompt).toMatch(/REMOVALS ALREADY TESTED AND REFUSED \(never propose them again\): D4, D5/);
  });
});
