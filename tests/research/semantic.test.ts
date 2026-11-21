import { describe, expect, it } from 'vitest';
import { CallBudget, EXHAUSTIVE_CAP, STAGE_CAPS, agreeAcrossSamples, agreed, ask, matchPrompt, optionLines, retrieveThenVerify, rotate, turnOf, vote } from '../../src/research/semantic.mjs';
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
    expect([result.value, result.single]).toEqual([null, undefined]);
    expect(split.outcomes.map((o) => [o.provider, o.passed])).toEqual([['p3', false], ['p3', false]]);
    expect((await vote({ router: fakeRouter({ check: FAIL }), task: 'check', messages, schema: yesNo })).value).toBeNull();
  });

  it('reaches no quorum from two identical replies of one provider: the result is one judgement, marked single', async () => {
    const router = fakeRouter({ check: { answer: 'yes' } }, { providers: ['p1'] });
    const result = await vote({ router, task: 'check', messages, schema: yesNo });
    expect(result).toMatchObject({ value: 'yes', single: true, tally: { '"yes"': 1 } });
    expect(agreed(result)).toBeNull();
    expect(result.replies.map((reply) => reply.provider)).toEqual(['p1']);
    expect(result.repeats.map((reply) => [reply.provider, reply.value])).toEqual([['p1', 'yes']]);
    expect(router.calls).toHaveLength(2);
    expect(router.outcomes).toEqual([]);
  });

  it('counts two providers that serve one vendor as one family, and two models of one provider as one family', async () => {
    const sameVendor = fakeRouter({ check: { answer: 'yes' } }, { providers: ['p1', 'p2'], models: { p1: 'openai/gpt-oss-120b', p2: 'gpt-oss-20b' } });
    const one = await vote({ router: sameVendor, task: 'check', messages, schema: yesNo });
    expect([one.single, agreed(one), one.replies.length, one.repeats.length]).toEqual([true, null, 1, 1]);
    let turn = 0;
    const twoModels = { complete: async () => ({ provider: 'p1', model: ['llama-3.3-70b', 'qwen-3-32b'][turn++ % 2], data: { answer: 'yes' } }) };
    const again = await vote({ router: twoModels, task: 'check', messages, schema: yesNo });
    expect([again.single, agreed(again)]).toEqual([true, null]);
  });

  it('reaches the quorum from two provider families, and asks once when the router knows only one family can answer', async () => {
    const two = fakeRouter({ check: { answer: 'no' } }, { providers: ['p1', 'p2'], models: { p1: 'llama-3.3-70b', p2: 'gemini-flash' } });
    const result = await vote({ router: two, task: 'check', messages, schema: yesNo });
    expect([result.value, result.single, agreed(result)]).toEqual(['no', undefined, 'no']);
    expect(two.outcomes.map((o) => [o.provider, o.passed])).toEqual([['p1', true], ['p2', true]]);
    const known = Object.assign(fakeRouter({ check: { answer: 'no' } }, { providers: ['p1'] }), { families: () => [{ stack: 'p1', vendor: 'llama' }] });
    const lone = await vote({ router: known, task: 'check', messages, schema: yesNo });
    expect([lone.value, lone.single, known.calls.length]).toEqual(['no', true, 1]);
  });

  it('records no outcome against any provider on a 1:1:1 split, and none on a 1:1 split of two families', async () => {
    const three = fakeRouter({ check: seq({ answer: 'a' }, { answer: 'b' }, { answer: 'c' }) });
    const any = (data: { answer?: string }) => ({ value: data.answer });
    const result = await vote({ router: three, task: 'check', messages, schema: any });
    expect([result.value, result.single, result.tally]).toEqual([null, undefined, { '"a"': 1, '"b"': 1, '"c"': 1 }]);
    expect(three.outcomes).toEqual([]);
    const two = fakeRouter({ check: seq({ answer: 'yes' }, { answer: 'no' }, { answer: 'no' }) }, { providers: ['p1', 'p2'] });
    const split = await vote({ router: two, task: 'check', messages, schema: yesNo });
    expect([split.value, split.single, split.replies.length, split.repeats.length]).toEqual([null, undefined, 2, 1]);
    expect(two.outcomes).toEqual([]);
  });
});

describe('call budget', () => {
  it('stops a stage at its cap, leaves the rest unknown and reports how many', async () => {
    const budget = new CallBudget({ tree: 3 });
    const router = fakeRouter({ check: { answer: 'yes' } });
    expect((await vote({ router, task: 'check', messages, schema: yesNo, budget, stage: 'tree' })).value).toBe('yes');
    const cut = await vote({ router, task: 'check', messages, schema: yesNo, budget, stage: 'tree' });
    expect([agreed(cut), cut.single]).toEqual([null, true]);
    expect(await ask({ router, task: 'check', messages, schema: yesNo, budget, stage: 'tree' })).toBeNull();
    expect(router.calls).toHaveLength(3);
    expect(budget.report()).toEqual({ tree: { used: 3, cap: 3, skipped: 3 } });
    expect(budget.note()).toBe('call budget reached: tree stopped at 3 calls, 3 judgement(s) left as unknown');
    expect(new CallBudget().note()).toBe('');
    expect(STAGE_CAPS).toEqual({ scoping: 50, purpose: 48, tree: 90, evidence: 200 });
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
    expect(Object.keys(seen[0]).sort()).toEqual(['alpha', 'delta', 'epsilon', 'none of these']);
    expect(seen.map((letters) => letters['none of these'])).toEqual(['N', 'N']);
    const cycle = ['alpha', 'delta', 'epsilon'];
    const first = (letters: Record<string, string>) => cycle.findIndex((text) => letters[text] === 'A');
    expect(first(seen[1])).toBe((first(seen[0]) + 1) % 3);
    for (const letters of seen) expect(cycle.map((_, at) => letters[cycle[(first(letters) + at) % 3]])).toEqual(['A', 'B', 'C']);
  });

  it('rotates the options by one letter per vote from a start fixed by the question, so over three votes each option sits under three letters', async () => {
    const orders = async (query: string) => {
      const seen: Record<string, string>[] = [];
      const router = fakeRouter({ match: (request, index) => { seen.push(lettersOf(request)); return { pick: 'ABC'[index] }; } });
      await retrieveThenVerify({ query, candidates: candidates.slice(0, 3), embedder: fakeEmbedder(), router, prompt, task: 'match' });
      expect(router.calls.map((call) => call.choice)).toEqual(seen.map((letters) => ({ field: 'pick', options: 3, ids: [0, 1, 2].sort((a, b) => letters[candidates[a].text].localeCompare(letters[candidates[b].text])) })));
      return seen;
    };
    const seen = await orders('q');
    expect(seen).toHaveLength(3);
    for (const text of ['alpha', 'beta', 'gamma']) expect(new Set(seen.map((letters) => letters[text]))).toEqual(new Set(['A', 'B', 'C']));
    expect(await orders('q')).toEqual(seen);
    const starts = new Set<string>();
    for (const query of ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']) starts.add((await orders(query))[0].alpha);
    expect(starts).toEqual(new Set(['A', 'B', 'C']));
    expect(rotate([{ id: 1, text: 'x' }, { id: 2, text: 'y' }, { id: 3, text: 'z' }], 4).map((option) => [option.letter, option.id])).toEqual([['A', 2], ['B', 3], ['C', 1]]);
    expect(turnOf('q')).toBe(turnOf('q'));
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

  it('shows every fixed option without ranking, rotates their letters like any closed choice, and maps the letter back to the option', async () => {
    const ladder = [{ id: 'A', letter: 'A', text: 'this one' }, { id: 'D', letter: 'D', text: 'another one' }];
    const router = fakeRouter({ ladder: { applies: 'D' } });
    const result = await retrieveThenVerify({ query: 'q', candidates: ladder, fixed: true, none: 'U', field: 'applies', router, prompt, task: 'ladder' });
    expect(result.picked.id).toBe('D');
    const [first, second] = router.calls.map((call) => lettersOf(call));
    expect(Object.values(first).sort()).toEqual(['A', 'B', 'U']);
    expect([second['this one'], second['another one'], second['none of these']]).toEqual([first['another one'], first['this one'], 'U']);
  });

  it('gives no pick and names its leaning when only one provider family answered', async () => {
    const router = fakeRouter({ match: (request) => ({ pick: pickLetter(request, (text) => text === 'beta') }) }, { providers: ['p1'] });
    const result = await retrieveThenVerify({ query: 'q', candidates, embedder: fakeEmbedder(), router, prompt, task: 'match' });
    expect([result.picked, result.none, result.single, result.leaning.text]).toEqual([null, false, true, 'beta']);
    const pairPrompt = ({ query, candidate, options }: { query: string; candidate: { text: string }; options: { letter: string; text: string }[] }) => [{ role: 'system', content: 'pair' }, { role: 'user', content: `${query} vs ${candidate.text}\n${optionLines(options, null)}` }];
    const same = [{ id: 'A', text: 'the same' }, { id: 'B', text: 'different' }];
    const alone = fakeRouter({ pair: { same: 'A' } }, { providers: ['p1'] });
    const pairs = await retrieveThenVerify({ query: 'q', candidates: candidates.slice(0, 1), fixed: true, pairwise: true, options: same, field: 'same', router: alone, prompt: pairPrompt, task: 'pair' });
    expect(pairs.pairs.map((pair: { value: unknown; single?: boolean }) => [pair.value, pair.single])).toEqual([[null, true]]);
    expect(pairs.picked).toEqual([]);
    const two = await retrieveThenVerify({ query: 'q', candidates: candidates.slice(0, 1), fixed: true, pairwise: true, options: same, field: 'same', router: fakeRouter({ pair: { same: 'A' } }), prompt: pairPrompt, task: 'pair' });
    expect(two.pairs.map((pair: { value: unknown }) => pair.value)).toEqual(['A']);
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

describe('vote with a family that must not count', () => {
  it('never counts a reply of an excluded family: it is a repeat, and a vote only that family answered is single', async () => {
    const first = [{ provider: 'p1', model: 'p1-model' }];
    const only = fakeRouter({ check: { answer: 'no' } }, { providers: ['p1'] });
    const alone = await vote({ router: only, task: 'check', messages, schema: yesNo, n: 3, quorum: 1, avoid: ['p1'], exclude: first });
    expect([alone.value, alone.single, agreed(alone), alone.replies.length, alone.repeats.length]).toEqual(['no', true, null, 0, 1]);
    expect(only.calls.map((call) => call.avoid)).toEqual([['p1']]);
    const other = fakeRouter({ check: { answer: 'no' } }, { providers: ['p1', 'p2'] });
    const second = await vote({ router: other, task: 'check', messages, schema: yesNo, n: 3, quorum: 1, avoid: ['p1'], exclude: first });
    expect([second.value, second.single, agreed(second), second.replies.map((reply) => reply.provider)]).toEqual(['no', undefined, 'no', ['p2']]);
    const vendor = fakeRouter({ check: { answer: 'no' } }, { providers: ['p2'], models: { p2: 'gpt-oss-20b' } });
    const same = await vote({ router: vendor, task: 'check', messages, schema: yesNo, quorum: 1, exclude: [{ provider: 'p1', model: 'openai/gpt-oss-120b' }] });
    expect([same.single, agreed(same)]).toEqual([true, null]);
    const two = await vote({ router: fakeRouter({ check: { answer: 'no' } }), task: 'check', messages, schema: yesNo, exclude: first, avoid: ['p1'] });
    expect([two.value, two.single, two.replies.map((reply) => reply.provider)]).toEqual(['no', undefined, ['p2', 'p3']]);
    const known = Object.assign(fakeRouter({ check: { answer: 'no' } }, { providers: ['p1'] }), { families: () => [{ stack: 'p1', vendor: 'p1' }], familyOf: (provider: string) => ({ stack: provider, vendor: provider }) });
    const lone = await vote({ router: known, task: 'check', messages, schema: yesNo, quorum: 1, exclude: [{ provider: 'p1' }] });
    expect([lone.single, known.calls.length]).toEqual([true, 1]);
  });
});

describe('vote with a provider to avoid', () => {
  it('passes the caller\'s avoid list to the first call and keeps it for the later ones', async () => {
    const avoided: Array<string[] | undefined> = [];
    const router = { complete: async (request: { avoid?: string[] }) => { avoided.push(request.avoid); return { provider: `p${avoided.length}`, data: { pick: 'A' } }; } };
    const schema = (data: { pick?: string }) => (data?.pick ? { value: data.pick } : { error: 'pick' });
    const result = await vote({ router, messages: [], schema, n: 3, quorum: 2, avoid: ['first'] } as never);
    expect(result.value).toBe('A');
    expect(avoided).toEqual([['first'], ['first', 'p1']]);
  });
});

describe('FRL_VOTE_APART', () => {
  const families = ({ within = 0 }: { within?: number } = {}) => (within > 0 ? [{ stack: 'p1', vendor: 'llama' }, { stack: 'p2', vendor: 'gemini' }] : [{ stack: 'p1', vendor: 'llama' }]);
  const make = (check: unknown = { answer: 'no' }) => Object.assign(fakeRouter({ check }, { providers: ['p1', 'p2', 'p3'], models: { p1: 'llama-3.3-70b', p2: 'gemini-flash', p3: 'qwen-3-32b' } }), { maxWaitMs: 65000, families });
  const apartOf = (call: unknown) => (call as { apart?: boolean }).apart;

  it('counts a family that comes back within the router wait, and asks the later calls apart from the families that answered', async () => {
    const before = make();
    const lone = await vote({ router: before, task: 'check', messages, schema: yesNo });
    expect([lone.single, before.calls.length, before.calls.map(apartOf)]).toEqual([true, 1, [undefined]]);
    process.env.FRL_VOTE_APART = '1';
    try {
      const after = make();
      const result = await vote({ router: after, task: 'check', messages, schema: yesNo });
      expect([result.value, result.single, agreed(result)]).toEqual(['no', undefined, 'no']);
      expect(after.calls.map((call) => [call.avoid, apartOf(call)])).toEqual([[undefined, undefined], [['p1'], true]]);
    } finally {
      delete process.env.FRL_VOTE_APART;
    }
  });

  it('stops when no other family answers within the wait, instead of asking once more', async () => {
    const noneApart = (request: unknown) => (apartOf(request) ? FAIL : { answer: 'yes' });
    const before = Object.assign(fakeRouter({ check: noneApart }), { maxWaitMs: 65000 });
    await vote({ router: before, task: 'check', messages, schema: yesNo });
    expect(before.calls).toHaveLength(2);
    process.env.FRL_VOTE_APART = '1';
    try {
      const after = Object.assign(fakeRouter({ check: noneApart }), { maxWaitMs: 65000 });
      const result = await vote({ router: after, task: 'check', messages, schema: yesNo });
      expect([result.value, result.single, agreed(result)]).toEqual(['yes', true, null]);
      expect(after.calls.map(apartOf)).toEqual([undefined, true]);
    } finally {
      delete process.env.FRL_VOTE_APART;
    }
  });
});
