import { plain } from './itemgate.mjs';

export const DOMAIN_ASPECTS = ['object', 'process', 'actors', 'terms', 'quality', 'where', 'not', 'use'];

const SYSTEM = 'You are a domain mapper for research. You reply with a single JSON object only, no prose, no code fences.';

const MAX_STATEMENTS = 5;
const PAGE_TEXT_CHARS = 3000;
const SUPPORT_HOSTS = 2;
const OVERLAP = 0.5;

export function domainQueryPrompt({ question, purpose, languages = [], object = '', hint = '' } = {}) {
  const langs = (Array.isArray(languages) ? languages : [languages]).map((l) => String(l ?? '').trim()).filter(Boolean);
  const languageLine = langs.length ? langs.join(', ') : 'English';
  const objectLine = String(object ?? '').replace(/\s+/g, ' ').trim();
  const hintLine = String(hint ?? '').replace(/\s+/g, ' ').trim();
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `TASK=DOMAIN_QUERIES
Before any research is planned, learn how this domain works.

QUESTION:
${String(question ?? '').trim()}

PURPOSE:
${String(purpose ?? '').trim() || 'not stated'}

OBJECT TO STUDY:
${objectLine || 'not stated'}

USER HINT (starting vocabulary):
${hintLine || 'none'}

Write 6 to 8 web search queries, spread across these languages: ${languageLine}.
The queries must explain the TRADE and the practice around the object:
1. what the object is, in the words of the trade
2. how it is sourced, sorted, graded and packaged
3. how it is priced, sold and bought, and who the actors are
4. the words practitioners use: grades, units, packaging, trade jargon
5. what separates good quality from bad quality
6. where it is concentrated: producing regions, trade hubs, markets
7. look-alikes that are not the object, sold alongside it
8. typical use cases for this purpose

Never ask about the history of the brands or the products named in the question; study the trade around the object, not the story of a brand.
Start from the words of the USER HINT and the OBJECT TO STUDY: use them in the queries, and keep the trade words of the object in every query.
Every query is a plain web search query, names the object concretely, and reads like a practitioner or a trade site would search. No site: filters, no operators.
Answer with JSON only: {"queries": ["...", "...", "..."]}`,
    },
  ];
}

export function domainFindingsPrompt({ question, purpose, sources = [] } = {}) {
  const pages = (Array.isArray(sources) ? sources : []).map((source) => ({
    id: String(source?.id ?? ''),
    url: String(source?.url ?? ''),
    text: String(source?.text ?? '').slice(0, PAGE_TEXT_CHARS),
  }));
  const blocks = pages.map((page) => `PAGE ${page.id}
URL: ${page.url}
TEXT:
${page.text}`).join('\n\n');
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `TASK=DOMAIN_FINDINGS
Read only the pages below and extract what they actually say about the domain.

QUESTION:
${String(question ?? '').trim()}

PURPOSE:
${String(purpose ?? '').trim() || 'not stated'}

ASPECTS: ${DOMAIN_ASPECTS.join(', ')}

Every finding is one fact taken from one page:
{"aspect": one of ${DOMAIN_ASPECTS.join('|')}, "statement": "<= 20 words", "quote": "exact sentence copied from the page", "sourceId": "the page id"}

Rules: the quote is copied character for character from that page, never paraphrased; the statement says what the quote means in at most 20 words; use only the pages below, never outside knowledge; skip a page with nothing to say; cover every aspect the pages support.
Answer with JSON only: {"findings": [{"aspect": "...", "statement": "...", "quote": "...", "sourceId": "..."}]}

${blocks || 'NO PAGES'}`,
    },
  ];
}

function squash(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function normalized(text) {
  return plain(squash(text));
}

function hostOf(url) {
  try {
    return new URL(String(url ?? '')).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function sourceMap(sources) {
  const map = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source?.id) continue;
    map.set(String(source.id), { ...source, host: hostOf(source.url) });
  }
  return map;
}

export function verifiedFindings(findings, sources) {
  const map = sourceMap(sources);
  const kept = [];
  for (const finding of Array.isArray(findings) ? findings : []) {
    const aspect = String(finding?.aspect ?? '').trim();
    if (!DOMAIN_ASPECTS.includes(aspect)) continue;
    const quote = normalized(finding?.quote);
    if (!quote) continue;
    const source = map.get(String(finding?.sourceId ?? ''));
    if (!source) continue;
    if (!normalized(source.text).includes(quote)) continue;
    kept.push({
      aspect,
      statement: squash(finding?.statement),
      quote: squash(finding?.quote),
      sourceId: String(finding.sourceId),
      host: source.host,
    });
  }
  return kept;
}

export function mergeFindings(replies, sources) {
  const merged = [];
  const seen = new Set();
  for (const reply of Array.isArray(replies) ? replies : []) {
    for (const finding of verifiedFindings(reply?.data?.findings, sources)) {
      const key = `${finding.aspect}::${normalized(finding.quote)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(finding);
    }
  }
  return merged;
}

function wordSet(text) {
  return new Set(normalized(text).split(/[^a-z0-9]+/).filter(Boolean));
}

function overlapRatio(left, right) {
  const a = wordSet(left);
  const b = wordSet(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function sameQuote(left, right) {
  return normalized(left?.quote) === normalized(right?.quote);
}

function clustersOf(findings) {
  const clusters = [];
  for (const finding of findings) {
    let target = null;
    for (const cluster of clusters) {
      if (cluster.some((member) => sameQuote(member, finding) || overlapRatio(member.statement, finding.statement) >= OVERLAP)) {
        target = cluster;
        break;
      }
    }
    if (target) target.push(finding);
    else clusters.push([finding]);
  }
  return clusters;
}

function hostsOf(findings) {
  return [...new Set(findings.map((finding) => String(finding?.host ?? '')).filter(Boolean))];
}

function keyPhrase(statement) {
  const text = squash(statement).replace(/^(?:the|a|an)\s+/i, '').replace(/[.;,]+$/, '');
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function supportedPhrases(findings) {
  const phrases = [];
  for (const cluster of clustersOf(findings)) {
    if (hostsOf(cluster).length < SUPPORT_HOSTS) continue;
    const representative = cluster.reduce((best, member) => (hostsOf([member]).length > hostsOf([best]).length ? member : best), cluster[0]);
    const phrase = keyPhrase(representative.statement);
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
  }
  return phrases;
}

const HINT_MIN_CHARS = 4;
const HINT_MAX_TERMS = 8;
const HINT_STOPWORDS = new Set(['per', 'and', 'the', 'for', 'from', 'with', 'that', 'this', 'are', 'was', 'its', 'has', 'have', 'not', 'but', 'you', 'our', 'their', 'they', 'them', 'then', 'than', 'when', 'what', 'which', 'will', 'would', 'can', 'could', 'should', 'into', 'over', 'under', 'more', 'most', 'some', 'such', 'also', 'each', 'both', 'other', 'others', 'are', 'been', 'being', 'here', 'there', 'them', 'these', 'those']);

function termWords(text) {
  return normalized(text).split(/[^a-z0-9]+/).filter(Boolean);
}

function stemMatch(word, other) {
  if (word === other) return true;
  if (Math.min(word.length, other.length) < HINT_MIN_CHARS) return false;
  return word.startsWith(other) || other.startsWith(word);
}

function significantWords(text) {
  const raw = String(text ?? '').split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return raw.filter((word) => (word.length >= 3 && !HINT_STOPWORDS.has(word.toLowerCase())) || (word.length === 1 && word === word.toUpperCase() && /[a-z]/i.test(word))).map((word) => plain(word));
}

export function mentionsTerm(text, term) {
  const words = significantWords(term);
  if (!words.length) return false;
  const page = termWords(text);
  return words.every((word) => page.some((other) => stemMatch(word, other)));
}

export function hintCandidates(hint) {
  return String(hint ?? '')
    .split(/[,;:\n/]|\s+or\s+|\s+and\s+/i)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 3 && significantWords(part).length > 0);
}

export function supportedHintTerms(hint, sources = []) {
  const pages = (Array.isArray(sources) ? sources : []).map((source) => ({ host: hostOf(source?.url), text: `${source?.title ?? ''} ${source?.snippet ?? ''} ${source?.text ?? ''}` })).filter((page) => page.host);
  const terms = [];
  for (const candidate of hintCandidates(hint)) {
    const hosts = new Set(pages.filter((page) => mentionsTerm(page.text, candidate)).map((page) => page.host));
    if (hosts.size < SUPPORT_HOSTS) continue;
    if (!terms.includes(candidate)) terms.push(candidate);
    if (terms.length >= HINT_MAX_TERMS) break;
  }
  return terms;
}

export function domainUnderstanding(findings, { hint = '', sources = [] } = {}) {
  const list = Array.isArray(findings) ? findings.filter(Boolean) : [];
  const byAspect = (aspect) => list.filter((finding) => String(finding?.aspect ?? '') === aspect);
  const statements = (aspect) => byAspect(aspect).map((finding) => keyPhrase(finding.statement)).filter(Boolean).slice(0, MAX_STATEMENTS);
  const understanding = {
    terms: [...supportedHintTerms(hint, sources), ...supportedPhrases(byAspect('terms'))],
    not: supportedPhrases(byAspect('not')),
    where: supportedPhrases(byAspect('where')),
    process: statements('process'),
    quality: statements('quality'),
    actors: statements('actors'),
    use: statements('use'),
    object: statements('object'),
    hosts: hostsOf(list),
  };
  understanding.ready = understanding.object.length > 0 && understanding.terms.length > 0;
  return understanding;
}
