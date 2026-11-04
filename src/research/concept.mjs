import { plain } from './itemgate.mjs';

export const CONCEPT_QUERIES = 6;
export const CONCEPT_PAGES = 10;
export const CONCEPT_SAMPLES = 3;
export const MIN_PAGES = 2;
export const CONCEPT_MARKER = 'TASK=CONCEPT_CARD';

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  return [
    { role: 'system', content: 'You write web search queries that find real sellers of one kind of item. Answer with JSON only: {"queries": ["..."]}.' },
    { role: 'user', content: `Item: ${label}${terms ? ` (words sellers use: ${terms})` : ''}\nQuestion: ${question}\nWrite ${CONCEPT_QUERIES} queries that find pages of real sellers of this item: what they are called, what they sell and where they sell. Write at least one query in English and one in each of these languages: ${wanted.join(', ') || 'none'}. Every query names the item in the words sellers use.` },
  ];
}

export function conceptCardPrompt({ kind = {}, question = '', pages = [] }) {
  const shown = pages.map((page) => `[${page.id}] ${page.title}\n${String(page.text ?? '').slice(0, 1200)}`).join('\n\n');
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
  return { data: { terms: voted((data) => data.terms), not: voted((data) => data.not), hubs: voted((data) => data.hubs) }, samples: datas.length };
}

export function applyConceptCard(card, pages = []) {
  const texts = pages.map((page) => plain(`${page.title ?? ''} ${page.text ?? ''}`));
  const supported = (phrase) => texts.filter((text) => mentionsPhrase(text, phrase)).length >= MIN_PAGES;
  const terms = (card?.terms ?? []).map((value) => plain(String(value)).trim()).filter((value) => value && supported(value));
  const not = (card?.not ?? []).map((value) => plain(String(value)).trim()).filter((value) => value && supported(value));
  const hubs = (card?.hubs ?? []).map((value) => plain(String(value)).trim()).filter((value) => value && supported(value));
  return { terms: [...new Set(terms)], not: [...new Set(not)], hubs: [...new Set(hubs)], pages: pages.length };
}

export function conceptQueries(kind = {}, brief = {}, languages = ['English']) {
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

export function conceptPages(sources = []) {
  return sources.slice(0, CONCEPT_PAGES).map((source, i) => ({
    id: `P${i + 1}`,
    title: String(source.title ?? '').slice(0, 200),
    url: source.url ?? '',
    text: `${source.title ?? ''} ${source.snippet ?? ''} ${source.text ?? ''}`.slice(0, 4000),
  }));
}
