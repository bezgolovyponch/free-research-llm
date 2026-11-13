import fs from 'node:fs/promises';
import { bm25 } from './evidence.mjs';
import { plain } from './itemgate.mjs';
import { explorePoints } from './site.mjs';
import { GLAMPING_LOW_ENTRY, TIER_ORDER, areaM2, clausesOf, quoteFound } from './strategy.mjs';
import { ChecklistModeler, CHECKLIST_VERSION, clusterChecklist, proposeChecklist, checklistSummary } from './checklist.mjs';

export const DECISION_MODEL_VERSION = 3;
export const SAMPLES = 3;
export const SAMPLE_TEMPERATURE = 0.7;
export const CASES_RETRIEVED = 2;
export const CASES_KEPT = 200;
export const UTILITY_PRIOR = 0.5;
export const UTILITY_WEIGHT = 0.5;
export const UTILITY_RATE = 0.3;
export const OPS = ['<=', '>=', '<', '>'];

const finite = (n) => (Number.isFinite(Number(n)) && n !== null && n !== '' ? Number(n) : undefined);
const climateOf = (row) => (row.site?.climate?.cci ? row.site.climate : undefined);
const contentWords = (text) => new Set(plain(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 4));

export const MEASURES = {
  priceEur: { label: 'asking price', unit: 'EUR', read: (row) => finite(row.value) },
  areaM2: { label: 'land area', unit: 'm²', read: (row) => areaM2(row) ?? undefined },
  coastKm: { label: 'distance to the sea', unit: 'km', read: (row) => (row.site ? row.site.coastKm ?? Infinity : undefined) },
  beachKm: { label: 'distance to a beach', unit: 'km', read: (row) => (row.site ? row.site.beachKm ?? Infinity : undefined) },
  lakeKm: { label: 'distance to a named lake or reservoir', unit: 'km', read: (row) => (row.site ? (row.site.lakesNamed ? row.site.lakeKm ?? Infinity : Infinity) : undefined) },
  workableMonths: { label: 'camping months a year (Camping Climate Index above 3, acceptable or better, Ma 2021 Table 4; 2025 daily weather per 0.25° cell, Open-Meteo)', unit: 'months', read: (row) => climateOf(row)?.workable },
  comfortableMonths: { label: 'optimal camping months a year (Camping Climate Index ≥ 7)', unit: 'months', read: (row) => climateOf(row)?.comfortable },
  optimalDays: { label: 'optimal camping days a year (Camping Climate Index ≥ 7)', unit: 'days', read: (row) => climateOf(row)?.cci?.optimalDays ?? undefined },
  hotDays: { label: 'days a year above 34 °C', unit: 'days', read: (row) => climateOf(row)?.cci?.hotDays ?? undefined },
  hottestC: { label: 'hottest month average daily high', unit: '°C', read: (row) => climateOf(row)?.hottest },
  coldestC: { label: 'coldest month average daily low', unit: '°C', read: (row) => climateOf(row)?.coldest },
  explorePoints: { label: 'beaches, viewpoints, sights, reserves and trails within 15 km', unit: 'places', read: (row) => (row.site ? explorePoints(row.site) : undefined) },
  staysNearby: { label: 'campsites and lodging within 15 km', unit: 'places', read: (row) => (row.site ? (row.site.lodging ?? 0) + (row.site.campsites ?? 0) : undefined) },
  realTrendVsEu: { label: 'country real house-price trend minus the EU average', unit: 'points a year', read: (row, ctx) => {
    const hpi = ctx?.trends?.[row.countryCode]?.real ?? row.fit?.hpi;
    return finite(hpi) !== undefined && finite(ctx?.euHpi) !== undefined ? Math.round((hpi - ctx.euHpi) * 10) / 10 : undefined;
  } },
};

export function compare(value, op, limit) {
  if (op === '<=') return value <= limit;
  if (op === '>=') return value >= limit;
  if (op === '<') return value < limit;
  return value > limit;
}

const numbersIn = (text) => (String(text ?? '').match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => Number(n.replace(',', '.')));

export function quoteStates(text, quote, value) {
  if (!quote || value === null || value === undefined || !quoteFound(text, quote)) return false;
  return numbersIn(quote).some((n) => n === Number(value));
}

const NEED_KINDS = ['listings', 'knowledge', 'computed'];
const words = (text, max) => String(text ?? '').trim().slice(0, max);

export function normalizeSample(raw) {
  const needs = (Array.isArray(raw?.needs) ? raw.needs : []).map((n) => ({
    need: words(n?.need, 160),
    kind: NEED_KINDS.includes(n?.kind) ? n.kind : '',
    sources: (Array.isArray(n?.sources) ? n.sources : []).map((s) => words(s, 80)).filter(Boolean).slice(0, 4),
  })).filter((n) => n.need && n.kind).slice(0, 8);
  const criteria = (Array.isArray(raw?.criteria) ? raw.criteria : []).slice(0, 20).map((c) => ({
    clause: String(c?.clause ?? '').slice(0, 200),
    measure: String(c?.measure ?? ''),
    op: OPS.includes(c?.op) ? c.op : '',
    value: finite(c?.value) ?? null,
    quote: String(c?.quote ?? '').slice(0, 200),
  })).filter((c) => MEASURES[c.measure] && c.op);
  const terms = (Array.isArray(raw?.kind?.terms) ? raw.kind.terms : []).map((t) => plain(String(t)).trim()).filter((t) => t && t.length <= 30).slice(0, 30);
  const not = (Array.isArray(raw?.kind?.not) ? raw.kind.not : []).map((t) => plain(String(t)).trim()).filter((t) => t && t.length <= 40).slice(0, 40);
  return {
    concept: String(raw?.concept ?? '').slice(0, 300),
    purpose: words(raw?.purpose, 240),
    value: words(raw?.value, 240),
    needs,
    kind: { label: String(raw?.kind?.label ?? '').slice(0, 60), terms, not },
    criteria,
    unmodelled: (Array.isArray(raw?.unmodelled) ? raw.unmodelled : []).map((u) => String(u).slice(0, 200)).filter(Boolean).slice(0, 12),
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const NOT_A_CASE_LIMIT = new Set(['assumption', 'question', 'guidance']);

function fromCases(measure, op, cases, id = '') {
  for (const c of cases) {
    if (c.approved !== true || (id && c.id === id)) continue;
    const hit = (c.criteria ?? []).find((k) => k.measure === measure && k.op === op && k.value !== null && !NOT_A_CASE_LIMIT.has(k.source));
    if (hit) return { value: hit.value, source: `case ${c.id}${hit.source ? ` (${hit.source})` : ''}` };
  }
  return null;
}

export function aggregate(samples, { question = '', guidance = '', cases = [], id = '' } = {}) {
  const n = samples.length;
  const majority = Math.floor(n / 2) + 1;
  const said = `${question}\n${guidance}`;
  const groups = new Map();
  for (const sample of samples) {
    const seen = new Set();
    for (const c of sample.criteria) {
      const key = `${c.measure}|${c.op}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
  }
  const criteria = [];
  const noLimit = [];
  for (const [key, votes] of groups) {
    if (votes.length < majority) continue;
    const [measure, op] = key.split('|');
    const stated = votes.filter((v) => quoteStates(said, v.quote, v.value));
    const clause = votes.map((v) => v.clause).find(Boolean) ?? '';
    if (stated.length) {
      const value = median(stated.map((v) => v.value));
      const quote = stated.find((v) => v.value === value)?.quote ?? stated[0].quote;
      criteria.push({ id: measure, measure, op, value, source: quoteFound(question, quote) ? 'question' : 'guidance', quote, clause, votes: votes.length });
      continue;
    }
    const cased = fromCases(measure, op, cases, id);
    if (cased) criteria.push({ id: measure, measure, op, value: cased.value, source: cased.source, quote: '', clause, votes: votes.length });
    else noLimit.push({ measure, op, clause, votes: votes.length });
  }
  const termVotes = new Map();
  for (const sample of samples) for (const t of new Set(sample.kind.terms)) termVotes.set(t, (termVotes.get(t) ?? 0) + 1);
  const terms = [...termVotes].filter(([, v]) => v >= majority).map(([t]) => t);
  const notVotes = new Map();
  for (const sample of samples) for (const t of new Set(sample.kind.not ?? [])) notVotes.set(t, (notVotes.get(t) ?? 0) + 1);
  const not = [...notVotes].filter(([, v]) => v >= majority).map(([t]) => t);
  const labels = samples.map((s) => s.kind.label).filter(Boolean);
  const label = labels.sort((a, b) => labels.filter((x) => x === b).length - labels.filter((x) => x === a).length)[0] ?? '';
  const clauses = clausesOf(question).map((text) => ({ text, criteria: criteria.filter((c) => (c.quote && quoteFound(text, c.quote)) || (c.clause && quoteFound(text, c.clause)) || (c.clause && quoteFound(c.clause, text))).map((c) => c.id) }));
  const wanted = contentWords(said);
  let chosen = null;
  let purposeGrounded = 0;
  for (const sample of samples) {
    const overlap = [...contentWords(`${sample.purpose ?? ''} ${sample.value ?? ''}`)].filter((w) => wanted.has(w)).length;
    if (!chosen || overlap > purposeGrounded) {
      chosen = sample;
      purposeGrounded = overlap;
    }
  }
  const purpose = chosen?.purpose && chosen.value && purposeGrounded >= 2 && /so that/i.test(chosen.purpose) ? chosen.purpose : null;
  return {
    concept: samples.map((s) => s.concept).find(Boolean) ?? '',
    purpose,
    value: chosen?.value || null,
    needs: chosen?.needs ?? [],
    purposeGrounded,
    kind: terms.length ? { label: label || terms[0], terms, ...(not.length ? { not } : {}), verified: null } : null,
    criteria,
    noLimit,
    clauses,
    missing: clauses.filter((c) => !c.criteria.length).map((c) => c.text),
    agreement: { samples: n, majority, proposed: groups.size, kept: criteria.length + noLimit.length },
  };
}

export function verifyKind(kind, titles) {
  if (!kind?.terms?.length) return kind;
  const texts = titles.map((t) => plain(t));
  if (!texts.length) return { ...kind, verified: null };
  const has = (text, term) => new RegExp(`(?:^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:e?s)?(?![a-z])`).test(text);
  const terms = kind.terms.filter((term) => texts.some((text) => has(text, term)));
  const matched = texts.filter((text) => terms.some((term) => has(text, term))).length;
  return { ...kind, terms: terms.length ? terms : kind.terms, dropped: kind.terms.filter((t) => !terms.includes(t)), verified: { titles: texts.length, matched, share: Math.round((matched / texts.length) * 100) / 100 } };
}

const wordList = (text) => plain(text).split(/[^a-z0-9]+/).filter(Boolean);
const wordHit = (text, word) => {
  const term = plain(word).trim();
  if (!term) return false;
  if (/\s/.test(term)) return new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(plain(text));
  return wordList(text).some((w) => w === term || (term.length >= 4 && w.startsWith(term)));
};

export const MIN_EXCLUSION_LETTERS = 4;

export function calibrationPrompt({ kind, question = '', titles = [] }) {
  const listed = (titles ?? []).map((title) => `- ${title}`).join('\n');
  return [
    { role: 'system', content: `You calibrate the item kind of a listing search against real listing titles. The item is "${kind?.label ?? ''}"${kind?.terms?.length ? ` and the proposed title words for it are: ${kind.terms.join(', ')}` : ''}. Answer with JSON only: {"not": ["..."], "condition": ["..."], "upgrades": ["..."], "subtype": {"label": "...", "models": ["..."], "variants": ["..."]}}. "condition" lists words or short phrases, as written in the titles, that state the item is damaged, worn out, not working, crashed or sold for parts. "upgrades" lists words or short phrases, as written in the titles, that state something done to the item that usually adds value (a new inspection, a service, new parts, extra equipment). "variants" lists title words that mark a body variant of those models that is not the asked sub-type (for example estate, sedan, cabriolet or van words as written in the titles). "not" lists every single title word (one word each, as written in the titles, in their language) that marks a listing of something that is not the item itself: parts, wheels, tyres, lights, bumpers, doors, engines sold alone, accessories, services, wanted ads; list all such words you see, typically 10 to 30. "subtype" names the sub-type the question asks for in "label", and "models" lists every model or make+model name that appears in the given titles and is built as that sub-type (list all of them, not examples). Copy words exactly as they appear in the titles. Return "" for the label and [] for the models when the question asks for no sub-type or no title shows one.` },
    { role: 'user', content: `Question: ${question}\n\nListing titles:\n${listed}` },
  ];
}

export function mergeCalibrations(replies) {
  const datas = (replies ?? []).map((r) => (r?.data && typeof r.data === 'object' ? r.data : null)).filter(Boolean);
  const need = Math.max(1, Math.ceil(datas.length / 2));
  const voted = (pick) => {
    const votes = new Map();
    for (const d of datas) for (const w of new Set((pick(d) ?? []).map((x) => plain(String(x)).trim()).filter(Boolean))) votes.set(w, (votes.get(w) ?? 0) + 1);
    return [...votes].filter(([, n]) => n >= need).map(([w]) => w);
  };
  const labels = datas.map((d) => String(d.subtype?.label ?? '').trim()).filter(Boolean);
  const label = labels.sort((a, b) => labels.filter((x) => x === b).length - labels.filter((x) => x === a).length)[0] ?? '';
  return { data: { not: voted((d) => d.not), condition: voted((d) => d.condition), upgrades: voted((d) => d.upgrades), subtype: { label, models: voted((d) => d.subtype?.models), variants: voted((d) => d.subtype?.variants) } }, samples: datas.length };
}

export function applyCalibration(kind, reply, titles, { itemTitles = [] } = {}) {
  const data = reply?.data && typeof reply.data === 'object' ? reply.data : reply ?? {};
  const texts = (titles ?? []).map((title) => String(title ?? ''));
  const proposed = (Array.isArray(data.subtype?.models) ? data.subtype.models : []).map((model) => plain(String(model)).trim().split(/\s+/).filter(Boolean));
  const leads = (word, parts) => proposed.some((other) => other !== parts && other[0] === word);
  const not = [...new Set((Array.isArray(data.not) ? data.not : []).map((word) => plain(String(word)).trim()).filter((word) => word.length >= MIN_EXCLUSION_LETTERS && texts.filter((text) => wordHit(text, word)).length >= 2))];
  const variants = [...new Set((Array.isArray(data.subtype?.variants) ? data.subtype.variants : []).map((word) => plain(String(word)).trim()).filter((word) => word.length >= 2 && texts.some((text) => wordHit(text, word))))];
  const upgrades = [...new Set((Array.isArray(data.upgrades) ? data.upgrades : []).map((word) => plain(String(word)).trim()).filter((word) => word.length >= 3 && texts.some((text) => wordHit(text, word))))];
  const condition = [...new Set((Array.isArray(data.condition) ? data.condition : []).map((word) => plain(String(word)).trim()).filter((word) => word.length >= MIN_EXCLUSION_LETTERS && texts.some((text) => wordHit(text, word))))];
  const label = String(data.subtype?.label ?? '').trim();
  const forms = (parts) => (parts.length > 2 && !(leads(parts[1], parts) && !leads(parts[0], parts)) ? [parts.join(' '), parts.slice(0, 2).join(' ')] : [parts.join(' ')]);
  const models = [...new Set(proposed.flatMap(forms).filter((model) => model && texts.some((text) => wordHit(text, model))))];
  const items = (itemTitles ?? []).map((title) => String(title ?? '')).filter((title) => models.some((model) => wordHit(title, model)));
  const onItems = (word) => items.some((title) => wordHit(title, word));
  return {
    kind: { ...kind, not: [...new Set([...(kind?.not ?? []), ...not])].filter((word) => !onItems(word)), condition: [...new Set([...(kind?.condition ?? []), ...condition])], upgrades: [...new Set([...(kind?.upgrades ?? []), ...upgrades])] },
    subtype: models.length ? { label, models, variants, source: 'model proposal, matched to listing titles by code' } : null,
  };
}

export function decisionPrompt({ question, guidance = '', expected = '', examples = [] }) {
  const measures = Object.entries(MEASURES).map(([id, m]) => `- ${id}: ${m.label} (${m.unit})`).join('\n');
  const shots = examples.map((c) => `Question: ${c.question}\nModel: ${JSON.stringify({ concept: c.concept, kind: c.kind ? { label: c.kind.label, terms: c.kind.terms, not: c.kind.not ?? [] } : null, criteria: c.criteria.map(({ clause, measure, op, value, quote }) => ({ clause, measure, op, value, quote })) })}`).join('\n\n');
  return [
    { role: 'system', content: `You turn a research question into a decision model that code will measure on every listing. Code can measure only these quantities:\n${measures}\nFor each clause of the question that one of them can test, return a criterion {clause, measure, op (one of <=, >=, <, >), value, quote}. "quote" is the exact words of the question or guidance that state the limit, copied character for character; when the question gives no number, set value to null and quote to "". Never invent a number. Clauses no measure can test go into "unmodelled". "kind" is the item the user wants listed: a short label, the words (in English and in the languages of the named countries) that listing titles use for it, and "not", the words (in English and in the languages of the named countries, and of the countries around a named place) that listing titles use for things sold alongside the item that are not the item itself (parts, accessories, wanted ads, services).\n"purpose" is one sentence "<who> wants <outcome> so that <value>" in the user's own terms, naming the decision the result serves. "value" is one sentence naming the result worth having and how it is judged (for example "a shortlist of 20 hatchbacks within 300 km of Prague, each at or below 65,000 CZK and below the median price of its model and year"). "needs" is up to 8 items {"need": "...", "kind": "listings" | "knowledge" | "computed", "sources": ["a domain or a source type", up to 4]} where listings are read by code from portals, knowledge is researched by tree pieces, and computed is derived by code from the listings table. Answer with JSON only: {"concept": "...", "purpose": "...", "value": "...", "needs": [...], "kind": {"label": "...", "terms": ["..."], "not": ["..."]}, "criteria": [...], "unmodelled": ["..."]}` },
    { role: 'user', content: `${shots ? `Approved examples:\n${shots}\n\n` : ''}Question: ${question}${expected ? `\nExpected result: ${expected}` : ''}${guidance ? `\nGuidance: ${guidance}` : ''}` },
  ];
}

export function evaluateCriterion(row, criterion, ctx = {}) {
  const m = MEASURES[criterion.measure];
  const value = m?.read(row, ctx);
  const label = `${m?.label ?? criterion.measure} ${criterion.op} ${criterion.value} ${m?.unit ?? ''}`.trim();
  if (value === undefined) return { id: criterion.id, label, ok: null, detail: `${m?.label ?? criterion.measure} not measured yet` };
  const shown = value === Infinity ? 'beyond the measured range' : `${value} ${m.unit}`;
  return { id: criterion.id, label, ok: compare(value, criterion.op, criterion.value), detail: `${m.label}: ${shown}` };
}

export function planByModel(row, model, ctx = {}) {
  const checks = (model?.criteria ?? []).map((c) => evaluateCriterion(row, c, ctx));
  const failed = checks.filter((c) => c.ok === false);
  const unknown = checks.filter((c) => c.ok === null);
  const tier = failed.length ? 'weak' : unknown.length ? 'unverified' : 'fits';
  const verdict = tier === 'fits' ? 'fits every criterion' : tier === 'unverified' ? `to confirm: ${unknown.map((c) => c.detail).join('; ')}` : `does not fit: ${failed.map((c) => `${c.label} (${c.detail})`).join('; ')}`;
  const share = checks.length ? Math.round((checks.filter((c) => c.ok).length / checks.length) * 100) / 100 : 0;
  return { tier, verdict, checks, share, why: checks.filter((c) => c.ok).map((c) => c.detail), tradeoffs: failed.map((c) => `${c.label}: no (${c.detail})`), potential: [], risks: [] };
}

export function applyModel(candidates, model, { euHpi = candidates?.sites?.euHpi ?? null, trends = candidates?.sites?.trends ?? null } = {}) {
  if (!candidates || !model?.criteria?.length) return candidates;
  const ctx = { euHpi, trends };
  const rows = (candidates.kept ?? []).map((row) => ({ ...row, plan: planByModel(row, model, ctx) }));
  rows.sort((a, b) => TIER_ORDER[a.plan.tier] - TIER_ORDER[b.plan.tier] || b.plan.share - a.plan.share || (a.value ?? Infinity) - (b.value ?? Infinity));
  const tiers = Object.fromEntries(Object.keys(TIER_ORDER).map((t) => [t, rows.filter((r) => r.plan.tier === t).length]));
  return { ...candidates, kept: rows, keptCount: tiers.fits, tiers, decision: { concept: model.concept, criteria: model.criteria } };
}

const MODEL_RULES = { hottestC: ['maxHottest', '<='], workableMonths: ['minWorkableMonths', '>='], coastKm: ['ebikeKm', '<='] };

export function withModelRules(foundation, model) {
  if (!foundation || !model?.criteria?.length) return foundation;
  const rules = { ...foundation.rules };
  for (const c of model.criteria) {
    const [rule, op] = MODEL_RULES[c.measure] ?? [];
    if (!rule || op !== c.op || !['question', 'guidance'].includes(c.source)) continue;
    if (rules[rule]?.source === 'question' && c.source !== 'question') continue;
    rules[rule] = { ...rules[rule], value: c.value, source: c.source, quote: c.quote };
  }
  return { ...foundation, rules, model: { concept: model.concept, criteria: model.criteria, noLimit: model.noLimit, missing: model.missing, agreement: model.agreement } };
}

export function modelText(model) {
  if (!model) return '';
  const lines = [];
  lines.push(`Why: ${model.purpose || 'not stated clearly — pieces must not be researched until it is'}`);
  if (model.value) lines.push(`Value: ${model.value}`);
  if (model.needs?.length) lines.push(`Needs: ${model.needs.map((n) => `${n.need} (${n.kind}${n.sources?.length ? `: ${n.sources.join(', ')}` : ''})`).join('; ')}`);
  if (model.concept) lines.push(`Concept: ${model.concept}`);
  if (model.criteria?.length) lines.push(`Decision model (code measures each listing): ${model.criteria.map((c) => `${MEASURES[c.measure].label} ${c.op} ${c.value} ${MEASURES[c.measure].unit} (${c.source})`).join('; ')}`);
  if (model.noLimit?.length) lines.push(`Asked but no limit stated, so not checked: ${model.noLimit.map((c) => MEASURES[c.measure].label).join('; ')}`);
  if (model.missing?.length) lines.push(`Not modelled yet (no code check): ${model.missing.join('; ')}`);
  if (model.checklist?.length) {
    lines.push(`Checklist (each item judged on its own page):`);
    for (const cluster of model.checklist) {
      for (const item of cluster.items) {
        const hard = item.hard ? ' [hard]' : '';
        const numeric = item.numeric ? ` (${item.numeric.measure} ${item.numeric.op} ${item.numeric.value} ${item.numeric.unit})` : '';
        lines.push(`  - ${cluster.clause}: ${item.question}${hard}${numeric}`);
      }
    }
  }
  return lines.join('\n');
}

export const REFERENCE_CASE = {
  id: GLAMPING_LOW_ENTRY.id,
  question: 'Find appropriate plots to buy for glamping business, but also with the strong price increase trend, very low enterance investments, 20000EUR max, 10 month a year, mild climate to have Glampings so no air condition, nearby sea or the ocean accessible by ebike',
  concept: GLAMPING_LOW_ENTRY.label,
  kind: { label: 'plot of land', terms: ['land', 'plot', 'terreno', 'parcela', 'arsa', 'tarla'] },
  criteria: [
    { id: 'coastKm', measure: 'coastKm', op: '<=', value: GLAMPING_LOW_ENTRY.rules.ebikeKm.value, source: 'guidance', quote: 'about 20 km', clause: 'nearby sea or the ocean accessible by ebike' },
    { id: 'workableMonths', measure: 'workableMonths', op: '>=', value: GLAMPING_LOW_ENTRY.rules.minWorkableMonths.value, source: 'question', quote: '10 month a year', clause: '10 month a year' },
    { id: 'hottestC', measure: 'hottestC', op: '<=', value: GLAMPING_LOW_ENTRY.rules.maxHottest.value, source: 'assumption', quote: '', clause: 'mild climate to have Glampings so no air condition' },
    { id: 'priceEur', measure: 'priceEur', op: '<=', value: 20000, source: 'question', quote: '20000EUR max', clause: '20000EUR max' },
    { id: 'realTrendVsEu', measure: 'realTrendVsEu', op: '>', value: 0, source: GLAMPING_LOW_ENTRY.rules.trendAboveEu.source, quote: '', clause: 'strong price increase trend' },
  ],
  approved: true,
  utility: 1,
  uses: 0,
};

export function rankCases(question, cases, k = CASES_RETRIEVED, exclude = '') {
  const pool = cases.filter((c) => c.question && !(exclude && c.id === exclude));
  if (!pool.length) return [];
  const sims = bm25(pool.map((c) => c.question), question);
  const top = Math.max(...sims);
  if (top <= 0) return [];
  return pool.map((c, i) => ({ c, score: (1 - UTILITY_WEIGHT) * (sims[i] / top) + UTILITY_WEIGHT * (c.utility ?? UTILITY_PRIOR), sim: sims[i] }))
    .filter((x) => x.sim > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.c);
}

export class CaseBank {
  constructor({ file = '', now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.cases = [];
    this.loaded = !file;
    this.writing = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.cases = Array.isArray(parsed?.cases) ? parsed.cases : [];
    } catch {
      this.cases = [];
    }
    this.loaded = true;
    return this;
  }

  all() {
    return [REFERENCE_CASE, ...this.cases.filter((c) => c.id !== REFERENCE_CASE.id)];
  }

  async retrieve(question, k = CASES_RETRIEVED, exclude = '') {
    await this.load();
    return rankCases(question, this.all(), k, exclude);
  }

  async record(projectId, question, model) {
    await this.load();
    const existing = this.cases.find((c) => c.id === projectId);
    const entry = { id: projectId, question, concept: model.concept, kind: model.kind, criteria: model.criteria, approved: false, utility: existing?.utility ?? UTILITY_PRIOR, uses: existing?.uses ?? 0, at: this.now() };
    this.cases = [entry, ...this.cases.filter((c) => c.id !== projectId)].slice(0, CASES_KEPT);
    this.save();
    return entry;
  }

  async reward(ids, reward) {
    if (!Number.isFinite(reward) || !ids?.length) return;
    await this.load();
    for (const c of this.cases) {
      if (!ids.includes(c.id)) continue;
      c.utility = Math.round(((c.utility ?? UTILITY_PRIOR) + UTILITY_RATE * (reward - (c.utility ?? UTILITY_PRIOR))) * 1000) / 1000;
      c.uses = (c.uses ?? 0) + 1;
    }
    this.save();
  }

  save() {
    if (this.file) this.writing = this.writing.then(() => fs.writeFile(this.file, JSON.stringify({ cases: this.cases }))).catch(() => {});
  }
}

const MODEL_STATE = ['subtype', 'calibrated', 'calibratedOn'];
const KIND_STATE = ['condition', 'upgrades', 'verified', 'dropped', 'validated', 'hubs'];
const defined = (source, keys) => Object.fromEntries(keys.filter((key) => source?.[key] !== undefined && source[key] !== null).map((key) => [key, source[key]]));

function carried(before, model) {
  const was = before?.kind;
  if (!was || !model.kind || plain(was.label).trim() !== plain(model.kind.label).trim()) return model;
  const not = [...new Set([...(model.kind.not ?? []), ...(was.not ?? [])])];
  const terms = [...new Set([...(was.validated?.terms ?? []), ...model.kind.terms])];
  return { ...model, ...defined(before, MODEL_STATE), kind: { ...model.kind, terms, ...(not.length ? { not } : {}), ...defined(was, KIND_STATE) } };
}

export class DecisionModeler {
  constructor({ router, cases = null, samples = SAMPLES } = {}) {
    this.router = router;
    this.cases = cases;
    this.samples = samples;
    this.checklistModeler = new ChecklistModeler({ router, samples });
  }

  fresh(project) {
    const m = project.decisionModel;
    return Boolean(m && m.version === DECISION_MODEL_VERSION && m.question === project.question && m.guidance === String(project.guidance ?? '') && m.agreement?.samples >= 2);
  }

  async build(project, { force = false } = {}) {
    if (this.fresh(project) && !force) return project.decisionModel;
    const question = project.question;
    const guidance = String(project.guidance ?? '');
    const examples = this.cases ? await this.cases.retrieve(question, CASES_RETRIEVED, project.id) : [];
    const messages = decisionPrompt({ question, guidance, expected: project.acceptance?.expected ?? '', examples });
    const replies = await Promise.all(Array.from({ length: this.samples }, () => this.router.complete({ purpose: 'decision-model', tier: 'deep', temperature: SAMPLE_TEMPERATURE, messages }).catch(() => null)));
    const samples = replies.filter((r) => r?.data).map((r) => normalizeSample(r.data));
    if (samples.length < 2) return project.decisionModel ?? null;
    const model = aggregate(samples, { question, guidance, cases: examples, id: project.id });
    const checklist = await this.checklistModeler.build(question, guidance);
    project.decisionModel = { ...carried(project.decisionModel, model), version: DECISION_MODEL_VERSION, question, guidance, caseIds: examples.map((c) => c.id), providers: replies.filter(Boolean).map((r) => r.provider), at: new Date().toISOString(), checklist, checklistVersion: CHECKLIST_VERSION };
    if (this.cases) await this.cases.record(project.id, question, model);
    return project.decisionModel;
  }
}
