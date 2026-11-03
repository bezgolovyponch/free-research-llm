import { describe, expect, it } from 'vitest';
import { decomposePrompt, researchPrompt, synthesizePrompt, variantPrompt } from '../../src/research/prompts.mjs';

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

describe('list-first decomposition', () => {
  const template = { label: 't', drivers: 'd', metrics: 'm', sources: 's', decisionRule: 'r' };

  it('keeps pieces away from finding, pricing, filtering, locating, ranking or verifying listings when code does that work', () => {
    const prompt = decomposePrompt({ question: 'Find 20 hatchbacks within 300 km of Prague under 65000 CZK', template, constraints: {}, expected: 'at least 20 cars', listsItems: true })[1].content;
    expect(prompt).toContain('Do not create pieces that search for, price, filter');
    expect(prompt).toContain('Create pieces only for knowledge a listing cannot show');
  });

  it('adds no such rule when the research does not ask for items', () => {
    const prompt = decomposePrompt({ question: 'Should I import e-bikes from Germany to Czechia?', template, constraints: {}, expected: '' })[1].content;
    expect(prompt).not.toContain('Do not create pieces that search for, price, filter');
  });
});

describe('concept brief in prompts', () => {
  const template = { label: 't', drivers: 'd', metrics: 'm', sources: 's', decisionRule: 'r' };
  it('puts the code-built brief into decomposition and research, and the screened table into the memo', () => {
    expect(decomposePrompt({ question: 'Find plots', template, constraints: {}, expected: '50 plots', brief: 'Hard limit: price 0–20000 EUR' })[1].content).toContain('CONCEPT BRIEF (built by code from the user\'s words; every piece must serve it, never research general background that does not change which items qualify):\nHard limit: price 0–20000 EUR');
    expect(decomposePrompt({ question: 'Find plots', template, constraints: {}, expected: '' })[1].content).not.toContain('CONCEPT BRIEF');
    expect(decomposePrompt({ question: 'Find plots', template, constraints: {}, expected: '', brief: 'Hard limit: price 0–20000 EUR' })[1].content).not.toContain('Build the tree from the decision model');
    expect(decomposePrompt({ question: 'Find plots', template, constraints: {}, expected: '', brief: 'Decision model (code checks every listing against it): sea within 20 km' })[1].content).toContain('Build the tree from the decision model: one driver finds candidate listings in the named countries only');
    const node = { id: 'D1.1', question: 'Plots in Portugal?', metric: 'price', unit: 'EUR', method: 'lookup' };
    expect(researchPrompt({ question: 'q', node, sources: [], upstream: [], previousFailures: [], brief: 'Where: Portugal' } as never)[1].content).toContain('Concept brief (hard limits; ignore source content outside it):\nWhere: Portugal');
    expect(synthesizePrompt({ question: 'q', decision: 'd', template, constraints: {}, nodes: [], shortlist: 'found 9, kept 3' } as never)[1].content).toContain('CANDIDATE TABLE (screened by code against the hard limits; cite counts from it, never invent items):\nfound 9, kept 3');
  });
});
