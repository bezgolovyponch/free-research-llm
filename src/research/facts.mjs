import fs from 'node:fs/promises';
import path from 'node:path';
import { pickSpans, quoteFromSpans, sentenceSpans, spansBlock } from './spans.mjs';
import { ask, idOf, oneOf, optionLines, retrieveThenVerify } from './semantic.mjs';
import { BLOCK_CHARS, PAGE_CHARS, RELEVANCE_SPANS, hostOf } from './scoping.mjs';

export const STAGE = 'evidence';
export const MAX_FACTS_PER_SOURCE = 6;
export const FACT_SPANS = 40;
export const MIN_HOST_HISTORY = 3;
export const NEAREST_CLAIMS = 3;
export const SCOPES = { A: 'the type in general', B: 'one single unit', C: 'a market figure such as a price or a trend' };
export const METHODS = { A: 'measured data with a stated sample', B: 'a named test', C: 'editorial', D: 'user reports', E: "the seller's own statement", F: 'cannot tell' };
export const APPLIES = ['A', 'B', 'C'];
export const SELLER_METHOD = 'E';

export function subjectKey(identity, levels) {
  return (levels ?? []).map((_, index) => identity?.fields?.[`L${index + 1}`]?.value ?? '').map((value) => String(value).trim());
}

export async function identify(ctx, { levels, text }) {
  const spans = sentenceSpans(text, { limit: PAGE_CHARS }).slice(0, FACT_SPANS);
  const block = spansBlock(spans, BLOCK_CHARS);
  const shown = spans.slice(0, block ? block.split('\n').length : 0);
  const names = levels.map((level, index) => ({ id: `L${index + 1}`, text: level }));
  if (!shown.length) return { fields: Object.fromEntries(names.map((name) => [name.id, null])), levels };
  const messages = [
    { role: 'system', content: 'You read one item page and identify the item at each listed level. For each level give the value as the page states it and the id of the sentence that states it, or null when the page does not state it. Answer with JSON only: {"fields":{"L1":{"value":"...","span":"S3"},"L2":null}}.' },
    { role: 'user', content: `Levels:\n${names.map((name) => `[${name.id}] ${name.text}`).join('\n')}\n\nSentences:\n${block}` },
  ];
  const schema = (data) => (data?.fields && typeof data.fields === 'object' ? { value: data.fields } : { error: '"fields" must be an object keyed by level id' });
  const reply = await ask({ router: ctx.router, task: 'identity', tier: 'fast', messages, schema, budget: ctx.budget, stage: STAGE });
  const fields = {};
  for (const name of names) {
    const entry = reply?.value?.[name.id];
    const quote = entry ? quoteFromSpans(entry.span, shown) : '';
    const value = String(entry?.value ?? '').trim().slice(0, 80);
    fields[name.id] = quote && value ? { level: name.text, value, quote } : null;
  }
  return { fields, levels };
}

export async function extractFacts(ctx, { questions, source }) {
  const spans = sentenceSpans(source.text ?? '', { limit: PAGE_CHARS }).slice(0, FACT_SPANS);
  const block = spansBlock(spans, BLOCK_CHARS);
  if (!block || !questions.length) return [];
  const shown = spans.slice(0, block.split('\n').length);
  const known = new Set(questions.map((question) => question.id));
  const messages = [
    { role: 'system', content: `You pick sentences that answer research questions. At most ${MAX_FACTS_PER_SOURCE} facts. Each fact: "spans" one or two sentence ids, "for" the id of the question it answers, "direction" + (speaks for the item), - (speaks against it) or 0 (neutral), "scope" ${Object.entries(SCOPES).map(([letter, text]) => `${letter} ${text}`).join(', ')}. Never write the sentence itself. Answer with JSON only: {"facts":[{"spans":["S7"],"for":"Q3","direction":"-","scope":"A"}]}.` },
    { role: 'user', content: `Questions:\n${questions.map((question) => `[${question.id}] ${question.q}`).join('\n')}\n\nSource: ${String(source.title ?? '').slice(0, 160)}\n\nSentences:\n${block}` },
  ];
  const schema = (data) => (Array.isArray(data?.facts) ? { value: data.facts.slice(0, MAX_FACTS_PER_SOURCE) } : { error: '"facts" must be a list' });
  const reply = await ask({ router: ctx.router, task: 'facts', tier: 'fast', messages, schema, budget: ctx.budget, stage: STAGE });
  const facts = [];
  for (const entry of reply?.value ?? []) {
    const quote = quoteFromSpans(entry?.spans, shown);
    const target = idOf(entry?.for, known);
    const direction = ['+', '-', '0'].includes(String(entry?.direction ?? '').trim()) ? String(entry.direction).trim() : null;
    const scope = oneOf(entry?.scope, Object.keys(SCOPES));
    if (quote && target && direction && scope) facts.push({ quote, for: target, direction, scope, url: source.url, host: hostOf(source.url) });
  }
  return facts;
}

export function subjectLadder(subject, kind) {
  const values = (subject ?? []).filter(Boolean);
  const exact = values.join(' ') || kind;
  const model = values.slice(0, Math.max(1, values.length - 1)).join(' ') || kind;
  return [
    { id: 'A', letter: 'A', text: `exactly this variant: ${exact}` },
    { id: 'B', letter: 'B', text: `${model} in every variant` },
    { id: 'C', letter: 'C', text: `the wider class: ${kind}` },
    { id: 'D', letter: 'D', text: 'a different variant or a different model' },
    { id: 'E', letter: 'E', text: 'one single unit, not the type' },
  ];
}

const subjectPrompt = ({ query, options, none }) => [
  { role: 'system', content: `You decide what a quoted statement is about, by meaning and in any language. Pick the one option that fits, or ${none} when the quote does not let you tell. Answer with JSON only: {"applies":"<letter>"}.` },
  { role: 'user', content: `Quote: ${query}\n\nThe statement is about:\n${optionLines(options, none, 'cannot tell')}` },
];

export async function matchSubject(ctx, fact, { subject, kind, cache = null }) {
  const cacheKey = `${fact.url}|${fact.quote}|${(subject ?? []).join('|')}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);
  const result = await retrieveThenVerify({ query: fact.quote, candidates: subjectLadder(subject, kind), fixed: true, none: 'U', field: 'applies', router: ctx.router, prompt: subjectPrompt, keyOf: (id) => id ?? 'U', task: 'subject-match', budget: ctx.budget, stage: STAGE });
  const level = result.picked?.id ?? null;
  const verdict = APPLIES.includes(level) ? { applies: true, level, tally: result.tally } : { applies: false, level: level ?? (result.none ? 'U' : null), tally: result.tally, ...(result.single ? { single: true } : {}) };
  cache?.set(cacheKey, verdict);
  return verdict;
}

export const CLAIM_OPTIONS = [{ id: 'A', text: 'they make the same claim and agree' }, { id: 'B', text: 'they make the same claim and contradict each other' }, { id: 'C', text: 'they make different claims' }];

const claimPrompt = ({ query, candidate, options }) => [
  { role: 'system', content: 'You compare two quoted statements from different sources, by meaning and in any language. Pick the one option that fits. Answer with JSON only: {"relation":"<letter>"}.' },
  { role: 'user', content: `Statement 1: ${query}\nStatement 2: ${candidate.text}\n\nThe two statements:\n${optionLines(options, null)}` },
];

export async function clusterClaims(ctx, facts) {
  const parent = facts.map((_, index) => index);
  const find = (index) => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  const edges = [];
  const judged = new Set();
  for (const [index, fact] of facts.entries()) {
    const others = facts.map((other, at) => ({ other, at })).filter(({ other, at }) => at !== index && other.for === fact.for && other.host !== fact.host && other.quote !== fact.quote && !judged.has([index, at].sort().join('|')));
    if (!others.length) continue;
    const result = await retrieveThenVerify({ query: fact.quote, candidates: others.map(({ other, at }) => ({ id: at, text: other.quote })), k: NEAREST_CLAIMS, pairwise: true, embedder: ctx.embedder, router: ctx.router, options: CLAIM_OPTIONS, field: 'relation', prompt: claimPrompt, task: 'claim-pair', budget: ctx.budget, stage: STAGE });
    for (const pair of result.pairs) {
      judged.add([index, pair.candidate.id].sort().join('|'));
      if (pair.value !== 'A' && pair.value !== 'B') continue;
      edges.push({ a: index, b: pair.candidate.id, agree: pair.value === 'A' });
      parent[find(index)] = find(pair.candidate.id);
    }
  }
  for (const [index, fact] of facts.entries()) for (const [at, other] of facts.entries()) if (at > index && other.quote === fact.quote && other.for === fact.for) {
    edges.push({ a: index, b: at, agree: true, copy: true });
    parent[find(index)] = find(at);
  }
  return { clusterOf: facts.map((_, index) => find(index)), edges };
}

function sides(count, edges) {
  const side = new Array(count).fill(null);
  const links = new Map();
  for (const edge of edges) {
    links.set(edge.a, [...(links.get(edge.a) ?? []), { to: edge.b, agree: edge.agree }]);
    links.set(edge.b, [...(links.get(edge.b) ?? []), { to: edge.a, agree: edge.agree }]);
  }
  for (let start = 0; start < count; start++) {
    if (side[start] !== null) continue;
    side[start] = 1;
    const queue = [start];
    while (queue.length) {
      const at = queue.shift();
      for (const link of links.get(at) ?? []) {
        if (side[link.to] !== null) continue;
        side[link.to] = link.agree ? side[at] : -side[at];
        queue.push(link.to);
      }
    }
  }
  return side;
}

export function credibilityOf(agree, against, alone) {
  if (alone) return 6;
  if (against === 0) return agree >= 2 ? 1 : agree === 1 ? 2 : 6;
  if (agree >= 1) return 3;
  return against >= 2 ? 5 : 4;
}

export function reliabilityOf(record) {
  if (!record || (record.total ?? 0) < MIN_HOST_HISTORY) return 'F';
  const share = record.confirmed / record.total;
  return share >= 0.9 ? 'A' : share >= 0.75 ? 'B' : share >= 0.6 ? 'C' : share >= 0.4 ? 'D' : 'E';
}

export function gradeFacts(facts, { clusterOf = [], edges = [] } = {}, hostBook = {}) {
  const side = sides(facts.length, edges);
  const home = (index) => clusterOf[index] ?? index;
  const graded = facts.map((fact, index) => {
    const hosts = { agree: new Set(), against: new Set() };
    const quotes = new Set([fact.quote]);
    for (const [at, other] of facts.entries()) {
      if (at === index || home(at) !== home(index) || other.host === fact.host || quotes.has(other.quote)) continue;
      quotes.add(other.quote);
      const agrees = side[at] === side[index];
      if (agrees && hostBook[other.host]?.method === SELLER_METHOD) continue;
      hosts[agrees ? 'agree' : 'against'].add(other.host);
    }
    const agree = hosts.agree.size;
    const against = hosts.against.size;
    const credibility = credibilityOf(agree, against, agree + against === 0);
    const reliability = reliabilityOf(hostBook[fact.host]);
    return { ...fact, cluster: home(index), credibility, reliability, admiralty: `${reliability}${credibility}`, agreeingHosts: [...hosts.agree], contradictingHosts: [...hosts.against] };
  });
  const book = Object.fromEntries(Object.entries(hostBook).map(([host, record]) => [host, { ...record }]));
  for (const fact of graded) {
    if (fact.credibility === 6) continue;
    const record = book[fact.host] ?? { confirmed: 0, contradicted: 0, total: 0 };
    record.total = (record.total ?? 0) + 1;
    if (fact.credibility <= 2) record.confirmed = (record.confirmed ?? 0) + 1;
    if (fact.credibility >= 4) record.contradicted = (record.contradicted ?? 0) + 1;
    book[fact.host] = record;
  }
  return { graded, hostBook: book };
}

export async function sourceMethod(ctx, source) {
  const spans = sentenceSpans(source.text ?? '', { limit: PAGE_CHARS });
  const shown = await pickSpans(spans, String(source.title ?? ''), ctx.embedder, RELEVANCE_SPANS);
  if (!shown.length) return null;
  const messages = [
    { role: 'system', content: `You classify how a source knows what it says. "method": ${Object.entries(METHODS).map(([letter, text]) => `${letter} ${text}`).join(', ')}. "span": the id of the sentence that shows it. Answer with JSON only: {"method":"A|B|C|D|E|F","span":"S<n>"}.` },
    { role: 'user', content: `Source: ${String(source.title ?? '').slice(0, 160)}\n\nSentences:\n${spansBlock(shown, BLOCK_CHARS)}` },
  ];
  const schema = (data) => {
    const method = oneOf(data?.method, Object.keys(METHODS));
    return method ? { value: { method, span: data?.span ?? null } } : { error: '"method" must be one of A, B, C, D, E, F' };
  };
  const reply = await ask({ router: ctx.router, task: 'source-method', tier: 'fast', messages, schema, budget: ctx.budget, stage: STAGE });
  if (!reply) return null;
  const quote = quoteFromSpans(reply.value.span, shown);
  return quote ? { method: reply.value.method, quote } : { method: 'F', quote: '' };
}

export class HostBook {
  constructor({ file = null } = {}) {
    this.file = file;
    this.records = {};
  }

  async load() {
    if (this.file) this.records = await fs.readFile(this.file, 'utf8').then(JSON.parse).catch(() => ({}));
    return this.records;
  }

  has(host) {
    return Boolean(this.records[host]?.method);
  }

  setMethod(host, method) {
    if (!method) return;
    this.records[host] = { confirmed: 0, contradicted: 0, total: 0, ...this.records[host], method: method.method, quote: method.quote };
  }

  absorb(book) {
    for (const [host, record] of Object.entries(book)) this.records[host] = { ...this.records[host], ...record };
  }

  async save() {
    if (!this.file) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.records, null, 1));
  }
}

export async function gatherEvidence(ctx, { questions, sources, subject, kind, hosts = new HostBook(), matchCache = new Map() }) {
  const extracted = [];
  for (const source of sources ?? []) {
    const host = hostOf(source.url);
    if (!hosts.has(host)) hosts.setMethod(host, await sourceMethod(ctx, source));
    extracted.push(...(await extractFacts(ctx, { questions, source })));
  }
  const typeFacts = [];
  const notApplicable = [];
  for (const fact of extracted) {
    if (fact.scope !== 'A') {
      notApplicable.push({ ...fact, reason: `scope ${fact.scope}: ${SCOPES[fact.scope]}` });
      continue;
    }
    const match = await matchSubject(ctx, fact, { subject, kind, cache: matchCache });
    if (match.applies) typeFacts.push({ ...fact, level: match.level });
    else notApplicable.push({ ...fact, reason: match.level ? `subject ${match.level}` : 'no majority on the subject', tally: match.tally });
  }
  const clusters = await clusterClaims(ctx, typeFacts);
  const { graded, hostBook } = gradeFacts(typeFacts, clusters, hosts.records);
  hosts.absorb(hostBook);
  return { facts: graded.map((fact, index) => ({ id: `F${index + 1}`, ...fact })), notApplicable, clusters: clusters.edges, at: new Date().toISOString() };
}
