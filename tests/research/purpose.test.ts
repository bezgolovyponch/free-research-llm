import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COST_GOAL, COST_PHASES, COST_ROLE, METHOD_ALTERNATIVE, PURPOSE, TENSION_ROLE, TREE_VERSION, UNREFINED, VALUE_GOAL, VALUE_ROLE, anchorsOf, applyOps, buildPurposeTree, confirmTree, consumesVote, costSide, coverageOf, coveredAnchors, critique, dismissNotModelled, draftGoals, drawImplications, drawPurpose, ensureTensions, explainTensions, measurableQuestions, mergeDuplicates, needsConfirmation, notModelledOf, numbersIn, openEntries, purposeCap, refineGoal, requirementsOf, splitPiece, splitPoint, tensionGoalsOf, tensionsAsked, thresholdsOf, traceGoal, traceables, treeCap, valueForCost, valueForCostOf, valueSide, voteHardness } from '../../src/research/purpose.mjs';
import { CallBudget, STAGE_CAPS } from '../../src/research/semantic.mjs';
import { clausesOf } from '../../src/research/strategy.mjs';
import { FAIL, fakeEmbedder, fakeRouter, pickLetter, seq } from '../helpers/fakes';

type Ask = { messages: { content: string }[] };

const refined = { refine: 'AND', questions: [{ q: 'Is it stated?', checker: 'page', threshold: null, note: null }], obstacles: [{ obstacle: 'It is missing', checker: 'page', threshold: null }] };
const split = (question: string, guidance = '') => anchorsOf({ router: fakeRouter({}) }, question, guidance);
const plotAnchors = await split('Find plots to buy, price up to 65000CZK');
const smallShopAnchors = await split('wholesale providers, for a small shop');
const shopAnchors = await split('Find wholesale providers, with the highest price/value ratio, for a small shop');

describe('the stored knowledge holds only the Admiralty scales, and the engine names no domain', () => {
  it('keeps admiralty alone in purpose.json: no mechanisms, no conflict obstacle, no word list', () => {
    const raw = JSON.parse(readFileSync(new URL('../../src/research/purpose.json', import.meta.url), 'utf8'));
    expect(Object.keys(raw)).toEqual(['admiralty']);
    expect(Object.keys(PURPOSE)).toEqual(['admiralty']);
    expect(Object.keys(raw.admiralty.reliability)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(Object.keys(raw.admiralty.credibility)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(JSON.stringify(raw)).not.toMatch(/cues?"|words"|stems?"|stop"|mechanism/i);
  });

  it('has no domain word, brand name or trace of the removed conflict path in purpose.mjs', () => {
    const source = readFileSync(new URL('../../src/research/purpose.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(cheap\w*|plots?|cars?|cloth\w*|garments?|glamping|ralph|lauren|moncl\w*|north face|barbour|suppliers?|wholesale)\b/i);
    expect(source).not.toMatch(/conflictAsked|ensureAskedConflict|CONFLICT_GOAL|CONFLICT_ROLE|conflictGoalOf|mechanisms|conflictObstacle|valueRange/);
    expect(TREE_VERSION).toBe(2);
  });

  it('splits a question into pieces at punctuation only', () => {
    expect(clausesOf('plots but also cheap, so no air condition; near the sea')).toEqual(['plots but also cheap', 'so no air condition', 'near the sea']);
    expect(clausesOf('cars near the city, hatchback, , cheap;')).toEqual(['cars near the city', 'hatchback', 'cheap']);
  });
});

describe('requirements are the punctuation pieces grouped by meaning', () => {
  const question = 'similar to A, B, C, D with highest price/value ratio, proven good quality';

  it('groups a list of examples of one thing into one requirement by a vote on piece ids, and keeps the hints', async () => {
    const router = fakeRouter({ requirements: (request: Ask) => (request.messages[1].content.includes('[T1]') ? { groups: [['T1'], ['T2']] } : { groups: [['S5'], ['S3', 'S1', 'S2', 'S4']] }) });
    const anchors = await anchorsOf({ router }, question, 'sold by weight, graded');
    expect(anchors).toEqual([
      { id: 'C1', kind: 'clause', text: 'similar to A, B, C, D with highest price/value ratio', spans: ['S1', 'S2', 'S3', 'S4'] },
      { id: 'C2', kind: 'clause', text: 'proven good quality', spans: ['S5'] },
      { id: 'H1', kind: 'hint', text: 'sold by weight', spans: ['T1'] },
      { id: 'H2', kind: 'hint', text: 'graded', spans: ['T2'] },
    ]);
    expect(router.count('requirements')).toBe(4);
    expect(router.calls[0]).toMatchObject({ tier: 'fast', purpose: 'purpose-judge' });
    expect(router.userText('requirements')).toContain('[S4] D with highest price/value ratio');
    expect(router.userText('requirements')).not.toContain('sold by weight');
    expect(router.userText('requirements', 2)).toBe(`${router.calls.filter((call: { task?: string }) => call.task === 'requirements')[0].messages[0].content}\nPieces:\n[T1] sold by weight\n[T2] graded`);
  });

  it('groups a hint that lists several examples into one hint anchor, with the same split and complete-link consensus as the question', async () => {
    const hint = 'supplier located in NL, DE, UK, IT, PL or LT';
    const votes = seq({ groups: [['T1', 'T2', 'T3', 'T4', 'T5']] }, { groups: [['T1', 'T2'], ['T3', 'T4', 'T5']] }, { groups: [['T1', 'T2', 'T3', 'T4', 'T5']] });
    const router = fakeRouter({ requirements: (request: Ask, index: number) => (request.messages[1].content.includes('[T1]') ? votes(request, index) : { groups: [['S1']] }) });
    const log: string[] = [];
    const budget = new CallBudget();
    const stored = await requirementsOf({ router, budget, log: (line: string) => log.push(line) }, 'Find wholesale providers', hint);
    expect(stored.anchors).toEqual([
      { id: 'C1', kind: 'clause', text: 'Find wholesale providers', spans: ['S1'] },
      { id: 'H1', kind: 'hint', text: hint, spans: ['T1', 'T2', 'T3', 'T4', 'T5'] },
    ]);
    expect(stored.hints).toMatchObject({ grouping: { grouped: true, valid: 3 }, pieces: [{ text: 'supplier located in NL', asked: true, spans: ['T1'] }, { text: 'DE', asked: false }, { text: 'UK' }, { text: 'IT' }, { text: 'PL or LT', asked: true, split: false, spans: ['T5'] }] });
    const splitAsked = router.calls.filter((call: { task?: string }) => call.task === 'requirement-split').map((call: Ask) => call.messages[1].content);
    expect([...new Set(splitAsked)]).toEqual(['Piece: Find wholesale providers', 'Piece: supplier located in NL', 'Piece: PL or LT']);
    expect(budget.caps.purpose).toBe(purposeCap(3));
    expect(log.filter((line) => line.includes('no majority'))).toEqual([]);
    const splitter = (request: Ask) => (request.messages[1].content === 'Piece: sold per kg graded A or cream' ? { more: true, second: 'graded A or cream' } : { more: false });
    const twice = await requirementsOf({ router: fakeRouter({ 'requirement-split': splitter, requirements: (request: Ask) => (request.messages[1].content.includes('[T1]') ? { groups: [['T1'], ['T2']] } : { groups: [['S1']] }) }) }, 'Find wholesale providers', 'sold per kg graded A or cream');
    expect(twice.anchors.slice(1)).toEqual([{ id: 'H1', kind: 'hint', text: 'sold per kg', spans: ['T1'] }, { id: 'H2', kind: 'hint', text: 'graded A or cream', spans: ['T2'] }]);
    const undecided: string[] = [];
    const kept = await requirementsOf({ router: fakeRouter({}), log: (line: string) => undecided.push(line) }, 'Find wholesale providers', hint);
    expect(kept.anchors.filter((anchor: { kind: string }) => anchor.kind === 'hint')).toHaveLength(5);
    expect(undecided).toEqual(['requirements: no majority on grouping the 5 pieces of the hints by meaning; the punctuation split is kept']);
    expect((await requirementsOf({ router: fakeRouter({}) }, 'Find wholesale providers')).hints).toBeUndefined();
  });

  it('groups by consensus over the votes: three votes that differ in one piece still group the list', async () => {
    const votes = seq({ groups: [['S1', 'S2', 'S3', 'S4'], ['S5']] }, { groups: [['S1', 'S2', 'S3'], ['S4', 'S5']] }, { groups: [['S1', 'S2', 'S3', 'S4', 'S5']] });
    const router = fakeRouter({ requirements: votes });
    const log: string[] = [];
    const anchors = await anchorsOf({ router, log: (line: string) => log.push(line) }, question);
    expect(router.count('requirements')).toBe(3);
    expect(anchors.map((anchor: { id: string; text: string; spans: string[] }) => [anchor.id, anchor.text, anchor.spans])).toEqual([['C1', 'similar to A, B, C, D with highest price/value ratio', ['S1', 'S2', 'S3', 'S4']], ['C2', 'proven good quality', ['S5']]]);
    expect(log).toEqual([]);
    const pairOnly = await anchorsOf({ router: fakeRouter({ requirements: seq({ groups: [['S1', 'S2'], ['S3']] }, { groups: [['S1'], ['S2', 'S3']] }, { groups: [['S1'], ['S2'], ['S3']] }) }) }, 'one, two, three');
    expect(pairOnly.map((anchor: { text: string }) => anchor.text)).toEqual(['one', 'two', 'three']);
    const chained = await anchorsOf({ router: fakeRouter({ requirements: seq({ groups: [['S1', 'S2'], ['S3']] }, { groups: [['S1'], ['S2', 'S3']] }, { groups: [['S1', 'S2', 'S3']] }) }) }, 'one, two, three');
    expect(chained.map((anchor: { text: string }) => anchor.text)).toEqual(['one, two', 'three']);
    const twoValid = await anchorsOf({ router: fakeRouter({ requirements: seq({ groups: [['S1', 'S2'], ['S3']] }, FAIL, { groups: [['S1'], ['S2', 'S3']] }) }) }, 'one, two, three');
    expect(twoValid.map((anchor: { text: string }) => anchor.text)).toEqual(['one', 'two', 'three']);
  });

  it('merges two groups only when every pair across them is voted together: no group forms through a chain', async () => {
    const pieces = 'good providers, like A, B, C, lasting';
    const grouped = async (...votes: string[][][]) => (await requirementsOf({ router: fakeRouter({ requirements: seq(...votes.map((groups) => ({ groups }))) }) }, pieces)).anchors.map((anchor: { spans: string[] }) => anchor.spans.join(''));
    expect(await grouped([['S1', 'S2', 'S3', 'S4'], ['S5']], [['S1'], ['S2', 'S3', 'S4', 'S5']], [['S1', 'S2'], ['S3', 'S4', 'S5']])).toEqual(['S1', 'S2S3S4', 'S5']);
    expect(await grouped([['S1', 'S2', 'S3', 'S4'], ['S5']], [['S1'], ['S2', 'S3', 'S4', 'S5']], [['S1'], ['S2', 'S3', 'S4'], ['S5']])).toEqual(['S1', 'S2S3S4', 'S5']);
    expect(await grouped([['S1', 'S2'], ['S3'], ['S4'], ['S5']], [['S1'], ['S2', 'S3'], ['S4'], ['S5']], [['S1', 'S2', 'S3'], ['S4'], ['S5']])).toEqual(['S1S2', 'S3', 'S4', 'S5']);
    expect(await grouped([['S1', 'S2'], ['S3', 'S4'], ['S5']], [['S1', 'S2', 'S3', 'S4'], ['S5']], [['S1', 'S2', 'S3', 'S4', 'S5']])).toEqual(['S1S2S3S4', 'S5']);
    expect(await grouped([['S1', 'S2', 'S3', 'S4', 'S5']], [['S1', 'S2', 'S3', 'S4', 'S5']])).toEqual(['S1S2S3S4S5']);
  });

  it('stores what the split and the grouping did, so a produced tree shows it', async () => {
    const router = fakeRouter({ 'requirement-split': (request: Ask) => (request.messages[1].content.includes('D with') ? { more: true, second: 'with highest price/value ratio' } : { more: false }), requirements: { groups: [['S1', 'S2', 'S3', 'S4'], ['S5'], ['S6']] }, purpose: FAIL });
    const stored = await requirementsOf({ router }, question);
    expect(stored.grouping).toEqual({ grouped: true, valid: 2 });
    expect(stored.pieces).toEqual([
      { text: 'similar to A', asked: true, split: false, votes: { 0: 2 }, spans: ['S1'] },
      { text: 'B', asked: false, split: false, votes: {}, spans: ['S2'] },
      { text: 'C', asked: false, split: false, votes: {}, spans: ['S3'] },
      { text: 'D with highest price/value ratio', asked: true, split: true, votes: { 2: 2 }, spans: ['S4', 'S5'] },
      { text: 'proven good quality', asked: true, split: false, votes: { 0: 2 }, spans: ['S6'] },
    ]);
    const built = await buildPurposeTree({ router }, { question });
    expect(built.requirements).toEqual({ pieces: stored.pieces, grouping: stored.grouping });
  });

  it('keeps the punctuation split and logs it when fewer than two votes are valid', async () => {
    const log: string[] = [];
    const router = fakeRouter({ requirements: seq({ groups: [['S1', 'S2', 'S3', 'S4'], ['S5']] }, FAIL, { groups: [['S1', 'S9']] }) });
    const anchors = await anchorsOf({ router, log: (line: string) => log.push(line) }, question);
    expect(anchors.map((anchor: { id: string; text: string }) => `${anchor.id} ${anchor.text}`)).toEqual(['C1 similar to A', 'C2 B', 'C3 C', 'C4 D with highest price/value ratio', 'C5 proven good quality']);
    expect(log).toEqual(['requirements: no majority on grouping the 5 pieces of the question by meaning; the punctuation split is kept']);
  });

  it('refuses a grouping that invents a piece or leaves one out, and asks nothing for a single short piece', async () => {
    const router = fakeRouter({ requirements: seq({ groups: [['S1', 'S9'], ['S2']] }, { groups: [['S1']] }) });
    const anchors = await anchorsOf({ router }, 'first piece, second piece');
    expect(router.calls[1].messages[2].content).toContain('a group names an id that is not one of S1, S2');
    expect(router.calls[3].messages[2].content).toContain('every piece id must be in exactly one group');
    expect(anchors.map((anchor: { text: string }) => anchor.text)).toEqual(['first piece', 'second piece']);
    const single = fakeRouter({});
    expect(await anchorsOf({ router: single }, 'one piece')).toEqual([{ id: 'C1', kind: 'clause', text: 'one piece', spans: ['S1'] }]);
    expect(single.calls).toEqual([]);
  });
});

describe('a piece that holds two requirements is split before grouping', () => {
  const question = 'similar to A, B, C, D with highest price/value ratio, proven good quality';
  const pieceOf = (request: Ask) => request.messages[1].content.replace('Piece: ', '');
  const splitter = (request: Ask) => (pieceOf(request).startsWith('D with') ? { more: true, second: 'with highest price/value ratio' } : { more: false });

  it('splits at the voted words, and the second part becomes its own requirement while the first stays with the list', async () => {
    const log: string[] = [];
    const router = fakeRouter({ 'requirement-split': splitter, requirements: { groups: [['S1', 'S2', 'S3', 'S4'], ['S5'], ['S6']] } });
    const anchors = await anchorsOf({ router, log: (line: string) => log.push(line) }, question);
    expect(anchors).toEqual([
      { id: 'C1', kind: 'clause', text: 'similar to A, B, C, D', spans: ['S1', 'S2', 'S3', 'S4'] },
      { id: 'C2', kind: 'clause', text: 'with highest price/value ratio', spans: ['S5'] },
      { id: 'C3', kind: 'clause', text: 'proven good quality', spans: ['S6'] },
    ]);
    expect(log).toEqual(['requirements: the piece "D with highest price/value ratio" holds two requirements; it is split before "with highest price/value ratio"']);
    expect(router.count('requirement-split')).toBe(6);
    expect(router.calls[0]).toMatchObject({ task: 'requirement-split', tier: 'fast', purpose: 'purpose-judge' });
    expect(router.calls.filter((call: { task?: string }) => call.task === 'requirement-split').map(pieceOf)).toEqual(['similar to A', 'similar to A', 'D with highest price/value ratio', 'D with highest price/value ratio', 'proven good quality', 'proven good quality']);
    expect(router.userText('requirements')).toContain('[S4] D\n[S5] with highest price/value ratio\n[S6] proven good quality');
    const rejoined = await anchorsOf({ router: fakeRouter({ 'requirement-split': splitter, requirements: { groups: [['S1', 'S2', 'S3'], ['S4', 'S5'], ['S6']] } }) }, question);
    expect(rejoined.map((anchor: { text: string }) => anchor.text)).toEqual(['similar to A, B, C', 'D with highest price/value ratio', 'proven good quality']);
  });

  it('takes the split point a majority gives, and none without a majority or when the majority sees one requirement', async () => {
    const piece = 'D with highest price/value ratio';
    const majority = await splitPiece({ router: fakeRouter({ 'requirement-split': seq({ more: true, second: 'highest price/value ratio' }, { more: true, second: 'with highest' }, { more: true, second: 'with highest price/value ratio' }) }) }, piece);
    expect(majority).toEqual({ parts: ['D', 'with highest price/value ratio'], votes: { 7: 1, 2: 2 } });
    const none = await splitPiece({ router: fakeRouter({ 'requirement-split': seq({ more: true, second: 'highest price/value ratio' }, { more: true, second: 'with highest' }, { more: false }) }) }, piece);
    expect(none.parts).toEqual([piece]);
    const one = fakeRouter({ 'requirement-split': seq({ more: false }, { more: true, second: 'with highest' }, { more: false }) });
    expect((await splitPiece({ router: one }, piece)).parts).toEqual([piece]);
    expect(one.count('requirement-split')).toBe(3);
    const short = fakeRouter({ 'requirement-split': { more: true, second: 'face' } });
    expect((await splitPiece({ router: short }, 'North face')).parts).toEqual(['North face']);
    expect(short.calls).toEqual([]);
  });

  it('refuses a split point that is not an exact substring at a word boundary', async () => {
    expect(splitPoint('D with highest price/value ratio', 'with highest')).toBe(2);
    expect(splitPoint('D  with   highest price/value ratio', ' with highest  price/value ratio ')).toBe(2);
    expect(splitPoint('D with highest price/value ratio', 'with the highest ratio')).toBeNull();
    expect(splitPoint('D with highest price/value ratio', 'With highest')).toBeNull();
    expect(splitPoint('D with highest price/value ratio', 'ighest price/value ratio')).toBeNull();
    expect(splitPoint('D with highest price/value ratio', 'with high')).toBeNull();
    expect(splitPoint('D with highest price/value ratio', 'D with highest')).toBeNull();
    expect(splitPoint('D with highest price/value ratio', '')).toBeNull();
    expect(splitPoint('as good as new as can be', 'as new')).toBe(8);
    const router = fakeRouter({ 'requirement-split': { more: true, second: 'and the best ratio' } });
    const refused = await splitPiece({ router }, 'D with highest price/value ratio');
    expect(refused.parts).toEqual(['D with highest price/value ratio']);
    expect(router.count('requirement-split')).toBe(6);
    expect(router.calls[1].messages[2].content).toContain('"second" must be words copied exactly from the piece, starting at one of its words after the first: D with highest price/value ratio');
    const untyped = fakeRouter({ 'requirement-split': { second: 'with highest' } });
    await splitPiece({ router: untyped }, 'D with highest price/value ratio');
    expect(untyped.calls[1].messages[2].content).toContain('"more" must be true or false');
  });
});

describe('the purpose stage budget is sized to the votes it makes', () => {
  it('is 48 calls plus 3 for every piece of at least 3 words, set before the first vote and logged', async () => {
    expect([purposeCap(0), purposeCap(4), purposeCap(10)]).toEqual([48, 60, 78]);
    expect(STAGE_CAPS.purpose).toBe(48);
    const budget = new CallBudget({ ...STAGE_CAPS, purpose: 2 });
    const log: string[] = [];
    const router = fakeRouter({ 'requirement-split': { more: false }, requirements: { groups: [['S1', 'S2', 'S3', 'S4'], ['S5']] } });
    await anchorsOf({ router, budget, log: (line: string) => log.push(line) }, 'similar to A, B, C, D with highest price/value ratio, proven good quality');
    expect(budget.caps.purpose).toBe(57);
    expect(budget.report().purpose).toEqual({ used: 8, cap: 57, skipped: 0 });
    expect(log).toEqual(['purpose budget: 57 calls (48 for grouping, tensions, purpose, consumes and implications, 3 for each of 3 piece(s) of at least 3 words)']);
  });
});

describe('tensions are pairs of the asker\'s own requirements, decided by votes on their ids', () => {
  const cases = [
    { text: 'Find trails near the city, short enough for children, with wide views from a summit', pair: ['C2', 'C3'] },
    { text: 'Najdi knihovnu, s co nejvíce funkcemi, a co nejmenší velikostí', pair: ['C3', 'C2'] },
    { text: 'Finde einen Dienst, mit schneller Lieferung, und gründlicher Prüfung', pair: ['C2', 'C3'] },
  ];

  it('keeps a pair a majority names, in any language and for any two qualities', async () => {
    for (const entry of cases) {
      const router = fakeRouter({ tensions: { pairs: [entry.pair] } });
      const anchors = await split(entry.text);
      const result = await tensionsAsked({ router }, anchors);
      expect(result).toMatchObject({ decided: true, replies: 2, votes: { 'C2|C3': 2 } });
      expect(result.pairs).toEqual([{ id: 'C2|C3', a: 'C2', b: 'C3', texts: [anchors[1].text, anchors[2].text], votes: 2 }]);
      expect(router.calls[0]).toMatchObject({ tier: 'fast', purpose: 'purpose-judge' });
      expect(router.userText('tensions')).not.toMatch(/price|cost|quality/i);
    }
  });

  it('counts each pair on its own, takes a requirement named twice as a tension inside it, and an invented id as none', async () => {
    const anchors = await split('first thing, second thing, third thing', 'a hint');
    const mixed = await tensionsAsked({ router: fakeRouter({ tensions: seq({ pairs: [['C1', 'C2'], ['C3', 'C3']] }, { pairs: [['C2', 'C1'], ['C1', 'C9'], ['H1', 'C1']] }, { pairs: ['C3|C3', ['C2', 'C3']] }) }) }, anchors);
    expect(mixed.pairs.map((pair: { id: string; votes: number }) => [pair.id, pair.votes])).toEqual([['C1|C2', 2], ['C3|C3', 2]]);
    expect(mixed.votes).toEqual({ 'C1|C2': 2, 'C3|C3': 2, 'C2|C3': 1 });
    const none = await tensionsAsked({ router: fakeRouter({ tensions: { pairs: [] } }) }, anchors);
    expect(none).toMatchObject({ pairs: [], decided: true, replies: 2 });
    const undecided = await tensionsAsked({ router: fakeRouter({ tensions: seq({ pairs: [['C1', 'C2']] }, FAIL, FAIL) }) }, anchors);
    expect(undecided).toMatchObject({ pairs: [], decided: false, replies: 1 });
    expect(ensureTensions({ tensions: undecided, goals: [] }).goals).toEqual([]);
    expect(openEntries(ensureTensions({ tensions: undecided, goals: [] }))).toEqual([]);
  });
});

describe('a tension goal is kept by code, only for voted pairs', () => {
  const tensions = { pairs: [{ id: 'C1|C2', a: 'C1', b: 'C2', texts: ['as light as possible', 'lasting many years'], votes: 2 }] };
  const notes = [
    { id: 'N1', url: 'https://one.example.org/a', quote: 'Frames of one alloy weigh 300 g less and last as long.', label: 'alloy' },
    { id: 'N2', url: 'https://two.example.org/b', quote: 'Older models are sold off when a new one arrives.', label: 'model change' },
    { id: 'N3', url: 'https://three.example.org/c', quote: 'Makers test every frame.', label: 'testing' },
  ];
  const explained = { explanations: [
    { explanation: 'One alloy is lighter and lasts as long', notes: ['N1', 'N9'], test: 'Is the frame made of that alloy?', checker: 'page' },
    { explanation: 'A replaced model keeps its build', notes: ['n2'], test: 'Was the model replaced by a newer one?', checker: 'oracle' },
    { explanation: 'Sellers are generous', notes: ['N8'], test: 'Is the seller generous?', checker: 'page' },
    { explanation: 'It simply is so', test: 'Is it so?', checker: 'page' },
  ] };

  it('builds the goal from the two requirement texts, protected, with the one method alternative and a research gap', () => {
    const tree = ensureTensions({ tensions, goals: [{ id: 'G1', goal: 'Light', questions: [{ id: 'Q1', q: 'x', checker: 'page' }], obstacles: [] }] });
    const [goal] = tensionGoalsOf(tree);
    expect(goal).toMatchObject({ id: 'G2', goal: 'Meet both at once: "as light as possible" and "lasting many years"', role: TENSION_ROLE, pair: 'C1|C2', anchors: ['C1', 'C2'], protected: true, state: 'kept', refine: 'OR', trace: { kind: 'rule', text: 'tension' }, questions: [], obstacles: [] });
    expect(goal.hypotheses).toEqual([{ id: 'M0', key: 'method', hypothesis: METHOD_ALTERNATIVE, notes: [], basis: 'Heuer 1999 Analysis of Competing Hypotheses' }]);
    expect(METHOD_ALTERNATIVE).toBe('the combination does not hold here');
    expect(goal.gap).toEqual({ kind: 'research gap', found: 0, needed: 2 });
    expect(openEntries(tree)).toEqual([{ id: 'G2', kind: 'research-gap', text: goal.goal, reason: 'research gap: 0 explanation(s) with a cited scoping note, at least 2 are needed before the tension can be tested' }]);
    expect(needsConfirmation(tree)).toBe(true);
    expect(ensureTensions(tree)).toEqual(tree);
    const inside = ensureTensions({ tensions: { pairs: [{ id: 'C1|C1', a: 'C1', b: 'C1', texts: ['light and lasting', 'light and lasting'], votes: 2 }] }, goals: [] });
    expect(inside.goals[0]).toMatchObject({ goal: 'Meet both sides of one requirement at once: "light and lasting"', anchors: ['C1'] });
  });

  it('adds no goal without a voted pair, removes one whose pair was not voted, and puts a lost one back', () => {
    expect(ensureTensions({ tensions: { pairs: [] }, goals: [] }).goals).toEqual([]);
    expect(ensureTensions({ goals: [] }).goals).toEqual([]);
    const tree = ensureTensions({ tensions, goals: [] });
    expect(ensureTensions({ ...tree, tensions: { pairs: [] } }).goals).toEqual([]);
    expect(tensionGoalsOf(ensureTensions({ ...tree, goals: [] }))).toHaveLength(1);
  });

  it('takes explanations only with the id of a note it was shown, one test question each, and no gap from 2 on', async () => {
    const router = fakeRouter({ 'tension-explain': explained });
    const embedder = fakeEmbedder([2, 0, 1]);
    const tree = await explainTensions({ router, embedder }, ensureTensions({ tensions, goals: [] }), { notes });
    const [goal] = tensionGoalsOf(tree);
    expect(goal.hypotheses).toEqual([
      { id: 'M1', key: 'retrieved', hypothesis: 'One alloy is lighter and lasts as long', notes: ['N1'], source: 'scoping' },
      { id: 'M2', key: 'retrieved', hypothesis: 'A replaced model keeps its build', notes: ['N2'], source: 'scoping' },
      { id: 'M0', key: 'method', hypothesis: METHOD_ALTERNATIVE, notes: [], basis: 'Heuer 1999 Analysis of Competing Hypotheses' },
    ]);
    expect(goal.questions).toEqual([
      { id: 'Q1', q: 'Is the frame made of that alloy?', checker: 'page', threshold: null, note: 'N1', hypothesis: 'M1' },
      { id: 'Q2', q: 'Was the model replaced by a newer one?', checker: 'consensus', threshold: null, note: 'N2', hypothesis: 'M2' },
    ]);
    expect(goal.gap).toBeUndefined();
    expect(openEntries(tree)).toEqual([]);
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]).toMatchObject({ task: 'tension-explain', tier: 'deep' });
    expect(embedder.calls[0]).toMatchObject({ query: goal.goal, k: 14 });
    expect(router.userText('tension-explain').indexOf('[N3]')).toBeLessThan(router.userText('tension-explain').indexOf('[N1]'));
    expect(await explainTensions({ router: fakeRouter({}) }, tree, { notes })).toEqual(tree);
  });

  it('reports a research gap when fewer than 2 explanations cite a note, and asks no model without notes', async () => {
    const one = await explainTensions({ router: fakeRouter({ 'tension-explain': { explanations: explained.explanations.slice(2).concat(explained.explanations[0]) } }) }, ensureTensions({ tensions, goals: [] }), { notes });
    expect(tensionGoalsOf(one)[0].hypotheses.map((entry: { id: string }) => entry.id)).toEqual(['M1', 'M0']);
    expect(tensionGoalsOf(one)[0].gap).toEqual({ kind: 'research gap', found: 1, needed: 2 });
    expect(openEntries(one).map((entry: { kind: string }) => entry.kind)).toEqual(['research-gap']);
    const silent = fakeRouter({});
    const none = await explainTensions({ router: silent }, ensureTensions({ tensions, goals: [] }), { notes: [] });
    expect(silent.calls).toEqual([]);
    expect(tensionGoalsOf(none)[0].gap.found).toBe(0);
    const forged = ensureTensions({ tensions, goals: [{ ...tensionGoalsOf(none)[0], hypotheses: [{ id: 'M1', hypothesis: 'no note', notes: [] }, { id: 'M2', hypothesis: 'made up' }] }] });
    expect(tensionGoalsOf(forged)[0].hypotheses.map((entry: { id: string }) => entry.id)).toEqual(['M0']);
  });

  it('asks once more when an explanation holds a number no cited note states, then moves a quantity out of the text', async () => {
    const numbered = { explanations: [{ explanation: 'The alloy saves 300 g', notes: ['N1'], test: 'Does the frame weigh under 900 g?', checker: 'page' }, { explanation: 'A replaced model keeps its build', notes: ['N2'], test: 'Was it replaced?', checker: 'page' }] };
    const router = fakeRouter({ 'tension-explain': numbered, 'number-kind': { kind: 'A' } });
    const tree = await explainTensions({ router }, ensureTensions({ tensions, goals: [] }), { notes });
    expect(router.count('tension-explain')).toBe(2);
    expect(router.userText('tension-explain', 1)).toContain('holds a number nobody stated (900)');
    const [goal] = tensionGoalsOf(tree);
    expect(goal.hypotheses[0].hypothesis).toBe('The alloy saves 300 g');
    expect(goal.questions[0]).toMatchObject({ q: 'Does the frame weigh under g?', threshold: { value: 900, source: 'assumption', moved: true }, movedNumber: [900] });
    expect(thresholdsOf(tree, { question: 'light, lasting', notes }).thresholds).toEqual([{ node: 'Q1', goal: 'G1', op: null, value: 900, unit: '', source: 'assumption', moved: true, hard: false }]);
  });

  it('refuses the critique drop of a tension goal, of a value or cost goal and of an obstacle, and logs each', async () => {
    const log: string[] = [];
    const side = (role: string, goal: string, id: string, q: string) => ({ id, goal, role, protected: true, state: 'kept', questions: [{ id: q, q: 'x', checker: 'code' }], obstacles: [] });
    const tree = ensureTensions({ tensions, goals: [{ id: 'G1', goal: 'Light', state: 'kept', anchor: 'C1', questions: [{ id: 'Q1', q: 'x', checker: 'page' }], obstacles: [{ id: 'O9', obstacle: 'none', checker: 'page' }] }, side(VALUE_ROLE, VALUE_GOAL, 'G2', 'Q2'), side(COST_ROLE, COST_GOAL, 'G3', 'Q3')], ops: { applied: [], refused: [] } });
    const tension = tensionGoalsOf(tree)[0];
    const router = fakeRouter({ critique: { ops: [{ op: 'drop', id: tension.id, reason: 'A' }, { op: 'drop', id: 'G2', reason: 'C' }, { op: 'checker', id: 'Q3', checker: 'page' }, { op: 'drop', id: 'O9', reason: 'A' }, { op: 'merge', a: 'G2', b: 'G3' }, { op: 'drop', id: 'G77', reason: 'A' }, { op: 'explode' }] } });
    const ops = await critique({ router }, tree, []);
    expect(ops).toHaveLength(5);
    const out = await applyOps({ router, log: (line: string) => log.push(line) }, tree, ops);
    expect(out.goals).toEqual(tree.goals);
    expect(out.ops.applied).toEqual([]);
    expect(out.ops.refused.map((entry: { why: string }) => entry.why)).toEqual([`"${tension.goal}" is a protected tension goal`, `"${VALUE_GOAL}" is a protected value goal`, `"${COST_GOAL}" is a protected cost goal`, 'an obstacle is a protected node', 'a protected node is never merged away']);
    expect(log).toHaveLength(5);
    expect(log[0]).toContain('critique operation refused: drop');
    expect(router.userText('critique')).toContain(`${tension.id} [from tension] Meet both at once`);
    expect(router.userText('critique')).toContain('G2 [from value]');
  });
});

describe('every goal is traced to what was asked by a voted selection', () => {
  const anchors = shopAnchors;
  const purpose = { id: 'P', text: 'a small shop owner wants stock that sells' };
  const implications = [{ id: 'I1', attribute: 'minimum order size', direction: 'low', anchor: 'C3', source: 'inferred' }];
  const options = traceables(anchors, purpose, implications);
  const tracer = (wanted: string | null, relation: string) => (request: Ask) => ({ anchor: wanted ? pickLetter(request, (text) => text.includes(wanted)) : 'N', relation });

  it('offers the claimed anchor plus the 3 nearest by embedding rank, and keeps a goal voted S with its trace', async () => {
    const router = fakeRouter({ trace: tracer('price/value', 'S') });
    const embedder = fakeEmbedder([3, 0, 1, 2]);
    const goal = await traceGoal({ router, embedder }, { goal: 'Compare price per kilogram', anchor: 'C2' }, options);
    expect(goal).toMatchObject({ state: 'kept', trace: { id: 'C2', text: 'with the highest price/value ratio' } });
    expect(goal.restates).toBeUndefined();
    expect(embedder.calls[0].candidates).toHaveLength(4);
    expect(embedder.calls[0].k).toBe(3);
    expect(router.userText('trace')).toContain('N) none of these statements');
    expect(router.calls).toHaveLength(2);
  });

  it('keeps a goal that restates its clause, flagged, proposes a goal voted N, and marks X as a conflict with what it contradicts', async () => {
    const embedder = fakeEmbedder();
    const restated = await traceGoal({ router: fakeRouter({ trace: tracer('price/value', 'R') }), embedder }, { goal: 'Highest price/value ratio', anchor: 'C2' }, options);
    expect(restated).toMatchObject({ state: 'kept', restates: true, trace: { id: 'C2', text: 'with the highest price/value ratio' }, votes: { R: 2 } });
    expect(restated.reason).toBeUndefined();
    const proposed = await traceGoal({ router: fakeRouter({ trace: tracer(null, 'S') }), embedder }, { goal: 'Secure financing', anchor: 'C1' }, options);
    expect(proposed).toMatchObject({ state: 'proposed', trace: null });
    const conflict = await traceGoal({ router: fakeRouter({ trace: tracer('minimum order size', 'X') }), embedder }, { goal: 'Suppliers with large capacity', anchor: 'I1' }, options);
    expect(conflict).toMatchObject({ state: 'conflict', trace: { id: 'I1' }, reason: 'contradicts I1: minimum order size: low is preferred' });
    const undecided = await traceGoal({ router: fakeRouter({ trace: seq({ anchor: 'A', relation: 'S' }, { anchor: 'A', relation: 'X' }, { anchor: 'N' }) }), embedder }, { goal: 'Unclear', anchor: 'C1' }, options);
    expect(undecided).toMatchObject({ state: 'proposed', reason: 'no majority on what it traces to: confirm or drop it' });
    expect(openEntries({ goals: [proposed, conflict, { ...restated, id: 'G9' }] }).map((e: { state: string }) => e.state)).toEqual(['proposed', 'conflict']);
  });

  it('never traces a protected goal: its trace is the rule', async () => {
    const router = fakeRouter({});
    expect((await traceGoal({ router }, { goal: VALUE_GOAL, role: VALUE_ROLE, protected: true }, options)).trace).toEqual({ kind: 'rule', text: 'value' });
    expect((await traceGoal({ router }, { goal: COST_GOAL, role: COST_ROLE, protected: true }, options)).trace).toEqual({ kind: 'rule', text: 'cost' });
    expect(router.calls).toEqual([]);
  });
});

describe('a question that only restates its goal or clause is dropped, the goal is not', () => {
  const restating = { q: 'Is the quality proven and good?', checker: 'consensus', threshold: null, note: null };
  const measurable = { q: 'Do independent buyers report the grading as accurate?', checker: 'consensus', threshold: null, note: null };
  const drafted = (...questions: object[]) => ({ refine: 'AND', questions, obstacles: refined.obstacles });
  const judge = (request: Ask) => ({ restates: [...request.messages[1].content.matchAll(/^([A-H])\) (.+)$/gm)].filter((match) => match[2].includes('proven and good')).map((match) => match[1]) });

  it('drops the restating question by a vote on question letters and keeps the measurable one', async () => {
    const router = fakeRouter({ refine: drafted(restating, measurable), restates: judge });
    const out = await refineGoal({ router }, { goal: 'Proven good quality', anchorText: 'proven good quality' });
    expect(out.questions).toEqual([measurable]);
    expect(out.restated).toBe(1);
    expect(router.count('refine')).toBe(1);
    expect(router.count('restates')).toBe(2);
    expect(router.calls.find((call: { task?: string }) => call.task === 'restates')).toMatchObject({ tier: 'fast', purpose: 'purpose-judge' });
    expect(router.userText('restates')).toContain('Goal: Proven good quality\nIt comes from: proven good quality\n\nQuestions:\nA) Is the quality proven and good?\nB) Do independent buyers report the grading as accurate?');
  });

  it('asks once more for measurable questions when every question restated, and takes those', async () => {
    const router = fakeRouter({ refine: seq(drafted(restating), drafted(measurable)), restates: judge });
    const out = await refineGoal({ router }, { goal: 'Proven good quality', anchorText: 'proven good quality' });
    expect(router.count('refine')).toBe(2);
    expect(router.userText('refine', 1)).toContain('Every question only restated the goal. Ask only for what a checker can observe, count, compare or look up.');
    expect(out.questions).toEqual([measurable]);
    expect(out.obstacles).toEqual(refined.obstacles);
  });

  it('has no refinement when the second answer restates too, and keeps the questions when the vote has no majority', async () => {
    const router = fakeRouter({ refine: drafted(restating), restates: judge });
    expect(await refineGoal({ router }, { goal: 'Proven good quality', anchorText: 'proven good quality' })).toBeNull();
    expect(router.count('refine')).toBe(2);
    const undecided = fakeRouter({ refine: drafted(restating), restates: seq({ restates: ['A'] }, { restates: [] }, FAIL) });
    expect((await refineGoal({ router: undecided }, { goal: 'Proven good quality' })).questions).toEqual([restating]);
    expect(await measurableQuestions({ router: fakeRouter({ restates: { restates: ['A', 'Z', 'b'] } }) }, [restating, restating, measurable], { goal: 'g' })).toEqual([measurable]);
  });
});

describe('a result the asker obtains or uses has a value side and a total-cost side', () => {
  const purpose = { id: 'P', text: 'a family wants a day out with small children, because they have one free day' };
  const phaseOf = (request: Ask) => COST_PHASES.find((phase: { id: string }) => request.messages[0].content.includes(`ownership: ${phase.id} (`))!.id;
  const phases: Record<string, unknown> = {
    'pre-transaction': { questions: [{ q: 'How long does finding and checking the route take?', paid: 'B', checker: 'consensus' }], obstacles: [] },
    transaction: { questions: [{ q: 'What is paid for parking and entry?', paid: 'A', checker: 'page' }, { q: 'How long is the drive there?', paid: 'B', checker: 'statistic' }, { q: 'A third question', paid: 'B', checker: 'page' }], obstacles: [{ obstacle: 'The drive takes longer than the walk', checker: 'code' }, { obstacle: 'second', checker: 'page' }] },
    'post-transaction': { questions: [{ q: 'What does a missed return connection cost?', checker: 'code' }, { q: 'Is rescue paid by the visitor?', checker: 'official', paid: 'b' }], obstacles: [{ obstacle: 'No way back before dark', checker: 'official' }] },
  };

  it('decides by a vote whether the result consumes resources, and keeps both sides when undecided', async () => {
    const anchors = await split('Find hiking trails near the city, that suit young children');
    const yes = fakeRouter({ consumes: { consumes: true } });
    expect(await consumesVote({ router: yes }, purpose, anchors)).toEqual({ value: true, decided: true, votes: { true: 2 } });
    expect(yes.calls[0]).toMatchObject({ tier: 'fast', purpose: 'purpose-judge' });
    expect(yes.userText('consumes')).toContain(`Purpose: ${purpose.text}`);
    expect(yes.userText('consumes')).toContain('consumes money, time or other resources');
    expect(await consumesVote({ router: fakeRouter({ consumes: { consumes: false } }) }, purpose, anchors)).toEqual({ value: false, decided: true, votes: { false: 2 } });
    expect(await consumesVote({ router: fakeRouter({ consumes: seq({ consumes: true }, { consumes: false }, { consumes: 'maybe' }) }) }, purpose, anchors)).toMatchObject({ value: true, decided: false });
  });

  it('refines the cost side into the three phases of total cost of ownership: code measures what is paid, sources the other costs', async () => {
    const anchors = await split('Find hiking trails near the city, that suit young children');
    const router = fakeRouter({ 'cost-phase': (request: Ask) => phases[phaseOf(request)], 'obstacle-stated': (request: Ask) => ({ anchor: request.messages[1].content.includes('Condition: No way back') ? pickLetter(request, (text) => text.includes('young children')) : 'N' }) });
    const goal = await costSide({ router, embedder: fakeEmbedder() }, { purpose, anchors });
    expect(goal).toMatchObject({ goal: COST_GOAL, role: COST_ROLE, protected: true, state: 'kept', refine: 'AND', trace: { kind: 'rule', text: 'cost' } });
    expect(COST_GOAL).toBe('Total cost to obtain and use it');
    expect(goal.basis).toContain('Ellram');
    expect(goal.phases).toEqual([{ id: 'pre-transaction', covers: 'finding, qualifying, minimum order, registration', questions: 1 }, { id: 'transaction', covers: 'price, delivery, duties, payment', questions: 2 }, { id: 'post-transaction', covers: 'defects, returns, repairs, resale or disposal', questions: 2 }]);
    expect(goal.questions.map((q: { phase: string; checker: string; price: boolean }) => [q.phase, q.checker, q.price])).toEqual([['pre-transaction', 'consensus', false], ['transaction', 'code', true], ['transaction', 'consensus', false], ['post-transaction', 'code', true], ['post-transaction', 'official', false]]);
    expect(goal.obstacles).toEqual([
      { obstacle: 'The drive takes longer than the walk', checker: 'code', threshold: null, phase: 'transaction', soft: true },
      { obstacle: 'No way back before dark', checker: 'official', threshold: null, phase: 'post-transaction', soft: false, trace: { id: 'C2', text: 'that suit young children' } },
    ]);
    expect(router.count('cost-phase')).toBe(3);
    expect(router.userText('cost-phase', 1)).toContain('transaction (price, delivery, duties, payment)');
    expect(router.userText('cost-phase')).toContain(`Goal: ${COST_GOAL}\nPurpose: ${purpose.text}`);
  });

  it('keeps the cost goal with the phase empty when a phase gets no answer, and the number rule holds for cost questions', async () => {
    const anchors = await split('Find hiking trails near the city, that suit young children');
    const numbered = { questions: [{ q: 'Is parking under 200 a day?', paid: 'A' }], obstacles: [] };
    const router = fakeRouter({ 'number-kind': { kind: 'A' }, 'cost-phase': (request: Ask) => (phaseOf(request) === 'transaction' ? numbered : phaseOf(request) === 'pre-transaction' ? { questions: [] } : FAIL) });
    const goal = await costSide({ router }, { purpose, anchors, said: 'trails near the city' });
    expect(router.count('cost-phase')).toBe(5);
    expect(router.userText('cost-phase', 1)).toContain('at least one question with a "q" text about a cost of the pre-transaction phase');
    expect(router.userText('cost-phase', 3)).toContain('holds a number nobody stated (200)');
    expect(goal.phases.map((phase: { questions: number }) => phase.questions)).toEqual([0, 1, 0]);
    expect(goal.questions).toEqual([{ q: 'Is parking under a day?', checker: 'code', threshold: { op: null, value: 200, unit: '', source: 'assumption', moved: true }, note: null, phase: 'transaction', price: true, movedNumber: [200] }]);
    expect(goal.obstacles).toBe('missing');
  });

  it('refines the value side by asking how of the purpose, with soft obstacles unless the asker stated them', async () => {
    const anchors = await split('Find hiking trails near the city, that suit young children');
    const reply = { refine: 'AND', questions: [{ q: 'Can a child walk the whole route?', checker: 'consensus' }, { q: 'Is the day out good for the family?', checker: 'page' }], obstacles: [{ obstacle: 'The route has exposed sections', checker: 'official' }, { obstacle: 'Too long for young children', checker: 'page' }] };
    const router = fakeRouter({ refine: reply, restates: { restates: ['B'] }, 'obstacle-stated': (request: Ask) => ({ anchor: request.messages[1].content.includes('Condition: Too long') ? pickLetter(request, (text) => text.includes('young children')) : 'N' }) });
    const goal = await valueSide({ router, embedder: fakeEmbedder() }, { purpose, anchors });
    expect(goal).toMatchObject({ goal: VALUE_GOAL, role: VALUE_ROLE, protected: true, state: 'kept', trace: { kind: 'rule', text: 'value' } });
    expect(VALUE_GOAL).toBe('What the result must do for the purpose');
    expect(goal.basis).toContain('EN 12973');
    expect(goal.questions.map((q: { q: string }) => q.q)).toEqual(['Can a child walk the whole route?']);
    expect(goal.obstacles).toEqual([{ obstacle: 'The route has exposed sections', checker: 'official', threshold: null, soft: true }, { obstacle: 'Too long for young children', checker: 'page', threshold: null, soft: false, trace: { id: 'C2', text: 'that suit young children' } }]);
    expect(router.userText('refine')).toContain(`Goal: ${VALUE_GOAL}\nIt comes from: ${purpose.text}\n[C1] Find hiking trails near the city\n[C2] that suit young children\nAsk "how?" of the purpose`);
    const bare = await valueSide({ router: fakeRouter({ refine: FAIL }) }, { purpose, anchors });
    expect(bare).toMatchObject({ goal: VALUE_GOAL, protected: true, questions: [], obstacles: 'missing' });
  });

  it('measures value for cost by code over the two sides', () => {
    const tree = { goals: [{ id: 'G1', goal: 'x', questions: [{ id: 'Q1' }] }, { id: 'G2', role: VALUE_ROLE, questions: [{ id: 'Q2' }, { id: 'Q3' }] }, { id: 'G3', role: COST_ROLE, questions: [{ id: 'Q4' }] }] };
    expect(valueForCostOf(tree)).toMatchObject({ measure: 'value-for-cost', checker: 'code', value: 'G2', cost: 'G3', satisfied: ['Q2', 'Q3'], costs: ['Q4'] });
    expect(valueForCostOf({ goals: [tree.goals[0], tree.goals[1]] })).toBeNull();
    expect(valueForCost({ satisfied: 3, asked: 4, cost: 150 })).toEqual({ satisfaction: 0.75, cost: 150, ratio: 0.005 });
    expect(valueForCost({ satisfied: 3, asked: 4, cost: 0 })).toEqual({ satisfaction: 0.75, cost: null, ratio: null });
    expect(valueForCost({ satisfied: 1, asked: 0, cost: 10 })).toEqual({ satisfaction: null, cost: 10, ratio: null });
    expect(valueForCost()).toEqual({ satisfaction: null, cost: null, ratio: null });
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
  const anchors = plotAnchors;
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
    { id: 'G1', goal: 'A scenic location', state: 'kept', anchor: 'C1', trace: { id: 'C1', text: 'a scenic location' }, questions: [{ id: 'Q1', q: 'a', checker: 'page' }], obstacles: [] },
    { id: 'G2', goal: 'Beautiful surroundings', state: 'kept', anchor: 'C1', trace: { id: 'C1', text: 'a scenic location' }, questions: [{ id: 'Q2', q: 'b', checker: 'official' }], obstacles: [] },
    { id: 'G3', goal: 'Low entry cost', state: 'kept', anchor: 'C2', trace: { id: 'C2', text: 'low entry cost' }, questions: [{ id: 'Q3', q: 'c', checker: 'page' }], obstacles: [] },
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
    const anchors = await split('a scenic location, low entry cost');
    const out = await applyOps({ router: fakeRouter({}) }, tree, [{ op: 'drop', id: 'G3', reason: 'B' }, { op: 'checker', id: 'Q1', checker: 'official' }]);
    expect(out.ops.applied).toEqual([{ op: 'drop', id: 'G3', reason: 'B', goal: 'Low entry cost', anchor: 'C2' }, { op: 'checker', id: 'Q1', checker: 'official' }]);
    expect(out.goals[0].questions[0].checker).toBe('official');
    expect(notModelledOf(tree, anchors)).toEqual([]);
    expect(notModelledOf(out, anchors)).toEqual([{ id: 'C2', kind: 'clause', text: 'low entry cost' }]);
  });

  it('keeps the requirement of a goal that was merged away covered by the goal that absorbed it', async () => {
    const anchors = await split('a scenic location, low entry cost');
    const merged = await applyOps({ router: fakeRouter({ 'same-goal': { same: 'A' } }) }, tree, [{ op: 'merge', a: 'G1', b: 'G3' }]);
    expect(merged.goals.map((g: { id: string }) => g.id)).toEqual(['G1', 'G2']);
    expect(merged.goals[0].anchors).toEqual(['C2']);
    expect(notModelledOf(merged, anchors)).toEqual([]);
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

describe('coverage invariant: every requirement is in a kept goal or listed as not modelled', () => {
  const anchors = [{ id: 'C1', kind: 'clause', text: 'find a tent' }, { id: 'C2', kind: 'clause', text: 'proven good quality' }, { id: 'C3', kind: 'clause', text: 'a low price' }, { id: 'C4', kind: 'clause', text: 'sellers in two countries' }, { id: 'H1', kind: 'hint', text: 'ask the forum' }];
  const question = [{ id: 'Q1', q: 'a', checker: 'page' }];
  const goal = (id: string, trace: string | null, more: object = {}) => ({ id, goal: id, state: 'kept', trace: trace ? { id: trace, text: trace } : null, questions: question, ...more });
  const implications = [{ id: 'I1', attribute: 'quality', direction: 'high', anchor: 'C2' }];

  it('counts a requirement as covered only by a kept goal with a question that a vote traced to it, also through an implication', () => {
    const tree = { implications, goals: [goal('G1', 'C1'), goal('G2', 'I1'), goal('G3', 'C3', { state: 'proposed' }), goal('G4', 'C4', { questions: [] }), goal('G5', null, { role: 'tension', anchors: ['C3', 'C4'] }), goal('G6', 'P', { anchor: 'C3' })] };
    expect([...coveredAnchors(tree)].sort()).toEqual(['C1', 'C2', 'I1', 'P']);
    expect(notModelledOf(tree, anchors)).toEqual([{ id: 'C3', kind: 'clause', text: 'a low price' }, { id: 'C4', kind: 'clause', text: 'sellers in two countries' }]);
    expect(notModelledOf({ ...tree, goals: [...tree.goals, goal('G7', 'C3'), goal('G8', 'C4')] }, anchors)).toEqual([]);
  });

  it('does not count a requirement as covered through an implication when its own goal could not be refined', () => {
    const dropped = [{ goal: 'Proven quality', reason: UNREFINED, trace: { id: 'C2', text: 'proven good quality' } }, { goal: 'Other', reason: 'another reason', trace: { id: 'C1', text: 'find a tent' } }];
    const tree = { implications, dropped, goals: [goal('G1', 'C1'), goal('G2', 'I1')] };
    expect([...coveredAnchors(tree)].sort()).toEqual(['C1', 'I1']);
    expect(notModelledOf(tree, anchors).map((entry: { id: string }) => entry.id)).toEqual(['C2', 'C3', 'C4']);
    expect([...coveredAnchors({ ...tree, goals: [...tree.goals, goal('G3', 'C2')] })].sort()).toEqual(['C1', 'C2', 'I1']);
  });

  it('finds a requirement that is neither covered nor listed: the silent gap', () => {
    const tree = { implications, goals: [goal('G1', 'C1'), goal('G2', 'I1')], notModelled: [{ id: 'C3', kind: 'clause', text: 'a low price' }] };
    expect(coverageOf(tree, anchors)).toEqual({ anchors: 4, covered: ['C1', 'C2'], notModelled: ['C3'], silent: ['C4'] });
    expect(coverageOf({ ...tree, notModelled: notModelledOf(tree, anchors) }, anchors).silent).toEqual([]);
  });

  it('blocks confirmation while an entry is not dismissed, and keeps a dismissal when the tree is rebuilt', () => {
    const tree = { implications, goals: [goal('G1', 'C1'), goal('G2', 'I1')], thresholds: [], confirmedAt: null as string | null, notModelled: [] as { id: string; text: string; dismissedAt?: string }[] };
    tree.notModelled = notModelledOf(tree, anchors);
    expect(openEntries(tree)).toEqual([
      { id: 'C3', kind: 'not-modelled', text: 'a low price', reason: 'no kept goal with a measurable question covers this requirement: dismiss it, or rebuild the tree' },
      { id: 'C4', kind: 'not-modelled', text: 'sellers in two countries', reason: 'no kept goal with a measurable question covers this requirement: dismiss it, or rebuild the tree' },
    ]);
    const refused = confirmTree(tree, { at: '2026-11-16T10:00:00Z' });
    expect(refused).toMatchObject({ ok: false, reason: '2 requirement(s) are not modelled by any kept goal and were not dismissed: C3 a low price | C4 sellers in two countries' });
    expect(refused.tree.confirmedAt).toBeNull();
    expect(needsConfirmation({ ...tree, confirmedAt: '2026-11-16T10:00:00Z' })).toBe(true);
    const one = dismissNotModelled(tree, 'C3', { at: '2026-11-16T10:01:00Z' });
    expect(confirmTree(one).blocked.map((entry: { id: string }) => entry.id)).toEqual(['C4']);
    const both = dismissNotModelled(dismissNotModelled(one, 'C4', { at: '2026-11-16T10:02:00Z' }), 'C9');
    expect(openEntries(both)).toEqual([]);
    expect(needsConfirmation(both)).toBe(false);
    const confirmed = confirmTree(both, { at: '2026-11-16T10:03:00Z' });
    expect(confirmed).toMatchObject({ ok: true, blocked: [] });
    expect(confirmed.tree.confirmedAt).toBe('2026-11-16T10:03:00Z');
    expect(notModelledOf(both, anchors)).toEqual([{ id: 'C3', kind: 'clause', text: 'a low price', dismissedAt: '2026-11-16T10:01:00Z' }, { id: 'C4', kind: 'clause', text: 'sellers in two countries', dismissedAt: '2026-11-16T10:02:00Z' }]);
    expect(notModelledOf(both, anchors.map((anchor) => (anchor.id === 'C3' ? { ...anchor, text: 'a low total price' } : anchor)))[0]).toEqual({ id: 'C3', kind: 'clause', text: 'a low total price' });
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
  const anchors = smallShopAnchors;
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
  const lettersOfPieces = (request: Ask) => [...request.messages[1].content.matchAll(/^\[(S\d+)\]/gm)].map((match) => [match[1]]);
  const base = {
    requirements: (request: Ask) => ({ groups: lettersOfPieces(request) }),
    implications: { implications: [] },
    'same-goal': { same: 'B' },
    restates: { restates: [] },
    'obstacle-stated': { anchor: 'N' },
    critique: { ops: [] },
  };
  const phaseQuestion = (request: Ask) => ({ questions: [{ q: `What does the ${COST_PHASES.find((phase: { id: string }) => request.messages[0].content.includes(`ownership: ${phase.id} (`))!.id} phase take?`, paid: 'B', checker: 'consensus' }], obstacles: [] });

  it('splits, groups and votes on tensions before the purpose samples, and on consumes before the implications', async () => {
    const order = (router: { calls: { task?: string }[] }) => router.calls.map((call) => call.task).filter((task, index, all) => task !== all[index - 1]);
    const failed = fakeRouter({ ...base, 'requirement-split': { more: false }, tensions: { pairs: [['C1', 'C2']] }, purpose: FAIL });
    const built = await buildPurposeTree({ router: failed, embedder: fakeEmbedder(), budget: new CallBudget() }, { question: 'as light as possible, lasting many years' });
    expect(order(failed)).toEqual(['requirement-split', 'requirements', 'tensions', 'purpose']);
    expect(built).toMatchObject({ phase: 'needs-purpose', tree: null, tensions: { decided: true, pairs: [{ id: 'C1|C2' }] } });
    const router = fakeRouter({ ...base, 'requirement-split': { more: false }, tensions: { pairs: [] }, purpose: { who: 'a buyer', outcome: 'x', why: 'y', anchors: ['C1'] }, consumes: { consumes: false }, goals: FAIL });
    const budget = new CallBudget();
    await buildPurposeTree({ router, embedder: fakeEmbedder(), budget }, { question: 'as light as possible, lasting many years' });
    expect(order(router).slice(0, 6)).toEqual(['requirement-split', 'requirements', 'tensions', 'purpose', 'consumes', 'implications']);
    expect(budget.report().purpose).toEqual({ used: 16, cap: 54, skipped: 0 });
  });

  it('keeps a restating goal refined, both sides and the tension goal after a critique that tried to delete them, and lists what is open', async () => {
    const question = 'Find a tent to buy, at a low entry price, with a long service life';
    const notes = [
      { id: 'N1', url: 'https://one.example.org/a', quote: 'Last season models are sold off when a new one arrives.', label: 'model change' },
      { id: 'N2', url: 'https://two.example.org/b', quote: 'Heavier cloth lasts longer and sells for less.', label: 'weight' },
    ];
    let critiqued = '';
    const router = fakeRouter({
      ...base,
      tensions: { pairs: [['C2', 'C3']] },
      purpose: { who: 'a camper', outcome: 'a tent that lasts', why: 'a small budget', anchors: ['C2'] },
      consumes: { consumes: true },
      goals: { goals: [{ goal: 'A long service life', anchor: 'C3', notes: [] }, { goal: 'A low entry price', anchor: 'C2', notes: [] }, { goal: 'Secure financing', anchor: 'C2', notes: [] }, { goal: 'Invented anchor', anchor: 'C9' }] },
      trace: (request: Ask) => {
        const goal = request.messages[1].content;
        if (goal.includes('Goal: A long')) return { anchor: pickLetter(request, (text) => text.includes('service life')), relation: 'S' };
        if (goal.includes('Goal: A low')) return { anchor: pickLetter(request, (text) => text.includes('entry price')), relation: 'R' };
        return { anchor: 'N' };
      },
      refine: (request: Ask) => {
        const asked = request.messages[1].content;
        if (asked.includes('Goal: A long')) return { ...refined, questions: [{ q: 'Is the warranty at least 5 years?', checker: 'page', threshold: { op: '>=', value: 5, unit: 'years' } }] };
        if (asked.includes('Goal: A low') && !asked.includes('Every question only restated')) return { ...refined, questions: [{ q: 'Is the entry price low?', checker: 'page' }] };
        if (asked.includes('Goal: A low')) return { ...refined, questions: [{ q: 'Where does the price stand among comparable items?', checker: 'code' }] };
        if (asked.includes(`Goal: ${VALUE_GOAL}`)) return { refine: 'AND', questions: [{ q: 'Does it stay dry in heavy rain?', checker: 'consensus' }], obstacles: [{ obstacle: 'Seams leak after one season', checker: 'consensus' }] };
        return refined;
      },
      restates: (request: Ask) => ({ restates: request.messages[1].content.includes('A) Is the entry price low?') ? ['A'] : [] }),
      'cost-phase': phaseQuestion,
      'tension-explain': { explanations: [{ explanation: 'A replaced model is sold off', notes: ['N1'], test: 'Is it a model of last season?', checker: 'page' }, { explanation: 'Heavier cloth lasts longer for less', notes: ['N2'], test: 'Is the cloth heavier than usual?', checker: 'page' }, { explanation: 'No note', notes: ['N7'] }] },
      critique: (request: Ask) => {
        critiqued = request.messages[1].content;
        const id = (role: string) => critiqued.match(new RegExp(`^(G\\d+) \\[from ${role}\\]`, 'm'))![1];
        return { ops: [{ op: 'drop', id: id('tension'), reason: 'A' }, { op: 'drop', id: id('value'), reason: 'C' }, { op: 'drop', id: id('cost'), reason: 'C' }] };
      },
    });
    const log: string[] = [];
    let failures = 0;
    const embedder = Object.assign(fakeEmbedder(), { failureNote: () => (failures++ ? '' : 'embeddings unavailable (one: answered 503); every candidate is judged instead') });
    const budget = new CallBudget();
    const { phase, tree, anchors } = await buildPurposeTree({ router, embedder, budget, log: (line: string) => log.push(line) }, { question, notes });
    expect(anchors.map((anchor: { id: string; text: string }) => `${anchor.id} ${anchor.text}`)).toEqual(['C1 Find a tent to buy', 'C2 at a low entry price', 'C3 with a long service life']);
    expect(phase).toBe('needs-confirmation');
    expect(tree.version).toBe(2);
    expect(tree.requirements).toMatchObject({ grouping: { grouped: true, valid: 2 }, pieces: [{ text: 'Find a tent to buy', split: false }, { text: 'at a low entry price', split: false }, { text: 'with a long service life', split: false }] });
    expect(tree.goals.map((g: { id: string; goal: string; state: string; role?: string }) => [g.id, g.goal, g.state, g.role ?? ''])).toEqual([
      ['G1', 'A long service life', 'kept', ''],
      ['G2', 'A low entry price', 'kept', ''],
      ['G3', 'Secure financing', 'proposed', ''],
      ['G4', VALUE_GOAL, 'kept', 'value'],
      ['G5', COST_GOAL, 'kept', 'cost'],
      ['G6', 'Meet both at once: "at a low entry price" and "with a long service life"', 'kept', 'tension'],
    ]);
    expect(tree.goals[1]).toMatchObject({ restates: true, restated: 1, trace: { id: 'C2', text: 'at a low entry price' } });
    expect(tree.goals[1].questions.map((q: { q: string; checker: string }) => [q.q, q.checker])).toEqual([['Where does the price stand among comparable items?', 'code']]);
    expect(router.userText('refine', 1)).toContain('It comes from: at a low entry price');
    expect(tree.dropped).toEqual([]);
    expect(tree.consumes).toEqual({ value: true, decided: true, votes: { true: 2 } });
    expect(tree.goals[4].phases.map((entry: { id: string; questions: number }) => [entry.id, entry.questions])).toEqual([['pre-transaction', 1], ['transaction', 1], ['post-transaction', 1]]);
    expect(tree.valueForCost).toMatchObject({ measure: 'value-for-cost', checker: 'code', value: 'G4', cost: 'G5', satisfied: ['Q4'], costs: ['Q5', 'Q6', 'Q7'] });
    expect(tree.goals[3].obstacles).toEqual([{ id: 'O4', obstacle: 'Seams leak after one season', checker: 'consensus', threshold: null, soft: true }]);
    const [tension] = tensionGoalsOf(tree);
    expect(tension.hypotheses.map((entry: { id: string; notes: string[] }) => [entry.id, entry.notes])).toEqual([['M1', ['N1']], ['M2', ['N2']], ['M0', []]]);
    expect(tension.questions.map((q: { id: string; hypothesis: string }) => [q.id, q.hypothesis])).toEqual([['Q8', 'M1'], ['Q9', 'M2']]);
    expect(tension.gap).toBeUndefined();
    expect(critiqued).toContain('G6 [from tension]');
    expect(tree.ops.applied).toEqual([]);
    expect(tree.ops.refused.map((entry: { why: string }) => entry.why)).toEqual([`"${tension.goal}" is a protected tension goal`, `"${VALUE_GOAL}" is a protected value goal`, `"${COST_GOAL}" is a protected cost goal`]);
    expect(tree.goals.filter((g: { state: string; trace: unknown }) => g.state === 'kept' && !g.trace)).toEqual([]);
    expect(tree.thresholds).toEqual([{ node: 'Q1', goal: 'G1', op: '>=', value: 5, unit: 'years', source: 'assumption', hard: false }]);
    expect(openEntries(tree).map((e: { id: string; kind: string }) => [e.id, e.kind])).toEqual([['C1', 'not-modelled'], ['G3', 'goal'], ['Q1', 'threshold']]);
    expect(tree.notModelled).toEqual([{ id: 'C1', kind: 'clause', text: 'Find a tent to buy' }]);
    expect(log).toContain('1 requirement(s) not modelled by any kept goal: C1 Find a tent to buy; the tree cannot be confirmed until each is dismissed');
    expect(tree.unrefined).toEqual([]);
    expect(tree.confirmedAt).toBeNull();
    expect(budget.caps.tree).toBe(72);
    expect(budget.report().tree.skipped).toBe(0);
    expect(log.filter((line) => line.startsWith('tree budget: 72 calls for 6 goal(s) (12 a goal, at least 60)'))).toHaveLength(2);
    expect(log.filter((line) => line.startsWith('embeddings unavailable'))).toHaveLength(1);
    expect(log.filter((line) => line.includes('protected'))).toHaveLength(3);
    expect(router.calls.findIndex((call: { task?: string }) => call.task === 'consumes')).toBeGreaterThan(router.calls.findIndex((call: { task?: string }) => call.task === 'purpose'));
    expect(router.count('conflict')).toBe(0);
  });

  it('adds neither side when the vote says the result consumes nothing, both when it does, for a question with no price wording, and never a tension nobody voted', async () => {
    const question = 'Find open-source libraries that read documents, actively maintained, well documented';
    const script = (consumes: unknown) => ({ ...base, tensions: { pairs: [] }, purpose: { who: 'a developer', outcome: 'a library to build on', why: 'a deadline', anchors: ['C1'] }, consumes, goals: { goals: [{ goal: 'Actively maintained', anchor: 'C2', notes: [] }] }, trace: (request: Ask) => ({ anchor: pickLetter(request, (text) => text.includes('maintained')), relation: 'S' }), refine: refined, 'cost-phase': phaseQuestion });
    const without = await buildPurposeTree({ router: fakeRouter(script({ consumes: false })), embedder: fakeEmbedder(), budget: new CallBudget() }, { question });
    expect(without.tree.goals.map((g: { goal: string }) => g.goal)).toEqual(['Actively maintained']);
    expect(without.tree.consumes).toMatchObject({ value: false, decided: true });
    expect(without.tree.valueForCost).toBeNull();
    expect(tensionGoalsOf(without.tree)).toEqual([]);
    expect(without.tree.notModelled.map((entry: { id: string }) => entry.id)).toEqual(['C1', 'C3']);
    expect(without.phase).toBe('needs-confirmation');
    const named = ['Libraries that read documents', 'Actively maintained', 'Well documented'];
    const traceEach = (request: Ask) => ({ anchor: pickLetter(request, (text) => text.toLowerCase().endsWith(request.messages[1].content.split('\n')[0].toLowerCase().split(' ').pop()!)), relation: 'S' });
    const covering = await buildPurposeTree({ router: fakeRouter({ ...script({ consumes: false }), goals: { goals: named.map((goal, index) => ({ goal, anchor: `C${index + 1}`, notes: [] })) }, trace: traceEach }), embedder: fakeEmbedder(), budget: new CallBudget() }, { question });
    expect(covering.tree.goals.map((g: { trace: { id: string } }) => g.trace.id)).toEqual(['C1', 'C2', 'C3']);
    expect(covering.tree.notModelled).toEqual([]);
    expect(covering.phase).toBe('tree-ready');
    const router = fakeRouter(script({ consumes: true }));
    const withSides = await buildPurposeTree({ router, embedder: fakeEmbedder(), budget: new CallBudget() }, { question });
    expect(withSides.tree.goals.map((g: { goal: string; role?: string }) => [g.goal, g.role ?? ''])).toEqual([['Actively maintained', ''], [VALUE_GOAL, 'value'], [COST_GOAL, 'cost']]);
    expect(withSides.tree.goals[2].questions.map((q: { phase: string; q: string }) => [q.phase, q.q])).toEqual([['pre-transaction', 'What does the pre-transaction phase take?'], ['transaction', 'What does the transaction phase take?'], ['post-transaction', 'What does the post-transaction phase take?']]);
    expect(tensionGoalsOf(withSides.tree)).toEqual([]);
    const log: string[] = [];
    const undecided = await buildPurposeTree({ router: fakeRouter(script(seq({ consumes: true }, { consumes: false }, FAIL))), embedder: fakeEmbedder(), budget: new CallBudget(), log: (line: string) => log.push(line) }, { question });
    expect(undecided.tree.consumes).toMatchObject({ value: true, decided: false });
    expect(undecided.tree.goals.map((g: { role?: string }) => g.role ?? '')).toEqual(['', 'value', 'cost']);
    expect(log).toContain('value and cost sides: no majority on whether the result consumes resources of the asker; both sides are kept');
  });

  it('sizes the tree budget per goal so that 8 goals are all refined, and names a goal that was not', async () => {
    expect([treeCap(0), treeCap(5), treeCap(6), treeCap(11)]).toEqual([60, 60, 72, 132]);
    const names = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].map((name) => `Goal number ${name}`);
    const script = (refine: unknown) => ({ ...base, tensions: { pairs: [] }, purpose: { who: 'a', outcome: 'x', why: 'y', anchors: ['C1'] }, consumes: { consumes: false }, goals: { goals: names.map((goal) => ({ goal, anchor: 'C1', notes: [] })) }, trace: (request: Ask) => ({ anchor: pickLetter(request, () => true), relation: 'S' }), refine });
    const budget = new CallBudget({ ...STAGE_CAPS, tree: 10 });
    const log: string[] = [];
    const { tree } = await buildPurposeTree({ router: fakeRouter(script(refined)), embedder: fakeEmbedder(), budget, log: (line: string) => log.push(line) }, { question: 'eight things at once' });
    expect(tree.goals.map((g: { goal: string }) => g.goal)).toEqual(names);
    expect(tree.goals.every((g: { questions: unknown[]; state: string }) => g.questions.length === 1 && g.state === 'kept')).toBe(true);
    expect(budget.caps.tree).toBe(96);
    expect(budget.report().tree).toMatchObject({ cap: 96, skipped: 0 });
    expect(budget.report().tree.used).toBeGreaterThan(10);
    expect(log).toContain('tree budget: 96 calls for 8 goal(s) (12 a goal, at least 60)');
    expect(tree.unrefined).toEqual([]);
    const missing: string[] = [];
    const partial = await buildPurposeTree({ router: fakeRouter(script((request: Ask) => (request.messages[1].content.includes('number three') ? FAIL : refined))), embedder: fakeEmbedder(), budget: new CallBudget(), log: (line: string) => missing.push(line) }, { question: 'eight things at once' });
    expect(partial.tree.goals).toHaveLength(7);
    expect(partial.tree.dropped).toEqual([{ goal: 'Goal number three', reason: UNREFINED, trace: { id: 'C1', text: 'eight things at once' } }]);
    expect(partial.tree.unrefined).toEqual(['Goal number three']);
    expect(missing).toContain('1 goal(s) not refined into measurable questions: Goal number three');
  });
});

describe('voteHardness with stub router', () => {
  const ctx = { router: fakeRouter({ hardness: { kind: 'constraint' } }), budget: new CallBudget(), log: () => {} };
  const ctxCriterion = { router: fakeRouter({ hardness: { kind: 'criterion' } }), budget: new CallBudget(), log: () => {} };
  const userWords = 'Find cars within 300km from Prague up to 65000CZK';

  it('explicit limit (within 300 km) -> constraint/hard', async () => {
    expect(await voteHardness(ctx, { requirementText: 'within 300 km of Prague', userWords })).toBe(true);
  });

  it('explicit limit (max 65000 CZK) -> constraint/hard', async () => {
    expect(await voteHardness(ctx, { requirementText: 'price up to 65000 CZK', userWords })).toBe(true);
  });

  it('hint describing the kind -> criterion/soft', async () => {
    expect(await voteHardness(ctxCriterion, { requirementText: 'hatchback preferred', userWords })).toBe(false);
  });

  it('location preference hint -> criterion/soft', async () => {
    expect(await voteHardness(ctxCriterion, { requirementText: 'prefer locations near Prague', userWords })).toBe(false);
  });

  it('supplier outside a location HINT is not rejected by the verdict (hint is soft)', async () => {
    const isHard = await voteHardness(ctxCriterion, { requirementText: 'supplier located in NL, DE, UK', userWords: 'Find suppliers in NL or DE' });
    expect(isHard).toBe(false);
  });
});

describe('composite goal combine truth table', () => {
  function combineGoal(answers: ('yes' | 'no' | 'unknown')[], refine: 'AND' | 'OR'): 'yes' | 'no' | 'unknown' {
    const hardAnswers = answers;
    if (refine === 'AND') {
      if (hardAnswers.every((a) => a === 'yes')) return 'yes';
      if (hardAnswers.some((a) => a === 'no')) return 'no';
      return 'unknown';
    }
    if (refine === 'OR') {
      if (hardAnswers.some((a) => a === 'yes')) return 'yes';
      if (hardAnswers.every((a) => a === 'no')) return 'no';
      return 'unknown';
    }
    return 'unknown';
  }

  it('AND: all hard yes -> yes', () => {
    expect(combineGoal(['yes', 'yes', 'yes'], 'AND')).toBe('yes');
  });

  it('AND: any hard no -> no', () => {
    expect(combineGoal(['yes', 'no', 'yes'], 'AND')).toBe('no');
    expect(combineGoal(['no', 'unknown'], 'AND')).toBe('no');
  });

  it('AND: else unknown', () => {
    expect(combineGoal(['yes', 'unknown'], 'AND')).toBe('unknown');
    expect(combineGoal(['unknown', 'unknown'], 'AND')).toBe('unknown');
  });

  it('OR: any yes -> yes', () => {
    expect(combineGoal(['no', 'yes', 'no'], 'OR')).toBe('yes');
    expect(combineGoal(['yes', 'unknown'], 'OR')).toBe('yes');
  });

  it('OR: all no -> no', () => {
    expect(combineGoal(['no', 'no', 'no'], 'OR')).toBe('no');
  });

  it('OR: else unknown', () => {
    expect(combineGoal(['unknown', 'unknown'], 'OR')).toBe('unknown');
    expect(combineGoal(['no', 'unknown'], 'OR')).toBe('unknown');
  });
});
