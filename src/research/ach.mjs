import { oneOf, vote } from './semantic.mjs';

export const STAGE = 'evidence';
export const MARKS = ['C', 'I', 'N'];
export const MIN_COMPARABLES = 5;
export const PRICE_MADS = 2.5;
export const MAD_SCALE = 1.4826;
export const MAX_ROW_CREDIBILITY = 3;

const middle = (sorted) => sorted[Math.floor(sorted.length / 2)];

export function pricedIn(item, rows, levels = []) {
  const value = Number(item?.value);
  const priced = (rows ?? []).filter((row) => Number.isFinite(Number(row?.value)) && Number(row.value) > 0 && row.url !== item?.url);
  const subject = item?.subject ?? [];
  if (!Number.isFinite(value) || value <= 0) return { position: 'unknown', reason: 'the item states no price' };
  for (let depth = Math.min(levels.length, subject.length); depth >= 0; depth--) {
    const key = subject.slice(0, depth);
    if (key.some((part) => !part)) continue;
    const same = priced.filter((row) => key.every((part, index) => String(row.subject?.[index] ?? '') === String(part)));
    if (same.length < MIN_COMPARABLES) continue;
    const logs = same.map((row) => Math.log(Number(row.value))).sort((a, b) => a - b);
    const median = middle(logs);
    const mad = middle(logs.map((entry) => Math.abs(entry - median)).sort((a, b) => a - b));
    if (!(mad > 0)) continue;
    const spread = PRICE_MADS * MAD_SCALE * mad;
    const low = Math.round(Math.exp(median - spread));
    const high = Math.round(Math.exp(median + spread));
    return { position: value < low ? 'below' : value > high ? 'above' : 'within', level: depth, comparables: same.length, median: Math.round(Math.exp(median)), low, high };
  }
  return { position: 'unknown', reason: `fewer than ${MIN_COMPARABLES} comparable rows with a spread of prices` };
}

export function evidenceRows({ identity = null, priced = null, facts = [] }) {
  const rows = [];
  for (const field of Object.values(identity?.fields ?? {})) if (field) rows.push({ id: `R${rows.length + 1}`, kind: 'identity', evidence: `${field.level}: ${field.value}`, quote: field.quote, weight: 1 });
  if (priced && priced.position !== 'unknown') rows.push({ id: `R${rows.length + 1}`, kind: 'priced-in', evidence: `the price is ${priced.position} the range of ${priced.comparables} comparable items (${priced.low} to ${priced.high}, median ${priced.median})`, weight: 1 });
  for (const fact of facts) if (fact.credibility <= MAX_ROW_CREDIBILITY) rows.push({ id: `R${rows.length + 1}`, kind: 'fact', evidence: fact.quote, for: fact.for, direction: fact.direction, credibility: fact.credibility, admiralty: fact.admiralty, url: fact.url, weight: 1 + MAX_ROW_CREDIBILITY - fact.credibility });
  return rows;
}

export async function markRow(ctx, row, hypotheses, about = '') {
  const ids = hypotheses.map((hypothesis) => hypothesis.id);
  const messages = [
    { role: 'system', content: 'You test competing explanations of one question against one piece of evidence (analysis of competing hypotheses). For each hypothesis mark C when the evidence is consistent with it, I when it is inconsistent with it, N when it says nothing about it. Answer with JSON only: {"marks":{"M1":"C|I|N","M2":"C|I|N"}} with one mark per hypothesis id.' },
    { role: 'user', content: `${about ? `What is explained: ${about}\n\n` : ''}Evidence: ${row.evidence}\n\nHypotheses:\n${hypotheses.map((hypothesis) => `[${hypothesis.id}] ${hypothesis.hypothesis}`).join('\n')}` },
  ];
  const schema = (data) => {
    const marks = {};
    for (const id of ids) marks[id] = oneOf(data?.marks?.[id], MARKS);
    return ids.some((id) => !marks[id]) ? { error: `"marks" needs C, I or N for each of ${ids.join(', ')}` } : { value: marks };
  };
  const result = await vote({ router: ctx.router, task: 'ach-row', tier: 'fast', messages, schema, n: 3, quorum: 2, budget: ctx.budget, stage: STAGE });
  const marks = {};
  for (const id of ids) {
    const counts = {};
    for (const reply of result.replies) counts[reply.value[id]] = (counts[reply.value[id]] ?? 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    marks[id] = top && top[1] >= 2 ? top[0] : result.replies.length >= 2 ? 'N' : '';
  }
  return { ...row, marks, votes: result.replies.length };
}

export async function markRows(ctx, rows, hypotheses, about = '') {
  const marked = [];
  for (const row of rows) marked.push(await markRow(ctx, row, hypotheses, about));
  return marked;
}

export function diagnosticRows(hypotheses, rows, { questions = [] } = {}) {
  const ids = (hypotheses ?? []).map((hypothesis) => hypothesis.id);
  const kept = [];
  const dropped = [];
  for (const row of rows ?? []) {
    const marks = Object.fromEntries(ids.map((id) => [id, String(row?.marks?.[id] ?? '').trim().toUpperCase().slice(0, 1)]));
    const values = Object.values(marks);
    if (values.some((mark) => !MARKS.includes(mark))) dropped.push({ ...row, marks, reason: values.every((mark) => !mark) ? 'not marked: too few votes answered' : 'a hypothesis has no mark' });
    else if (new Set(values).size === 1) dropped.push({ ...row, marks, reason: 'the same mark for every hypothesis, so it cannot tell them apart' });
    else kept.push({ ...row, marks });
  }
  const ranking = (hypotheses ?? []).map((hypothesis) => {
    const against = kept.filter((row) => row.marks[hypothesis.id] === 'I');
    return { id: hypothesis.id, key: hypothesis.key ?? null, hypothesis: hypothesis.hypothesis, inconsistent: against.length, weighted: against.reduce((sum, row) => sum + (row.weight ?? 1), 0) };
  }).sort((a, b) => a.inconsistent - b.inconsistent || a.weighted - b.weighted);
  const answered = new Set(kept.map((row) => row.for).filter(Boolean));
  const needed = questions.filter((question) => !answered.has(question.id)).map((question) => ({ id: question.id, q: question.q, checker: question.checker }));
  return { kept, dropped, ranking, needed };
}

export async function buildMatrix(ctx, { identity = null, priced = null, facts = [], goal }) {
  const hypotheses = goal?.hypotheses ?? [];
  const rows = evidenceRows({ identity, priced, facts });
  const marked = hypotheses.length ? await markRows(ctx, rows, hypotheses, goal?.goal ?? '') : [];
  return diagnosticRows(hypotheses, marked, { questions: goal?.questions ?? [] });
}
