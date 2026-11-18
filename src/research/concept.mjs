import { plain } from './itemgate.mjs';
import { SAMPLE_TEMPERATURE, ask } from './semantic.mjs';

export const CONCEPT_QUERIES = 6;
export const CONCEPT_PAGES = 10;
export const CONCEPT_SAMPLES = 3;
export const MIN_PAGES = 2;
export const CONCEPT_MARKER = 'TASK=CONCEPT_CARD';
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 16;
export const UMBRELLA_QUERIES = 12;
export const UMBRELLA_PAGES = 24;

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isUmbrella(kind) {
  return (kind?.members?.length ?? 0) >= MIN_MEMBERS;
}

export function memberTerms(member) {
  const terms = (member?.terms ?? []).map((term) => plain(String(term ?? '')).trim()).filter(Boolean);
  const label = plain(String(member?.label ?? '')).trim();
  return [...new Set(terms.length ? terms : label ? [label] : [])];
}

export function sameMember(left, right) {
  const a = plain(String(left?.label ?? '')).trim();
  const b = plain(String(right?.label ?? '')).trim();
  if (a && a === b) return true;
  const terms = new Set(memberTerms(left));
  return memberTerms(right).some((term) => terms.has(term));
}

export function conceptQueryCount(kind) {
  return isUmbrella(kind) ? Math.min(UMBRELLA_QUERIES, Math.max(CONCEPT_QUERIES, kind.members.length)) : CONCEPT_QUERIES;
}

export function conceptPageLimit(kind) {
  return isUmbrella(kind) ? UMBRELLA_PAGES : CONCEPT_PAGES;
}

export function mentionsPhrase(text, phrase) {
  const value = plain(text);
  const key = plain(phrase).trim();
  if (!key) return false;
  if (/\s/.test(key)) return new RegExp(`(?:^|[^a-z0-9])${escapeRe(key)}(?![a-z0-9])`).test(value);
  return value.split(/[^a-z0-9]+/).some((word) => word === key || (key.length >= 4 && word.startsWith(key)));
}

export function conceptQueryPrompt({ kind = {}, question = '', languages = ['English'] }) {
  const label = kind.label ?? '';
  const terms = (kind.terms ?? []).join(', ');
  const wanted = [...new Set((languages ?? []).filter((language) => language && language !== 'English'))];
  if (isUmbrella(kind)) {
    const kinds = kind.members.map((member) => `- ${member.label}${memberTerms(member).length ? ` (words sellers use: ${memberTerms(member).join(', ')})` : ''}`).join('\n');
    return [
      { role: 'system', content: 'You write web search queries that find real sellers of the kinds of one category. Answer with JSON only: {"queries": ["..."]}.' },
      { role: 'user', content: `Category: ${label}\nKinds of the category:\n${kinds}\nQuestion: ${question}\nWrite ${conceptQueryCount(kind)} queries that find pages of real sellers of these kinds: what they are called, what they sell and where they sell. One kind per query, spread over as many kinds as the queries allow. Write at least one query in English and one in each of these languages: ${wanted.join(', ') || 'none'}. Every query names its kind in the words sellers use.` },
    ];
  }
  return [
    { role: 'system', content: 'You write web search queries that find real sellers of one kind of item. Answer with JSON only: {"queries": ["..."]}.' },
    { role: 'user', content: `Item: ${label}${terms ? ` (words sellers use: ${terms})` : ''}\nQuestion: ${question}\nWrite ${CONCEPT_QUERIES} queries that find pages of real sellers of this item: what they are called, what they sell and where they sell. Write at least one query in English and one in each of these languages: ${wanted.join(', ') || 'none'}. Every query names the item in the words sellers use.` },
  ];
}

export function conceptCardPrompt({ kind = {}, question = '', pages = [] }) {
  const shown = pages.map((page) => `[${page.id}] ${page.title}\n${String(page.text ?? '').slice(0, 1200)}`).join('\n\n');
  if (isUmbrella(kind)) {
    return [
      { role: 'system', content: 'You name the kinds of one category from real pages. Answer with JSON only: {"members": [{"label": "...", "terms": ["..."]}], "not": ["..."], "hubs": ["..."]}. "members" lists every kind of the category that the pages show a real seller of, each with the phrases those pages use for it; a kind the pages show that is not proposed below counts too. "not" lists the phrases that mark a near-miss kind of thing that is NOT in the category. "hubs" lists the countries the pages say such sellers are concentrated in, as the pages state them. Copy the phrases as the pages write them.' },
      { role: 'user', content: `${CONCEPT_MARKER}\nCategory asked: ${kind.label ?? ''}\nKinds proposed: ${kind.members.map((member) => member.label).join(', ')}\nQuestion: ${question}\n\nPages:\n${shown}` },
    ];
  }
  return [
    { role: 'system', content: 'You name one kind of item from real pages. Answer with JSON only: {"terms": ["..."], "not": ["..."], "hubs": ["..."]}. "terms" lists the phrases the pages that ARE the asked item use for it. "not" lists the phrases that mark a near-miss kind of thing that is NOT the asked item. "hubs" lists the countries the pages say such sellers are concentrated in, as the pages state them. Copy the phrases as the pages write them.' },
    { role: 'user', content: `${CONCEPT_MARKER}\nItem asked: ${kind.label ?? ''}${kind.terms?.length ? ` (first guess: ${kind.terms.join(', ')})` : ''}\nQuestion: ${question}\n\nPages:\n${shown}` },
  ];
}

export function mergeConceptCards(replies) {
  const datas = (replies ?? []).map((reply) => (reply?.data && typeof reply.data === 'object' ? reply.data : null)).filter(Boolean);
  const need = Math.max(1, Math.ceil(datas.length / 2));
  const voted = (pick) => {
    const votes = new Map();
    for (const data of datas) for (const phrase of new Set((pick(data) ?? []).map((value) => plain(String(value)).trim()).filter(Boolean))) votes.set(phrase, (votes.get(phrase) ?? 0) + 1);
    return [...votes].filter(([, count]) => count >= need).map(([phrase]) => phrase);
  };
  const memberVotes = new Map();
  for (const data of datas) {
    const seen = new Set();
    for (const member of Array.isArray(data.members) ? data.members : []) {
      const label = plain(String(member?.label ?? '')).trim();
      for (const phrase of memberTerms(member)) {
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        const entry = memberVotes.get(phrase) ?? { count: 0, label };
        entry.count += 1;
        memberVotes.set(phrase, entry);
      }
    }
  }
  const members = [];
  for (const [phrase, { count, label }] of memberVotes) {
    if (count < need) continue;
    const key = label || phrase;
    const member = members.find((m) => m.label === key);
    if (member) member.terms.push(phrase);
    else members.push({ label: key, terms: [phrase] });
  }
  return { data: { terms: voted((data) => data.terms), not: voted((data) => data.not), hubs: voted((data) => data.hubs), ...(members.length ? { members } : {}) }, samples: datas.length };
}

function pageSupport(pages) {
  const texts = pages.map((page) => plain(`${page.title ?? ''} ${page.text ?? ''}`));
  return (phrase) => texts.filter((text) => mentionsPhrase(text, phrase)).length >= MIN_PAGES;
}

function siteOf(page, index) {
  try {
    return new URL(String(page.url ?? '')).hostname.replace(/^www\./, '');
  } catch {
    return `page ${index}`;
  }
}

function sellerSupport(pages) {
  const sites = pages.map((page, index) => ({ site: siteOf(page, index), text: plain(`${page.title ?? ''} ${page.text ?? ''}`) }));
  return (phrase) => new Set(sites.filter((page) => mentionsPhrase(page.text, phrase)).map((page) => page.site)).size >= MIN_PAGES;
}

export function applyConceptCard(card, pages = []) {
  const supported = pageSupport(pages);
  const named = sellerSupport(pages);
  const terms = (card?.terms ?? []).map((value) => plain(String(value)).trim()).filter((value) => value && supported(value));
  const not = (card?.not ?? []).map((value) => plain(String(value)).trim()).filter((value) => value && supported(value));
  const hubs = (card?.hubs ?? []).map((value) => plain(String(value)).trim()).filter((value) => value && supported(value));
  const members = Array.isArray(card?.members) ? card.members.map((member) => ({ label: plain(String(member?.label ?? '')).trim(), terms: memberTerms(member).filter(named) })).filter((member) => member.label && member.terms.length) : null;
  return { terms: [...new Set(terms)], not: [...new Set(not)], hubs: [...new Set(hubs)], ...(members ? { members } : {}), pages: pages.length };
}

export function groundMembers(members = [], cardMembers = [], pages = []) {
  const supported = sellerSupport(pages);
  const grounded = (members ?? []).map((member) => ({ label: String(member?.label ?? '').trim(), terms: memberTerms(member), grounded: memberTerms(member).filter(supported) })).filter((member) => member.label);
  for (const found of cardMembers ?? []) {
    const terms = memberTerms(found);
    if (!terms.length) continue;
    const known = grounded.find((member) => sameMember(member, found));
    if (known) {
      known.terms = [...new Set([...known.terms, ...terms])];
      known.grounded = [...new Set([...known.grounded, ...terms])];
    } else if (grounded.length < MAX_MEMBERS) {
      grounded.push({ label: String(found.label ?? terms[0]).trim(), terms, grounded: terms });
    }
  }
  return grounded;
}

export function conceptQueries(kind = {}, brief = {}, languages = ['English']) {
  if (isUmbrella(kind)) {
    const perKind = kind.members.map((member) => {
      const terms = memberTerms(member);
      const head = plain(String(member.label ?? '')).trim() || terms[0];
      const second = terms.find((term) => term !== head) ?? '';
      return `${head} ${second}`.replace(/\s+/g, ' ').trim();
    });
    return [...new Set(perKind)].filter(Boolean).slice(0, conceptQueryCount(kind));
  }
  const label = plain(kind.label ?? '').trim();
  const terms = (kind.terms ?? []).map((term) => plain(String(term)).trim()).filter(Boolean);
  const head = label || terms[0] || '';
  const second = terms.find((term) => term !== head) ?? head;
  const queries = [];
  if (head) queries.push(`${head} ${second} supplier`);
  if (label) queries.push(`${label} b2b seller`);
  if (terms[0]) queries.push(`${terms[0]} ${terms[1] ?? 'wholesale'} wholesale`);
  for (const language of [...new Set(languages ?? [])].filter((language) => language && language !== 'English').slice(0, 2)) queries.push(`${label || head} ${language}`);
  return [...new Set(queries.map((query) => query.replace(/\s+/g, ' ').trim()))].filter(Boolean).slice(0, CONCEPT_QUERIES);
}

export function conceptPages(sources = [], limit = CONCEPT_PAGES) {
  return sources.slice(0, limit).map((source, i) => ({
    id: `P${i + 1}`,
    title: String(source.title ?? '').slice(0, 200),
    url: source.url ?? '',
    text: `${source.title ?? ''} ${source.snippet ?? ''} ${source.text ?? ''}`.slice(0, 4000),
  }));
}

export const CONCEPT_VERSION = 1;
export const FRAME_SAMPLES = 3;
export const FRAME_TASK = 'concept-frame';
export const FRAME_STAGE = 'purpose';
export const POPULATION = 'population';
export const CRITERION = 'criterion';
export const LIMIT = 'limit';
export const RANK = 'rank';
export const CONTEXT = 'context';
export const METHOD = 'method';
export const DEMOTING_ROLES = [RANK, CONTEXT, METHOD];
export const PIECE_MIN_WORDS = 2;
export const KIND_LABEL_CHARS = 80;
export const CRITERION_TEXT_CHARS = 200;
const FRAME_FIELDS = { concept: CRITERION, limits: LIMIT, ranks: RANK, context: CONTEXT, method: METHOD };
const ROLE_ORDER = [CRITERION, LIMIT, RANK, CONTEXT, METHOD];
const ASKED = [['question', 'Request'], ['expected', 'Expected result']];

const squeeze = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const folded = (text) => squeeze(text).toLowerCase();

export function spanIn(text, quote) {
  const wanted = folded(quote);
  if (!wanted) return null;
  const at = folded(text).indexOf(wanted);
  return at < 0 ? null : { at, end: at + wanted.length };
}

function located(quote, said) {
  for (const [source] of ASKED) {
    const span = spanIn(said[source], quote);
    if (span) return { source, ...span };
  }
  return null;
}

export function framePrompt({ question, expected = '' }) {
  const said = { question, expected };
  return [
    { role: 'system', content: 'You frame one request for a list of results the way a review protocol does (population, concept, context), in any language. Every "quote" is copied letter for letter from the request or its expected result. "population": the one thing each result is, the unit that is delivered: {"quote":"...","label":"at most 8 words"}. "concept": what every single result must be, have or offer to count, one entry per separate condition: {"quote":"...","text":"the condition in at most 16 words","examples":["..."]}; when the request names examples of something, the condition is the class those examples stand for, "examples" lists them as written in the quote, and a result with another member of that class meets it. "limits": conditions stated with a number: {"quote":"..."}. "ranks": words that ask for the most or the least of something across the results, which order the results: {"quote":"...","text":"..."}. "context": why the result is wanted and where it is used: {"quote":"...","text":"..."}. "method": words about how the results are to be researched or compared, which no single result can meet: {"quote":"...","text":"..."}. Leave no part of the request out. Answer with JSON only: {"population":{"quote":"...","label":"..."},"concept":[],"limits":[],"ranks":[],"context":[],"method":[]}.' },
    { role: 'user', content: ASKED.map(([source, label]) => (squeeze(said[source]) ? `${label}: ${squeeze(said[source])}` : '')).filter(Boolean).join('\n') },
  ];
}

export function frameSample(data, said) {
  const elements = [];
  const take = (role, entry) => {
    const quote = squeeze(entry?.quote);
    const span = located(quote, said);
    if (!span) return;
    const examples = [...new Set((Array.isArray(entry?.examples) ? entry.examples : []).map(squeeze).filter((example) => example && spanIn(quote, example)))];
    elements.push({ role, quote, text: squeeze(entry?.text ?? entry?.label).slice(0, CRITERION_TEXT_CHARS), examples, ...span });
  };
  if (data?.population) take(POPULATION, data.population);
  for (const [field, role] of Object.entries(FRAME_FIELDS)) for (const entry of Array.isArray(data?.[field]) ? data[field] : []) take(role, entry);
  return elements.length ? { value: elements } : { error: 'no "quote" was copied letter for letter from the request or its expected result' };
}

function overlaps(a, b) {
  if (a.source !== b.source) return false;
  const shared = Math.min(a.end, b.end) - Math.max(a.at, b.at);
  return shared > 0 && shared * 2 >= Math.min(a.end - a.at, b.end - b.at);
}

function clustersOf(samples, wanted) {
  const clusters = [];
  samples.forEach((elements, sample) => {
    for (const element of elements.filter(wanted)) {
      const touching = clusters.filter((cluster) => cluster.some((member) => overlaps(member, element)));
      const merged = [...touching.flat(), { ...element, sample }];
      for (const cluster of touching) clusters.splice(clusters.indexOf(cluster), 1);
      clusters.push(merged);
    }
  });
  return clusters;
}

const votersOf = (cluster) => new Set(cluster.map((member) => member.sample)).size;

function votedRole(cluster) {
  const voters = (role) => votersOf(cluster.filter((member) => member.role === role));
  const best = Math.max(...ROLE_ORDER.map(voters));
  const role = ROLE_ORDER.find((candidate) => voters(candidate) === best);
  return DEMOTING_ROLES.includes(role) && best < 2 ? CRITERION : role;
}

function settled(cluster, role) {
  const members = cluster.filter((member) => member.role === role);
  const pool = members.length ? members : cluster;
  const widest = [...pool].sort((a, b) => (b.end - b.at) - (a.end - a.at) || a.at - b.at)[0];
  const examples = [...new Map(pool.flatMap((member) => member.examples).map((example) => [folded(example), example])).values()];
  return { text: pool.map((member) => member.text).find(Boolean) || widest.quote, quote: widest.quote, source: widest.source, at: widest.at, end: widest.end, examples, samples: votersOf(cluster) };
}

function piecesOf(said) {
  const pieces = [];
  for (const [source] of ASKED) {
    for (const piece of String(said[source] ?? '').split(/,|;/).map(squeeze).filter((part) => part.split(' ').length >= PIECE_MIN_WORDS)) {
      const span = spanIn(said[source], piece);
      if (span) pieces.push({ source, quote: piece, ...span });
    }
  }
  return pieces;
}

function describedBy(head, said) {
  const pieces = String(said[head.source] ?? '').split(/,|;/).map(squeeze).filter(Boolean).map((piece) => ({ quote: piece, source: head.source, ...spanIn(said[head.source], piece) }));
  const around = pieces.find((piece) => piece.at <= head.at && piece.end >= head.end) ?? pieces.find((piece) => overlaps(piece, head));
  return (around?.quote ?? head.quote).slice(0, CRITERION_TEXT_CHARS);
}

const sourceRank = (element) => ASKED.findIndex(([source]) => source === element.source);
const inOrder = (a, b) => sourceRank(a) - sourceRank(b) || a.at - b.at;
const holds = (element, piece) => element.source === piece.source && element.at <= piece.at && element.end >= piece.end;

export function agreeFrames(samples, { question, expected = '' }) {
  const said = { question, expected };
  const population = clustersOf(samples, (element) => element.role === POPULATION).sort((a, b) => votersOf(b) - votersOf(a))[0];
  const byRole = Object.fromEntries(ROLE_ORDER.map((role) => [role, []]));
  const framed = [];
  for (const cluster of clustersOf(samples, (element) => element.role !== POPULATION)) {
    const role = votedRole(cluster);
    const element = settled(cluster, role);
    byRole[role].push(element);
    framed.push(element);
  }
  const head = population ? settled(population, POPULATION) : null;
  const covered = [...framed, ...(head ? [head] : [])];
  for (const piece of piecesOf(said)) {
    if (covered.some((element) => overlaps(element, piece) || holds(element, piece))) continue;
    byRole[CRITERION].push({ text: piece.quote.slice(0, CRITERION_TEXT_CHARS), quote: piece.quote, source: piece.source, at: piece.at, end: piece.end, examples: [], samples: 0, unframed: true });
  }
  const numbered = (role, prefix) => byRole[role].sort(inOrder).map((element, index) => ({ id: `${prefix}${index + 1}`, ...element }));
  return {
    version: CONCEPT_VERSION,
    question: String(question ?? ''),
    expected: String(expected ?? ''),
    samples: samples.length,
    population: head ? { label: head.text, quote: head.quote, source: head.source, samples: head.samples, described: describedBy(head, said) } : null,
    criteria: numbered(CRITERION, 'E'),
    limits: numbered(LIMIT, 'L'),
    ranks: numbered(RANK, 'R'),
    context: numbered(CONTEXT, 'X'),
    method: numbered(METHOD, 'M'),
  };
}

export async function frameConcept(ctx, { question, expected = '' }) {
  const said = { question, expected };
  const samples = [];
  for (let index = 0; index < FRAME_SAMPLES; index++) {
    const reply = await ask({ router: ctx.router, task: FRAME_TASK, tier: 'deep', temperature: SAMPLE_TEMPERATURE, messages: framePrompt(said), schema: (data) => frameSample(data, said), budget: ctx.budget, stage: FRAME_STAGE });
    if (reply) samples.push(reply.value);
  }
  return samples.length ? agreeFrames(samples, said) : null;
}

export function conceptOf(model) {
  if (!model?.requirements?.length && !model?.framing) return null;
  return { question: model.question ?? '', expected: model.expected ?? '', criteria: model.requirements ?? [], ...(model.framing ?? {}) };
}

export function conceptKindLabel(concept) {
  return squeeze(concept?.population?.quote).slice(0, KIND_LABEL_CHARS);
}

export function conceptDescribed(concept) {
  return squeeze(concept?.population?.described ?? concept?.population?.quote);
}

export function conceptExamples(concept) {
  return [...new Set((concept?.criteria ?? []).flatMap((criterion) => criterion.examples ?? []))];
}

export const ELIGIBILITY = 'eligibility';
export const APPRAISAL = 'appraisal';

export function criterionQuestion(criterion) {
  const examples = criterion.examples?.length ? ` The asker named ${criterion.examples.join(', ')} as examples; another member of the same class counts as well.` : '';
  return `Does this page show that the result meets this requirement of the request: "${criterion.text}"?${examples}`;
}

export function askedWithUnit(text, value, unit) {
  const wanted = folded(unit).replace(/[^\p{L}\p{Sc}%]/gu, '');
  if (!wanted || !Number.isFinite(Number(value))) return false;
  for (const match of String(text ?? '').matchAll(/\d+(?:[ .,]\d{3})*(?:[.,]\d+)?/g)) {
    const digits = match[0].replace(/[ .,](?=\d{3}(?:\D|$))/g, '').replace(',', '.');
    if (Number(digits) !== Number(value)) continue;
    const beside = folded(String(text).slice(match.index + match[0].length, match.index + match[0].length + 14)).match(/^\s*(\p{L}+|\p{Sc}|%)/u)?.[1] ?? '';
    if (beside && (beside.startsWith(wanted) || wanted.startsWith(beside))) return true;
  }
  return false;
}

export const ASKED_LIMIT = 'your words';

export function definedByHint(numeric, criteria, question) {
  const defining = (criteria ?? []).find((criterion) => criterion.source === 'guidance' && criterion.measure === numeric?.measure && criterion.op === numeric?.op && Number(criterion.value) === Number(numeric?.value) && squeeze(criterion.clause) && spanIn(question, criterion.clause));
  return defining ? `your hint "${squeeze(defining.quote)}", which defines "${squeeze(defining.clause)}" of your request` : '';
}

export function conceptChecklist(concept, checklist = null, { criteria = [] } = {}) {
  if (!concept?.criteria?.length) return checklist ?? null;
  const asked = `${concept.question}\n${concept.expected}`;
  const limitSource = (item) => {
    if (!item.hard || !item.numeric?.measure) return '';
    return askedWithUnit(asked, item.numeric.value, item.numeric.unit) ? ASKED_LIMIT : definedByHint(item.numeric, criteria, concept.question);
  };
  const eligibility = concept.criteria.map((criterion) => ({ clause: criterion.text, role: ELIGIBILITY, criterion: criterion.id, quote: criterion.quote, items: [{ clause: criterion.text, question: criterionQuestion(criterion), hard: true, criterion: criterion.id, examples: criterion.examples ?? [] }] }));
  const appraisal = (checklist ?? []).map((cluster) => ({ ...cluster, role: APPRAISAL, items: cluster.items.map((item) => {
    const source = limitSource(item);
    return { ...item, hard: Boolean(source), ...(source ? { limitSource: source } : {}) };
  }) }));
  return [...eligibility, ...appraisal];
}

export function conceptText(concept) {
  if (!concept) return '';
  const lines = [];
  if (concept.population) lines.push(`Each result is: ${concept.population.quote}`);
  for (const criterion of concept.criteria ?? []) lines.push(`[${criterion.id}] must: ${criterion.text}${criterion.examples?.length ? ` (the asker's examples of the class: ${criterion.examples.join(', ')}; a similar member counts)` : ''}`);
  for (const limit of concept.limits ?? []) lines.push(`[${limit.id}] limit: ${limit.quote}`);
  for (const rank of concept.ranks ?? []) lines.push(`[${rank.id}] ranks the eligible: ${rank.text}`);
  for (const entry of concept.context ?? []) lines.push(`Context: ${entry.text}`);
  return lines.join('\n');
}
