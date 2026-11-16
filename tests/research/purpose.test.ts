import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFLICT_GOAL, CONFLICT_ROLE, PURPOSE, anchorsOf, applyOps, buildPurposeTree, conflictAsked, conflictGoalOf, critique, draftGoals, drawImplications, drawPurpose, ensureAskedConflict, mergeDuplicates, needsConfirmation, notModelledOf, numbersIn, openEntries, refineGoal, thresholdsOf, traceGoal, traceables } from '../../src/research/purpose.mjs';
import { CallBudget } from '../../src/research/semantic.mjs';
import { clausesOf } from '../../src/research/strategy.mjs';
import { FAIL, fakeEmbedder, fakeRouter, pickLetter, seq } from '../helpers/fakes';

const MECHANISMS = ['M1', 'M2', 'M3', 'M4', 'M5'];
const refined = { refine: 'AND', questions: [{ q: 'Is it stated?', checker: 'page', threshold: null, note: null }], obstacles: [{ obstacle: 'It is missing', checker: 'page', threshold: null }] };

describe('the stored knowledge holds mechanisms, not word lists', () => {
  it('has five mechanisms with ids and sources, the Admiralty scales, and no cue or word list', () => {
    const raw = JSON.parse(readFileSync(new URL('../../src/research/purpose.json', import.meta.url), 'utf8'));
    expect(Object.keys(raw).sort()).toEqual(['admiralty', 'conflictObstacle', 'mechanisms']);
    expect(raw.mechanisms.map((m: { id: string }) => m.id)).toEqual(MECHANISMS);
    expect(raw.mechanisms.every((m: { test: string; basis: string; checker: string }) => m.test && m.basis && m.checker)).toBe(true);
    expect(JSON.stringify(raw)).not.toMatch(/cues?"|words"|stems?"|stop"/i);
    expect(raw.conflictObstacle).toBe('M5');
  });

  it('splits a question into clauses at punctuation only, with stable ids', () => {
    expect(clausesOf('plots but also cheap, so no air condition; near the sea')).toEqual(['plots but also cheap', 'so no air condition', 'near the sea']);
    expect(clausesOf('cars near the city, hatchback, , cheap;')).toEqual(['cars near the city', 'hatchback', 'cheap']);
    expect(anchorsOf('cars near the city, hatchback').map((anchor: { id: string; text: string }) => `${anchor.id} ${anchor.text}`)).toEqual(['C1 cars near the city', 'C2 hatchback']);
    expect(anchorsOf('cheap plots, near the sea', 'sea within 20 km')).toEqual([
      { id: 'C1', kind: 'clause', text: 'cheap plots' },
      { id: 'C2', kind: 'clause', text: 'near the sea' },
      { id: 'H1', kind: 'hint', text: 'sea within 20 km' },
    ]);
  });
});

describe('whether cheap and valuable are asked at once is voted on clause ids', () => {
  const cases = [
    { text: 'Find plots to buy, affordable and valuable, with future upside', reply: { cost: 'C2', worth: 'C2' } },
    { text: 'Najdi ojetý vůz, za nízkou cenu, a zároveň spolehlivý', reply: { cost: 'C2', worth: 'C3' } },
    { text: 'Finde Lieferanten, mit niedrigem Preis, und nachweislich guter Qualität', reply: { cost: 'C2', worth: 'C3' } },
  ];

  it('is true when a majority names a clause for both, in any language, with no cue list', async () => {
    for (const entry of cases) {
      const router = fakeRouter({ conflict: entry.reply });
      const result = await conflictAsked({ router }, anchorsOf(entry.text));
      expect(result).toMatchObject({ asked: true, cost: entry.reply.cost, worth: entry.reply.worth });
      expect(router.calls).toHaveLength(2);
      expect(router.calls[0]).toMatchObject({ tier: 'fast', purpose: 'purpose-judge' });
    }
  });

  it('is false when the majority finds only one side, and an invented clause id counts as none', async () => {
    const anchors = anchorsOf('Find the most valuable paintings, in the museum');
    expect((await conflictAsked({ router: fakeRouter({ conflict: { cost: null, worth: 'C1' } }) }, anchors)).asked).toBe(false);
    expect((await conflictAsked({ router: fakeRouter({ conflict: { cost: 'C9', worth: 'C1' } }) }, anchors)).asked).toBe(false);
  });

  it('counts a clause that asks for the most worth per unit of money as cost and worth at once, and a worth-only question stays no', async () => {
    const byContract = (clause: string | null) => (request: { messages: { content: string }[] }) => {
      const contract = request.messages[0].content;
      const tradesOff = contract.includes('limits, minimises or trades off what is paid') && contract.includes('the most worth per unit of money is a cost clause') && contract.includes('One clause may be both cost and worth');
      return { cost: tradesOff ? clause : null, worth: 'C2' };
    };
    const suppliers = anchorsOf('Find the wholesale branded second hand clothing providers, with highest price/value ratio, proven good quality');
    expect(suppliers[1]).toMatchObject({ id: 'C2', text: 'with highest price/value ratio' });
    const asked = await conflictAsked({ router: fakeRouter({ conflict: byContract('C2') }) }, suppliers);
    expect(asked).toMatchObject({ asked: true, cost: 'C2', worth: 'C2', votes: { yes: 2 } });
    const worthOnly = anchorsOf('Find second hand clothing providers, of proven good quality');
    const no = await conflictAsked({ router: fakeRouter({ conflict: byContract(null) }) }, worthOnly);
    expect(no).toMatchObject({ asked: false, cost: null, worth: null, votes: { no: 2 } });
    expect(conflictGoalOf(ensureAskedConflict({ conflict: no, goals: [] }))).toBeNull();
  });

  it('is undecided without a majority, and an undecided vote adds no goal: the branch exists only when the question asks for it', async () => {
    const anchors = anchorsOf('cheap things, good things');
    const undecided = await conflictAsked({ router: fakeRouter({ conflict: seq({ cost: 'C1', worth: 'C2' }, { cost: null, worth: null }, FAIL) }) }, anchors);
    expect(undecided.asked).toBeNull();
    const tree = ensureAskedConflict({ conflict: undecided, goals: [] });
    expect(conflictGoalOf(tree)).toBeNull();
    expect(openEntries(tree)).toEqual([]);
  });
});

describe('the "why still cheap" goal is kept by code', () => {
  const asked = { asked: true, votes: { yes: 2 }, cost: 'C1', worth: 'C2' };

  it('inserts the goal with every mechanism, a question per mechanism and the real-defect obstacle', () => {
    const tree = ensureAskedConflict({ conflict: asked, goals: [{ id: 'G1', goal: 'Quality', questions: [{ id: 'Q1', q: 'x', checker: 'page' }], obstacles: [] }] });
    const goal = conflictGoalOf(tree);
    expect(goal).toMatchObject({ id: 'G2', goal: CONFLICT_GOAL, role: CONFLICT_ROLE, protected: true, refine: 'OR', state: 'kept', anchors: ['C1', 'C2'], trace: { kind: 'rule', text: 'conflict' } });
    expect(goal.hypotheses.map((h: { id: string }) => h.id)).toEqual(MECHANISMS);
    expect(goal.hypotheses.map((h: { hypothesis: string }) => h.hypothesis)).toEqual(PURPOSE.mechanisms.map((m: { label: string }) => m.label));
    expect(goal.questions.map((q: { id: string; mechanism: string }) => [q.id, q.mechanism])).toEqual([['Q2', 'M1'], ['Q3', 'M2'], ['Q4', 'M3'], ['Q5', 'M4'], ['Q6', 'M5']]);
    expect(goal.obstacles).toEqual([{ id: 'O1', obstacle: PURPOSE.mechanisms[4].label, checker: 'consensus', threshold: null, mechanism: 'M5', protected: true }]);
    expect(ensureAskedConflict(tree)).toEqual(tree);
  });

  it('completes a kept goal to the five mechanisms, keeps its own wording and at most 2 confirmed extra hypotheses', () => {
    const kept = { conflict: asked, goals: [{ id: 'G1', role: CONFLICT_ROLE, goal: 'Why cheap', state: 'kept', questions: [], obstacles: [], hypotheses: [{ id: 'M3', hypothesis: 'own words' }, { id: 'X1', hypothesis: 'seller in a hurry', confirmed: true }, { id: 'X2', hypothesis: 'unconfirmed' }, { id: 'X3', hypothesis: 'b', confirmed: true }, { id: 'X4', hypothesis: 'c', confirmed: true }] }] };
    const goal = conflictGoalOf(ensureAskedConflict(kept));
    expect(goal.hypotheses.map((h: { id: string }) => h.id)).toEqual([...MECHANISMS, 'X1', 'X3']);
    expect(goal.hypotheses[2].hypothesis).toBe('own words');
    expect(goal.goal).toBe('Why cheap');
  });

  it('adds nothing when the question does not ask for both', () => {
    expect(ensureAskedConflict({ conflict: { asked: false }, goals: [] }).goals).toEqual([]);
  });

  it('refuses the critique drop of the conflict goal and of an obstacle, and logs it', async () => {
    const log: string[] = [];
    const tree = ensureAskedConflict({ conflict: asked, goals: [{ id: 'G1', goal: 'Quality', state: 'kept', anchor: 'C2', questions: [{ id: 'Q1', q: 'x', checker: 'page' }], obstacles: [{ id: 'O9', obstacle: 'none', checker: 'page' }] }], ops: { applied: [], refused: [] } });
    const conflict = conflictGoalOf(tree);
    const router = fakeRouter({ critique: { ops: [{ op: 'drop', id: conflict.id, reason: 'A' }, { op: 'drop', id: 'O9', reason: 'A' }, { op: 'checker', id: conflict.questions[0].id, checker: 'code' }, { op: 'checker', id: 'O9', checker: 'code' }, { op: 'drop', id: 'G77', reason: 'A' }, { op: 'explode' }] } });
    const ops = await critique({ router }, tree, []);
    expect(ops).toHaveLength(4);
    const out = await applyOps({ router, log: (line: string) => log.push(line) }, tree, ops);
    expect(out.goals).toEqual(tree.goals);
    expect(out.ops.applied).toEqual([]);
    expect(out.ops.refused.map((r: { why: string }) => r.why)).toEqual([`"${CONFLICT_GOAL}" is protected because the question asks for it`, 'an obstacle is a protected node', `"${CONFLICT_GOAL}" is protected because the question asks for it`, 'an obstacle is a protected node']);
    expect(log).toHaveLength(4);
    expect(log[0]).toContain('critique operation refused: drop');
    expect(conflictGoalOf(ensureAskedConflict(out)).hypotheses).toHaveLength(5);
  });

  it('puts the goal back when a tree lost it', () => {
    const tree = ensureAskedConflict({ conflict: asked, goals: [] });
    const lost = { ...tree, goals: [] };
    expect(conflictGoalOf(ensureAskedConflict(lost)).hypotheses.map((h: { id: string }) => h.id)).toEqual(MECHANISMS);
  });
});

describe('every goal is traced to what was asked by a voted selection', () => {
  const anchors = anchorsOf('Find wholesale providers, with the highest price/value ratio, for a small shop');
  const purpose = { id: 'P', text: 'a small shop owner wants stock that sells' };
  const implications = [{ id: 'I1', attribute: 'minimum order size', direction: 'low', anchor: 'C3', source: 'inferred' }];
  const options = traceables(anchors, purpose, implications);
  const tracer = (wanted: string | null, relation: string) => (request: { messages: { content: string }[] }) => ({ anchor: wanted ? pickLetter(request, (text) => text.includes(wanted)) : 'N', relation });

  it('offers the claimed anchor plus the 3 nearest by embedding rank, and keeps a goal voted S with its trace', async () => {
    const router = fakeRouter({ trace: tracer('price/value', 'S') });
    const embedder = fakeEmbedder([3, 0, 1, 2]);
    const goal = await traceGoal({ router, embedder }, { goal: 'Compare price per kilogram', anchor: 'C2' }, options);
    expect(goal).toMatchObject({ state: 'kept', trace: { id: 'C2', text: 'with the highest price/value ratio' } });
    expect(embedder.calls[0].candidates).toHaveLength(4);
    expect(embedder.calls[0].k).toBe(3);
    expect(router.userText('trace')).toContain('N) none of these statements');
    expect(router.calls).toHaveLength(2);
  });

  it('proposes a goal voted N, marks X as a conflict with what it contradicts, and drops R', async () => {
    const embedder = fakeEmbedder();
    const proposed = await traceGoal({ router: fakeRouter({ trace: tracer(null, 'S') }), embedder }, { goal: 'Secure financing', anchor: 'C1' }, options);
    expect(proposed).toMatchObject({ state: 'proposed', trace: null });
    const conflict = await traceGoal({ router: fakeRouter({ trace: tracer('minimum order size', 'X') }), embedder }, { goal: 'Suppliers with large capacity', anchor: 'I1' }, options);
    expect(conflict).toMatchObject({ state: 'conflict', trace: { id: 'I1' }, reason: 'contradicts I1: minimum order size: low is preferred' });
    const restated = await traceGoal({ router: fakeRouter({ trace: tracer('wholesale', 'R') }), embedder }, { goal: 'Find wholesale providers', anchor: 'C1' }, options);
    expect(restated.state).toBe('dropped');
    const split = await traceGoal({ router: fakeRouter({ trace: seq({ anchor: 'A', relation: 'S' }, { anchor: 'A', relation: 'X' }, { anchor: 'N' }) }), embedder }, { goal: 'Unclear', anchor: 'C1' }, options);
    expect(split).toMatchObject({ state: 'proposed', reason: 'no majority on what it traces to: confirm or drop it' });
    expect(openEntries({ goals: [proposed, conflict, { ...restated, id: 'G9' }] }).map((e: { state: string }) => e.state)).toEqual(['proposed', 'conflict']);
  });

  it('never traces a protected goal: its trace is the rule', async () => {
    const router = fakeRouter({});
    expect((await traceGoal({ router }, { goal: CONFLICT_GOAL, role: CONFLICT_ROLE, protected: true }, options)).trace).toEqual({ kind: 'rule', text: 'conflict' });
    expect(router.calls).toEqual([]);
  });
});

describe('numbers live in a structured field and are compared with the user numbers', () => {
  it('reads numbers in the forms people type', () => {
    expect(numbersIn('within 300km, up to 65 000 CZK or 65,000 and 1,5 %')).toEqual([300, 65000, 65, 65000, 1.5]);
  });

  it('labels a threshold asked, sourced from the cited quote, or an assumption that is never hard', () => {
    const notes = [{ id: 'N1', url: 'https://stats.example.org/a', quote: 'Bales weigh 450 kg on average.', label: 'bale weight' }];
    const tree = { goals: [{ id: 'G1', goal: 'Stay near the city', notes: ['N1'], questions: [
      { id: 'Q1', q: 'Is it within the distance?', checker: 'code', threshold: { op: '<=', value: 300, unit: 'km' }, note: null },
      { id: 'Q2', q: 'Is one bale the minimum order?', checker: 'page', threshold: { op: '<=', value: 450, unit: 'kg' }, note: 'N1' },
      { id: 'Q3', q: 'Does demand grow fast enough?', checker: 'statistic', threshold: { op: '>=', value: 3, unit: '%' }, note: null },
      { id: 'Q4', q: 'Is it stated?', checker: 'page', threshold: null, note: null },
    ], obstacles: [{ id: 'O1', obstacle: 'No road nearby', checker: 'official', threshold: { op: '>', value: 500, unit: 'm' } }] }] };
    const { thresholds, tree: out } = thresholdsOf(tree, { question: 'plots within 300km of the city, price up to 65000CZK', notes });
    expect(thresholds.map((t: { node: string; source: string; hard: boolean }) => [t.node, t.source, t.hard])).toEqual([['Q1', 'asked', true], ['Q2', 'sourced', true], ['Q3', 'assumption', false], ['O1', 'assumption', false]]);
    expect(thresholds[1]).toMatchObject({ url: 'https://stats.example.org/a', note: 'N1' });
    expect(out.thresholds).toEqual(thresholds);
    expect(openEntries(out).map((e: { id: string; kind: string }) => [e.id, e.kind])).toEqual([['Q3', 'threshold'], ['O1', 'threshold']]);
    expect(needsConfirmation(out)).toBe(true);
    expect(needsConfirmation({ ...out, confirmedAt: '2026-11-16T00:00:00Z' })).toBe(false);
  });

  it('records a digit in free text that is neither the user number nor the threshold field', () => {
    const tree = { goals: [{ id: 'G1', goal: 'Grow 10 percent a year', questions: [
      { id: 'Q1', q: 'Is the price within 10 % of comparables under 65000?', checker: 'code', threshold: null },
      { id: 'Q2', q: 'Is it under 500 m from a road?', checker: 'code', threshold: { op: '<', value: 500, unit: 'm' } },
    ], obstacles: 'missing' }] };
    const out = thresholdsOf(tree, { question: 'price up to 65000CZK' }).tree;
    expect(out.goals[0].inventedNumber).toEqual([10]);
    expect(out.goals[0].questions[0].inventedNumber).toEqual([10]);
    expect(out.goals[0].questions[1].inventedNumber).toBeUndefined();
    expect(out.goals[0].obstacles).toBe('missing');
  });
});

describe('a number nobody stated never stays in goal, question or obstacle text', () => {
  const anchors = anchorsOf('Find plots to buy, price up to 65000CZK');
  const purpose = { id: 'P', text: 'a buyer wants a plot' };
  const said = 'Find plots to buy, price up to 65000CZK\nsea within 20 km\nat most 3 hours by car';
  const withNumber = { refine: 'AND', questions: [{ q: 'Is the price in the top 10% of listings?', checker: 'code', threshold: null }], obstacles: [{ obstacle: 'Cost exceeds €5,000 per hectare', checker: 'page', threshold: { op: '>', value: 5000, unit: 'EUR/ha' } }] };
  const fixed = { refine: 'AND', questions: [{ q: 'Is the price in the top share of listings?', checker: 'code', threshold: { op: '>=', value: 10, unit: '%' } }], obstacles: withNumber.obstacles };

  it('asks once more with the number named, and takes a retry that moved it into the threshold', async () => {
    const router = fakeRouter({ refine: seq(withNumber, fixed) });
    const out = await refineGoal({ router }, { goal: 'Low price', said });
    expect(router.count('refine')).toBe(2);
    expect(router.userText('refine', 1)).toContain('holds a number nobody stated (10): move it into "threshold" and write the text without it');
    expect(out.questions).toEqual([{ q: 'Is the price in the top share of listings?', checker: 'code', threshold: { op: '>=', value: 10, unit: '%' }, note: null }]);
    expect(out.obstacles[0].obstacle).toBe('Cost exceeds €5,000 per hectare');
    const goals = fakeRouter({ goals: seq({ goals: [{ goal: 'Grow 10 percent a year', anchor: 'C1' }] }, { goals: [{ goal: 'Grow every year', anchor: 'C1' }] }) });
    expect(await draftGoals({ router: goals }, { anchors, purpose, said })).toEqual([{ goal: 'Grow every year', anchor: 'C1', notes: [] }]);
    expect(goals.count('goals')).toBe(2);
  });

  it('moves a number that is still there after the retry into an assumption threshold, which is never hard', async () => {
    const router = fakeRouter({ 'number-kind': { kind: 'A' }, refine: { ...withNumber, obstacles: [{ obstacle: 'Bale size is below 38 kg', checker: 'page', threshold: { op: '<', value: 12, unit: 'kg' } }] } });
    const out = await refineGoal({ router }, { goal: 'Low price', said });
    expect(router.count('refine')).toBe(2);
    expect(out.questions).toEqual([{ q: 'Is the price in the top % of listings?', checker: 'code', threshold: { op: null, value: 10, unit: '', source: 'assumption', moved: true }, note: null, movedNumber: [10] }]);
    expect(out.obstacles).toEqual([{ obstacle: 'Bale size is below kg', checker: 'page', threshold: { op: '<', value: 12, unit: 'kg' }, movedNumber: [38] }]);
    expect(router.count('number-kind')).toBe(4);
    expect(router.userText('number-kind')).toContain('Sentence: Is the price in the top [[10]]% of listings?');
    const drafted = await draftGoals({ router: fakeRouter({ 'number-kind': { kind: 'A' }, goals: { goals: [{ goal: 'Grow 10 percent a year', anchor: 'C1' }] } }) }, { anchors, purpose, said });
    expect(drafted).toEqual([{ goal: 'Grow percent a year', anchor: 'C1', notes: [], threshold: { op: null, value: 10, unit: '', source: 'assumption', moved: true }, movedNumber: [10] }]);
    const tree = thresholdsOf({ goals: [{ id: 'G1', ...drafted[0], questions: out.questions.map((q: object, i: number) => ({ id: `Q${i + 1}`, ...q })), obstacles: out.obstacles.map((o: object, i: number) => ({ id: `O${i + 1}`, ...o })) }] }, { question: said }).tree;
    expect(tree.thresholds.map((t: { node: string; value: number; source: string; hard: boolean }) => [t.node, t.value, t.source, t.hard])).toEqual([['G1', 10, 'assumption', false], ['Q1', 10, 'assumption', false], ['O1', 12, 'assumption', false]]);
    expect([tree.goals[0], ...tree.goals[0].questions, ...tree.goals[0].obstacles].some((node: { inventedNumber?: number[] }) => node.inventedNumber)).toBe(false);
    expect(openEntries(tree).map((e: { id: string; text: string }) => [e.id, e.text])).toEqual([['G1', '10'], ['Q1', '10'], ['O1', '< 12 kg']]);
  });

  it('keeps a number the user typed, in the question, a hint or an earlier answer, and a number of the cited quote', async () => {
    const notes = [{ id: 'N1', url: 'https://stats.example.org/a', quote: 'Bales weigh 450 kg on average.', label: 'bale weight' }];
    const reply = { refine: 'AND', questions: [{ q: 'Is the price at most 65 000 CZK?', checker: 'page', threshold: null }, { q: 'Is the sea within 20 km and 3 hours away?', checker: 'code', threshold: null }, { q: 'Is one bale of 450 kg the minimum order?', checker: 'page', threshold: null, note: 'N1' }], obstacles: [{ obstacle: 'A road is within 500 m', checker: 'official', threshold: { op: '<', value: 500, unit: 'm' } }] };
    const router = fakeRouter({ refine: reply });
    const out = await refineGoal({ router }, { goal: 'Low price', notes, said });
    expect(router.count('refine')).toBe(1);
    expect(out.questions.map((q: { q: string }) => q.q)).toEqual(reply.questions.map((q) => q.q));
    expect(out.obstacles[0].obstacle).toBe('A road is within 500 m');
    const uncited = await refineGoal({ router: fakeRouter({ refine: reply }) }, { goal: 'Low price', notes, said, cited: [] });
    expect(uncited.questions[2].q).toBe('Is one bale of 450 kg the minimum order?');
    const kept = await draftGoals({ router: fakeRouter({ goals: { goals: [{ goal: 'Stay under 65000 CZK', anchor: 'C2' }] } }) }, { anchors, purpose, said });
    expect(kept).toEqual([{ goal: 'Stay under 65000 CZK', anchor: 'C2', notes: [] }]);
    const answered = thresholdsOf({ goals: [{ id: 'G1', goal: 'Reach it in 3 hours', questions: [{ id: 'Q1', q: 'Does one bale weigh 450 kg?', checker: 'page', threshold: null, note: 'N1' }], obstacles: [] }] }, { question: 'plots', answers: ['at most 3 hours by car'], notes }).tree;
    expect(answered.goals[0].inventedNumber).toBeUndefined();
    expect(answered.goals[0].questions[0].inventedNumber).toBeUndefined();
  });

  it('moves only a quantity: a number in a name, a code or a year is voted to stay and is not counted as invented, and no majority leaves the text', async () => {
    const marked = (request: { messages: { content: string }[] }) => request.messages[1].content.match(/\[\[(.+?)\]\]/)![1];
    const kinds: Record<string, unknown> = { '9001': { kind: 'B' }, '1.2': { kind: 'B' }, '4': { kind: 'B' }, '2000': { kind: 'B' }, '2019': { kind: 'C' }, '5': { kind: 'A' } };
    const byMeaning = (request: { messages: { content: string }[] }, index: number) => (marked(request) === '77' ? [{ kind: 'A' }, { kind: 'B' }, FAIL][index % 3] : kinds[marked(request)]);
    const reply = { refine: 'AND', questions: [
      { q: 'Is an ISO 9001 certificate listed?', checker: 'page', threshold: null },
      { q: 'Is the 1.2 MPi engine of the Golf 4 reliable since 2019?', checker: 'consensus', threshold: null },
      { q: 'Is a road within 5 km of the Natura 2000 area?', checker: 'official', threshold: null },
    ], obstacles: [{ obstacle: 'Batch 77 was recalled', checker: 'page', threshold: null }] };
    const router = fakeRouter({ refine: reply, 'number-kind': byMeaning });
    const out = await refineGoal({ router }, { goal: 'Proven quality', said });
    expect(router.count('refine')).toBe(2);
    expect(router.calls.find((call: { task?: string }) => call.task === 'number-kind')).toMatchObject({ tier: 'fast', purpose: 'purpose-judge' });
    expect(out.questions).toEqual([
      { q: 'Is an ISO 9001 certificate listed?', checker: 'page', threshold: null, note: null, keptNumber: [9001] },
      { q: 'Is the 1.2 MPi engine of the Golf 4 reliable since 2019?', checker: 'consensus', threshold: null, note: null, keptNumber: [1.2, 4, 2019] },
      { q: 'Is a road within km of the Natura 2000 area?', checker: 'official', threshold: { op: null, value: 5, unit: '', source: 'assumption', moved: true }, note: null, movedNumber: [5], keptNumber: [2000] },
    ]);
    expect(out.obstacles).toEqual([{ obstacle: 'Batch 77 was recalled', checker: 'page', threshold: null }]);
    const tree = thresholdsOf({ goals: [{ id: 'G1', goal: 'Proven quality', questions: out.questions.map((q: object, i: number) => ({ id: `Q${i + 1}`, ...q })), obstacles: out.obstacles.map((o: object, i: number) => ({ id: `O${i + 1}`, ...o })) }] }, { question: said }).tree;
    expect(tree.goals[0].questions.map((q: { inventedNumber?: number[] }) => q.inventedNumber)).toEqual([undefined, undefined, undefined]);
    expect(tree.goals[0].obstacles[0].inventedNumber).toEqual([77]);
    expect(tree.thresholds.map((t: { node: string; value: number; source: string; hard: boolean }) => [t.node, t.value, t.source, t.hard])).toEqual([['Q3', 5, 'assumption', false]]);
  });

  it('reads a thousands-separated number as one number, and moves the number of a goal the critique adds', async () => {
    const tree = { goals: [{ id: 'G1', goal: 'Low entry cost', questions: [{ id: 'Q1', q: 'Is the cost at most €5,000?', checker: 'page', threshold: { op: '<=', value: 5000, unit: 'EUR' } }], obstacles: [] }], ops: { applied: [], refused: [] } };
    expect(thresholdsOf(tree, { question: 'plots' }).tree.goals[0].questions[0].inventedNumber).toBeUndefined();
    const candidates = [{ id: 'C1', text: 'plots to buy' }];
    const router = fakeRouter({ 'number-kind': { kind: 'A' }, critique: { ops: [{ op: 'add', goal: 'Visitors above 500,000 a year', anchor: 'C1' }] }, refine: refined, trace: { anchor: 'N' } });
    const ops = await critique({ router }, tree, candidates, { said });
    expect(router.count('critique')).toBe(2);
    expect(ops).toEqual([{ op: 'add', goal: 'Visitors above a year', anchor: 'C1', threshold: { op: null, value: 500000, unit: '', source: 'assumption', moved: true }, movedNumber: [500000] }]);
    const out = await applyOps({ router, embedder: fakeEmbedder() }, tree, ops, { candidates, said });
    expect(out.goals[1]).toMatchObject({ id: 'G2', goal: 'Visitors above a year', threshold: { value: 500000, source: 'assumption' } });
    expect(openEntries(thresholdsOf(out, { question: said }).tree).map((e: { id: string; kind: string }) => [e.id, e.kind])).toEqual([['G2', 'goal'], ['Q1', 'threshold'], ['G2', 'threshold']]);
  });
});

describe('the critique returns operations that code applies or refuses', () => {
  const goals = [
    { id: 'G1', goal: 'A scenic location', state: 'kept', anchor: 'C1', questions: [{ id: 'Q1', q: 'a', checker: 'page' }], obstacles: [] },
    { id: 'G2', goal: 'Beautiful surroundings', state: 'kept', anchor: 'C1', questions: [{ id: 'Q2', q: 'b', checker: 'official' }], obstacles: [] },
    { id: 'G3', goal: 'Low entry cost', state: 'kept', anchor: 'C2', questions: [{ id: 'Q3', q: 'c', checker: 'page' }], obstacles: [] },
  ];
  const tree = { goals, ops: { applied: [], refused: [] } };

  it('applies a merge only when the two goals are voted to be one objective', async () => {
    const same = await applyOps({ router: fakeRouter({ 'same-goal': { same: 'A' } }) }, tree, [{ op: 'merge', a: 'G1', b: 'G2' }]);
    expect(same.goals.map((g: { id: string }) => g.id)).toEqual(['G1', 'G3']);
    expect(same.goals[0].questions.map((q: { id: string }) => q.id)).toEqual(['Q1', 'Q2']);
    expect(same.goals[0].merged).toEqual(['G2']);
    const different = await applyOps({ router: fakeRouter({ 'same-goal': { same: 'B' } }) }, tree, [{ op: 'merge', a: 'G1', b: 'G3' }]);
    expect(different.goals).toHaveLength(3);
    expect(different.ops.refused[0].why).toBe('the two goals were not voted to be one objective');
    const split = await applyOps({ router: fakeRouter({ 'same-goal': seq({ same: 'A' }, { same: 'B' }, FAIL) }) }, tree, [{ op: 'merge', a: 'G1', b: 'G2' }]);
    expect(split.goals).toHaveLength(3);
  });

  it('finds duplicates among the 2 nearest neighbours of each goal and merges them', async () => {
    const router = fakeRouter({ 'same-goal': (request: { messages: { content: string }[] }) => ({ same: request.messages[1].content.includes('scenic') && request.messages[1].content.includes('Beautiful') ? 'A' : 'B' }) });
    const out = await mergeDuplicates({ router, embedder: fakeEmbedder() }, tree);
    expect(out.goals.map((g: { id: string }) => g.id)).toEqual(['G1', 'G3']);
    expect(out.ops.applied).toEqual([{ op: 'merge', a: 'G1', b: 'G2', by: 'duplicate check' }]);
  });

  it('lists a clause left with no goal as not modelled after a drop', async () => {
    const anchors = anchorsOf('a scenic location, low entry cost');
    const out = await applyOps({ router: fakeRouter({}) }, tree, [{ op: 'drop', id: 'G3', reason: 'B' }, { op: 'checker', id: 'Q1', checker: 'official' }]);
    expect(out.ops.applied).toEqual([{ op: 'drop', id: 'G3', reason: 'B', goal: 'Low entry cost', anchor: 'C2' }, { op: 'checker', id: 'Q1', checker: 'official' }]);
    expect(out.goals[0].questions[0].checker).toBe('official');
    expect(notModelledOf(tree, anchors)).toEqual([]);
    expect(notModelledOf(out, anchors)).toEqual([{ id: 'C2', text: 'low entry cost' }]);
  });

  it('sends an added goal through refine and trace before it joins the tree', async () => {
    const candidates = [{ id: 'C1', text: 'a scenic location' }];
    const router = fakeRouter({ refine: refined, trace: { anchor: 'N' } });
    const out = await applyOps({ router, embedder: fakeEmbedder() }, tree, [{ op: 'add', goal: 'Marketing plan', anchor: 'C1' }], { candidates });
    expect(out.goals[3]).toMatchObject({ id: 'G4', goal: 'Marketing plan', state: 'proposed' });
    expect(out.goals[3].questions[0].id).toBe('Q4');
    expect(out.ops.applied).toEqual([{ op: 'add', goal: 'Marketing plan', anchor: 'C1', state: 'proposed' }]);
  });
});

describe('a goal is refined into questions with one checker each', () => {
  it('asks once more for an obstacle, then stores the goal with obstacles missing', async () => {
    const bare = { ...refined, obstacles: [] };
    const router = fakeRouter({ refine: bare });
    const out = await refineGoal({ router }, { goal: 'g', anchorText: 'a' });
    expect(router.count('refine')).toBe(2);
    expect(router.userText('refine', 1)).toContain('Name at least one obstacle');
    expect(out.obstacles).toBe('missing');
    expect((await refineGoal({ router: fakeRouter({ refine: seq(bare, refined) }) }, { goal: 'g' })).obstacles).toHaveLength(1);
  });

  it('drops a question without a checker of the closed set and keeps numbers in the threshold field only', async () => {
    const router = fakeRouter({ refine: { refine: 'or', questions: [{ q: 'ok', checker: 'PAGE', threshold: { op: '<=', value: '12,5', unit: 'km' }, note: 'N9' }, { q: 'bad', checker: 'oracle' }, { q: 'no number', checker: 'code', threshold: { op: '~', value: 3 } }], obstacles: [{ obstacle: 'o', checker: 'official' }] } });
    const out = await refineGoal({ router }, { goal: 'g' });
    expect(out.refine).toBe('OR');
    expect(out.questions).toEqual([{ q: 'ok', checker: 'page', threshold: { op: '<=', value: 12.5, unit: 'km' }, note: null }, { q: 'no number', checker: 'code', threshold: null, note: null }]);
  });
});

describe('the purpose is the sample nearest to the others', () => {
  const anchors = anchorsOf('wholesale providers, for a small shop');
  const samples = [{ who: 'a', outcome: 'first', why: 'x', anchors: ['C1'] }, { who: 'b', outcome: 'second', why: 'y', anchors: ['C2', 'C1'] }, { who: 'c', outcome: 'third', why: 'z', anchors: ['C2'] }];

  it('takes the medoid by embedding rank, and the sample sharing most anchors without an embedder', async () => {
    const byRank = await drawPurpose({ router: fakeRouter({ purpose: seq(...samples) }), embedder: fakeEmbedder(undefined, 2) }, anchors);
    expect(byRank).toMatchObject({ id: 'P', outcome: 'third', samples: 3 });
    const byAnchors = await drawPurpose({ router: fakeRouter({ purpose: seq(...samples) }), embedder: fakeEmbedder(null) }, anchors);
    expect(byAnchors.outcome).toBe('second');
  });

  it('has no purpose when fewer than 2 samples name a real anchor', async () => {
    const router = fakeRouter({ purpose: seq(samples[0], { who: 'b', outcome: 'x', anchors: ['C9'] }, { who: 'c', outcome: '', anchors: ['C1'] }) });
    expect(await drawPurpose({ router, embedder: fakeEmbedder() }, anchors)).toBeNull();
    const built = await buildPurposeTree({ router: fakeRouter({ purpose: FAIL }), embedder: fakeEmbedder() }, { question: 'wholesale providers, for a small shop' });
    expect(built).toMatchObject({ phase: 'needs-purpose', tree: null });
  });

  it('keeps an implication 2 of 3 samples give with the same anchor and direction, as inferred', async () => {
    const low = { attribute: 'minimum order size', direction: 'low', anchor: 'C2' };
    const router = fakeRouter({ implications: seq({ implications: [low, { attribute: 'brand range', direction: 'high', anchor: 'C1' }] }, { implications: [{ ...low, attribute: 'smallest order' }] }, { implications: [{ attribute: 'capacity', direction: 'high', anchor: 'C2' }, { attribute: 'x', direction: 'sideways', anchor: 'C1' }] }), 'implications-match': { pick: 'A' } });
    const kept = await drawImplications({ router, embedder: fakeEmbedder() }, anchors, { text: 'p' });
    expect(kept).toEqual([{ id: 'I1', attribute: 'minimum order size', direction: 'low', anchor: 'C2', source: 'inferred', samples: 2 }]);
    expect(openEntries({ implications: kept }).map((e: { kind: string }) => e.kind)).toEqual(['implication']);
  });
});

describe('the whole tree', () => {
  it('decides whether cheap and valuable are asked before the purpose samples can spend the stage budget', async () => {
    const router = fakeRouter({ conflict: { cost: 'C1', worth: 'C2' }, purpose: { who: 'a buyer', outcome: 'x', why: 'y', anchors: ['C1'] }, implications: { implications: [] } });
    const built = await buildPurposeTree({ router, embedder: fakeEmbedder(), budget: new CallBudget({ purpose: 3 }) }, { question: 'cheap hatchback cars, with the highest value for the price' });
    expect(router.calls[0].task).toBe('conflict');
    expect(router.count('conflict')).toBe(2);
    expect(built).toMatchObject({ phase: 'needs-purpose', tree: null, conflict: { asked: true, cost: 'C1', worth: 'C2' } });
  });

  it('ends with the conflict goal after a critique that tried to delete it, every kept goal traced, and open entries listed', async () => {
    const question = 'Find plots to buy, affordable and valuable, with a scenic location';
    let conflictId = '';
    const router = fakeRouter({
      purpose: { who: 'a buyer', outcome: 'a plot that pays back', why: 'low entry', anchors: ['C2'] },
      implications: { implications: [] },
      conflict: { cost: 'C2', worth: 'C2' },
      goals: { goals: [{ goal: 'A scenic location', anchor: 'C3', notes: [] }, { goal: 'Secure financing', anchor: 'C2', notes: [] }, { goal: 'Invented anchor', anchor: 'C9' }] },
      refine: (request: { messages: { content: string }[] }) => (request.messages[1].content.includes('scenic') ? { ...refined, questions: [{ q: 'Is a viewpoint within 5 km?', checker: 'official', threshold: { op: '<=', value: 5, unit: 'km' } }] } : refined),
      trace: (request: { messages: { content: string }[] }) => (request.messages[1].content.includes('Goal: A scenic') ? { anchor: pickLetter(request, (text) => text.includes('scenic')), relation: 'S' } : { anchor: 'N' }),
      'same-goal': { same: 'B' },
      critique: (request: { messages: { content: string }[] }) => {
        conflictId = request.messages[1].content.match(/^(G\d+) \[from conflict\]/m)![1];
        return { ops: [{ op: 'drop', id: conflictId, reason: 'A' }] };
      },
    });
    const log: string[] = [];
    let notes = 0;
    const embedder = Object.assign(fakeEmbedder(), { failureNote: () => (notes++ ? '' : 'embeddings unavailable (one: answered 503); every candidate is judged instead') });
    const { phase, tree } = await buildPurposeTree({ router, embedder, log: (line: string) => log.push(line) }, { question });
    expect(log.filter((line) => line.startsWith('embeddings unavailable'))).toHaveLength(1);
    expect(phase).toBe('needs-confirmation');
    expect(tree.goals.map((g: { goal: string; state: string }) => [g.goal, g.state])).toEqual([['A scenic location', 'kept'], ['Secure financing', 'proposed'], [CONFLICT_GOAL, 'kept']]);
    expect(conflictGoalOf(tree).id).toBe(conflictId);
    expect(conflictGoalOf(tree).hypotheses).toHaveLength(5);
    expect(tree.ops.refused).toHaveLength(1);
    expect(log.some((line) => line.includes('protected'))).toBe(true);
    expect(tree.goals.filter((g: { state: string; trace: unknown }) => g.state === 'kept' && !g.trace)).toEqual([]);
    expect(tree.thresholds).toEqual([{ node: 'Q1', goal: 'G1', op: '<=', value: 5, unit: 'km', source: 'assumption', hard: false }]);
    expect(openEntries(tree).map((e: { id: string; kind: string }) => [e.id, e.kind])).toEqual([['G2', 'goal'], ['Q1', 'threshold']]);
    expect(tree.notModelled).toEqual([{ id: 'C1', text: 'Find plots to buy' }]);
    expect(tree.confirmedAt).toBeNull();
  });
});
