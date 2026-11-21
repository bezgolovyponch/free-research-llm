import { plain } from './itemgate.mjs';
import { quoteFound } from './quote.mjs';
import { isUmbrella } from './concept.mjs';
import { pickSpans, quoteFromSpans, sentenceSpans, spansBlock } from './spans.mjs';
import { agreed, closedVote, matchPrompt, retrieveThenVerify } from './semantic.mjs';
import { MEASURES as DecisionMeasures, compare, adaptForChecklist } from './measures.mjs';

const isAnswer = (entry) => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry) && 'id' in entry && 'answer' in entry;

export function replyList(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.answers)) return data.answers;
  if (isAnswer(data)) return [data];
  return Object.values(data).find((value) => Array.isArray(value) && value.some(isAnswer)) ?? [];
}

const shortIdOf = (reply) => String(reply?.id ?? '').trim().toLowerCase().replace(/^["']|["']$/g, '');

const ANSWERS = ['yes', 'no', 'unknown'];

export function applyQuoteCheck(replies, spans) {
  return replies.map((r) => {
    if (!r || typeof r !== 'object') return { ...r, answer: 'unknown', quote: '' };
    const answer = ANSWERS.includes(r.answer) ? r.answer : 'unknown';
    const quote = answer === 'unknown' ? '' : quoteFromSpans(r.spans, spans);
    return quote ? { ...r, answer, quote } : { ...r, answer: 'unknown', quote: '' };
  });
}

export const CHECKLIST_VERSION = 6;
export const JUDGE_VERSION = 6;
export const JUDGE_QUESTIONS_PER_CALL = 4;
export const JUDGE_BLOCK_CHARS = 6000;
export const JUDGE_PAGE_CHARS = 40000;
export const LOW_PRICE_REASON = 'priced far below comparable items: confirm it is the item itself';
export const KIND_ANSWERS = { A: 'yes', B: 'no', C: 'no', D: 'no', E: 'no', U: 'unknown' };
export const KIND_NONE = 'U';
export const SINGLE_KIND_OPINION = 'second opinion from one provider family only: not rejected, to confirm';
export const SINGLE_KIND_REASON ='priced far below comparable items, and only one independent judgement was available: confirm it is the item itself';

export { matchPrompt } from './semantic.mjs';

export const KIND_SECOND_VOTES = 3;
export const KIND_SECOND_OPINION_BUDGET = 30;

const isKindYes = (check) => check?.clause === 'kind' && String(check.id).startsWith('kind|') && check.answer === 'yes';

export function needsSecondKind(checks, item, cut) {
  const value = item?.value === null || item?.value === undefined ? NaN : Number(item.value);
  return typeof cut === 'number' && Number.isFinite(cut) && Number.isFinite(value) && value < cut && (checks ?? []).some(isKindYes);
}

export async function hardenKind(checks, item, { cut = null, median = null, judge = null, pageText = '', kind = null } = {}) {
  if (!needsSecondKind(checks, item, cut)) return checks;
  const second = judge && kind?.label ? await judge.judgeKindAgain(pageText, kind, { value: Number(item.value), unit: item.unit ?? '', median }) : { answer: 'unknown', quote: '', tally: {} };
  return checks.map((check) => {
    if (!isKindYes(check)) return check;
    if (second.answer === 'yes') return { ...check, second: { answer: 'yes', tally: second.tally } };
    if (second.answer === 'no') return { ...check, answer: 'no', quote: second.quote, reason: LOW_PRICE_REASON, second: { answer: 'no', tally: second.tally } };
    return { ...check, answer: 'unknown', reason: second.single ? SINGLE_KIND_REASON : LOW_PRICE_REASON, second: { answer: 'unknown', tally: second.tally, ...(second.single ? { single: true } : {}) } };
  });
}

export function migrateChecks(project) {
  let changed = 0;
  for (const item of project?.acceptanceResult?.items ?? []) {
    if (!Array.isArray(item.checks)) continue;
    item.checks = item.checks.map((check) => {
      if (!check || (check.answer !== 'yes' && check.answer !== 'no') || String(check.quote ?? '').trim()) return check;
      changed += 1;
      return { ...check, answer: 'unknown', quote: '' };
    });
  }
  return changed;
}

export async function proposeChecklist({ router, question, guidance = '', samples = 3, expected = '' }) {
  const messages = checklistPrompt({ question, guidance, expected });
  const replies = await Promise.all(
    Array.from({ length: samples }, () =>
      router.complete({ purpose: 'checklist', tier: 'deep', temperature: 0.7, messages }).catch(() => null)
    )
  );
  return replies.filter((r) => r?.data?.items?.length).map((r) => normalizeSample(r.data));
}

export function normalizeSample(raw) {
  const items = (Array.isArray(raw?.items) ? raw.items : []).slice(0, 12).map((i) => ({
    clause: String(i?.clause ?? '').slice(0, 200),
    question: String(i?.question ?? '').slice(0, 300),
    hard: Boolean(i?.hard),
    numeric: i?.numeric ? {
      measure: String(i.numeric.measure ?? ''),
      op: ['<=', '>=', '<', '>'].includes(i.numeric.op) ? i.numeric.op : '',
      value: i.numeric.value !== null && i.numeric.value !== undefined ? Number(i.numeric.value) : null,
      unit: String(i.numeric.unit ?? ''),
    } : undefined,
    ...(process.env.FRL_QUOTED_CHECKS ? { quote: String(i?.quote ?? '').trim().slice(0, 200) } : {}),
  })).filter((i) => i.clause && i.question);
  return { items };
}

export function clusterChecklist(samples, { askerWords = '' } = {}) {
  const byQuote = Boolean(process.env.FRL_QUOTED_CHECKS) && Boolean(String(askerWords).trim());
  const allItems = [];
  for (let sampleIdx = 0; sampleIdx < samples.length; sampleIdx++) {
    for (const item of samples[sampleIdx].items) {
      allItems.push({ ...item, sampleIdx });
    }
  }

  const groups = [];
  for (const item of allItems) {
    let placed = false;
    for (const group of groups) {
      if (sameMeaning(group[0].question, item.question)) {
        group.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([item]);
  }

  const majority = Math.floor(samples.length / 2) + 1;
  const clusters = [];

  for (const group of groups) {
    const sampleCount = new Set(group.map((i) => i.sampleIdx)).size;
    const quotedItem = byQuote ? group.find((i) => i.quote && quoteFound(askerWords, i.quote)) : null;
    if (sampleCount < majority && !quotedItem) continue;

    const questions = group.map((i) => i.question);
    const questionCounts = new Map();
    for (const q of questions) {
      questionCounts.set(q, (questionCounts.get(q) ?? 0) + 1);
    }
    const mostCommonQuestion = [...questionCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const hardCount = group.filter((i) => i.hard).length;
    const hard = hardCount >= majority || Boolean(quotedItem);

    let numeric = undefined;
    const numericItems = group.filter((i) => i.numeric);
    if (numericItems.length > 0) {
      const measures = new Map();
      const ops = new Map();
      const values = new Map();
      const units = new Map();
      for (const ni of numericItems) {
        measures.set(ni.numeric.measure, (measures.get(ni.numeric.measure) ?? 0) + 1);
        ops.set(ni.numeric.op, (ops.get(ni.numeric.op) ?? 0) + 1);
        if (ni.numeric.value !== null && ni.numeric.value !== undefined) {
          values.set(ni.numeric.value, (values.get(ni.numeric.value) ?? 0) + 1);
        }
        units.set(ni.numeric.unit, (units.get(ni.numeric.unit) ?? 0) + 1);
      }
      const measure = [...measures.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const op = [...ops.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const value = values.size ? [...values.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
      const unit = [...units.entries()].sort((a, b) => b[1] - a[1])[0][0];
      numeric = { measure, op, value, unit };
    }

    const clause = (quotedItem?.quote ?? group[0].clause).toLowerCase().trim();
    const provenance = byQuote ? { source: quotedItem ? 'quoted' : 'derived', quote: quotedItem?.quote ?? '', share: Math.round((sampleCount / samples.length) * 100) / 100 } : {};
    clusters.push({ clause, ...provenance, items: [{ clause, question: mostCommonQuestion, hard, numeric }] });
  }

  return clusters;
}

function sameMeaning(a, b) {
  const wa = contentWords(a);
  const wb = contentWords(b);
  return jaccard(wa, wb) >= 0.3;
}

const QUESTION_SCAFFOLD = new Set(['does', 'this', 'that', 'these', 'have', 'with', 'from', 'page', 'state', 'stated', 'show', 'shows', 'list', 'listed', 'item', 'offer', 'offered', 'there', 'their', 'they', 'which', 'what', 'about', 'than', 'mention', 'mentions', 'include', 'includes', 'provide', 'provided']);

function contentWords(text) {
  return new Set(plain(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !QUESTION_SCAFFOLD.has(w)));
}

function jaccard(a, b) {
  const union = new Set([...a, ...b]).size;
  return union ? [...a].filter((w) => b.has(w)).length / union : 0;
}

const OPS = ['<=', '>=', '<', '>'];

function getMeasures() {
  return adaptForChecklist(DecisionMeasures);
}

function finiteReading(measure, item, ctx) {
  if (!measure) return undefined;
  const raw = measure.read(item ?? {}, ctx);
  return raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
}

export function measuredReading(item, numeric, { measures = getMeasures(), criteria = [], ctx = {} } = {}) {
  if (!numeric?.measure || !numeric.op || numeric.value === null || numeric.value === undefined) return undefined;
  const own = finiteReading(measures[numeric.measure], item, ctx);
  if (own !== undefined) return { value: own, measure: numeric.measure };
  for (const criterion of criteria ?? []) {
    if (!criterion?.measure || criterion.op !== numeric.op || criterion.value !== numeric.value) continue;
    const stated = finiteReading(measures[criterion.measure], item, ctx);
    if (stated !== undefined) return { value: stated, measure: criterion.measure };
  }
  return undefined;
}

export function measuredValue(item, numeric, options = {}) {
  return measuredReading(item, numeric, options)?.value;
}

export function checklistSummary(items) {
  return items.map((item) => {
    const checks = item.checks ?? [];
    const hardChecks = checks.filter((c) => c.hard === true);
    const hardPass = hardChecks.length > 0 && hardChecks.every((c) => c.answer === 'yes');
    const unknown = checks.filter((c) => c.answer === 'unknown').length;
    const softYes = checks.filter((c) => c.hard !== true && c.answer === 'yes').length;
    return { hardPass, unknown, softYes };
  });
}

export function checklistFingerprint(checklist) {
  const parts = [];
  for (const cluster of checklist) {
    for (const ci of cluster.items) {
      parts.push(`${cluster.clause}|${ci.question}|${ci.hard ? 1 : 0}|${ci.numeric ? `${ci.numeric.measure}:${ci.numeric.op}:${ci.numeric.value}:${ci.numeric.unit}` : 'none'}`);
    }
  }
  return [...parts.sort(), `judge:${JUDGE_VERSION}`].join('::');
}

const clauseMatchCache = new Map();

function buildClauseCandidates(criteria, planChecks) {
  const candidates = [];
  for (const criterion of criteria ?? []) {
    const measure = DecisionMeasures[criterion.measure];
    const label = measure?.label ?? criterion.measure;
    candidates.push({
      id: `criterion:${criterion.measure}`,
      type: 'criterion',
      text: `${criterion.clause || ''} ${label} ${criterion.measure}`.trim(),
      criterion,
      measure: criterion.measure,
      op: criterion.op,
      value: criterion.value,
    });
  }
  for (const check of planChecks ?? []) {
    candidates.push({
      id: `planCheck:${check.id}`,
      type: 'planCheck',
      text: `${check.label || ''} ${check.id}`.trim(),
      check,
    });
  }
  return candidates;
}

async function matchClausesToCandidates(checklist, context, embedder, router) {
  const fingerprint = context.fingerprint;
  if (!fingerprint) return new Map();
  if (clauseMatchCache.has(fingerprint)) return clauseMatchCache.get(fingerprint);

  const criteria = context.criteria ?? [];
  const row = context.row ?? null;
  const planChecks = row?.plan?.checks ?? [];

  const candidates = buildClauseCandidates(criteria, planChecks);
  if (!candidates.length) return new Map();

  const matchMap = new Map();
  const clauses = [...new Set(checklist.map((cluster) => cluster.clause))];

  for (const clause of clauses) {
    const query = clause;
    const result = await retrieveThenVerify({
      query,
      candidates: candidates.map((c) => ({ id: c.id, text: c.text })),
      embedder,
      router,
      prompt: matchPrompt('requirement clause'),
      task: 'checklist-clause-match',
      tier: 'fast',
    });
    if (result.picked) {
      const matched = candidates.find((c) => c.id === result.picked.id);
      if (matched) matchMap.set(clause, matched);
    }
  }

  clauseMatchCache.set(fingerprint, matchMap);
  return matchMap;
}

function answerFromMatch(match, row, context) {
  if (!match) return null;
  if (match.type === 'criterion') {
    const measure = DecisionMeasures[match.measure];
    const value = measure?.read(row, context.measures ?? {});
    if (value === undefined || value === null || !Number.isFinite(value)) return null;
    if (match.value === null || match.value === undefined) {
      return { answer: 'unknown', quote: `${match.measure}: to confirm`, derived: true };
    }
    const answer = compare(value, match.op, match.value) ? 'yes' : 'no';
    return { answer, quote: `${match.measure}: ${value} ${measure?.unit ?? ''}`, derived: true };
  }
  if (match.type === 'planCheck') {
    const ok = match.check.ok;
    if (ok === null || ok === undefined) return { answer: 'unknown', quote: `${match.check.id}: to confirm`, derived: true };
    return { answer: ok ? 'yes' : 'no', quote: `${match.check.id}: ${ok ? 'yes' : 'no'}`, derived: true };
  }
  return null;
}

function checklistPrompt({ question, guidance = '', expected = '' }) {
  const quoted = Boolean(process.env.FRL_QUOTED_CHECKS);
  const sys = 'You turn a research question into a checklist of yes/no questions about ONE delivered item. Each clause of the question produces items that test that single item. Answer with JSON only: {"items": [{"clause": "short phrase from the question naming the property", "question": "Does this <kind> ...?", "hard": true/false, "numeric": {"measure": "distanceKm|areaM2|coastKm|...", "op": "<=|>=|<|>", "value": 123, "unit": "km|m2|..."} | null}]}.\n\n- "clause" is a short phrase naming the property tested (e.g. "<property> is <value>", "within <distance> of <place>"), NOT the whole sentence.\n- "question" is a yes/no question about ONE item: "Does this <kind> ...?".\n- "hard" = true when the user stated it as a requirement (must have, required, up to, at least, within). Soft = preference (highest, best, prefer, ratio).\n- "numeric" is present only when the question asks for a measurable quantity that code can verify. Use only these measures: distanceKm (distance from the asked place), priceEur, coastKm, beachKm, lakeKm, workableMonths, comfortableMonths, optimalDays, hotDays, hottestC, coldestC, explorePoints, staysNearby, areaM2, realTrendVsEu. When the question gives no number, set value to null. Never invent a number.\n- DROP price limits (checked by the acceptance value range in any currency) and collection/count clauses ("at least N items", "up to M as trade-off", "list of X") — they are checked at acceptance level, not per item.\n- Each clause must yield at least one item. If a clause has no numeric measure, numeric is null and the question is qualitative.\n- The guidance field may add constraints; treat them as additional clauses.';
  const quoteRule = '\n- Each item also has "quote": the words of the question, expected result or guidance that state this condition, copied character for character; "" when no words of the user state it and the item is your own reading.\n- A request that each item states a value (its price, a fee, a size, a duration) is not a limit and is not dropped: it becomes the item "Does this <kind> page state its <value>?", hard, with the words that ask for it as "quote". Only a bound on that value (at most, under, at least) is left to the acceptance value range.';
  return [
    { role: 'system', content: quoted ? sys + quoteRule : sys },
    { role: 'user', content: 'Question: ' + question + (quoted && expected ? '\nExpected result: ' + expected : '') + (guidance ? '\nGuidance: ' + guidance : '') }
  ];
}

export function askedCounts(acceptance) {
  const bounds = new Set((acceptance?.valueRange ?? []).map(Number));
  const stated = (String(acceptance?.expected ?? '').match(/\d+/g) ?? []).map(Number).filter((n) => !bounds.has(n));
  return [...new Set([acceptance?.itemCount, ...stated].filter((n) => Number.isFinite(n) && n > 1))];
}

function statesCount(ci, counts) {
  if (ci.numeric?.measure) return false;
  const numbers = (`${ci.clause} ${ci.question}`.match(/\d+/g) ?? []).map(Number);
  return numbers.some((n) => counts.includes(n));
}

export function filterCountItems(clusters, counts) {
  if (!counts?.length) return clusters ?? null;
  return (clusters ?? [])
    .map((cluster) => ({ ...cluster, items: cluster.items.filter((ci) => !statesCount(ci, counts)) }))
    .filter((cluster) => cluster.items.length > 0);
}

export class ChecklistModeler {
  constructor({ router, samples = 3 } = {}) {
    this.router = router;
    this.samples = samples;
  }

  async build(question, guidance = '', expected = '') {
    const samples = await proposeChecklist({ router: this.router, question, guidance, samples: this.samples, expected });
    if (samples.length < 2) return null;
    return clusterChecklist(samples, { askerWords: [question, expected, guidance].join('\n') });
  }
}

export function kindCluster(kind) {
  const not = (kind.not ?? []).length ? ` and not ${kind.not.join(', ')}` : '';
  const kinds = isUmbrella(kind) ? `, of one of these kinds: ${kind.members.map((member) => member.label).join(', ')}` : '';
  if (kind.entity) {
    const options = [
      { letter: 'A', text: `one ${kind.label}${kinds}: a single business, on its own website or its own profile page, whatever range of goods it shows` },
      { letter: 'B', text: `a directory, list or search page of several businesses` },
      { letter: 'C', text: 'an article, guide, course, news or blog page' },
      { letter: 'D', text: `a wanted ad, or a business that is not ${kind.label}${not}` },
      { letter: 'E', text: 'something else' },
      { letter: 'U', text: 'cannot tell from these sentences' },
    ];
    return { clause: 'kind', options, items: [{ question: `Is this page one ${kind.label}${kinds}, a single business on its own site or profile (not a directory of several, an article, or a wanted ad${not})?`, hard: true, numeric: null }] };
  }
  const options = [
    { letter: 'A', text: `one ${kind.label}, offered as asked${kinds}` },
    { letter: 'B', text: `a part or an accessory of it${not}` },
    { letter: 'C', text: 'several items or a list' },
    { letter: 'D', text: 'a wanted ad or a service' },
    { letter: 'E', text: 'something else' },
    { letter: 'U', text: 'cannot tell from these sentences' },
  ];
  return { clause: 'kind', options, items: [{ question: `Is this page one ${kind.label} offered as asked${kinds} (not a part, accessory, wanted ad or list${not})?`, hard: true, numeric: null }] };
}

async function shownSpans(spans, query, embedder) {
  const lineCount = (list) => {
    const block = spansBlock(list, JUDGE_BLOCK_CHARS);
    return block ? block.split('\n').length : 0;
  };
  const opening = lineCount(spans);
  if (opening >= spans.length) return spans;
  const picked = await pickSpans(spans, query, embedder, opening);
  return picked.slice(0, lineCount(picked));
}

export class ChecklistJudge {
  constructor({ router, embedder = null } = {}) {
    this.router = router;
    this.embedder = embedder;
  }

  async complete(messages) {
    try {
      return await this.router.complete({ purpose: 'checklist', tier: 'fast', temperature: 0, messages });
    } catch {
      return null;
    }
  }

  async completeFull(messages) {
    try {
      return await this.router.complete({ purpose: 'checklist', tier: 'fast', temperature: 0, messages });
    } catch {
      return null;
    }
  }

  async answersFromPage(asked, spans) {
    const shown = spans.length ? await shownSpans(spans, asked.map((q) => q.question).join(' '), this.embedder) : [];
    if (!shown.length) return new Map();
    const reply = await this.complete(judgePrompt({ questions: asked, block: spansBlock(shown, JUDGE_BLOCK_CHARS) }));
    const validated = applyQuoteCheck(replyList(reply?.data), shown);
    return new Map(asked.flatMap((q) => {
      const found = validated.find((r) => shortIdOf(r) === q.short);
      return found ? [[q.short, found]] : [];
    }));
  }

  async judgeKind(spans, cluster) {
    const question = cluster.items[0];
    const check = { id: `${cluster.clause}|${question.question}`, answer: 'unknown', quote: '', hard: question.hard, clause: cluster.clause };
    const shown = await shownSpans(spans, question.question, this.embedder);
    if (!shown.length) return { ...check, provider: null };
    const reply = await this.completeFull(kindPrompt({ options: cluster.options, block: spansBlock(shown, JUDGE_BLOCK_CHARS) }));
    const letter = String(reply?.data?.kind ?? '').trim().toUpperCase();
    const answer = KIND_ANSWERS[letter] ?? 'unknown';
    const quote = answer === 'unknown' ? '' : quoteFromSpans(reply?.data?.span ?? reply?.data?.spans, shown);
    const provider = reply?.provider ?? null;
    return quote ? { ...check, answer, quote, option: letter, provider } : { ...check, provider };
  }

  async judgeKindAgain(pageText, kind, { value, unit = '', median = null, avoid = null, exclude = null } = {}) {
    const cluster = kindCluster(kind);
    const spans = this.router ? sentenceSpans(pageText, { limit: JUDGE_PAGE_CHARS }) : [];
    const shown = spans.length ? await shownSpans(spans, cluster.items[0].question, this.embedder) : [];
    if (!shown.length) return { answer: 'unknown', quote: '', tally: {} };
    const price = { value, unit, median };
    const first = exclude ?? (avoid ? [{ provider: avoid }] : []);
    const block = spansBlock(shown, JUDGE_BLOCK_CHARS);
    const closed = cluster.options.filter((option) => option.letter !== KIND_NONE);
    const extra = (data, hit) => {
      const answer = hit ? KIND_ANSWERS[hit.id] : 'unknown';
      const quote = answer === 'unknown' ? '' : quoteFromSpans(data?.span ?? data?.spans, shown);
      return { value: { answer: quote ? answer : 'unknown', quote } };
    };
    const result = await closedVote({ router: this.router, task: 'kind-second', tier: 'fast', options: closed.map((option) => ({ id: option.letter, text: option.text })), field: 'kind', none: KIND_NONE, seed: block, prompt: (options) => kindPrompt({ options: [...options, ...cluster.options.filter((option) => option.letter === KIND_NONE)], block, price }), extra, n: KIND_SECOND_VOTES, quorum: first.length ? 1 : 2, keyOf: (_id, more) => more.answer, avoid: avoid ? [avoid] : undefined, exclude: first });
    const voted = agreed(result)?.extra ?? null;
    return { answer: voted?.answer ?? 'unknown', quote: voted?.quote ?? '', tally: result.tally, ...(result.single ? { single: true } : {}) };
  }

  async judge(item, pageText, checklist, kind = null, context = {}) {
    const checks = [];
    const numericItems = [];
    const qualitativeItems = [];

    const decisionCriteria = Array.isArray(context) ? context : (context.criteria ?? []);
    const ctx = Array.isArray(context) ? {} : (context.measures ?? context.ctx ?? {});

    const measures = getMeasures();
    for (const cluster of checklist) {
      for (const ci of cluster.items) {
        const reading = measuredReading(item, ci.numeric, { measures, criteria: decisionCriteria, ctx });
        if (reading) {
          numericItems.push({ cluster, item: ci, ...reading });
        } else {
          qualitativeItems.push({ cluster, item: ci });
        }
      }
    }

    for (const { cluster, item: ci, value, measure } of numericItems) {
      const answer = compare(value, ci.numeric.op, ci.numeric.value) ? 'yes' : 'no';
      checks.push({ id: cluster.clause + '|' + ci.question, answer, quote: `${measure}: ${value} ${ci.numeric.unit}`, hard: ci.hard, clause: cluster.clause });
    }

    const matchContext = {
      criteria: decisionCriteria,
      measures: ctx,
      row: item,
      fingerprint: Array.isArray(context) ? checklistFingerprint(checklist) : (context.fingerprint ?? checklistFingerprint(checklist)),
    };
    const matchMap = await matchClausesToCandidates(checklist, matchContext, this.embedder, this.router);
    const remainingQualitative = [];
    for (const { cluster, item: ci } of qualitativeItems) {
      const match = matchMap.get(cluster.clause);
      const answer = answerFromMatch(match, context.row, context);
      if (answer) {
        checks.push({ id: cluster.clause + '|' + ci.question, answer: answer.answer, quote: answer.quote, hard: ci.hard, clause: cluster.clause, derived: answer.derived });
      } else {
        remainingQualitative.push({ cluster, item: ci });
      }
    }

    const questions = remainingQualitative.map(({ cluster, item: ci }, index) => ({ short: `q${index + 1}`, id: cluster.clause + '|' + ci.question, question: ci.question, hard: ci.hard, clause: cluster.clause }));
    const spans = this.router ? sentenceSpans(pageText, { limit: JUDGE_PAGE_CHARS }) : [];

    for (let at = 0; at < questions.length; at += JUDGE_QUESTIONS_PER_CALL) {
      const asked = questions.slice(at, at + JUDGE_QUESTIONS_PER_CALL);
      const answers = await this.answersFromPage(asked, spans);
      const missing = asked.filter((q) => !answers.has(q.short));
      if (missing.length) {
        for (const [short, found] of await this.answersFromPage(missing, spans)) answers.set(short, found);
      }
      for (const q of asked) {
        const found = answers.get(q.short);
        checks.push({ id: q.id, answer: found?.answer ?? 'unknown', quote: found?.quote ?? '', hard: q.hard, clause: q.clause });
      }
    }

    if (kind?.label) {
      const kindCheck = this.router ? await this.judgeKind(spans, kindCluster(kind)) : { id: `kind|${kindCluster(kind).items[0].question}`, answer: 'unknown', quote: '', hard: true, clause: 'kind' };
      checks.push(kindCheck);
    }

    return checks;
  }
}

export function judgePrompt({ questions, block }) {
  const answers = process.env.FRL_NO_MEANS_CONTRARY
    ? 'For each question answer "yes" when a sentence shows it is so, "no" only when a sentence shows it is not so (the page states the item lacks it, or states a different value, place or kind), and "unknown" when no sentence settles it: a page that does not mention it is "unknown", never "no". Give in "spans" the ids of the one or two sentences that show the answer.'
    : 'For each question answer "yes", "no" or "unknown", and give in "spans" the ids of the one or two sentences that show it.';
  const sys = `You are a strict judge of one item page. The page is shown as numbered sentences. ${answers} Never write the sentence itself. An answer without a sentence id is not counted, so answer "unknown" with empty "spans" when no sentence shows it. Answer with JSON only, one entry per question: {"answers":[{"id":"q1","answer":"yes|no|unknown","spans":["S12"]}]}`;
  const qText = questions.map((q) => `${q.short}: ${q.question}`).join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `Item page text:\n${block}\n\nQuestions:\n${qText}` },
  ];
}

export function kindPrompt({ options, block, price = null }) {
  const sys = `You are a strict judge of one item page. The page is shown as numbered sentences. Select the one option that says what this page offers, and give in "span" the id of the sentence that shows it. Never write the sentence itself.${price ? ' The price of this item is far below the usual price of such items: a low price alone proves nothing, so decide from what the sentences say is offered.' : ''} Answer with JSON only: {"kind":"<letter>","span":"S<n>"}`;
  const prices = price ? `\n\nPrice of this item: ${price.value} ${price.unit}`.trimEnd() + (price.median !== null && price.median !== undefined ? `\nMedian price of its comparable items: ${price.median} ${price.unit}`.trimEnd() : '') : '';
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `Item page text:\n${block}${prices}\n\nThis page offers:\n${options.map((option) => `${option.letter}) ${option.text}`).join('\n')}` },
  ];
}
