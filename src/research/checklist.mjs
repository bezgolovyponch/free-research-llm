import { isUmbrella } from './concept.mjs';
import { MAX_SPAN_CHARS, pickRanked, quoteFromSpans, sentenceSpans, spansBlock } from './spans.mjs';
import { agreeAcrossSamples, agreed, closedVote, familyProposals, matchPrompt } from './semantic.mjs';
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
export const JUDGE_VERSION = 7;
export const JUDGE_QUESTIONS_PER_CALL = 4;
export const JUDGE_BLOCK_CHARS = 6000;
export const JUDGE_PAGE_CHARS = 40000;
export const LOW_PRICE_REASON = 'priced far below comparable items: confirm it is the item itself';
export const KIND_ANSWERS = { A: 'yes', B: 'no', C: 'no', D: 'no', E: 'no', U: 'unknown' };
export const KIND_NONE = 'U';
export const SINGLE_KIND_OPINION = 'second opinion from one provider family only: not rejected, to confirm';
export const SINGLE_KIND_REASON ='priced far below comparable items, and only one independent judgement was available: confirm it is the item itself';

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

export const NO_CHECKLIST_ITEM = 'it holds no item with a "clause" and a "question"';

const checklistProposal = (data) => {
  const sample = normalizeSample(data);
  return sample.items.length ? { value: sample } : { error: NO_CHECKLIST_ITEM };
};

export async function proposeChecklist({ router, question, guidance = '', samples = 3 }) {
  const drawn = await familyProposals({ router, n: samples, tier: 'deep', purpose: 'checklist', temperature: 0.7, messages: checklistPrompt({ question, guidance }), schema: checklistProposal });
  return drawn.proposals.map((proposal) => proposal.value);
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
  })).filter((i) => i.clause && i.question);
  return { items };
}

export const CHECKLIST_MATCH_TASK = 'checklist-match';

export async function clusterChecklist(samples, { router, embedder = null } = {}) {
  const majority = Math.floor(samples.length / 2) + 1;
  const groups = await agreeAcrossSamples({ samples: samples.map((sample) => sample.items), textOf: (item) => item.question, minSamples: majority, embedder, router, prompt: matchPrompt('question about one result'), task: CHECKLIST_MATCH_TASK, keepUndecided: true });
  const clusters = [];

  for (const { items: group, undecided } of groups) {
    const questions = group.map((i) => i.question);
    const questionCounts = new Map();
    for (const q of questions) {
      questionCounts.set(q, (questionCounts.get(q) ?? 0) + 1);
    }
    const mostCommonQuestion = [...questionCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const hardCount = group.filter((i) => i.hard).length;
    const hard = hardCount >= majority;

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

    const clause = group[0].clause.toLowerCase().trim();
    clusters.push(undecided ? { clause, single: true, items: [{ clause, question: mostCommonQuestion, hard: false, numeric }] } : { clause, items: [{ clause, question: mostCommonQuestion, hard, numeric }] });
  }

  return clusters;
}

const OPS = ['<=', '>=', '<', '>'];

function getMeasures() {
  return adaptForChecklist(DecisionMeasures);
}

const finite = (raw) => (raw !== null && raw !== undefined && raw !== '' && typeof raw !== 'boolean' && Number.isFinite(Number(raw)) ? Number(raw) : undefined);

function finiteReading(measure, item, ctx) {
  return measure ? finite(measure.read(item ?? {}, ctx)) : undefined;
}

export function measuredReading(item, numeric, { measures = getMeasures(), criteria = [], ctx = {}, row = null, price = null } = {}) {
  if (!numeric?.measure || !numeric.op || numeric.value === null || numeric.value === undefined) return undefined;
  const source = row ?? item;
  const own = numeric.measure === PRICE_MEASURE && price ? finite(price(item ?? {}, numeric.unit)) : finiteReading(measures[numeric.measure], source, ctx);
  if (own !== undefined) return { value: own, measure: numeric.measure };
  for (const criterion of criteria ?? []) {
    if (!criterion?.measure || criterion.op !== numeric.op || criterion.value !== numeric.value) continue;
    const stated = finiteReading(measures[criterion.measure], source, ctx);
    if (stated !== undefined) return { value: stated, measure: criterion.measure };
  }
  return undefined;
}

export function measuredValue(item, numeric, options = {}) {
  return measuredReading(item, numeric, options)?.value;
}

function readingOptions(context = {}, measures = getMeasures()) {
  return { measures, criteria: context.criteria ?? [], ctx: context.measures ?? {}, row: context.row ?? null, price: context.price ?? null };
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

function checklistPrompt({ question, guidance = '' }) {
  const sys = 'You turn a research question into a checklist of yes/no questions about ONE delivered item. Each clause of the question produces items that test that single item. Answer with JSON only: {"items": [{"clause": "short phrase from the question naming the property", "question": "Does this <kind> ...?", "hard": true/false, "numeric": {"measure": "distanceKm|areaM2|coastKm|...", "op": "<=|>=|<|>", "value": 123, "unit": "km|m2|..."} | null}]}.\n\n- "clause" is a short phrase naming the property tested (e.g. "<property> is <value>", "within <distance> of <place>"), NOT the whole sentence.\n- "question" is a yes/no question about ONE item: "Does this <kind> ...?".\n- "hard" = true when the user stated it as a requirement (must have, required, up to, at least, within). Soft = preference (highest, best, prefer, ratio).\n- "numeric" is present only when the question asks for a measurable quantity that code can verify. Use only these measures: distanceKm (distance from the asked place), priceEur, coastKm, beachKm, lakeKm, workableMonths, comfortableMonths, optimalDays, hotDays, hottestC, coldestC, explorePoints, staysNearby, areaM2, realTrendVsEu. When the question gives no number, set value to null. Never invent a number.\n- DROP price limits (checked by the acceptance value range in any currency) and collection/count clauses ("at least N items", "up to M as trade-off", "list of X") — they are checked at acceptance level, not per item.\n- Each clause must yield at least one item. If a clause has no numeric measure, numeric is null and the question is qualitative.\n- The guidance field may add constraints; treat them as additional clauses.';
  return [
    { role: 'system', content: sys },
    { role: 'user', content: 'Question: ' + question + (guidance ? '\nGuidance: ' + guidance : '') }
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
  constructor({ router, samples = 3, embedder = null } = {}) {
    this.router = router;
    this.samples = samples;
    this.embedder = embedder;
  }

  async build(question, guidance = '') {
    const samples = await proposeChecklist({ router: this.router, question, guidance, samples: this.samples });
    if (!samples.length) return null;
    return samples.length === 1 ? singleChecklist(samples[0]) : clusterChecklist(samples, { router: this.router, embedder: this.embedder });
  }
}

export function singleChecklist(sample) {
  return (sample?.items ?? []).map((item) => {
    const clause = item.clause.toLowerCase().trim();
    return { clause, single: true, items: [{ clause, question: item.question, hard: false, numeric: item.numeric }] };
  });
}

export function askedKind(kind) {
  return String(kind?.label ?? '').trim() || String(kind?.asked ?? '').trim();
}

export function kindCluster(kind) {
  const label = askedKind(kind);
  const not = (kind.not ?? []).length ? ` and not ${kind.not.join(', ')}` : '';
  const others = (kind.not ?? []).length ? `, such as ${kind.not.join(', ')}` : '';
  const kinds = isUmbrella(kind) ? `, of one of these kinds: ${kind.members.map((member) => member.label).join(', ')}` : '';
  if (kind.entity) {
    const described = String(kind.described ?? '').trim();
    const examples = (kind.examples ?? []).length ? `; the asker's examples: ${kind.examples.join(', ')}, and similar ones count` : '';
    const offer = described ? `a single business that offers what the asker described ("${described}"${examples})${kinds}, on its own website or its own profile page` : `one ${label}${kinds}: a single business, on its own website or its own profile page`;
    const other = described ? 'a wanted ad, or a business that does not offer what the asker described' : `a wanted ad, or a business that is not ${label}`;
    const options = [
      { letter: 'A', text: offer },
      { letter: 'B', text: `a directory, list or search page of several businesses` },
      { letter: 'C', text: 'an article, guide, course, news or blog page' },
      { letter: 'D', text: other },
      { letter: 'E', text: `something else${others}` },
      { letter: 'U', text: 'cannot tell from these sentences' },
    ];
    const question = described ? `Is this page a single business that offers what the asker described ("${described}")${kinds}, on its own site or profile (not a directory of several, an article, or a wanted ad${not})?` : `Is this page one ${label}${kinds}, a single business on its own site or profile (not a directory of several, an article, or a wanted ad${not})?`;
    return { clause: 'kind', options, items: [{ question, hard: true, numeric: null }] };
  }
  const options = [
    { letter: 'A', text: `one ${label}, offered as asked${kinds}` },
    { letter: 'B', text: 'a part or an accessory of it' },
    { letter: 'C', text: 'several items or a list' },
    { letter: 'D', text: 'a wanted ad or a service' },
    { letter: 'E', text: `something else${others}` },
    { letter: 'U', text: 'cannot tell from these sentences' },
  ];
  const context = String(kind.described ?? '').trim();
  return { clause: 'kind', options, ...(context ? { context } : {}), items: [{ question: `Is this page one ${label} offered as asked${kinds} (not a part, accessory, wanted ad or list${not})?`, hard: true, numeric: null }] };
}

async function shownSpans(spans, query, embedder, always = []) {
  const lineCount = (list) => {
    const block = spansBlock([...always, ...list], JUDGE_BLOCK_CHARS);
    return block ? block.split('\n').length : 0;
  };
  const room = (list) => Math.max(0, lineCount(list) - always.length);
  const opening = room(spans);
  if (opening >= spans.length) return spans;
  const ranked = embedder ? await embedder.rank(query, spans.map((span) => span.text), opening, { capped: false }) : null;
  if (!ranked) return null;
  const picked = pickRanked(spans, ranked);
  return picked.slice(0, room(picked));
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

  async answersFromPage(asked, shown) {
    if (!shown.length) return { answers: new Map(), replied: true };
    const reply = await this.complete(judgePrompt({ questions: asked.map((q) => ({ short: q.short, question: q.asked ?? q.question })), block: spansBlock(shown, JUDGE_BLOCK_CHARS) }));
    const validated = applyQuoteCheck(replyList(reply?.data), shown);
    const by = { provider: reply?.provider ?? null, model: reply?.model ?? null };
    const answers = new Map(asked.flatMap((q) => {
      const found = validated.find((r) => shortIdOf(r) === q.short);
      return found ? [[q.short, { ...found, ...by }]] : [];
    }));
    return { answers, replied: Boolean(reply) };
  }

  async judgeKind(spans, cluster) {
    const question = cluster.items[0];
    const check = { id: `${cluster.clause}|${question.question}`, answer: 'unknown', quote: '', hard: question.hard, clause: cluster.clause };
    const shown = await shownSpans(spans, question.question, this.embedder);
    if (!shown) return { ...check, provider: null, notJudged: true, reason: NOT_RANKED_REASON };
    if (!shown.length) return { ...check, provider: null };
    const reply = await this.completeFull(kindPrompt({ options: cluster.options, block: spansBlock(shown, JUDGE_BLOCK_CHARS), context: cluster.context }));
    if (!reply) return { ...check, provider: null, notJudged: true, reason: NO_ANSWER_REASON };
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
    if (!shown?.length) return { answer: 'unknown', quote: '', tally: {} };
    const price = { value, unit, median };
    const first = exclude ?? (avoid ? [{ provider: avoid }] : []);
    const block = spansBlock(shown, JUDGE_BLOCK_CHARS);
    const closed = cluster.options.filter((option) => option.letter !== KIND_NONE);
    const extra = (data, hit) => {
      const answer = hit ? KIND_ANSWERS[hit.id] : 'unknown';
      const quote = answer === 'unknown' ? '' : quoteFromSpans(data?.span ?? data?.spans, shown);
      return { value: { answer: quote ? answer : 'unknown', quote } };
    };
    const result = await closedVote({ router: this.router, task: 'kind-second', tier: 'fast', options: closed.map((option) => ({ id: option.letter, text: option.text })), field: 'kind', none: KIND_NONE, seed: block, prompt: (options) => kindPrompt({ options: [...options, ...cluster.options.filter((option) => option.letter === KIND_NONE)], block, price, context: cluster.context }), extra, n: KIND_SECOND_VOTES, quorum: first.length ? 1 : 2, keyOf: (_id, more) => more.answer, avoid: avoid ? [avoid] : undefined, exclude: first });
    const voted = agreed(result)?.extra ?? null;
    return { answer: voted?.answer ?? 'unknown', quote: voted?.quote ?? '', tally: result.tally, ...(result.single ? { single: true } : {}) };
  }

  async confirm(question, shown, first) {
    const block = spansBlock(shown, JUDGE_BLOCK_CHARS);
    const extra = (data, hit) => ({ value: { quote: hit ? quoteFromSpans(data?.spans ?? data?.span, shown) : '' } });
    const ask = (avoid) => closedVote({ router: this.router, task: SECOND_TASK, tier: 'fast', options: SECOND_OPTIONS, field: 'answer', none: KIND_NONE, seed: `${question}|${block}`, prompt: (options) => confirmPrompt({ question, options, block }), extra, n: 1, quorum: 1, keyOf: (id, more) => (id && more.quote ? id : 'unknown'), avoid: avoid.length ? avoid : undefined, exclude: [{ provider: first.provider, model: first.model }] });
    const avoided = first.provider ? [first.provider] : [];
    let result = await ask(avoided);
    if (result.single) result = await ask([...new Set([...avoided, ...(result.repeats ?? []).map((reply) => reply.provider).filter(Boolean)])]);
    const voted = agreed(result);
    if (!voted) return { answer: null, quote: '' };
    return voted.id && voted.extra.quote ? { answer: voted.id, quote: voted.extra.quote } : { answer: 'unknown', quote: '' };
  }

  async settle(check, asked, shown, first) {
    const second = await this.confirm(asked, shown, first);
    if (second.answer === check.answer) return { ...check, second: { answer: second.answer, quote: second.quote } };
    if (second.answer === null) return { ...check, answer: 'unknown', quote: '', reason: SECOND_FAMILY_REASON, leaning: { answer: check.answer, quote: check.quote } };
    return { ...check, answer: 'unknown', quote: '', reason: SPLIT_REASON, split: { first: { answer: check.answer, quote: check.quote }, second: { answer: second.answer, quote: second.quote } } };
  }

  async confirmPending(checks, pageText, checklist, context = {}) {
    if (!(checks ?? []).some((check) => check.pending)) return checks;
    const facts = rowSentences(context.row);
    const pageSpans = this.router ? sentenceSpans(pageText, { limit: JUDGE_PAGE_CHARS }) : [];
    const items = new Map(checklist.flatMap((cluster) => cluster.items.map((ci) => [cluster.clause + '|' + ci.question, ci])));
    const settled = [];
    for (const check of checks) {
      const ci = check.pending ? items.get(check.id) : null;
      const picked = ci && pageSpans.length ? await shownSpans(pageSpans, criterionAsked(ci, context), this.embedder, facts) : null;
      if (!picked) {
        settled.push(check);
        continue;
      }
      const rest = Object.fromEntries(Object.entries(check).filter(([key]) => !PENDING_KEYS.has(key)));
      settled.push(await this.settle(rest, criterionAsked(ci, context), [...facts, ...picked], check.first ?? {}));
    }
    return settled;
  }

  async judge(item, pageText, checklist, kind = null, context = {}) {
    const checks = [];
    const toSettle = [];
    const numericItems = [];
    const qualitativeItems = [];

    const measures = getMeasures();
    for (const cluster of checklist) {
      for (const ci of cluster.items) {
        const reading = measuredReading(item, ci.numeric, readingOptions(context, measures));
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

    const facts = rowSentences(context.row);
    const pageSpans = this.router ? sentenceSpans(pageText, { limit: JUDGE_PAGE_CHARS }) : [];
    const kindCheck = kind?.label ? (this.router ? await this.judgeKind(pageSpans, kindCluster(kind)) : { id: `kind|${kindCluster(kind).items[0].question}`, answer: 'unknown', quote: '', hard: true, clause: 'kind' }) : null;
    const notKind = kindCheck?.answer === 'no';

    const questions = qualitativeItems.map(({ cluster, item: ci }, index) => ({ short: `q${index + 1}`, id: cluster.clause + '|' + ci.question, question: ci.question, asked: criterionAsked(ci, context), hard: ci.hard, clause: cluster.clause, criterion: ci.criterion ?? null }));

    for (let at = 0; at < questions.length; at += JUDGE_QUESTIONS_PER_CALL) {
      const asked = questions.slice(at, at + JUDGE_QUESTIONS_PER_CALL);
      if (notKind) {
        for (const q of asked) checks.push({ id: q.id, answer: 'unknown', quote: '', hard: q.hard, clause: q.clause, reason: NOT_KIND_REASON });
        continue;
      }
      const picked = pageSpans.length ? await shownSpans(pageSpans, asked.map((q) => q.asked).join(' '), this.embedder, facts) : [];
      if (!picked) {
        for (const q of asked) checks.push({ id: q.id, answer: 'unknown', quote: '', hard: q.hard, clause: q.clause, notJudged: true, reason: NOT_RANKED_REASON, ...(q.criterion ? { criterion: q.criterion } : {}) });
        continue;
      }
      const shown = [...facts, ...picked];
      const first = await this.answersFromPage(asked, shown);
      const answers = first.answers;
      let replied = first.replied;
      const missing = asked.filter((q) => !answers.has(q.short));
      if (missing.length) {
        const again = await this.answersFromPage(missing, shown);
        replied = replied || again.replied;
        for (const [short, found] of again.answers) answers.set(short, found);
      }
      for (const q of asked) {
        const found = answers.get(q.short);
        if (!found && !replied) {
          checks.push({ id: q.id, answer: 'unknown', quote: '', hard: q.hard, clause: q.clause, notJudged: true, reason: NO_ANSWER_REASON, ...(q.criterion ? { criterion: q.criterion } : {}) });
          continue;
        }
        const check = { id: q.id, answer: found?.answer ?? 'unknown', quote: found?.quote ?? '', hard: q.hard, clause: q.clause };
        if (!q.criterion || check.answer === 'unknown') {
          checks.push(q.criterion ? { ...check, criterion: q.criterion } : check);
          continue;
        }
        toSettle.push({ at: checks.push({ ...check, criterion: q.criterion }) - 1, asked: q.asked, shown, first: { provider: found.provider, model: found.model } });
      }
    }

    if (kindCheck) checks.push(kindCheck);

    for (const { at, asked, shown, first } of toSettle) {
      const check = checks[at];
      const decisive = check.answer === 'no' || checks.every((other, index) => index === at || !other.hard || other.answer === 'yes');
      checks[at] = decisive ? await this.settle(check, asked, shown, first) : { ...check, pending: true, reason: SECOND_PENDING_REASON, first };
    }

    return checks;
  }
}

export const NOT_RANKED_REASON = 'to confirm: the page is longer than one reading and no sentence ranking answered; it is judged again on the next check';
export const NO_ANSWER_REASON = 'to confirm: no provider answered this question; it is judged again on the next check';

export function notJudged(checks) {
  return (checks ?? []).some((check) => check.notJudged);
}

export const PRICE_MEASURE = 'priceEur';
export const SECOND_TASK = 'criterion-second';
export const SECOND_OPTIONS = [{ id: 'yes', text: 'the sentences show that the result meets the requirement' }, { id: 'no', text: 'the sentences show that the result does not meet it' }];
export const SECOND_FAMILY_REASON = 'one independent judgement only: to confirm';
export const SPLIT_REASON = 'two provider families read the page differently: to confirm';
export const SECOND_PENDING_REASON = 'one reading so far: a second provider family is asked once every other must-have of the item passes';
const PENDING_KEYS = new Set(['pending', 'reason', 'first']);
export const NOT_KIND_REASON = 'not asked: the page is not the asked kind';
export const ROW_SPAN = 'F';
export const ANCHORS_SHOWN = 12;
export const EVIDENCE_SHOWN = 3;

export function rowSentences(row) {
  if (!row) return [];
  const lines = [];
  const add = (label, value, unit = '') => {
    if (value !== null && value !== undefined && value !== '') lines.push(`${label}: ${value}${unit ? ` ${unit}` : ''}`);
  };
  add('Listing title', row.title);
  add('Asking price', row.price ?? row.value, row.currency ?? row.unit);
  add('Place', row.place);
  add('Country', row.country);
  add('Distance from the asked place', Number.isFinite(row.distanceKm) ? Math.round(row.distanceKm) : null, 'km');
  add('Area', row.area, row.areaUnit);
  add('Measured against the decision model', row.plan?.verdict);
  for (const reason of row.plan?.why ?? []) add('Measured', reason);
  return lines.map((text, index) => ({ id: `${ROW_SPAN}${index + 1}`, text: String(text).replace(/\s+/g, ' ').slice(0, MAX_SPAN_CHARS) }));
}

export function criterionAsked(ci, context = {}) {
  if (!ci.criterion) return ci.question;
  const members = (context.members ?? []).slice(0, ANCHORS_SHOWN);
  const evidence = (context.evidence?.[ci.criterion] ?? []).slice(0, EVIDENCE_SHOWN);
  const labels = (context.labels ?? []).filter((label) => label.criterion === ci.criterion);
  const counted = labels.filter((label) => label.label === 'yes').map((label) => label.title);
  const refused = labels.filter((label) => label.label === 'no').map((label) => label.title);
  return [
    ci.question,
    ci.examples?.length && members.length ? `Sources name these next to the asker's examples, as members of the same class: ${members.join(', ')}.` : '',
    evidence.length ? `Sources say the page of such a result shows it like this: ${evidence.map((entry) => `"${entry.quote}"`).join(' ')}` : '',
    counted.length ? `The asker counted these as meeting it: ${counted.join('; ')}.` : '',
    refused.length ? `The asker counted these as not meeting it: ${refused.join('; ')}.` : '',
  ].filter(Boolean).join(' ');
}

export function confirmPrompt({ question, options, block }) {
  return [
    { role: 'system', content: 'You are a strict judge of one item page, shown as numbered sentences. Select the one option that says what the sentences show about the requirement, and give in "spans" the ids of the one or two sentences that show it. Never write the sentence itself. Answer with JSON only: {"answer":"<letter>","spans":["S12"]}' },
    { role: 'user', content: `Item page text:\n${block}\n\nRequirement: ${question}\n\nThe sentences show:\n${options.map((option) => `${option.letter}) ${option.text}`).join('\n')}\n${KIND_NONE}) the sentences do not say` },
  ];
}

export function judgePrompt({ questions, block }) {
  const sys = 'You are a strict judge of one item page. The page is shown as numbered sentences. For each question answer "yes", "no" or "unknown", and give in "spans" the ids of the one or two sentences that show it. Never write the sentence itself. An answer without a sentence id is not counted, so answer "unknown" with empty "spans" when no sentence shows it. Answer with JSON only, one entry per question: {"answers":[{"id":"q1","answer":"yes|no|unknown","spans":["S12"]}]}';
  const qText = questions.map((q) => `${q.short}: ${q.question}`).join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `Item page text:\n${block}\n\nQuestions:\n${qText}` },
  ];
}

export function kindPrompt({ options, block, price = null, context = '' }) {
  const sys = `You are a strict judge of one item page. The page is shown as numbered sentences. Select the one option that says what this page offers, and give in "span" the id of the sentence that shows it. Never write the sentence itself.${price ? ' The price of this item is far below the usual price of such items: a low price alone proves nothing, so decide from what the sentences say is offered.' : ''} Answer with JSON only: {"kind":"<letter>","span":"S<n>"}`;
  const prices = price ? `\n\nPrice of this item: ${price.value} ${price.unit}`.trimEnd() + (price.median !== null && price.median !== undefined ? `\nMedian price of its comparable items: ${price.median} ${price.unit}`.trimEnd() : '') : '';
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `Item page text:\n${block}${prices}\n\n${context ? `The asker's request, for context only (what kind of thing the page offers is decided here; every other requirement is judged apart): "${context}"\n\n` : ''}This page offers:\n${options.map((option) => `${option.letter}) ${option.text}`).join('\n')}` },
  ];
}
