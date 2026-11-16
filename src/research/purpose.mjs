import { readFileSync } from 'node:fs';
import { clausesOf } from './strategy.mjs';
import { SAMPLE_TEMPERATURE, agreeAcrossSamples, ask, idOf, matchPrompt, oneOf, optionLines, retrieveThenVerify, shortText, vote } from './semantic.mjs';

export const PURPOSE = JSON.parse(readFileSync(new URL('./purpose.json', import.meta.url), 'utf8'));
export const TREE_VERSION = 1;
export const CONFLICT_ROLE = 'conflict';
export const CONFLICT_GOAL = 'Why is it still cheap?';
export const CHECKERS = ['page', 'code', 'consensus', 'statistic', 'official'];
export const THRESHOLD_OPS = ['<=', '>=', '<', '>'];
export const DIRECTIONS = ['low', 'high', 'match'];
export const DROP_REASONS = { A: 'redundant with another goal', B: 'not asked by the question or its purpose', C: 'a means, not an objective' };
export const MAX_GOALS = 8;
export const MAX_NOTES_SHOWN = 14;
export const EXTRA_HYPOTHESES = 2;
export const PURPOSE_STAGE = 'purpose';
export const TREE_STAGE = 'tree';

const OPEN_STATES = ['proposed', 'conflict'];
const lines = (rows) => rows.map((row) => `[${row.id}] ${row.text}`).join('\n');

export function anchorsOf(question, guidance = '') {
  return [
    ...clausesOf(question).map((text, index) => ({ id: `C${index + 1}`, kind: 'clause', text })),
    ...clausesOf(guidance).map((text, index) => ({ id: `H${index + 1}`, kind: 'hint', text })),
  ];
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
    { role: 'system', content: `You ask "why is that important" of a purpose. List at most 5 attributes the purpose makes preferable, each with its direction: "low" (less is better), "high" (more is better) or "match" (must fit a given value). "anchor" is the id of the clause or hint it follows from. Attributes of at most 6 words. Answer with JSON only: {"implications":[{"attribute":"...","direction":"low|high|match","anchor":"C5"}]}.` },
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

export async function conflictAsked(ctx, anchors) {
  const known = new Set(anchors.map((anchor) => anchor.id));
  const messages = [
    { role: 'system', content: 'You read the clauses of a request, in any language. "cost": the id of the clause that limits, minimises or trades off what is paid, or null; a clause that asks for the most worth per unit of money is a cost clause, because it trades what is paid against what is received. "worth": the id of the clause that asks for worth beyond the minimum (value, quality, upside), or null. One clause may be both cost and worth: then give its id in both fields. Answer with JSON only: {"cost":"C<n>","worth":"C<n>"}.' },
    { role: 'user', content: `Clauses and hints:\n${lines(anchors)}` },
  ];
  const schema = (data) => (data && typeof data === 'object' && !Array.isArray(data) && ('cost' in data || 'worth' in data) ? { value: { cost: idOf(data.cost, known), worth: idOf(data.worth, known) } } : { error: 'answer with the two fields "cost" and "worth"' });
  const result = await vote({ router: ctx.router, task: 'conflict', tier: 'fast', messages, schema, n: 3, quorum: 2, key: (value) => (value.cost && value.worth ? 'yes' : 'no'), budget: ctx.budget, stage: PURPOSE_STAGE });
  if (!result.value) return { asked: null, votes: result.tally, cost: null, worth: null };
  const asked = Boolean(result.value.cost && result.value.worth);
  return { asked, votes: result.tally, cost: asked ? result.value.cost : null, worth: asked ? result.value.worth : null };
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
    { role: 'system', content: `You list the goals a result must reach (Goal-Question-Metric). At most ${MAX_GOALS} goals of at most 12 words, no numbers. "anchor" is the id the goal comes from: a clause (C), a hint (H), the purpose (P) or an implication (I). "notes" are the ids of scoping notes the goal uses. Do not add goals nobody asked for. Answer with JSON only: {"goals":[{"goal":"...","anchor":"C3","notes":["N2"]}]}.` },
    { role: 'user', content: `Clauses and hints:\n${lines(anchors)}\n\n[P] ${purpose.text}\n${implications.length ? `\nImplications:\n${lines(implications.map((entry) => ({ id: entry.id, text: `${entry.attribute}: ${entry.direction}` })))}\n` : ''}${shown.length ? `\nScoping notes:\n${lines(shown.map((note) => ({ id: note.id, text: `${note.label}: ${String(note.quote).slice(0, 160)}` })))}` : ''}` },
  ];
  const userNumbers = numbersIn([said, ...anchors.map((anchor) => anchor.text)].join('\n'));
  const allowedFor = (entry) => new Set([...userNumbers, ...shown.filter((note) => entry.notes.includes(note.id)).flatMap((note) => numbersIn(note.quote))]);
  let rounds = 0;
  const schema = (data) => {
    rounds += 1;
    const drafted = (Array.isArray(data?.goals) ? data.goals : []).slice(0, MAX_GOALS).map((entry) => ({ goal: shortText(entry?.goal, 12, 160), anchor: idOf(entry?.anchor, known), notes: [...new Set((Array.isArray(entry?.notes) ? entry.notes : []).map((id) => idOf(id, noteIds)).filter(Boolean))] })).filter((entry) => entry.goal && entry.anchor);
    const stray = drafted.flatMap((entry) => strayNumbers(entry.goal, allowedFor(entry)));
    if (stray.length && rounds < 2) return { error: numberError(stray, 'a goal') };
    const goals = drafted.map((entry) => moveNumbers(entry, 'goal', allowedFor(entry))).filter((entry) => entry.goal);
    return goals.length ? { value: goals } : { error: 'every goal needs a "goal" text and an "anchor" id from the lists' };
  };
  const reply = await ask({ router: ctx.router, task: 'goals', tier: 'deep', messages, schema, budget: ctx.budget, stage: TREE_STAGE });
  return reply?.value ?? [];
}

function leafOf(entry, textField, noteIds) {
  const text = shortText(entry?.[textField], 40, 300);
  const checker = CHECKERS.find((name) => name === String(entry?.checker ?? '').trim().toLowerCase());
  if (!text || !checker) return null;
  return { [textField]: text, checker, threshold: normalizeThreshold(entry?.threshold), ...(textField === 'q' ? { note: idOf(entry?.note, noteIds) } : {}) };
}

export async function refineGoal(ctx, { goal, anchorText = '', notes = [], said = '', cited = null }) {
  const noteIds = new Set(notes.map((note) => note.id));
  const system = `You refine one goal into questions a checker can answer. "refine": "AND" when every question must hold, "OR" when one is enough. At most 3 questions, each with exactly one checker: page (stated on the item's page), code (computed or compared across items), consensus (independent sources agree), statistic (a published figure), official (a registry or plan). At most 2 obstacles: conditions that defeat the goal. A number goes only in "threshold", never in the text; use null when no number was given. Answer with JSON only: {"refine":"AND|OR","questions":[{"q":"...","checker":"page","threshold":{"op":"<=","value":0,"unit":"..."},"note":"N2"}],"obstacles":[{"obstacle":"...","checker":"page","threshold":null}]}.`;
  const user = `Goal: ${goal}\nIt comes from: ${anchorText}${notes.length ? `\n\nNotes:\n${lines(notes.map((note) => ({ id: note.id, text: `${note.label}: ${String(note.quote).slice(0, 160)}` })))}` : ''}`;
  const userNumbers = numbersIn(said);
  const goalNotes = notes.filter((note) => (cited ?? [...noteIds]).includes(note.id));
  const allowedFor = (leaf) => new Set([...userNumbers, ...[...goalNotes, ...notes.filter((note) => note.id === leaf.note)].flatMap((note) => numbersIn(note.quote)), ...(leaf.threshold ? [leaf.threshold.value] : [])]);
  const noQuestion = { error: 'at least one question with a "q" text and one checker of page, code, consensus, statistic, official' };
  const validator = () => {
    let rounds = 0;
    return (data) => {
      rounds += 1;
      const refine = oneOf(data?.refine, ['AND', 'OR']);
      const drafted = {
        q: (Array.isArray(data?.questions) ? data.questions : []).slice(0, 3).map((entry) => leafOf(entry, 'q', noteIds)).filter(Boolean),
        obstacle: (Array.isArray(data?.obstacles) ? data.obstacles : []).slice(0, 2).map((entry) => leafOf(entry, 'obstacle', noteIds)).filter(Boolean),
      };
      if (!refine) return { error: '"refine" must be AND or OR' };
      if (!drafted.q.length) return noQuestion;
      const stray = Object.entries(drafted).flatMap(([field, leaves]) => leaves.flatMap((leaf) => strayNumbers(leaf[field], allowedFor(leaf))));
      if (stray.length && rounds < 2) return { error: numberError(stray, 'a question or an obstacle') };
      const settled = (field) => drafted[field].map((leaf) => moveNumbers(leaf, field, allowedFor(leaf))).filter((leaf) => leaf[field]);
      const questions = settled('q');
      return questions.length ? { value: { refine, questions, obstacles: settled('obstacle') } } : noQuestion;
    };
  };
  const request = { router: ctx.router, task: 'refine', tier: 'deep', budget: ctx.budget, stage: TREE_STAGE };
  const first = await ask({ ...request, schema: validator(), messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
  if (!first) return null;
  if (first.value.obstacles.length) return first.value;
  const again = await ask({ ...request, schema: validator(), messages: [{ role: 'system', content: system }, { role: 'user', content: `${user}\n\nName at least one obstacle that would defeat this goal.` }] });
  if (again?.value.obstacles.length) return again.value;
  return { ...first.value, obstacles: 'missing' };
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
  if (relation === 'R') return { ...goal, state: 'dropped', trace, reason: 'only restates what was asked', votes: result.tally };
  if (relation === 'X') return { ...goal, state: 'conflict', trace, reason: `contradicts ${trace.id}: ${trace.text}`, votes: result.tally };
  return { ...goal, state: 'proposed', trace: null, reason: result.none ? 'traces to no clause, hint, purpose or implication: confirm or drop it' : 'no majority on what it traces to: confirm or drop it', votes: result.tally };
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
  return { ...into, questions, obstacles: obstacles.length ? obstacles : into.obstacles, notes: [...new Set([...(into.notes ?? []), ...(other.notes ?? [])])], merged: [...(into.merged ?? []), other.id] };
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
    { role: 'system', content: `You review a goal tree (critique and revise). Return operations only, never a rewritten tree. Allowed: {"op":"merge","a":"G2","b":"G5"} two goals that are one objective; {"op":"drop","id":"G4","reason":"A|B|C"} with ${Object.entries(DROP_REASONS).map(([letter, text]) => `${letter} ${text}`).join(', ')}; {"op":"add","goal":"...","anchor":"C3"} a missing goal and the statement id it comes from; {"op":"checker","id":"Q3","checker":"page|code|consensus|statistic|official"} a question with the wrong checker. Answer with JSON only: {"ops":[...]}.` },
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
        const added = moveNumbers({ goal: shortText(entry.goal, 12, 160) }, 'goal', allowed);
        if (added.goal) ops.push({ op, ...added, anchor: idOf(entry.anchor, anchorIds) });
      }
      else if (op === 'checker' && idOf(entry.id, ids) && CHECKERS.includes(String(entry.checker ?? '').trim().toLowerCase())) ops.push({ op, id: idOf(entry.id, ids), checker: String(entry.checker).trim().toLowerCase() });
    }
    return { value: ops };
  };
  const reply = await ask({ router: ctx.router, task: 'critique', tier: 'deep', messages, schema, budget: ctx.budget, stage: TREE_STAGE });
  return reply?.value ?? [];
}

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
      else if (node.goal.protected) refused.push({ ...op, why: `"${node.goal.goal}" is protected because the question asks for it` });
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
      const anchor = candidates.find((candidate) => candidate.id === op.anchor);
      const refined = await refineGoal(ctx, { goal: op.goal, anchorText: anchor?.text ?? '', notes, said, cited: [] });
      if (!refined) refused.push({ ...op, why: 'the goal could not be refined into questions' });
      else {
        const traced = await traceGoal(ctx, { goal: op.goal, anchor: op.anchor, notes: [], ...(op.threshold ? { threshold: op.threshold, movedNumber: op.movedNumber } : {}), ...refined }, candidates);
        if (traced.state === 'dropped') refused.push({ ...op, why: traced.reason });
        else {
          goals = numberTree({ goals: [...goals, traced] }).goals;
          applied.push({ ...op, state: traced.state });
        }
      }
    } else if (op.op === 'checker') {
      const node = find(op.id);
      if (node?.kind !== 'question') refused.push({ ...op, why: node?.kind === 'obstacle' ? 'an obstacle is a protected node' : 'only a question has a checker to change' });
      else if (node.goal.protected) refused.push({ ...op, why: `"${node.goal.goal}" is protected because the question asks for it` });
      else {
        goals = goals.map((goal) => (goal === node.goal ? { ...goal, questions: goal.questions.map((question) => (question === node.node ? { ...question, checker: op.checker } : question)) } : goal));
        applied.push(op);
      }
    }
  }
  for (const entry of refused.slice((tree.ops?.refused ?? []).length)) ctx.log?.(`critique operation refused: ${entry.op} ${entry.id ?? entry.a ?? entry.goal ?? ''}: ${entry.why}`);
  return { ...tree, goals, ops: { applied, refused } };
}

export function ensureAskedConflict(tree) {
  const asked = tree.conflict?.asked ?? null;
  const goals = [...(tree.goals ?? [])];
  const present = goals.find((goal) => goal.role === CONFLICT_ROLE);
  if (asked !== true && !present) return { ...tree, goals };
  const base = present ?? { goal: CONFLICT_GOAL, role: CONFLICT_ROLE, refine: 'OR', state: asked === true ? 'kept' : 'proposed', reason: asked === true ? undefined : 'no majority on whether the question asks for a low price and worth at once: confirm or drop it', anchors: [tree.conflict?.cost, tree.conflict?.worth].filter(Boolean), questions: [], obstacles: [], hypotheses: [] };
  const own = Array.isArray(base.hypotheses) ? base.hypotheses : [];
  const ids = new Set(PURPOSE.mechanisms.map((mechanism) => mechanism.id));
  const hypotheses = [
    ...PURPOSE.mechanisms.map((mechanism) => ({ id: mechanism.id, key: mechanism.key, hypothesis: own.find((entry) => entry?.id === mechanism.id)?.hypothesis ?? mechanism.label, test: mechanism.test, basis: mechanism.basis })),
    ...own.filter((entry) => entry && !ids.has(entry.id) && entry.confirmed === true).slice(0, EXTRA_HYPOTHESES),
  ];
  const questions = [...(base.questions ?? [])];
  for (const mechanism of PURPOSE.mechanisms) if (!questions.some((question) => question.mechanism === mechanism.id)) questions.push({ q: mechanism.test, checker: mechanism.checker, threshold: null, note: null, mechanism: mechanism.id });
  const obstacles = Array.isArray(base.obstacles) ? [...base.obstacles] : [];
  const defect = PURPOSE.mechanisms.find((mechanism) => mechanism.id === PURPOSE.conflictObstacle);
  if (!obstacles.some((obstacle) => obstacle.mechanism === defect.id)) obstacles.push({ obstacle: defect.label, checker: defect.checker, threshold: null, mechanism: defect.id, protected: true });
  const completed = { ...base, protected: true, trace: { kind: 'rule', text: CONFLICT_ROLE }, hypotheses, questions, obstacles };
  return numberTree({ ...tree, goals: present ? goals.map((goal) => (goal === present ? completed : goal)) : [...goals, completed] });
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

export function numbersIn(text) {
  return numberRuns(text).flatMap((run) => run.values);
}

export function strayNumbers(text, allowed) {
  return numberRuns(text).filter((run) => !run.values.some((value) => allowed.has(value)));
}

function numberError(stray, where) {
  return `the text of ${where} holds a number nobody stated (${[...new Set(stray.map((run) => run.raw))].join(', ')}): move it into "threshold" and write the text without it`;
}

export function moveNumbers(node, textField, allowed) {
  const stray = strayNumbers(node[textField], allowed);
  if (!stray.length) return node;
  let text = String(node[textField]);
  for (const run of [...stray].reverse()) text = `${text.slice(0, run.at)} ${text.slice(run.at + run.raw.length)}`;
  const moved = [...new Set(stray.filter((run) => run.values.length).map((run) => run.values[run.values.length - 1]))];
  const threshold = node.threshold ?? (moved.length ? { op: null, value: moved[0], unit: '', source: 'assumption', moved: true } : null);
  return { ...node, [textField]: text.replace(/\s+/g, ' ').trim(), ...(threshold ? { threshold } : {}), ...(moved.length ? { movedNumber: moved } : {}) };
}

export function thresholdsOf(tree, { question = '', guidance = '', answers = [], notes = [] } = {}) {
  const said = new Set(numbersIn([question, guidance, ...answers].join('\n')));
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const thresholds = [];
  const settle = (node, goal, textField) => {
    const quoted = [noteById.get(node.note), ...(goal.notes ?? []).map((id) => noteById.get(id))].filter(Boolean).flatMap((note) => numbersIn(note.quote));
    const invented = strayNumbers(node[textField], new Set([...said, ...quoted, ...(node.threshold ? [node.threshold.value] : [])])).flatMap((run) => run.values);
    const out = { ...node };
    delete out.inventedNumber;
    if (invented.length) out.inventedNumber = [...new Set(invented)];
    if (!node.threshold) return out;
    const cited = noteById.get(node.note) ?? (goal.notes ?? []).map((id) => noteById.get(id)).find((note) => note && numbersIn(note.quote).includes(node.threshold.value));
    const confirmed = node.threshold.confirmed === true;
    const source = said.has(node.threshold.value) ? 'asked' : cited && numbersIn(cited.quote).includes(node.threshold.value) ? 'sourced' : 'assumption';
    const threshold = { ...node.threshold, source, ...(source === 'sourced' ? { url: cited.url, note: cited.id } : {}), hard: source !== 'assumption' || confirmed };
    thresholds.push({ node: node.id, goal: goal.id, ...threshold });
    return { ...out, threshold };
  };
  const goals = (tree.goals ?? []).map((goal) => {
    const own = settle(goal, goal, 'goal');
    return { ...own, questions: (goal.questions ?? []).map((node) => settle(node, goal, 'q')), obstacles: Array.isArray(goal.obstacles) ? goal.obstacles.map((node) => settle(node, goal, 'obstacle')) : goal.obstacles };
  });
  return { tree: { ...tree, goals, thresholds }, thresholds };
}

export function notModelledOf(tree, anchors) {
  const covered = new Set();
  for (const goal of tree.goals ?? []) {
    if (goal.state === 'dropped') continue;
    for (const id of [goal.trace?.id, goal.anchor, ...(goal.anchors ?? [])]) if (id) covered.add(id);
  }
  return anchors.filter((anchor) => anchor.kind === 'clause' && !covered.has(anchor.id)).map((anchor) => ({ id: anchor.id, text: anchor.text }));
}

export function openEntries(tree) {
  const open = [];
  for (const goal of tree?.goals ?? []) if (OPEN_STATES.includes(goal.state)) open.push({ id: goal.id, kind: 'goal', state: goal.state, text: goal.goal, reason: goal.reason ?? goal.state });
  for (const threshold of tree?.thresholds ?? []) if (threshold.source === 'assumption' && !threshold.confirmed) open.push({ id: threshold.node, kind: 'threshold', text: `${threshold.op ?? ''} ${threshold.value} ${threshold.unit}`.trim(), reason: 'a number the question, the hints and the cited note do not state' });
  for (const entry of tree?.implications ?? []) if (entry.source === 'inferred') open.push({ id: entry.id, kind: 'implication', text: `${entry.attribute}: ${entry.direction}`, reason: 'inferred from the purpose, not stated' });
  return open;
}

export function needsConfirmation(tree) {
  return Boolean(tree) && !tree.confirmedAt && openEntries(tree).length > 0;
}

export function conflictGoalOf(tree) {
  return (tree?.goals ?? []).find((goal) => goal.role === CONFLICT_ROLE) ?? null;
}

export async function buildPurposeTree(ctx, { question, guidance = '', answers = [], notes = [] }) {
  const said = [question, guidance, ...answers].join('\n');
  const anchors = anchorsOf(question, guidance);
  const conflict = await conflictAsked(ctx, anchors);
  const purpose = await drawPurpose(ctx, anchors);
  if (!purpose) return { phase: 'needs-purpose', tree: null, anchors, conflict };
  const implications = await drawImplications(ctx, anchors, purpose);
  const candidates = traceables(anchors, purpose, implications);
  const drafted = await draftGoals(ctx, { anchors, purpose, implications, notes, said });
  const goals = [];
  const dropped = [];
  for (const entry of drafted) {
    const anchor = candidates.find((candidate) => candidate.id === entry.anchor);
    const refined = await refineGoal(ctx, { goal: entry.goal, anchorText: anchor?.text ?? '', notes: notes.filter((note) => entry.notes.includes(note.id)), said });
    if (!refined) {
      dropped.push({ goal: entry.goal, reason: 'not refined into questions' });
      continue;
    }
    const traced = await traceGoal(ctx, { ...entry, ...refined }, candidates);
    if (traced.state === 'dropped') dropped.push({ goal: traced.goal, reason: traced.reason, trace: traced.trace });
    else goals.push(traced);
  }
  let tree = numberTree({ version: TREE_VERSION, purpose, implications, conflict, goals, dropped, ops: { applied: [], refused: [] }, confirmedAt: null });
  tree = ensureAskedConflict(tree);
  tree = await mergeDuplicates(ctx, tree);
  const ops = await critique(ctx, tree, candidates, { said });
  tree = await applyOps(ctx, tree, ops, { candidates, notes, said });
  tree = ensureAskedConflict(tree);
  tree = thresholdsOf(tree, { question, guidance, answers, notes }).tree;
  tree.notModelled = notModelledOf(tree, anchors);
  const budgetNote = ctx.budget?.note?.() ?? '';
  if (budgetNote) ctx.log?.(budgetNote);
  const embedNote = ctx.embedder?.failureNote?.() ?? '';
  if (embedNote) ctx.log?.(embedNote);
  return { phase: needsConfirmation(tree) ? 'needs-confirmation' : 'tree-ready', tree, anchors };
}
