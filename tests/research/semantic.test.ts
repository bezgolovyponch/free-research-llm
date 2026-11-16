import { describe, expect, it } from 'vitest';
import { CallBudget, EXHAUSTIVE_CAP, STAGE_CAPS, agreeAcrossSamples, ask, matchPrompt, optionLines, retrieveThenVerify, vote } from '../../src/research/semantic.mjs';
import { FAIL, fakeEmbedder, fakeRouter, lettersOf, pickLetter, seq } from '../helpers/fakes';

const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'user' }];
const yesNo = (data: { answer?: string }) => (['yes', 'no'].includes(String(data?.answer)) ? { value: data.answer } : { error: '"answer" must be yes or no' });
const prompt = ({ query, options, none }: { query: string; options: { letter: string; text: string }[]; none: string }) => [{ role: 'system', content: 'pick' }, { role: 'user', content: `Text: ${query}\n${optionLines(options, none)}` }];
const candidates = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((text, id) => ({ id, text }));

describe('ask', () => {
  it('makes one call with the purpose and temperature of its tier and returns the validated value', async () => {
    const router = fakeRouter({ check: { answer: 'yes' } });
    expect(await ask({ router, task: 'check', tier: 'fast', messages, schema: yesNo })).toEqual({ value: 'yes', provider: 'p1', model: 'p1-model' });
    expect(router.calls[0]).toMatchObject({ purpose: 'purpose-judge', tier: 'fast', temperature: 0, task: 'check' });
    await ask({ router, task: 'check', tier: 'deep', messages, schema: yesNo });
    await ask({ router, task: 'check', tier: 'deep', temperature: 0.7, messages, schema: yesNo });
    expect(router.calls.slice(1).map((call) => [call.purpose, call.temperature])).toEqual([['purpose-draft', 0.2], ['purpose-draft', 0.7]]);
  });

  it('retries an invalid reply once with the validator message, then returns null', async () => {
    const router = fakeRouter({ check: seq({ answer: 'maybe' }, { answer: 'no' }) });
    expect((await ask({ router, task: 'check', messages, schema: yesNo }))!.value).toBe('no');
    expect(router.calls).toHaveLength(2);
    expect(router.calls[1].messages[2].content).toContain('"answer" must be yes or no');
    expect(router.outcomes.map((o) => o.passed)).toEqual([false, true]);
    const stubborn = fakeRouter({ check: { answer: 'maybe' } });
    expect(await ask({ router: stubborn, task: 'check', messages, schema: yesNo })).toBeNull();
    expect(stubborn.calls).toHaveLength(2);
    expect(await ask({ router: fakeRouter({ check: FAIL }), task: 'check', messages, schema: yesNo })).toBeNull();
  });

  it('records one outcome per reply with the purpose and the provider', async () => {
    const router = fakeRouter({ check: { answer: 'yes' } });
    await ask({ router, task: 'check', messages, schema: yesNo });
    expect(router.outcomes).toEqual([{ provider: 'p1', model: 'p1-model', purpose: 'purpose-judge', passed: true }]);
  });
});

describe('vote', () => {
  it('stops as soon as the quorum agrees and avoids the providers already used', async () => {
    const router = fakeRouter({ check: { answer: 'yes' } });
    const result = await vote({ router, task: 'check', messages, schema: yesNo });
    expect(result.value).toBe('yes');
    expect(router.calls).toHaveLength(2);
    expect(router.calls.map((call) => call.avoid)).toEqual([undefined, ['p1']]);
    expect(result.replies.map((reply) => reply.provider)).toEqual(['p1', 'p2']);
  });

  it('takes a third vote on a split, grows the avoid list, and scores each reply against the majority', async () => {
    const router = fakeRouter({ check: seq({ answer: 'yes' }, { answer: 'no' }, { answer: 'no' }) });
    const result = await vote({ router, task: 'check', messages, schema: yesNo });
    expect(result.value).toBe('no');
    expect(result.tally).toEqual({ '"yes"': 1, '"no"': 2 });
    expect(router.calls.map((call) => call.avoid)).toEqual([undefined, ['p1'], ['p1', 'p2']]);
    expect(router.outcomes.map((o) => [o.provider, o.passed])).toEqual([['p1', false], ['p2', true], ['p3', true]]);
  });

  it('gives null without a majority, and an invalid vote counts for nothing', async () => {
    const split = fakeRouter({ check: seq({ answer: 'yes' }, { answer: 'no' }, { answer: 'maybe' }) });
    const result = await vote({ router: split, task: 'check', messages, schema: yesNo });
    expect(result.value).toBeNull();
    expect(split.outcomes.every((o) => o.passed === false)).toBe(true);
    expect((await vote({ router: fakeRouter({ check: FAIL }), task: 'check', messages, schema: yesNo })).value).toBeNull();
  });
});

describe('call budget', () => {
  it('stops a stage at its cap, leaves the rest unknown and reports how many', async () => {
    const budget = new CallBudget({ tree: 3 });
    const router = fakeRouter({ check: { answer: 'yes' } });
    expect((await vote({ router, task: 'check', messages, schema: yesNo, budget, stage: 'tree' })).value).toBe('yes');
    expect((await vote({ router, task: 'check', messages, schema: yesNo, budget, stage: 'tree' })).value).toBeNull();
    expect(await ask({ router, task: 'check', messages, schema: yesNo, budget, stage: 'tree' })).toBeNull();
    expect(router.calls).toHaveLength(3);
    expect(budget.report()).toEqual({ tree: { used: 3, cap: 3, skipped: 3 } });
    expect(budget.note()).toBe('call budget reached: tree stopped at 3 calls, 3 judgement(s) left as unknown');
    expect(new CallBudget().note()).toBe('');
    expect(STAGE_CAPS).toEqual({ scoping: 40, purpose: 24, tree: 90, evidence: 200 });
  });
});

describe('retrieveThenVerify', () => {
  it('shortlists the extra candidates plus the top k by rank, and maps the shuffled letter back', async () => {
    const seen: Record<string, string>[] = [];
    const router = fakeRouter({ match: (request) => { seen.push(lettersOf(request)); return { pick: pickLetter(request, (text) => text === 'delta') }; } });
    const embedder = fakeEmbedder([2, 3, 0, 1]);
    const result = await retrieveThenVerify({ query: 'q', candidates, k: 2, extra: [0], embedder, router, prompt, task: 'match' });
    expect(result.shortlist.map((c: { text: string }) => c.text)).toEqual(['alpha', 'delta', 'epsilon']);
    expect(result.exhaustive).toBe(false);
    expect(result.picked.text).toBe('delta');
    expect(embedder.calls[0]).toMatchObject({ candidates: ['beta', 'gamma', 'delta', 'epsilon'], k: 2 });
    expect(seen[0]).toEqual({ alpha: 'A', delta: 'B', epsilon: 'C', 'none of these': 'N' });
    expect(seen[1]).toEqual({ delta: 'A', epsilon: 'B', alpha: 'C', 'none of these': 'N' });
  });

  it('returns no pick without a majority, on the none option, and on an invalid letter', async () => {
    const split = fakeRouter({ match: seq({ pick: 'A' }, { pick: 'A' }, { pick: 'A' }) });
    expect((await retrieveThenVerify({ query: 'q', candidates, embedder: fakeEmbedder(), router: split, prompt, task: 'match' })).picked).toBeNull();
    const none = await retrieveThenVerify({ query: 'q', candidates, embedder: fakeEmbedder(), router: fakeRouter({ match: { pick: 'N' } }), prompt, task: 'match' });
    expect([none.picked, none.none]).toEqual([null, true]);
    const invalid = fakeRouter({ match: { pick: 'Z' } });
    expect((await retrieveThenVerify({ query: 'q', candidates, embedder: fakeEmbedder(), router: invalid, prompt, task: 'match' })).picked).toBeNull();
    expect(invalid.calls[1].messages[2].content).toContain('must be one of A, B, C or N');
  });

  it('judges every candidate in chunks of 5 without an embedder, capped at 25, then the chunk winners', async () => {
    const many = Array.from({ length: 40 }, (_, id) => ({ id, text: `candidate ${id}` }));
    const router = fakeRouter({ match: (request) => ({ pick: lettersOf(request)['candidate 7'] ?? lettersOf(request)['candidate 21'] ?? 'N' }) });
    const result = await retrieveThenVerify({ query: 'q', candidates: many, embedder: fakeEmbedder(null), router, prompt, task: 'match' });
    expect(result.exhaustive).toBe(true);
    expect(result.shortlist).toHaveLength(EXHAUSTIVE_CAP);
    expect(router.calls).toHaveLength(12);
    expect(Object.keys(lettersOf(router.calls[10]))).toEqual(['candidate 7', 'candidate 21', 'none of these']);
    expect(result.picked.text).toBe('candidate 7');
    const nobody = await retrieveThenVerify({ query: 'q', candidates: many, embedder: null, router: fakeRouter({ match: { pick: 'N' } }), prompt, task: 'match' });
    expect([nobody.picked, nobody.exhaustive]).toEqual([null, true]);
  });

  it('verifies each shortlisted candidate on its own in pairwise mode', async () => {
    const pairPrompt = ({ query, candidate }: { query: string; candidate: { text: string } }) => [{ role: 'system', content: 'pair' }, { role: 'user', content: `${query} vs ${candidate.text}` }];
    const router = fakeRouter({ pair: (request) => ({ answer: request.messages[1].content.endsWith('beta') ? 'yes' : 'no' }) });
    const result = await retrieveThenVerify({ query: 'q', candidates, k: 2, embedder: fakeEmbedder(), router, prompt: pairPrompt, schema: yesNo, pairwise: true, task: 'pair' });
    expect(result.pairs.map((pair: { candidate: { text: string }; value: string }) => [pair.candidate.text, pair.value])).toEqual([['alpha', 'no'], ['beta', 'yes']]);
    expect(router.calls).toHaveLength(4);
  });

  it('keeps fixed options and their own letters for a closed selection', async () => {
    const ladder = [{ id: 'A', letter: 'A', text: 'this one' }, { id: 'D', letter: 'D', text: 'another one' }];
    const router = fakeRouter({ ladder: { applies: 'D' } });
    const result = await retrieveThenVerify({ query: 'q', candidates: ladder, fixed: true, none: 'U', field: 'applies', router, prompt, task: 'ladder' });
    expect(result.picked.id).toBe('D');
    expect(lettersOf(router.calls[0])).toEqual({ 'this one': 'A', 'another one': 'D', 'none of these': 'U' });
    expect(lettersOf(router.calls[1])).toEqual(lettersOf(router.calls[0]));
  });
});

describe('agreeAcrossSamples', () => {
  it('keeps what 2 of 3 samples name, matched by meaning and not by spelling', async () => {
    const router = fakeRouter({ match: (request) => ({ pick: pickLetter(request, (text) => (request.messages[1].content.includes('Text: motor') ? text === 'engine' : false)) }) });
    const agreed = await agreeAcrossSamples({ samples: [['make', 'engine'], ['Make', 'motor'], ['colour']], textOf: (text: string) => text, embedder: fakeEmbedder(), router, prompt: matchPrompt('attribute'), task: 'match' });
    expect(agreed.map((entry: { item: string; samples: number }) => [entry.item, entry.samples])).toEqual([['make', 2], ['engine', 2]]);
  });

  it('never joins two items on the same key alone: the same anchor and direction with another meaning stays a second cluster', async () => {
    const low = (attribute: string) => ({ attribute, direction: 'low', anchor: 'C2' });
    const sameKey = (entry: { anchor: string; direction: string }) => `${entry.anchor}|${entry.direction}`;
    const textOf = (entry: { attribute: string }) => entry.attribute;
    const different = fakeRouter({ match: { pick: 'N' } });
    const apart = await agreeAcrossSamples({ samples: [[low('minimum order size')], [low('delivery time')]], textOf, sameKey, minSamples: 1, embedder: fakeEmbedder(), router: different, prompt: matchPrompt('attribute'), task: 'match' });
    expect(apart.map((entry: { item: { attribute: string }; samples: number }) => [entry.item.attribute, entry.samples])).toEqual([['minimum order size', 1], ['delivery time', 1]]);
    expect(different.calls).toHaveLength(2);
    expect(await agreeAcrossSamples({ samples: [[low('minimum order size')], [low('delivery time')]], textOf, sameKey, embedder: fakeEmbedder(), router: fakeRouter({ match: { pick: 'N' } }), prompt: matchPrompt('attribute'), task: 'match' })).toEqual([]);
    const same = fakeRouter({ match: { pick: 'A' } });
    const joined = await agreeAcrossSamples({ samples: [[low('minimum order size')], [low('smallest order')], [low('Minimum order size')]], textOf, sameKey, embedder: fakeEmbedder(), router: same, prompt: matchPrompt('attribute'), task: 'match' });
    expect(joined.map((entry: { samples: number }) => entry.samples)).toEqual([3]);
    expect(same.calls).toHaveLength(2);
  });
});
