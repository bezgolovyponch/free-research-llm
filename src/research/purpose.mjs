import { readFileSync } from 'node:fs';
import { clausesOf } from './clauses.mjs';
import { currencyOf } from './acceptance.mjs';
import { SAMPLE_TEMPERATURE, agreeAcrossSamples, ask, idOf, matchPrompt, oneOf, optionLines, retrieveThenVerify, shortText, vote } from './semantic.mjs';

export const PURPOSE = JSON.parse(readFileSync(new URL('./purpose.json', import.meta.url), 'utf8'));
export const TREE_VERSION = 4;
export const TENSION_ROLE = 'tension';
export const VALUE_ROLE = 'value';
export const COST_ROLE = 'cost';
export const VALUE_GOAL = 'What the result must do for the purpose';
export const COST_GOAL = 'Total cost to obtain and use it';
export const VALUE_BASIS = 'EN 12973:2020 value management: value = satisfaction of needs / resources used; function analysis by "how?" and "why?" (FAST)';
export const COST_BASIS = 'Total cost of ownership (Ellram 1993, 1995): pre-transaction, transaction and post-transaction costs';
export const COST_PHASES = [
  { id: 'pre-transaction', covers: 'finding, qualifying, minimum order, registration' },
  { id: 'transaction', covers: 'price, delivery, duties, payment' },
  { id: 'post-transaction', covers: 'defects, returns, repairs, resale or disposal' },
];
export const PRICE_CHECKER = 'code';
export const COST_CHECKERS = ['consensus', 'page', 'official'];
export const METHOD_ALTERNATIVE = 'the combination does not hold here';
export const METHOD_ID = 'M0';
export const METHOD_BASIS = 'Heuer 1999 Analysis of Competing Hypotheses';
export const RESEARCH_GAP = 'research gap';
export const MIN_EXPLANATIONS = 2;
export const MAX_EXPLANATIONS = 4;
export const MAX_TENSIONS = 3;
export const CHECKERS = ['page', 'code', 'consensus', 'statistic', 'official'];
export const THRESHOLD_OPS = ['<=', '>=', '<', '>'];
export const DIRECTIONS = ['low', 'high', 'match'];
export const DROP_REASONS = { A: 'redundant with another goal', B: 'not asked by the question or its purpose', C: 'a means, not an objective' };
export const MAX_GOALS = 8;
export const MAX_NOTES_SHOWN = 14;
export const PURPOSE_STAGE = 'purpose';
export const PURPOSE_BASE_CAP = 48;
export const PURPOSE_CALLS_PER_PIECE = 3;
export const SPLIT_MIN_WORDS = 3;
export const TREE_STAGE = 'tree';
export const TREE_CALLS_PER_GOAL = 12;
export const TREE_MIN_CAP = 60;
export const UNREFINED = 'not refined into measurable questions';
export const NOT_MODELLED = 'not-modelled';

const OPEN_STATES = ['proposed', 'conflict'];
const QUESTION_LETTERS = 'ABCDEFGH';
const lines = (rows) => rows.map((row) => `[${row.id}] ${row.text}`).join('\n');
const noteLines = (notes) => lines(notes.map((note) => ({ id: note.id, text: `${note.label}: ${String(note.quote).slice(0, 160)}` })));

export function aboutSubject(ctx) {
  const subject = String(ctx?.subject ?? '').trim();
  return subject ? `Everything here is about ${subject}: read every requirement word in that sense, never in another trade. ` : '';
}

export function treeCap(goals) {
  return Math.max(TREE_MIN_CAP, Math.max(0, Number(goals) || 0) * TREE_CALLS_PER_GOAL);
}

export function purposeCap(pieces) {
  return PURPOSE_BASE_CAP + Math.max(0, Number(pieces) || 0) * PURPOSE_CALLS_PER_PIECE;
}

function planPurpose(ctx, pieces) {
  if (!ctx.budget?.caps) return;
  ctx.budget.caps[PURPOSE_STAGE] = purposeCap(pieces);
  ctx.log?.(`purpose budget: ${ctx.budget.caps[PURPOSE_STAGE]} calls (${PURPOSE_BASE_CAP} for grouping, tensions, purpose, consumes and implications, ${PURPOSE_CALLS_PER_PIECE} for each of ${pieces} piece(s) of at least ${SPLIT_MIN_WORDS} words)`);
}

function planTree(ctx, goals) {
  if (!ctx.budget?.caps) return;
  ctx.budget.caps[TREE_STAGE] = treeCap(goals);
  ctx.log?.(`tree budget: ${ctx.budget.caps[TREE_STAGE]} calls for ${goals} goal(s) (${TREE_CALLS_PER_GOAL} a goal, at least ${TREE_MIN_CAP})`);
}

const oneSpace = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const wordCount = (text) => oneSpace(text).split(' ').filter(Boolean).length;

export function splitPoint(piece, second) {
  const text = oneSpace(piece);
  const wanted = oneSpace(second);
  if (!wanted) return null;
  for (let at = text.indexOf(wanted); at !== -1; at = text.indexOf(wanted, at + 1)) {
    const end = at + wanted.length;
    if (at > 0 && text[at - 1] === ' ' && (end === text.length || text[end] === ' ')) return at;
  }
  return null;
}

export async function splitPiece(ctx, piece) {
  const text = oneSpace(piece);
  if (wordCount(text) < SPLIT_MIN_WORDS) return { parts: [text], votes: {} };
  const messages = [
    { role: 'system', content: 'You read one piece of a request, in any language. Decide whether it holds more than one requirement: two things the asker wants, where one could be met while the other is missed. A thing together with its own description is one requirement. "more": true or false. When true, "second": the words of the piece where the second requirement starts, copied letter for letter from the piece. Answer with JSON only: {"more":true,"second":"..."} or {"more":false}.' },
    { role: 'user', content: `Piece: ${text}` },
  ];
  const schema = (data) => {
    if (typeof data?.more !== 'boolean') return { error: '"more" must be true or false' };
    if (!data.more) return { value: { at: 0 } };
    const at = splitPoint(text, data.second);
    return at === null ? { error: `"second" must be words copied exactly from the piece, starting at one of its words after the first: ${text}` } : { value: { at } };
  };
  const result = await vote({ router: ctx.router, task: 'requirement-split', tier: 'fast', messages, schema, n: 3, quorum: 2, key: (value) => String(value.at), budget: ctx.budget, stage: PURPOSE_STAGE });
  const at = result.value?.at ?? 0;
  return { parts: at > 0 ? [text.slice(0, at).trim(), text.slice(at).trim()] : [text], votes: result.tally };
}

export async function groupSpans(ctx, spans) {
  const singles = spans.map((span) => [span.id]);
  if (spans.length < 2) return { groups: singles, grouped: false, valid: 0 };
  const known = new Set(spans.map((span) => span.id));
  const order = new Map(spans.map((span, index) => [span.id, index]));
  const messages = [
    { role: 'system', content: 'You read one request that was cut into pieces, in any language. Group the pieces into requirements by meaning: pieces that only make sense together are one requirement, and a list of examples of one thing is one requirement. Every piece id goes into exactly one group. Answer with JSON only: {"groups":[["S1","S2"],["S3"]]}.' },
    { role: 'user', content: `Pieces:\n${lines(spans)}` },
  ];
  const schema = (data) => {
    if (!Array.isArray(data?.groups) || data.groups.some((group) => !Array.isArray(group))) return { error: '"groups" must be a list of lists of piece ids' };
    const groups = data.groups.map((group) => group.map((id) => idOf(id, known))).filter((group) => group.length);
    const named = groups.flat();
    if (named.some((id) => !id)) return { error: `a group names an id that is not one of ${[...known].join(', ')}` };
    if (named.length !== spans.length || new Set(named).size !== spans.length) return { error: 'every piece id must be in exactly one group' };
    return { value: groups.map((group) => [...group].sort((a, b) => order.get(a) - order.get(b))).sort((a, b) => order.get(a[0]) - order.get(b[0])) };
  };
  const result = await vote({ router: ctx.router, task: 'requirements', tier: 'fast', messages, schema, n: 3, quorum: 2, budget: ctx.budget, stage: PURPOSE_STAGE });
  const valid = result.replies.length;
  if (valid < 2) return { groups: singles, grouped: false, valid };
  const together = new Map();
  for (const reply of result.replies) for (const group of reply.value) for (const a of group) for (const b of group) if (order.get(a) < order.get(b)) together.set(`${a}|${b}`, (together.get(`${a}|${b}`) ?? 0) + 1);
  const count = (a, b) => together.get(order.get(a) < order.get(b) ? `${a}|${b}` : `${b}|${a}`) ?? 0;
  const link = (first, second) => {
    const counts = first.flatMap((a) => second.map((b) => count(a, b)));
    return { weakest: Math.min(...counts), sum: counts.reduce((sum, value) => sum + value, 0) };
  };
  let groups = singles;
  for (;;) {
    let best = null;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const { weakest, sum } = link(groups[i], groups[j]);
        if (weakest * 2 > valid && (!best || weakest > best.weakest || (weakest === best.weakest && sum > best.sum))) best = { i, j, weakest, sum };
      }
    }
    if (!best) break;
    const merged = [...groups[best.i], ...groups[best.j]].sort((a, b) => order.get(a) - order.get(b));
    groups = groups.filter((_, index) => index !== best.i && index !== best.j).concat([merged]).sort((a, b) => order.get(a[0]) - order.get(b[0]));
  }
  return { groups, grouped: true, valid };
}

async function groupedPieces(ctx, texts, { prefix, of }) {
  const spans = [];
  const pieces = [];
  for (const [index, piece] of texts.entries()) {
    const { parts, votes } = await splitPiece(ctx, piece);
    if (parts.length > 1) ctx.log?.(`requirements: the piece "${oneSpace(piece)}" holds two requirements; it is split before "${parts[1]}"`);
    const ids = [];
    for (const text of parts.length > 1 ? parts : [piece]) {
      spans.push({ id: `${prefix}${spans.length + 1}`, text, piece: index });
      ids.push(`${prefix}${spans.length}`);
    }
    pieces.push({ text: piece, asked: wordCount(piece) >= SPLIT_MIN_WORDS, split: parts.length > 1, votes, spans: ids });
  }
  const byId = new Map(spans.map((span) => [span.id, span]));
  const { groups, grouped, valid } = await groupSpans(ctx, spans);
  if (!grouped && spans.length > 1) ctx.log?.(`requirements: no majority on grouping the ${spans.length} pieces of the ${of} by meaning; the punctuation split is kept`);
  const joined = (group) => group.map((id, at) => `${at === 0 ? '' : byId.get(id).piece === byId.get(group[at - 1]).piece ? ' ' : ', '}${byId.get(id).text}`).join('');
  return { groups: groups.map((group) => ({ text: joined(group), spans: group })), pieces, grouping: { grouped, valid } };
}

export async function requirementsOf(ctx, question, guidance = '') {
  const texts = clausesOf(question);
  const hintTexts = clausesOf(guidance);
  planPurpose(ctx, [...texts, ...hintTexts].filter((piece) => wordCount(piece) >= SPLIT_MIN_WORDS).length);
  const asked = await groupedPieces(ctx, texts, { prefix: 'S', of: 'question' });
  const hinted = hintTexts.length ? await groupedPieces(ctx, hintTexts, { prefix: 'T', of: 'hints' }) : null;
  const anchors = [
    ...asked.groups.map((group, index) => ({ id: `C${index + 1}`, kind: 'clause', ...group })),
    ...(hinted?.groups ?? []).map((group, index) => ({ id: `H${index + 1}`, kind: 'hint', ...group })),
  ];
  return { anchors, pieces: asked.pieces, grouping: asked.grouping, ...(hinted ? { hints: { pieces: hinted.pieces, grouping: hinted.grouping } } : {}) };
}

export async function drawRequirements(ctx, question, guidance = '') {
  const requirements = await requirementsOf(ctx, question, guidance);
  return { requirements, purpose: await drawPurpose(ctx, requirements.anchors) };
}

export async function anchorsOf(ctx, question, guidance = '') {
  return (await requirementsOf(ctx, question, guidance)).anchors;
}

export function purposeText(purpose) {
  return purpose ? `${purpose.who} wants ${purpose.outcome}${purpose.why ? `, because ${purpose.why}` : ''}` : '';
}

function sharedAnchors(samples) {
  const scores = samples.map((sample, index) => samples.reduce((sum, other, at) => (at === index ? sum : sum + other.anchors.filter((id) => sample.anchors.includes(id)).length), 0));
  return scores.indexOf(Math.max(...scores));
}

export async function drawPurpose(ctx, anchors) {
  const known = new Set(anchors.map((anchor) => anchor.id));
  const messages = [
    { role: 'system', content: 'You state the purpose behind a question (value-focused thinking): who decides, the outcome they want, and why that matters to them. Use only what the clauses and hints say. Name the ids of the clauses and hints the purpose rests on. Answer with JSON only: {"who":"...","outcome":"...","why":"...","anchors":["C2","H1"]}.' },
    { role: 'user', content: `Clauses and hints:\n${lines(anchors)}` },
  ];
  const schema = (data) => {
    const ids = [...new Set((Array.isArray(data?.anchors) ? data.anchors : []).map((id) => idOf(id, known)).filter(Boolean))];
    const outcome = shortText(data?.outcome, 40, 300);
    if (!outcome) return { error: '"outcome" is empty' };
    if (!ids.length) return { error: '"anchors" must name at least one clause or hint id from the list' };
    return { value: { who: shortText(data?.who, 20, 160) || 'the asker', outcome, why: shortText(data?.why, 40, 300), anchors: ids } };
  };
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const reply = await ask({ router: ctx.router, task: 'purpose', tier: 'deep', temperature: SAMPLE_TEMPERATURE, messages, schema, budget: ctx.budget, stage: PURPOSE_STAGE });
    if (reply) samples.push(reply.value);
  }
  if (samples.length < 2) return null;
  const nearest = ctx.embedder ? await ctx.embedder.medoid(samples.map(purposeText)) : null;
  const chosen = samples[nearest ?? sharedAnchors(samples)];
  return { id: 'P', ...chosen, text: purposeText(chosen), samples: samples.length };
}

export async function drawImplications(ctx, anchors, purpose) {
  const known = new Set(anchors.map((anchor) => anchor.id));
  const messages = [
    { role: 'system', content: `${aboutSubject(ctx)}You ask "why is that important" of a purpose. List at most 5 attributes the purpose makes preferable, each with its direction: "low" (less is better), "high" (more is better) or "match" (must fit a given value). "anchor" is the id of the clause or hint it follows from. Attributes of at most 6 words. Answer with JSON only: {"implications":[{"attribute":"...","direction":"low|high|match","anchor":"C5"}]}.` },
    { role: 'user', content: `Purpose: ${purpose.text}\n\nClauses and hints:\n${lines(anchors)}` },
  ];
  const schema = (data) => {
    if (!Array.isArray(data?.implications)) return { error: '"implications" must be a list' };
    const list = data.implications.slice(0, 5).map((entry) => ({ attribute: shortText(entry?.attribute, 6, 80), direction: DIRECTIONS.find((direction) => direction === String(entry?.direction ?? '').trim().toLowerCase()) ?? null, anchor: idOf(entry?.anchor, known) })).filter((entry) => entry.attribute && entry.direction && entry.anchor);
    return { value: list };
  };
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const reply = await ask({ router: ctx.router, task: 'implications', tier: 'deep', temperature: SAMPLE_TEMPERATURE, messages, schema, budget: ctx.budget, stage: PURPOSE_STAGE });
    if (reply) samples.push(reply.value);
  }
  const agreed = await agreeAcrossSamples({ samples, textOf: (entry) => entry.attribute, sameKey: (entry) => `${entry.anchor}|${entry.direction}`, embedder: ctx.embedder, router: ctx.router, prompt: matchPrompt('attribute'), task: 'implications-match', budget: ctx.budget, stage: PURPOSE_STAGE });
  return agreed.map((entry, index) => ({ id: `I${index + 1}`, ...entry.item, source: 'inferred', samples: entry.samples }));
}

export async function consumesVote(ctx, purpose, anchors) {
  const messages = [
    { role: 'system', content: 'You read the purpose of one request and its requirements, in any language. Decide whether the result is something the asker obtains or uses, so that getting it or using it consumes money, time or other resources of theirs. Answer with JSON only: {"consumes":true} or {"consumes":false}.' },
    { role: 'user', content: `Purpose: ${purpose.text}\n\nRequirements and hints:\n${lines(anchors)}` },
  ];
  const schema = (data) => (typeof data?.consumes === 'boolean' ? { value: data.consumes } : { error: '"consumes" must be true or false' });
  const result = await vote({ router: ctx.router, task: 'consumes', tier: 'fast', messages, schema, n: 3, quorum: 2, key: (value) => String(value), budget: ctx.budget, stage: PURPOSE_STAGE });
  return { value: result.value ?? true, decided: result.value !== null, votes: result.tally };
}

export async function tensionsAsked(ctx, anchors) {
  const clauses = anchors.filter((anchor) => anchor.kind === 'clause');
  if (!clauses.length) return { pairs: [], decided: true, replies: 0, votes: {} };
  const known = new Set(clauses.map((clause) => clause.id));
  const order = new Map(clauses.map((clause, index) => [clause.id, index]));
  const textOf = new Map(clauses.map((clause) => [clause.id, clause.text]));
  const messages = [
    { role: 'system', content: 'You read the requirements of one request, in any language. Two requirements pull against each other when meeting one more fully usually makes the other harder to meet. Name only pairs the requirements themselves state, whatever the two qualities are. When both sides are inside one requirement, give its id twice. Give an empty list when none pull against each other. Answer with JSON only: {"pairs":[["C1","C3"]]}.' },
    { role: 'user', content: `Requirements:\n${lines(clauses)}` },
  ];
  const schema = (data) => {
    if (!Array.isArray(data?.pairs)) return { error: '"pairs" must be a list of pairs of requirement ids, or an empty list' };
    const ids = new Set();
    for (const pair of data.pairs) {
      const [a, b] = (Array.isArray(pair) ? pair : String(pair ?? '').split('|')).map((id) => idOf(id, known));
      if (a && b) ids.add([a, b].sort((x, y) => order.get(x) - order.get(y)).join('|'));
    }
    return { value: [...ids].sort() };
  };
  const result = await vote({ router: ctx.router, task: 'tensions', tier: 'fast', messages, schema, n: 3, quorum: 2, key: (value) => value.join(','), budget: ctx.budget, stage: PURPOSE_STAGE });
  const votes = {};
  for (const reply of result.replies) for (const id of reply.value) votes[id] = (votes[id] ?? 0) + 1;
  const rank = (id) => id.split('|').map((part) => order.get(part));
  const pairs = Object.keys(votes).filter((id) => votes[id] >= 2).sort((x, y) => rank(x)[0] - rank(y)[0] || rank(x)[1] - rank(y)[1]).slice(0, MAX_TENSIONS).map((id) => {
    const [a, b] = id.split('|');
    return { id, a, b, texts: [textOf.get(a), textOf.get(b)], votes: votes[id] };
  });
  return { pairs, decided: result.replies.length >= 2, replies: result.replies.length, votes };
}

function tensionText(pair) {
  return pair.a === pair.b ? `Meet both sides of one requirement at once: "${pair.texts[0]}"` : `Meet both at once: "${pair.texts[0]}" and "${pair.texts[1]}"`;
}

function retrievedOf(goal) {
  return (Array.isArray(goal.hypotheses) ? goal.hypotheses : []).filter((entry) => entry && entry.id !== METHOD_ID && entry.hypothesis && Array.isArray(entry.notes) && entry.notes.length > 0).slice(0, MAX_EXPLANATIONS);
}

function completeTension(goal) {
  const retrieved = retrievedOf(goal);
  const linked = new Set(retrieved.map((entry) => entry.id));
  const out = {
    ...goal,
    role: TENSION_ROLE,
    protected: true,
    state: 'kept',
    refine: 'OR',
    trace: { kind: 'rule', text: TENSION_ROLE },
    hypotheses: [...retrieved, { id: METHOD_ID, key: 'method', hypothesis: METHOD_ALTERNATIVE, notes: [], basis: METHOD_BASIS }],
    questions: (goal.questions ?? []).filter((question) => !question.hypothesis || linked.has(question.hypothesis)),
    obstacles: Array.isArray(goal.obstacles) ? goal.obstacles : [],
  };
  delete out.gap;
  return retrieved.length < MIN_EXPLANATIONS ? { ...out, gap: { kind: RESEARCH_GAP, found: retrieved.length, needed: MIN_EXPLANATIONS } } : out;
}

export function tensionGoalsOf(tree) {
  return (tree?.goals ?? []).filter((goal) => goal.role === TENSION_ROLE);
}

export function ensureTensions(tree) {
  const pairs = tree?.tensions?.pairs ?? [];
  const voted = new Set(pairs.map((pair) => pair.id));
  const goals = (tree?.goals ?? []).filter((goal) => goal.role !== TENSION_ROLE || voted.has(goal.pair)).map((goal) => (goal.role === TENSION_ROLE ? completeTension(goal) : goal));
  for (const pair of pairs) {
    if (goals.some((goal) => goal.role === TENSION_ROLE && goal.pair === pair.id)) continue;
    goals.push(completeTension({ goal: tensionText(pair), pair: pair.id, anchors: [...new Set([pair.a, pair.b])], hypotheses: [], questions: [], obstacles: [] }));
  }
  return numberTree({ ...tree, goals });
}

async function explainTension(ctx, goal, { notes, said }) {
  const ranked = ctx.embedder ? await ctx.embedder.rank(goal.goal, notes.map((note) => `${note.label}: ${note.quote}`), MAX_NOTES_SHOWN) : null;
  const shown = ranked?.order?.length ? ranked.order.map((index) => notes[index]).filter(Boolean) : notes.slice(0, MAX_NOTES_SHOWN);
  const noteIds = new Set(shown.map((note) => note.id));
  const userNumbers = numbersIn(said);
  const allowedFor = (entry) => new Set([...userNumbers, ...shown.filter((note) => entry.notes.includes(note.id)).flatMap((note) => numbersIn(note.quote))]);
  const messages = [
    { role: 'system', content: `${aboutSubject(ctx)}You explain how two requirements that pull against each other can still both hold, using only the notes given. At most ${MAX_EXPLANATIONS} explanations of at most 20 words, each a different one, each with the ids of the notes it rests on and one "test": a question a checker can answer to see whether the explanation applies to one result, with one checker of page (stated on the item's page), code (computed or compared across items), consensus (independent sources agree), statistic (a published figure), official (a registry or plan). Never give an explanation no note supports, and write no number a cited note does not state. Give an empty list when the notes explain nothing. Answer with JSON only: {"explanations":[{"explanation":"...","notes":["N2"],"test":"...","checker":"consensus"}]}.` },
    { role: 'user', content: `${goal.goal}\n\nNotes:\n${noteLines(shown)}` },
  ];
  let rounds = 0;
  const schema = (data) => {
    rounds += 1;
    if (!Array.isArray(data?.explanations)) return { error: '"explanations" must be a list, or an empty list' };
    const drafted = data.explanations.map((entry) => ({ hypothesis: shortText(entry?.explanation, 20, 240), notes: [...new Set((Array.isArray(entry?.notes) ? entry.notes : []).map((id) => idOf(id, noteIds)).filter(Boolean))], test: shortText(entry?.test, 40, 300), checker: CHECKERS.find((name) => name === String(entry?.checker ?? '').trim().toLowerCase()) ?? 'consensus' })).filter((entry) => entry.hypothesis && entry.notes.length).slice(0, MAX_EXPLANATIONS);
    const stray = drafted.flatMap((entry) => [...strayNumbers(entry.hypothesis, allowedFor(entry)), ...strayNumbers(entry.test, allowedFor(entry))]);
    if (stray.length && rounds < 2) return { error: numberError(stray, 'an explanation or its test') };
    return { value: drafted };
  };
  const reply = await ask({ router: ctx.router, task: 'tension-explain', tier: 'deep', messages, schema, budget: ctx.budget, stage: TREE_STAGE });
  const hypotheses = [];
  const questions = [];
  for (const entry of reply?.value ?? []) {
    const settled = await settleNumbers(ctx, { hypothesis: entry.hypothesis }, 'hypothesis', allowedFor(entry));
    if (!settled.hypothesis) continue;
    const id = `M${hypotheses.length + 1}`;
    hypotheses.push({ id, key: 'retrieved', hypothesis: settled.hypothesis, notes: entry.notes, source: 'scoping', ...(settled.keptNumber ? { keptNumber: settled.keptNumber } : {}), ...(settled.movedNumber ? { movedNumber: settled.movedNumber } : {}) });
    if (!entry.test) continue;
    const question = await settleNumbers(ctx, { q: entry.test, checker: entry.checker, threshold: null, note: entry.notes[0], hypothesis: id }, 'q', allowedFor(entry));
    if (question.q) questions.push(question);
  }
  return { ...goal, hypotheses, questions };
}

export async function explainTensions(ctx, tree, { notes = [], said = '' } = {}) {
  const goals = [];
  for (const goal of tree.goals ?? []) goals.push(goal.role === TENSION_ROLE && notes.length && !retrievedOf(goal).length ? await explainTension(ctx, goal, { notes, said }) : goal);
  return ensureTensions({ ...tree, goals });
}

export function normalizeThreshold(threshold) {
  if (!threshold || typeof threshold !== 'object') return null;
  const value = typeof threshold.value === 'number' ? threshold.value : Number(String(threshold.value ?? '').replace(',', '.'));
  if (!THRESHOLD_OPS.includes(threshold.op) || !Number.isFinite(value) || threshold.value === null || threshold.value === '') return null;
  return { op: threshold.op, value, unit: String(threshold.unit ?? '').slice(0, 20) };
}

export async function draftGoals(ctx, { anchors, purpose, implications = [], notes = [], said = '' }) {
  const shown = notes.slice(0, MAX_NOTES_SHOWN);
  const known = new Set([...anchors.map((anchor) => anchor.id), 'P', ...implications.map((entry) => entry.id)]);
  const noteIds = new Set(shown.map((note) => note.id));
  const messages = [
    { role: 'system', content: `${aboutSubject(ctx)}You list the goals a result must reach (Goal-Question-Metric). At most ${MAX_GOALS} goals of at most 12 words, no numbers. "anchor" is the id the goal comes from: a clause (C), a hint (H), the purpose (P) or an implication (I). "notes" are the ids of scoping notes the goal uses. Do not add goals nobody asked for. Answer with JSON only: {"goals":[{"goal":"...","anchor":"C3","notes":["N2"]}]}.` },
    { role: 'user', content: `Clauses and hints:\n${lines(anchors)}\n\n[P] ${purpose.text}\n${implications.length ? `\nImplications:\n${lines(implications.map((entry) => ({ id: entry.id, text: `${entry.attribute}: ${entry.direction}` })))}\n` : ''}${shown.length ? `\nScoping notes:\n${noteLines(shown)}` : ''}` },
  ];
  const userNumbers = numbersIn([said, ...anchors.map((anchor) => anchor.text)].join('\n'));
  const allowedFor = (entry) => new Set([...userNumbers, ...shown.filter((note) => entry.notes.includes(note.id)).flatMap((note) => numbersIn(note.quote))]);
  let rounds = 0;
  const schema = (data) => {
    rounds += 1;
    const drafted = (Array.isArray(data?.goals) ? data.goals : []).slice(0, MAX_GOALS).map((entry) => ({ goal: shortText(entry?.goal, 12, 160), anchor: idOf(entry?.anchor, known), notes: [...new Set((Array.isArray(entry?.notes) ? entry.notes : []).map((id) => idOf(id, noteIds)).filter(Boolean))] })).filter((entry) => entry.goal && entry.anchor);
    const stray = drafted.flatMap((entry) => strayNumbers(entry.goal, allowedFor(entry)));
    if (stray.length && rounds < 2) return { error: numberError(stray, 'a goal') };
    return drafted.length ? { value: drafted } : { error: 'every goal needs a "goal" text and an "anchor" id from the lists' };
  };
  const reply = await ask({ router: ctx.router, task: 'goals', tier: 'deep', messages, schema, budget: ctx.budget, stage: TREE_STAGE });
  const goals = [];
  for (const entry of reply?.value ?? []) goals.push(await settleNumbers(ctx, entry, 'goal', allowedFor(entry)));
  return goals.filter((entry) => entry.goal);
}

function leafOf(entry, textField, noteIds) {
  const text = shortText(entry?.[textField], 40, 300);
  const checker = CHECKERS.find((name) => name === String(entry?.checker ?? '').trim().toLowerCase());
  if (!text || !checker) return null;
  return { [textField]: text, checker, threshold: normalizeThreshold(entry?.threshold), ...(textField === 'q' ? { note: idOf(entry?.note, noteIds) } : {}) };
}

function leafRules({ notes = [], said = '', cited = null }) {
  const noteIds = new Set(notes.map((note) => note.id));
  const userNumbers = numbersIn(said);
  const goalNotes = notes.filter((note) => (cited ?? [...noteIds]).includes(note.id));
  const allowedFor = (leaf) => new Set([...userNumbers, ...[...goalNotes, ...notes.filter((note) => note.id === leaf.note)].flatMap((note) => numbersIn(note.quote)), ...(leaf.threshold ? [leaf.threshold.value] : [])]);
  return { noteIds, allowedFor };
}

function leafValidator(parse, allowedFor) {
  let rounds = 0;
  return (data) => {
    rounds += 1;
    const drafted = parse(data);
    if (drafted.error !== undefined) return drafted;
    const stray = [['q', drafted.questions], ['obstacle', drafted.obstacles]].flatMap(([field, leaves]) => leaves.flatMap((leaf) => strayNumbers(leaf[field], allowedFor(leaf))));
    if (stray.length && rounds < 2) return { error: numberError(stray, 'a question or an obstacle') };
    return { value: drafted };
  };
}

async function settleLeaves(ctx, list, field, allowedFor) {
  const out = [];
  for (const leaf of list) out.push(await settleNumbers(ctx, leaf, field, allowedFor(leaf)));
  return out.filter((leaf) => leaf[field]);
}

export async function measurableQuestions(ctx, questions, { goal, anchorText = '' }) {
  const shown = questions.slice(0, QUESTION_LETTERS.length);
  if (!shown.length) return questions;
  const letters = shown.map((_, index) => QUESTION_LETTERS[index]);
  const messages = [
    { role: 'system', content: 'You compare questions with the goal they were written for, by meaning and in any language. A question only restates when it asks again what the goal or the statement it comes from already says, and names nothing a checker could observe, count, compare or look up. List the letters of the questions that only restate; give an empty list when none does. Answer with JSON only: {"restates":["A"]}.' },
    { role: 'user', content: `Goal: ${goal}\nIt comes from: ${anchorText}\n\nQuestions:\n${shown.map((question, index) => `${letters[index]}) ${question.q}`).join('\n')}` },
  ];
  const schema = (data) => (Array.isArray(data?.restates) ? { value: [...new Set(data.restates.map((letter) => oneOf(letter, letters)).filter(Boolean))].sort() } : { error: '"restates" must be a list of question letters, or an empty list' });
  const result = await vote({ router: ctx.router, task: 'restates', tier: 'fast', messages, schema, n: 3, quorum: 2, key: (value) => value.join(''), budget: ctx.budget, stage: TREE_STAGE });
  const votes = {};
  for (const reply of result.replies) for (const letter of reply.value) votes[letter] = (votes[letter] ?? 0) + 1;
  return questions.filter((_, index) => (votes[QUESTION_LETTERS[index]] ?? 0) < 2);
}

export async function refineGoal(ctx, { goal, anchorText = '', notes = [], said = '', cited = null, method = '' }) {
  const { noteIds, allowedFor } = leafRules({ notes, said, cited });
  const system = `${aboutSubject(ctx)}You refine one goal into questions a checker can answer. "refine": "AND" when every question must hold, "OR" when one is enough. At most 3 questions, each with exactly one checker: page (stated on the item's page), code (computed or compared across items), consensus (independent sources agree), statistic (a published figure), official (a registry or plan). At most 2 obstacles: conditions that defeat the goal. A number goes only in "threshold", never in the text; use null when no number was given. Answer with JSON only: {"refine":"AND|OR","questions":[{"q":"...","checker":"page","threshold":{"op":"<=","value":0,"unit":"..."},"note":"N2"}],"obstacles":[{"obstacle":"...","checker":"page","threshold":null}]}.`;
  const user = `Goal: ${goal}\nIt comes from: ${anchorText}${method ? `\n${method}` : ''}${notes.length ? `\n\nNotes:\n${noteLines(notes)}` : ''}`;
  const parse = (data) => {
    const refine = oneOf(data?.refine, ['AND', 'OR']);
    const questions = (Array.isArray(data?.questions) ? data.questions : []).slice(0, 3).map((entry) => leafOf(entry, 'q', noteIds)).filter(Boolean);
    const obstacles = (Array.isArray(data?.obstacles) ? data.obstacles : []).slice(0, 2).map((entry) => leafOf(entry, 'obstacle', noteIds)).filter(Boolean);
    if (!refine) return { error: '"refine" must be AND or OR' };
    if (!questions.length) return { error: 'at least one question with a "q" text and one checker of page, code, consensus, statistic, official' };
    return { refine, questions, obstacles };
  };
  const settle = async (reply) => {
    if (!reply) return null;
    const questions = await settleLeaves(ctx, reply.value.questions, 'q', allowedFor);
    return questions.length ? { refine: reply.value.refine, questions, obstacles: await settleLeaves(ctx, reply.value.obstacles, 'obstacle', allowedFor) } : null;
  };
  const draft = (more = '') => ask({ router: ctx.router, task: 'refine', tier: 'deep', budget: ctx.budget, stage: TREE_STAGE, schema: leafValidator(parse, allowedFor), messages: [{ role: 'system', content: system }, { role: 'user', content: `${user}${more}` }] });
  const first = await draft();
  if (!first) return null;
  let refined = first.value.obstacles.length ? await settle(first) : null;
  if (!first.value.obstacles.length) {
    const again = await draft('\n\nName at least one obstacle that would defeat this goal.');
    const withObstacle = again?.value.obstacles.length ? await settle(again) : null;
    const bare = withObstacle?.obstacles.length ? null : await settle(first);
    refined = withObstacle?.obstacles.length ? withObstacle : bare ? { ...bare, obstacles: 'missing' } : null;
  }
  if (!refined) return null;
  const kept = await measurableQuestions(ctx, refined.questions, { goal, anchorText });
  if (kept.length === refined.questions.length) return refined;
  if (kept.length) return { ...refined, questions: kept, restated: refined.questions.length - kept.length };
  const again = await settle(await draft('\n\nEvery question only restated the goal. Ask only for what a checker can observe, count, compare or look up.'));
  const measured = again ? await measurableQuestions(ctx, again.questions, { goal, anchorText }) : [];
  return measured.length ? { ...refined, refine: again.refine, questions: measured, restated: refined.questions.length + again.questions.length - measured.length } : null;
}

const statedPrompt = ({ query, options, none }) => [
  { role: 'system', content: `You check whether the asker stated a condition, by meaning and in any language. "anchor": the letter of the statement that itself states this condition, or ${none} when no statement does. Answer with JSON only: {"anchor":"<letter>"}.` },
  { role: 'user', content: `Condition: ${query}\n\nStatements:\n${optionLines(options, none, 'none of these statements')}` },
];

async function softObstacles(ctx, obstacles, anchors) {
  if (!Array.isArray(obstacles)) return obstacles;
  const out = [];
  for (const obstacle of obstacles) {
    const result = await retrieveThenVerify({ query: obstacle.obstacle, candidates: anchors.map((anchor) => ({ id: anchor.id, text: anchor.text })), k: 3, embedder: ctx.embedder, router: ctx.router, prompt: statedPrompt, field: 'anchor', task: 'obstacle-stated', budget: ctx.budget, stage: TREE_STAGE });
    out.push(result.picked ? { ...obstacle, soft: false, trace: { id: result.picked.id, text: result.picked.text } } : { ...obstacle, soft: true });
  }
  return out;
}

function sideGoal(role, goal, basis, refined) {
  return { goal, role, protected: true, state: 'kept', trace: { kind: 'rule', text: role }, basis, notes: [], refine: refined?.refine ?? 'AND', questions: refined?.questions ?? [], obstacles: refined?.obstacles ?? 'missing' };
}

export async function valueSide(ctx, { purpose, anchors, notes = [], said = '' }) {
  const refined = await refineGoal(ctx, { goal: VALUE_GOAL, anchorText: `${purpose.text}\n${lines(anchors)}`, notes: notes.slice(0, MAX_NOTES_SHOWN), said, cited: [], method: 'Ask "how?" of the purpose: each question names one thing the result must do for it, in the terms of this request, and what a checker observes to see that it does. Asking "why?" of a question must lead back to the purpose.' });
  return sideGoal(VALUE_ROLE, VALUE_GOAL, VALUE_BASIS, refined ? { ...refined, obstacles: await softObstacles(ctx, refined.obstacles, anchors) } : null);
}

async function costPhase(ctx, phase, { purpose, anchors, notes, said }) {
  const { noteIds, allowedFor } = leafRules({ notes, said, cited: [] });
  const system = `${aboutSubject(ctx)}You refine one goal, the total cost to obtain and use a result, for one phase of total cost of ownership: ${phase.id} (${phase.covers}). At most 2 questions about the costs of this phase that apply to this request, in its own terms. "paid": "A" when the question asks what is paid for an item itself, which code measures from the items and comparable items; "B" for any other cost, then with one checker of consensus (independent sources agree), page (stated on the item's page) or official (a registry or tariff). At most 1 obstacle: a cost of this phase that would defeat the purpose, with one checker of page, code, consensus, statistic, official. A number goes only in "threshold", never in the text; use null when no number was given. Answer with JSON only: {"questions":[{"q":"...","paid":"A|B","checker":"consensus","threshold":{"op":"<=","value":0,"unit":"..."},"note":"N2"}],"obstacles":[{"obstacle":"...","checker":"page","threshold":null}]}.`;
  const user = `Goal: ${COST_GOAL}\nPurpose: ${purpose.text}\n\nRequirements and hints:\n${lines(anchors)}${notes.length ? `\n\nNotes:\n${noteLines(notes)}` : ''}`;
  const parse = (data) => {
    const questions = (Array.isArray(data?.questions) ? data.questions : []).slice(0, 2).map((entry) => {
      const text = shortText(entry?.q, 40, 300);
      const named = String(entry?.checker ?? '').trim().toLowerCase();
      const price = (oneOf(entry?.paid, ['A', 'B']) ?? (named === PRICE_CHECKER ? 'A' : 'B')) === 'A';
      return text ? { q: text, checker: price ? PRICE_CHECKER : COST_CHECKERS.includes(named) ? named : COST_CHECKERS[0], threshold: normalizeThreshold(entry?.threshold), note: idOf(entry?.note, noteIds), phase: phase.id, price } : null;
    }).filter(Boolean);
    const obstacles = (Array.isArray(data?.obstacles) ? data.obstacles : []).slice(0, 1).map((entry) => leafOf(entry, 'obstacle', noteIds)).filter(Boolean).map((leaf) => ({ ...leaf, phase: phase.id }));
    return questions.length ? { questions, obstacles } : { error: `at least one question with a "q" text about a cost of the ${phase.id} phase` };
  };
  const reply = await ask({ router: ctx.router, task: 'cost-phase', tier: 'deep', budget: ctx.budget, stage: TREE_STAGE, schema: leafValidator(parse, allowedFor), messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
  if (!reply) return { questions: [], obstacles: [] };
  return { questions: await settleLeaves(ctx, reply.value.questions, 'q', allowedFor), obstacles: await settleLeaves(ctx, reply.value.obstacles, 'obstacle', allowedFor) };
}

export async function costSide(ctx, { purpose, anchors, notes = [], said = '' }) {
  const shown = notes.slice(0, MAX_NOTES_SHOWN);
  const questions = [];
  const obstacles = [];
  const phases = [];
  for (const phase of COST_PHASES) {
    const refined = await costPhase(ctx, phase, { purpose, anchors, notes: shown, said });
    questions.push(...refined.questions);
    obstacles.push(...refined.obstacles);
    phases.push({ id: phase.id, covers: phase.covers, questions: refined.questions.length });
  }
  return { ...sideGoal(COST_ROLE, COST_GOAL, COST_BASIS, { refine: 'AND', questions, obstacles: obstacles.length ? await softObstacles(ctx, obstacles, anchors) : 'missing' }), phases };
}

export function valueForCost({ satisfied, asked, cost } = {}) {
  const satisfaction = Number(asked) > 0 && Number.isFinite(Number(satisfied)) ? Number(satisfied) / Number(asked) : null;
  const spent = Number.isFinite(Number(cost)) && Number(cost) > 0 ? Number(cost) : null;
  return { satisfaction, cost: spent, ratio: satisfaction === null || spent === null ? null : satisfaction / spent };
}

export function valueForCostOf(tree) {
  const value = (tree?.goals ?? []).find((goal) => goal.role === VALUE_ROLE);
  const cost = (tree?.goals ?? []).find((goal) => goal.role === COST_ROLE);
  if (!value || !cost) return null;
  return { measure: 'value-for-cost', checker: PRICE_CHECKER, value: value.id, cost: cost.id, satisfied: (value.questions ?? []).map((question) => question.id), costs: (cost.questions ?? []).map((question) => question.id), basis: VALUE_BASIS };
}

export function traceables(anchors, purpose, implications = []) {
  return [
    ...anchors.map((anchor) => ({ id: anchor.id, text: anchor.text })),
    ...(purpose ? [{ id: 'P', text: purpose.text }] : []),
    ...implications.map((entry) => ({ id: entry.id, text: `${entry.attribute}: ${entry.direction} is preferred` })),
  ];
}

const tracePrompt = ({ query, options, none }) => [
  { role: 'system', content: `You trace one goal to what was asked, by meaning and in any language. "anchor": the letter of the statement the goal belongs to, or ${none} when it belongs to none. "relation": S the goal serves that statement, R the goal only restates it, X the goal contradicts it. Answer with JSON only: {"anchor":"<letter>","relation":"S|R|X"}.` },
  { role: 'user', content: `Goal: ${query}\n\nStatements:\n${optionLines(options, none, 'none of these statements')}` },
];

export async function traceGoal(ctx, goal, candidates) {
  if (goal.protected) return { ...goal, trace: { kind: 'rule', text: goal.role ?? 'protected' } };
  const result = await retrieveThenVerify({
    query: goal.goal,
    candidates,
    extra: [goal.anchor].filter(Boolean),
    k: 3,
    embedder: ctx.embedder,
    router: ctx.router,
    prompt: tracePrompt,
    field: 'anchor',
    schema: (data, candidate) => {
      if (!candidate) return { value: {} };
      const relation = oneOf(data?.relation, ['S', 'R', 'X']);
      return relation ? { value: { relation } } : { error: '"relation" must be S, R or X' };
    },
    keyOf: (id, more) => (id === null ? 'N' : more.relation),
    task: 'trace',
    budget: ctx.budget,
    stage: TREE_STAGE,
  });
  const relation = result.picked ? result.extra?.relation : null;
  const trace = result.picked ? { id: result.picked.id, text: result.picked.text } : null;
  if (relation === 'S') return { ...goal, state: 'kept', trace, votes: result.tally };
  if (relation === 'R') return { ...goal, state: 'kept', trace, restates: true, votes: result.tally };
  if (relation === 'X') return { ...goal, state: 'conflict', trace, reason: `contradicts ${trace.id}: ${trace.text}`, votes: result.tally };
  return { ...goal, state: 'proposed', trace: null, reason: result.none ? 'traces to no clause, hint, purpose or implication: confirm or drop it' : 'no majority on what it traces to: confirm or drop it', votes: result.tally };
}

async function traceAndRefine(ctx, entry, { candidates, notes, said, cited = null }) {
  const traced = await traceGoal(ctx, entry, candidates);
  const anchor = traced.trace ?? candidates.find((candidate) => candidate.id === entry.anchor);
  const refined = await refineGoal(ctx, { goal: entry.goal, anchorText: anchor?.text ?? '', notes, said, cited });
  return refined ? { ...traced, ...refined } : { unrefined: traced };
}

const samePrompt = ({ query, candidate }) => [
  { role: 'system', content: 'You compare two goals by meaning, in any language. A: they are one objective, stated twice. B: they are two different objectives. Answer with JSON only: {"same":"A|B"}.' },
  { role: 'user', content: `Goal 1: ${query}\nGoal 2: ${candidate.text}` },
];

const sameSchema = (data) => {
  const same = oneOf(data?.same, ['A', 'B']);
  return same ? { value: same } : { error: '"same" must be A or B' };
};

export async function sameGoal(ctx, a, b) {
  const result = await retrieveThenVerify({ query: a.goal, candidates: [{ id: b.id, text: b.goal }], fixed: true, pairwise: true, router: ctx.router, prompt: samePrompt, schema: sameSchema, task: 'same-goal', budget: ctx.budget, stage: TREE_STAGE });
  const value = result.pairs[0]?.value ?? null;
  return value === null ? null : value === 'A';
}

function absorb(into, other) {
  const questions = [...(into.questions ?? []), ...(other.questions ?? [])];
  const obstacles = [...(Array.isArray(into.obstacles) ? into.obstacles : []), ...(Array.isArray(other.obstacles) ? other.obstacles : [])];
  const anchors = [...new Set([...(into.anchors ?? []), other.trace?.id, ...(other.anchors ?? [])].filter(Boolean))];
  return { ...into, questions, obstacles: obstacles.length ? obstacles : into.obstacles, notes: [...new Set([...(into.notes ?? []), ...(other.notes ?? [])])], merged: [...(into.merged ?? []), other.id], ...(anchors.length ? { anchors } : {}) };
}

export async function mergeDuplicates(ctx, tree) {
  let goals = [...tree.goals];
  const merged = [];
  const judged = new Set();
  for (const goal of [...goals]) {
    if (goal.protected || !goals.includes(goal)) continue;
    const others = goals.filter((other) => other !== goal && !other.protected && !judged.has([goal.id, other.id].sort().join('|')));
    if (!others.length) continue;
    const result = await retrieveThenVerify({ query: goal.goal, candidates: others.map((other) => ({ id: other.id, text: other.goal })), k: 2, pairwise: true, embedder: ctx.embedder, router: ctx.router, prompt: samePrompt, schema: sameSchema, task: 'same-goal', budget: ctx.budget, stage: TREE_STAGE });
    for (const pair of result.pairs) {
      judged.add([goal.id, pair.candidate.id].sort().join('|'));
      const other = goals.find((entry) => entry.id === pair.candidate.id);
      const current = goals.find((entry) => entry.id === goal.id);
      if (pair.value !== 'A' || !other || !current) continue;
      goals = goals.filter((entry) => entry !== other).map((entry) => (entry === current ? absorb(current, other) : entry));
      merged.push({ op: 'merge', a: goal.id, b: other.id, by: 'duplicate check' });
    }
  }
  return { ...tree, goals, ops: { applied: [...(tree.ops?.applied ?? []), ...merged], refused: tree.ops?.refused ?? [] } };
}

function nodesOf(tree) {
  const nodes = [];
  for (const goal of tree.goals ?? []) {
    nodes.push({ id: goal.id, kind: 'goal', goal });
    for (const question of goal.questions ?? []) nodes.push({ id: question.id, kind: 'question', goal, node: question });
    for (const obstacle of Array.isArray(goal.obstacles) ? goal.obstacles : []) nodes.push({ id: obstacle.id, kind: 'obstacle', goal, node: obstacle });
  }
  return nodes;
}

export function numberTree(tree) {
  const highest = { G: 0, Q: 0, O: 0 };
  for (const node of nodesOf(tree)) {
    const match = String(node.id ?? '').match(/^([GQO])(\d+)$/);
    if (match) highest[match[1]] = Math.max(highest[match[1]], Number(match[2]));
  }
  const next = (prefix) => `${prefix}${++highest[prefix]}`;
  const goals = (tree.goals ?? []).map((goal) => ({
    ...goal,
    id: goal.id ?? next('G'),
    questions: (goal.questions ?? []).map((question) => (question.id ? question : { ...question, id: next('Q') })),
    obstacles: Array.isArray(goal.obstacles) ? goal.obstacles.map((obstacle) => (obstacle.id ? obstacle : { ...obstacle, id: next('O') })) : goal.obstacles,
  }));
  return { ...tree, goals };
}

export function treeLines(tree) {
  const out = [];
  for (const goal of tree.goals ?? []) {
    out.push(`${goal.id} [from ${goal.trace?.id ?? goal.anchor ?? goal.role ?? '?'}] ${goal.goal}`);
    for (const question of goal.questions ?? []) out.push(`  ${question.id} (${question.checker}) ${question.q}`);
    for (const obstacle of Array.isArray(goal.obstacles) ? goal.obstacles : []) out.push(`  ${obstacle.id} (${obstacle.checker}) obstacle: ${obstacle.obstacle}`);
  }
  return out.join('\n');
}

export async function critique(ctx, tree, candidates, { said = '' } = {}) {
  const ids = new Set(nodesOf(tree).map((node) => node.id));
  const anchorIds = new Set(candidates.map((candidate) => candidate.id));
  const messages = [
    { role: 'system', content: `${aboutSubject(ctx)}You review a goal tree (critique and revise). Return operations only, never a rewritten tree. Allowed: {"op":"merge","a":"G2","b":"G5"} two goals that are one objective; {"op":"drop","id":"G4","reason":"A|B|C"} with ${Object.entries(DROP_REASONS).map(([letter, text]) => `${letter} ${text}`).join(', ')}; {"op":"add","goal":"...","anchor":"C3"} a missing goal and the statement id it comes from; {"op":"checker","id":"Q3","checker":"page|code|consensus|statistic|official"} a question with the wrong checker. Answer with JSON only: {"ops":[...]}.` },
    { role: 'user', content: `Statements:\n${lines(candidates)}\n\nTree:\n${treeLines(tree)}` },
  ];
  const allowed = new Set(numbersIn(said));
  let rounds = 0;
  const schema = (data) => {
    rounds += 1;
    if (!Array.isArray(data?.ops)) return { error: '"ops" must be a list of operations' };
    const ops = [];
    const stray = data.ops.slice(0, 12).filter((entry) => String(entry?.op ?? '').trim().toLowerCase() === 'add').flatMap((entry) => strayNumbers(shortText(entry.goal, 12, 160), allowed));
    if (stray.length && rounds < 2) return { error: numberError(stray, 'an added goal') };
    for (const entry of data.ops.slice(0, 12)) {
      const op = String(entry?.op ?? '').trim().toLowerCase();
      if (op === 'merge' && idOf(entry.a, ids) && idOf(entry.b, ids) && idOf(entry.a, ids) !== idOf(entry.b, ids)) ops.push({ op, a: idOf(entry.a, ids), b: idOf(entry.b, ids) });
      else if (op === 'drop' && idOf(entry.id, ids)) ops.push({ op, id: idOf(entry.id, ids), reason: oneOf(entry.reason, Object.keys(DROP_REASONS)) ?? 'B' });
      else if (op === 'add' && idOf(entry.anchor, anchorIds)) {
        if (shortText(entry.goal, 12, 160)) ops.push({ op, goal: shortText(entry.goal, 12, 160), anchor: idOf(entry.anchor, anchorIds) });
      }
      else if (op === 'checker' && idOf(entry.id, ids) && CHECKERS.includes(String(entry.checker ?? '').trim().toLowerCase())) ops.push({ op, id: idOf(entry.id, ids), checker: String(entry.checker).trim().toLowerCase() });
    }
    return { value: ops };
  };
  const reply = await ask({ router: ctx.router, task: 'critique', tier: 'deep', messages, schema, budget: ctx.budget, stage: TREE_STAGE });
  const ops = [];
  for (const op of reply?.value ?? []) ops.push(op.op === 'add' ? await settleNumbers(ctx, op, 'goal', allowed) : op);
  return ops.filter((op) => op.op !== 'add' || op.goal);
}

const protectedWhy = (goal) => `"${goal.goal}" is a protected ${goal.role ?? ''} goal`.replace(/\s+/g, ' ');

export async function applyOps(ctx, tree, ops, { candidates = [], notes = [], said = '' } = {}) {
  let goals = [...(tree.goals ?? [])];
  const applied = [...(tree.ops?.applied ?? [])];
  const refused = [...(tree.ops?.refused ?? [])];
  const find = (id) => nodesOf({ goals }).find((node) => node.id === id);
  for (const op of ops ?? []) {
    if (op.op === 'drop') {
      const node = find(op.id);
      if (!node) refused.push({ ...op, why: 'no such node' });
      else if (node.kind === 'obstacle') refused.push({ ...op, why: 'an obstacle is a protected node' });
      else if (node.kind !== 'goal') refused.push({ ...op, why: 'only a goal can be dropped' });
      else if (node.goal.protected) refused.push({ ...op, why: protectedWhy(node.goal) });
      else {
        goals = goals.filter((goal) => goal !== node.goal);
        applied.push({ ...op, goal: node.goal.goal, anchor: node.goal.trace?.id ?? node.goal.anchor ?? null });
      }
    } else if (op.op === 'merge') {
      const a = find(op.a);
      const b = find(op.b);
      if (a?.kind !== 'goal' || b?.kind !== 'goal') refused.push({ ...op, why: 'a merge needs two goals' });
      else if (a.goal.protected || b.goal.protected) refused.push({ ...op, why: 'a protected node is never merged away' });
      else if ((await sameGoal(ctx, a.goal, b.goal)) !== true) refused.push({ ...op, why: 'the two goals were not voted to be one objective' });
      else {
        goals = goals.filter((goal) => goal !== b.goal).map((goal) => (goal === a.goal ? absorb(a.goal, b.goal) : goal));
        applied.push(op);
      }
    } else if (op.op === 'add') {
      const added = await traceAndRefine(ctx, { goal: op.goal, anchor: op.anchor, notes: [], ...(op.threshold ? { threshold: op.threshold, movedNumber: op.movedNumber } : {}) }, { candidates, notes, said, cited: [] });
      if (added.unrefined) refused.push({ ...op, why: `the goal was ${UNREFINED}` });
      else {
        goals = numberTree({ goals: [...goals, added] }).goals;
        applied.push({ ...op, state: added.state });
      }
    } else if (op.op === 'checker') {
      const node = find(op.id);
      if (node?.kind !== 'question') refused.push({ ...op, why: node?.kind === 'obstacle' ? 'an obstacle is a protected node' : 'only a question has a checker to change' });
      else if (node.goal.protected) refused.push({ ...op, why: protectedWhy(node.goal) });
      else {
        goals = goals.map((goal) => (goal === node.goal ? { ...goal, questions: goal.questions.map((question) => (question === node.node ? { ...question, checker: op.checker } : question)) } : goal));
        applied.push(op);
      }
    }
  }
  for (const entry of refused.slice((tree.ops?.refused ?? []).length)) ctx.log?.(`critique operation refused: ${entry.op} ${entry.id ?? entry.a ?? entry.goal ?? ''}: ${entry.why}`);
  return { ...tree, goals, ops: { applied, refused } };
}

function numberRuns(text) {
  const out = [];
  for (const match of String(text ?? '').matchAll(/\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)*/g)) {
    const raw = match[0].replace(/[   ]/g, '');
    const values = [Number(raw.replace(',', '.'))];
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(raw)) values.push(Number(raw.replace(/[.,]/g, '')));
    out.push({ raw: match[0], at: match.index, values: values.filter(Number.isFinite) });
  }
  return out;
}

export function unitsBeside(text, run) {
  const before = String(text).slice(Math.max(0, run.at - 12), run.at).match(/(\p{L}+|\p{Sc})\s*$/u)?.[1] ?? '';
  const after = String(text).slice(run.at + run.raw.length, run.at + run.raw.length + 14).match(/^\s*(\p{L}+|\p{Sc}|%)/u)?.[1] ?? '';
  return [before, after].map((unit) => unit.toLowerCase()).filter(Boolean);
}

export function sameUnit(a, b) {
  const money = [currencyOf(a), currencyOf(b)];
  if (money[0] && money[1]) return money[0] === money[1];
  const x = String(a ?? '').toLowerCase().replace(/[^\p{L}\p{Sc}%]/gu, '');
  const y = String(b ?? '').toLowerCase().replace(/[^\p{L}\p{Sc}%]/gu, '');
  return Boolean(x && y) && (x.startsWith(y) || y.startsWith(x));
}

export function askedNumber(text, value, unit) {
  const runs = numberRuns(text).filter((run) => run.values.includes(value));
  if (!runs.length) return false;
  if (!String(unit ?? '').trim()) return true;
  return runs.some((run) => unitsBeside(text, run).some((beside) => sameUnit(beside, unit)));
}

export function numbersIn(text) {
  return numberRuns(text).flatMap((run) => run.values);
}

export function strayNumbers(text, allowed) {
  return numberRuns(text).filter((run) => !run.values.some((value) => allowed.has(value)));
}

function numberError(stray, where) {
  return `the text of ${where} holds a number nobody stated (${[...new Set(stray.map((run) => run.raw))].join(', ')}): move it into "threshold" and write the text without it`;
}

export const NUMBER_KINDS = { A: 'a quantity used as a limit, target or amount', B: 'part of a name, model, code, standard or identifier', C: 'a date or year' };

async function numberKind(ctx, text, run) {
  const marked = `${text.slice(0, run.at)}[[${run.raw}]]${text.slice(run.at + run.raw.length)}`;
  const messages = [
    { role: 'system', content: `You read one sentence, in any language, with one number marked by [[ ]]. Say what the marked number is: ${Object.entries(NUMBER_KINDS).map(([letter, label]) => `${letter} ${label}`).join('; ')}. Answer with JSON only: {"kind":"A|B|C"}.` },
    { role: 'user', content: `Sentence: ${marked}` },
  ];
  const schema = (data) => {
    const kind = oneOf(data?.kind, Object.keys(NUMBER_KINDS));
    return kind ? { value: kind } : { error: '"kind" must be A, B or C' };
  };
  const result = await vote({ router: ctx.router, task: 'number-kind', tier: 'fast', messages, schema, n: 3, quorum: 2, key: (value) => value, budget: ctx.budget, stage: TREE_STAGE });
  return result.value;
}

export async function settleNumbers(ctx, node, textField, allowed) {
  const text = String(node[textField] ?? '');
  const quantities = [];
  const kept = [];
  for (const run of strayNumbers(text, allowed)) {
    const kind = await numberKind(ctx, text, run);
    if (kind === 'A') quantities.push(run);
    else if (kind) kept.push(...run.values);
  }
  const moved = moveNumbers(node, textField, quantities);
  return kept.length ? { ...moved, keptNumber: [...new Set(kept)] } : moved;
}

export function moveNumbers(node, textField, stray) {
  if (!stray.length) return node;
  let text = String(node[textField]);
  for (const run of [...stray].reverse()) text = `${text.slice(0, run.at)} ${text.slice(run.at + run.raw.length)}`;
  const moved = [...new Set(stray.filter((run) => run.values.length).map((run) => run.values[run.values.length - 1]))];
  const threshold = node.threshold ?? (moved.length ? { op: null, value: moved[0], unit: '', source: 'assumption', moved: true } : null);
  return { ...node, [textField]: text.replace(/\s+/g, ' ').trim(), ...(threshold ? { threshold } : {}), ...(moved.length ? { movedNumber: moved } : {}) };
}

export function thresholdsOf(tree, { question = '', guidance = '', answers = [], notes = [] } = {}) {
  const saidText = [question, guidance, ...answers].join('\n');
  const said = new Set(numbersIn(saidText));
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const thresholds = [];
  const settle = (node, goal, textField) => {
    const quoted = [noteById.get(node.note), ...(goal.notes ?? []).map((id) => noteById.get(id))].filter(Boolean).flatMap((note) => numbersIn(note.quote));
    const invented = strayNumbers(node[textField], new Set([...said, ...quoted, ...(node.keptNumber ?? []), ...(node.threshold ? [node.threshold.value] : [])])).flatMap((run) => run.values);
    const out = { ...node };
    delete out.inventedNumber;
    if (invented.length) out.inventedNumber = [...new Set(invented)];
    if (!node.threshold) return out;
    const cited = noteById.get(node.note) ?? (goal.notes ?? []).map((id) => noteById.get(id)).find((note) => note && numbersIn(note.quote).includes(node.threshold.value));
    const confirmed = node.threshold.confirmed === true;
    const source = askedNumber(saidText, node.threshold.value, node.threshold.unit) ? 'asked' : cited && numbersIn(cited.quote).includes(node.threshold.value) ? 'sourced' : 'assumption';
    const threshold = { ...node.threshold, source, ...(source === 'sourced' ? { url: cited.url, note: cited.id } : {}), hard: source === 'asked' || confirmed };
    thresholds.push({ node: node.id, goal: goal.id, ...threshold });
    return { ...out, threshold };
  };
  const goals = (tree.goals ?? []).map((goal) => {
    const own = settle(goal, goal, 'goal');
    return { ...own, questions: (goal.questions ?? []).map((node) => settle(node, goal, 'q')), obstacles: Array.isArray(goal.obstacles) ? goal.obstacles.map((node) => settle(node, goal, 'obstacle')) : goal.obstacles };
  });
  return { tree: { ...tree, goals, thresholds }, thresholds };
}

export async function voteHardness(ctx, { requirementText, userWords } = {}) {
  const messages = [
    { role: 'system', content: 'You read one requirement from a research question, in any language. Decide whether it states a hard constraint that must be satisfied (a veto if violated) or a soft criterion that only scores and orders. Numbers, counts of results, limits, ranges and radii are checked separately by code: ignore them. Answer constraint only when, without them, the user\'s own text demands or excludes a property of every single item with an exclusive word (required, must, only, exactly, mandatory, no, not, without, exclude, forbidden). A description, preference, example, quality or hint is a criterion. Answer with JSON only: {"kind":"constraint|criterion"}.' },
    { role: 'user', content: `Requirement: ${requirementText}\n\nUser's own words (question + guidance):\n${userWords}` },
  ];
  const schema = (data) => {
    const kind = oneOf(data?.kind, ['CONSTRAINT', 'CRITERION']);
    return kind ? { value: kind } : { error: '"kind" must be constraint or criterion' };
  };
  const result = await vote({ router: ctx.router, task: 'hardness', tier: 'fast', messages, schema, n: 3, quorum: 2, key: (value) => value, budget: ctx.budget, stage: TREE_STAGE });
  return result.value === 'CONSTRAINT';
}

export function requirementAnchors(anchors) {
  return (anchors ?? []).filter((anchor) => anchor.kind === 'clause');
}

export function coveredAnchors(tree) {
  const anchorOf = new Map((tree?.implications ?? []).map((entry) => [entry.id, entry.anchor]));
  const direct = new Set();
  const derived = new Set();
  for (const goal of tree?.goals ?? []) {
    if (goal.state !== 'kept' || goal.role === TENSION_ROLE || !(goal.questions ?? []).length) continue;
    for (const id of [goal.trace?.id, ...(goal.anchors ?? [])]) {
      if (!id) continue;
      direct.add(id);
      if (anchorOf.get(id)) derived.add(anchorOf.get(id));
    }
  }
  const unrefined = new Set((tree?.dropped ?? []).filter((entry) => entry.reason === UNREFINED).map((entry) => entry.trace?.id).filter(Boolean));
  return new Set([...direct, ...[...derived].filter((id) => !unrefined.has(id))]);
}

export function notModelledOf(tree, anchors) {
  const covered = coveredAnchors(tree);
  const before = new Map((tree?.notModelled ?? []).map((entry) => [entry.id, entry]));
  return requirementAnchors(anchors).filter((anchor) => !covered.has(anchor.id)).map((anchor) => {
    const held = before.get(anchor.id);
    return { id: anchor.id, kind: anchor.kind, text: anchor.text, ...(held?.dismissedAt && held.text === anchor.text ? { dismissedAt: held.dismissedAt } : {}) };
  });
}

export function coverageOf(tree, anchors) {
  const covered = coveredAnchors(tree);
  const listed = new Set((tree?.notModelled ?? []).map((entry) => entry.id));
  const ids = requirementAnchors(anchors).map((anchor) => anchor.id);
  return { anchors: ids.length, covered: ids.filter((id) => covered.has(id)), notModelled: (tree?.notModelled ?? []).map((entry) => entry.id), silent: ids.filter((id) => !covered.has(id) && !listed.has(id)) };
}

export function coverageOpen(tree) {
  return (tree?.notModelled ?? []).filter((entry) => !entry.dismissedAt);
}

export function dismissNotModelled(tree, id, { at = new Date().toISOString() } = {}) {
  return { ...tree, notModelled: (tree?.notModelled ?? []).map((entry) => (entry.id === id && !entry.dismissedAt ? { ...entry, dismissedAt: at } : entry)) };
}

export function confirmTree(tree, { at = new Date().toISOString() } = {}) {
  const blocked = coverageOpen(tree);
  if (blocked.length) return { ok: false, tree, blocked, reason: `${blocked.length} requirement(s) are not modelled by any kept goal and were not dismissed: ${blocked.map((entry) => `${entry.id} ${entry.text}`).join(' | ')}` };
  return { ok: true, tree: { ...tree, confirmedAt: at }, blocked: [] };
}

export function openEntries(tree) {
  const open = [];
  for (const entry of coverageOpen(tree)) open.push({ id: entry.id, kind: NOT_MODELLED, text: entry.text, reason: 'no kept goal with a measurable question covers this requirement: dismiss it, or rebuild the tree' });
  for (const goal of tree?.goals ?? []) if (OPEN_STATES.includes(goal.state)) open.push({ id: goal.id, kind: 'goal', state: goal.state, text: goal.goal, reason: goal.reason ?? goal.state });
  for (const threshold of tree?.thresholds ?? []) if (threshold.source === 'assumption' && !threshold.confirmed) open.push({ id: threshold.node, kind: 'threshold', text: `${threshold.op ?? ''} ${threshold.value} ${threshold.unit}`.trim(), reason: 'a number the question, the hints and the cited note do not state' });
  for (const entry of tree?.implications ?? []) if (entry.source === 'inferred') open.push({ id: entry.id, kind: 'implication', text: `${entry.attribute}: ${entry.direction}`, reason: 'inferred from the purpose, not stated' });
  for (const goal of tensionGoalsOf(tree)) if (goal.gap) open.push({ id: goal.id, kind: 'research-gap', text: goal.goal, reason: `${RESEARCH_GAP}: ${goal.gap.found} explanation(s) with a cited scoping note, at least ${goal.gap.needed} are needed before the tension can be tested` });
  return open;
}

export function needsConfirmation(tree) {
  return Boolean(tree) && (coverageOpen(tree).length > 0 || (!tree.confirmedAt && openEntries(tree).length > 0));
}

export async function coverAskedClauses(ctx, tree, anchors, { notes = [], said = '', question = '', guidance = '', answers = [] } = {}) {
  const open = (tree.notModelled ?? []).filter((entry) => entry.kind === 'clause' && !entry.dismissedAt);
  if (!open.length) return tree;
  if (ctx.budget?.caps) ctx.budget.caps[TREE_STAGE] = (ctx.budget.caps[TREE_STAGE] ?? 0) + open.length * TREE_CALLS_PER_GOAL;
  const added = [];
  for (const anchor of open) {
    const refined = await refineGoal(ctx, { goal: anchor.text, anchorText: anchor.text, notes: notes.slice(0, MAX_NOTES_SHOWN), said });
    if (refined) added.push({ goal: anchor.text, state: 'kept', trace: { id: anchor.id, kind: anchor.kind, text: anchor.text }, notes: [], refine: refined.refine ?? 'AND', questions: refined.questions ?? [], obstacles: refined.obstacles ?? 'missing', basis: 'asked clause not covered by a drafted goal' });
  }
  if (!added.length) return tree;
  ctx.log?.(`${added.length} asked clause(s) not covered by any drafted goal became goals of their own: ${added.map((goal) => goal.trace.id).join(', ')}`);
  const numbered = thresholdsOf(numberTree({ ...tree, goals: [...tree.goals, ...added] }), { question, guidance, answers, notes }).tree;
  return { ...numbered, notModelled: notModelledOf(numbered, anchors) };
}

export async function buildPurposeTree(ctx, { question, guidance = '', answers = [], notes = [], drawn = null }) {
  const said = [question, guidance, ...answers].join('\n');
  const { anchors, ...requirements } = drawn?.requirements ?? (await requirementsOf(ctx, question, guidance));
  const tensions = await tensionsAsked(ctx, anchors);
  const purpose = drawn ? drawn.purpose : await drawPurpose(ctx, anchors);
  if (!purpose) return { phase: 'needs-purpose', tree: null, anchors, requirements, tensions };
  const consumes = await consumesVote(ctx, purpose, anchors);
  if (!consumes.decided) ctx.log?.('value and cost sides: no majority on whether the result consumes resources of the asker; both sides are kept');
  const implications = await drawImplications(ctx, anchors, purpose);
  const candidates = traceables(anchors, purpose, implications);
  const drafted = await draftGoals(ctx, { anchors, purpose, implications, notes, said });
  planTree(ctx, drafted.length + tensions.pairs.length + (consumes.value ? 2 : 0));
  const goals = [];
  const dropped = [];
  for (const entry of drafted) {
    const built = await traceAndRefine(ctx, entry, { candidates, notes: notes.filter((note) => entry.notes.includes(note.id)), said });
    if (built.unrefined) dropped.push({ goal: entry.goal, reason: UNREFINED, trace: built.unrefined.trace ?? null });
    else goals.push(built);
  }
  if (consumes.value) goals.push(await valueSide(ctx, { purpose, anchors, notes, said }), await costSide(ctx, { purpose, anchors, notes, said }));
  let tree = numberTree({ version: TREE_VERSION, requirements, purpose, implications, consumes, tensions, goals, dropped, ops: { applied: [], refused: [] }, confirmedAt: null });
  tree = await explainTensions(ctx, ensureTensions(tree), { notes, said });
  tree = await mergeDuplicates(ctx, tree);
  const ops = await critique(ctx, tree, candidates, { said });
  planTree(ctx, tree.goals.length + dropped.length + ops.filter((op) => op.op === 'add').length);
  tree = await applyOps(ctx, tree, ops, { candidates, notes, said });
  tree = ensureTensions(tree);
  tree = thresholdsOf(tree, { question, guidance, answers, notes }).tree;
  tree.notModelled = notModelledOf(tree, anchors);
  tree = await coverAskedClauses(ctx, tree, anchors, { notes, said, question, guidance, answers });
  if (tree.notModelled.length) ctx.log?.(`${tree.notModelled.length} requirement(s) not modelled by any kept goal: ${tree.notModelled.map((entry) => `${entry.id} ${entry.text}`).join(' | ')}; the tree cannot be confirmed until each is dismissed`);
  tree.valueForCost = valueForCostOf(tree);
  tree.unrefined = [...dropped.filter((entry) => entry.reason === UNREFINED).map((entry) => entry.goal), ...tree.goals.filter((goal) => !(goal.questions ?? []).length && goal.role !== TENSION_ROLE).map((goal) => goal.goal)];
  if (tree.unrefined.length) ctx.log?.(`${tree.unrefined.length} goal(s) ${UNREFINED}: ${tree.unrefined.join(' | ')}`);
  const budgetNote = ctx.budget?.note?.() ?? '';
  if (budgetNote) ctx.log?.(budgetNote);
  const embedNote = ctx.embedder?.failureNote?.() ?? '';
  if (embedNote) ctx.log?.(embedNote);
  return { phase: needsConfirmation(tree) ? 'needs-confirmation' : 'tree-ready', tree, anchors };
}

export function combineGoalAnswers(answers, refine) {
  const hardAnswers = answers.filter((a) => a.hard === true).map((a) => a.answer);
  if (hardAnswers.length === 0) return 'unknown';
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
