import { plain } from './itemgate.mjs';

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
