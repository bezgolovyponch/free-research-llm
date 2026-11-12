import { plain } from './itemgate.mjs';
import { regionVerdict } from './brief.mjs';
const CURRENCIES = {
  EUR: ['€', 'eur', 'euro'],
  PLN: ['zł', 'zl', 'pln'],
  CZK: ['kč', 'kc', 'czk'],
  USD: ['$', 'usd'],
  GBP: ['£', 'gbp'],
  TRY: ['₺', 'tl', 'try'],
  VND: ['₫', 'vnd', 'vnđ'],
};
const CURRENCY_TOKEN = '(€|eur|euro|zł|zl|pln|kč|kc|czk|\\$|usd|£|gbp|₺|(?<![a-z])tl(?![a-z])|₫|vnđ|vnd)';
const NUMBER_TOKEN = '(?<![A-Za-z\\d.,])(\\d{1,3}(?:[ .,\\u00a0\\u202f]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
const SCALE_TOKEN = '(?:[ \\u00a0\\u202f]?(thousand|k|million|mil|mln|mn|milyon|triệu|trieu|billion|bn|bln|milyar|tỷ|ty|b)(?![a-zà-ỹ²\\d]))?';
const LOCAL_SCALE_TOKEN = '[ \\u00a0\\u202f]?(tỷ|triệu)(?![a-zà-ỹ])';
const AMOUNT = new RegExp(`${CURRENCY_TOKEN}[ \\u00a0\\u202f]?${NUMBER_TOKEN}${SCALE_TOKEN}|${NUMBER_TOKEN}${SCALE_TOKEN}[ \\u00a0\\u202f]?(?:,-[ \\u00a0\\u202f]?)?${CURRENCY_TOKEN}|${NUMBER_TOKEN}${LOCAL_SCALE_TOKEN}`, 'gi');
const SCALES = { thousand: 1e3, k: 1e3, million: 1e6, mil: 1e6, mln: 1e6, mn: 1e6, milyon: 1e6, 'triệu': 1e6, trieu: 1e6, billion: 1e9, bn: 1e9, bln: 1e9, milyar: 1e9, 'tỷ': 1e9, ty: 1e9, b: 1e9 };
export const MAX_ITEM_CHECKS = 100;
export const PAGE_READS_AT_ONCE = 6;
const MIN_LIVE_TEXT = 200;

function text(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function currencyOfWord(word) {
  return Object.keys(CURRENCIES).find((code) => code.toLowerCase() === word || CURRENCIES[code].includes(word)) ?? '';
}

export function currencyOf(token) {
  const t = String(token ?? '').toLowerCase().trim();
  return currencyOfWord(t) || t.split(/[\s,;/()]+/).map(currencyOfWord).find(Boolean) || '';
}

export function toAmount(raw) {
  const cleaned = String(raw).replace(/[\s  ]/g, '');
  const decimal = cleaned.match(/[.,](\d{1,2})$/);
  const whole = decimal ? cleaned.slice(0, -decimal[0].length) : cleaned;
  return Number(whole.replace(/[.,]/g, '') + (decimal ? `.${decimal[1]}` : ''));
}

const PER_UNIT = /^\s*(?:\/|per\b|por\b|par\b|a\b)?\s*(?:m²|m2|sqm|sq\.?\s?m|mês|mes\b|month|mo\b|mois|night|noite|week|semana|year|ano\b|an\b|ha\b|hectare)/i;

export function parseAmounts(pageText) {
  const amounts = [];
  const textValue = String(pageText ?? '');
  for (const m of textValue.matchAll(AMOUNT)) {
    const currency = m[8] ? 'VND' : currencyOf(m[1] ?? m[6]);
    const scale = SCALES[String(m[3] ?? m[5] ?? m[8] ?? '').toLowerCase()] ?? 1;
    const value = toAmount(m[2] ?? m[4] ?? m[7]) * scale;
    const perUnit = PER_UNIT.test(textValue.slice(m.index + m[0].length, m.index + m[0].length + 14));
    if (currency && Number.isFinite(value)) amounts.push({ value, currency, perUnit });
  }
  return amounts;
}

export function headlinePrice(amounts) {
  return amounts.find((a) => !a.perUnit) ?? null;
}

export function normalizeAcceptance(raw, expected = '') {
  const count = finite(raw?.itemCount);
  const range = Array.isArray(raw?.valueRange) ? raw.valueRange.map(finite) : [];
  return {
    expected: text(expected || raw?.expected, 600),
    itemCount: count && count > 0 ? Math.min(100, Math.round(count)) : null,
    urlsLive: Boolean(raw?.urlsLive),
    valueRange: range.length === 2 && range.every((v) => v !== null) ? [Math.min(...range), Math.max(...range)] : null,
    unit: text(raw?.unit, 20),
    mustMention: (Array.isArray(raw?.mustMention) ? raw.mustMention : []).map((m) => text(m, 60)).filter(Boolean).slice(0, 5),
  };
}

const COUNT_NOUNS = 'links?|listings?|items?|results?|offers?|ads?|cars?|vehicles?|plots?|properties|property|options?|candidates?|suppliers?|providers?|vendors?|wholesalers?|distributors?|manufacturers?|compan(?:y|ies)|shops?|stores?';
const COUNT_DESCRIBERS = '(?:[a-z][a-z-]*\\s+){0,2}';
const COUNT_PHRASE = /\b(?:at least|top|list of)\s+(\d{1,4})(?!\d)/gi;
const COUNT_NOUN = new RegExp(`(?<![\\d.,])(\\d{1,4})(?![\\d.,])\\s+${COUNT_DESCRIBERS}(?:${COUNT_NOUNS})(?![a-z])`, 'gi');
const COUNT_UNIT_AFTER = /^\s*(?:[€$£₺₫]|(?:eur|euro|euros|czk|pln|usd|gbp|try|vnd|kč|kc|zl|zł|km|m2|m²|sqm|%|percent|years?|months?|weeks?|days?|hours?|minutes?)(?![a-zà-ÿ]))/i;
const RANGE_BEFORE = /[-–—]\s*$/;
const RANGE_AFTER = /^\s*[-–—]\s*\d/;

export function itemCountFromWords(...texts) {
  const source = texts.filter((t) => typeof t === 'string' && t.trim()).join(' \n ');
  const found = [];
  for (const m of source.matchAll(COUNT_PHRASE)) {
    const at = m.index + m[0].length - m[1].length;
    found.push({ at, end: at + m[1].length, value: Number(m[1]) });
  }
  for (const m of source.matchAll(COUNT_NOUN)) found.push({ at: m.index, end: m.index + m[1].length, value: Number(m[1]) });
  found.sort((a, b) => a.at - b.at);
  for (const { at, end, value } of found) {
    if (!(value >= 1 && value <= 1000)) continue;
    const before = source.slice(Math.max(0, at - 3), at);
    const after = source.slice(end);
    if (RANGE_BEFORE.test(before) || RANGE_AFTER.test(after) || COUNT_UNIT_AFTER.test(after)) continue;
    return value;
  }
  return null;
}

export function hasCriteria(spec) {
  return Boolean(spec && (spec.itemCount || spec.urlsLive || spec.valueRange || spec.mustMention?.length));
}

const NAME_STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'with', 'without', 'in', 'on', 'at', 'from', 'to', 'by', 'as', 'is', 'are', 'be', 'that', 'this', 'these', 'those', 'which', 'who', 'what', 'when', 'where', 'how', 'why', 'within', 'up', 'under', 'over', 'about', 'into', 'similar', 'like', 'such', 'certain', 'must', 'should', 'include', 'including', 'mention', 'containing', 'between', 'across', 'near', 'around', 'than', 'then', 'also', 'all', 'any', 'each', 'every', 'both', 'some', 'find', 'get', 'give', 'list', 'search', 'identify', 'select', 'show', 'compare']);
const NAME_WORD = /^[\p{L}\p{N}'’.-]{2,}$/u;
const NAME_MAX = 5;
const NAME_WORDS_MAX = 3;

function nameWord(token) {
  const bare = String(token ?? '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return NAME_WORD.test(bare) && !NAME_STOP.has(plain(bare)) ? bare : null;
}

function capitalised(word) {
  return /^\p{Lu}/u.test(word);
}

function leadingName(tokens, atStart) {
  if (atStart || !tokens.length) return '';
  const first = nameWord(tokens[0]);
  if (!first || !capitalised(first)) return '';
  const out = [first];
  for (let i = 1; i < tokens.length && out.length < NAME_WORDS_MAX; i++) {
    const word = nameWord(tokens[i]);
    if (!word) break;
    out.push(word);
  }
  return out.join(' ');
}

function trailingName(tokens) {
  if (!tokens.length) return '';
  const last = nameWord(tokens.at(-1));
  if (!last || !capitalised(last)) return '';
  const out = [last];
  for (let i = tokens.length - 2; i >= 0 && out.length < NAME_WORDS_MAX; i--) {
    const word = nameWord(tokens[i]);
    if (!word) break;
    out.unshift(word);
  }
  return out.join(' ');
}

function wholeName(tokens) {
  if (!tokens.length || tokens.length > NAME_WORDS_MAX) return '';
  const out = tokens.map(nameWord);
  return out.every(Boolean) && capitalised(out[0]) ? out.join(' ') : '';
}

function fragmentsOf(text) {
  return String(text ?? '').split(',').map((part) => part.replace(/[.;!?]+$/, '').trim().split(/\s+/).filter(Boolean));
}

export function nameLists(text) {
  const fragments = fragmentsOf(text).map((tokens, i) => ({ pure: wholeName(tokens), lead: leadingName(tokens, i === 0), trail: trailingName(tokens) }));
  const lists = [];
  for (let i = 0; i < fragments.length; i++) {
    if (!fragments[i].pure) continue;
    const names = [];
    let next = i;
    while (next < fragments.length && fragments[next].pure) names.push(fragments[next++].pure);
    if (i > 0 && fragments[i - 1].trail) names.unshift(fragments[i - 1].trail);
    if (next < fragments.length && fragments[next].lead) names.push(fragments[next].lead);
    const unique = [...new Set(names)];
    if (unique.length >= 2) lists.push(unique.slice(0, NAME_MAX));
    i = next - 1;
  }
  return lists;
}

export function purposeChecks(project) {
  const question = String(project?.question ?? '');
  if (!question) return [];
  const words = plain(question);
  const checks = nameLists(question).map((names, i) => ({ id: `purpose-names-${i + 1}`, type: 'any', names, label: `Page mentions one of: ${names.map((n) => `"${n}"`).join(', ')} (your words)` }));
  const kind = project?.decisionModel?.kind ?? project?.brief?.kind ?? null;
  const subtype = project?.decisionModel?.subtype ?? project?.brief?.subtype ?? null;
  const terms = (kind?.terms ?? []).filter((term) => {
    const parts = plain(term).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    return parts.length >= 1 && parts.length <= 2 && parts.every((w) => words.includes(w));
  });
  if (terms.length) checks.push({ id: 'purpose-kind', type: 'kind', terms: [...new Set(terms)].slice(0, 3), ...(subtype?.models?.length ? { subtype: { models: subtype.models, variants: subtype.variants ?? [] } } : {}), label: `Page shows the asked ${[...new Set(terms)].join(' / ')} (your words)` });
  return checks;
}

function wordMatch(text, words) {
  const value = plain(text);
  return (words ?? []).some((word) => {
    const key = plain(word).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return Boolean(key) && new RegExp(`(?:^|[^\\p{L}\\p{N}])${key}(?![\\p{L}\\p{N}])`, 'u').test(value);
  });
}

const NAME_NEAR_MIN = 6;
const NAME_NEAR_DISTANCE = 2;

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[b.length];
}

function nearName(page, name) {
  const target = plain(name).replace(/[^a-z0-9]+/g, ' ').trim();
  if (target.replace(/[^a-z0-9]/g, '').length < NAME_NEAR_MIN) return false;
  const words = page.split(/[^a-z0-9]+/).filter(Boolean);
  const span = target.split(' ').length;
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= span && i + n <= words.length; n++) {
      const sequence = words.slice(i, i + n).join(' ');
      if (Math.abs(sequence.length - target.length) > NAME_NEAR_DISTANCE) continue;
      if (editDistance(sequence, target) <= NAME_NEAR_DISTANCE) return true;
    }
  }
  return false;
}

function purposePass(criterion, pageText, item) {
  if (criterion.type === 'kind') {
    if (item?.harvested && item?.nodeId === 'sweep') return true;
    if (kindOnPage(pageText, { terms: criterion.terms })) return true;
    const subtype = criterion.subtype;
    if (!subtype?.models?.length) return false;
    return wordMatch(item?.title ?? '', subtype.models) && !wordMatch(item?.title ?? '', subtype.variants) && !wordMatch(pageText, subtype.variants);
  }
  const page = plain(pageText);
  return criterion.names.some((name) => page.includes(plain(name)) || nearName(page, name));
}

function deliveryRank(item) {
  if (!item.harvested) return 0;
  return item.value !== null && item.value !== undefined ? 1 : 2;
}

export function collectDeliverables(nodes) {
  const seen = new Set();
  const items = [];
  for (const node of nodes) {
    const trusted = ['verified', 'supported'].includes(node.status);
    for (const item of node.finding?.items ?? []) {
      if (!item.url || seen.has(item.url) || (!trusted && !item.harvested)) continue;
      seen.add(item.url);
      items.push({ ...item, nodeId: node.id });
    }
  }
  return items.map((item, i) => [item, i]).sort(([a, i], [b, j]) => deliveryRank(a) - deliveryRank(b) || i - j).map(([item]) => item);
}

function termWords(term) {
  return plain(term).split(/[^a-z0-9]+/).filter(Boolean);
}

function matchedTerms(pageText, terms) {
  const matched = [...new Set((terms ?? []).filter(Boolean).map((term) => plain(term).trim()).filter(Boolean))].filter((term) => kindOnPage(pageText, { terms: [term] }));
  const multiWord = matched.some((term) => termWords(term).length >= 2);
  return { matched, ok: multiWord || matched.length >= 2 };
}

const ANCHOR_MIN_LENGTH = 4;

function anchorWords(kindLabel) {
  const label = typeof kindLabel === 'string' ? kindLabel : `${kindLabel?.label ?? ''} ${kindLabel?.object ?? ''}`;
  return new Set(plain(label).split(/[^a-z0-9]+/).filter((word) => word.length >= ANCHOR_MIN_LENGTH).map((word) => word.slice(0, KIND_STEM)));
}

function anchoredTerm(matched, anchors) {
  if (!anchors.size) return true;
  return matched.some((term) => {
    const words = termWords(term);
    return words.length >= 2 && words.some((word) => anchors.has(word.slice(0, KIND_STEM)));
  });
}

const DIRECTORY_LISTINGS = 10;
const DIRECTORY_PATHS = 5;
const MARKETPLACE_SUBDOMAINS = 3;
const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);
const KNOWN_B2B_MARKETPLACES = new Set(['made-in-china.com', 'alibaba.com', 'tradewheel.com', 'tradekey.com', 'ec21.com', 'globalsources.com', 'indiamart.com']);
const LISTICLE_TITLE = /(?:^top\s+\d+|^\d+\s+best|^best\s+.+\s+near|near\s+[a-z]+|^(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred)\s+best)/i;
const REVIEW_NEWS_HOST = /yelp|tripadvisor|news/i;
const BLOG_GUIDE_PATH = /\/(?:blog|blogs|guide|guides)\//i;
const SUPPLIER_DIRECTORY_HOSTS = new Set(['accio.com', 'apparelsearch.com']);
export function isExcludedSurfaceUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  return SUPPLIER_DIRECTORY_HOSTS.has(host) || BLOG_GUIDE_PATH.test(parsed.pathname);
}
const WHOLESALE_SIGNAL = /\b(?:wholesale|bulk|bales?|per\s+kg|container|b2b|export|groothandel|großhandel|ingrosso|hurtownia|didmena|velkoobchod)\b/i;
const GENERIC_SEGMENTS = new Set(['about', 'about-us', 'contact', 'contact-us', 'blog', 'news', 'faq', 'help', 'privacy', 'terms', 'search', 'category', 'categories', 'product', 'products', 'sitemap', 'login', 'register', 'cart', 'jobs', 'careers', 'press', 'media', 'home', 'index', 'suppliers', 'vendors', 'manufacturers', 'companies', 'directory', 'browse']);

function registrableDomain(host) {
  const labels = host.split('.');
  const secondLevelSuffix = labels.length > 2 && labels.at(-1).length === 2 && SECOND_LEVEL_LABELS.has(labels.at(-2));
  return labels.slice(secondLevelSuffix ? -3 : -2).join('.');
}

function productPath(parsed) {
  const path = parsed.pathname.toLowerCase().replace(/\/+$/, '');
  const segments = path.split('/').filter(Boolean);
  if (!segments.length) return '';
  return segments.every((segment) => GENERIC_SEGMENTS.has(segment)) ? '' : path;
}

function entityDeliverable(page, regions) {
  const deliverable = { title: text(page.source.title, 200) || page.host, url: `${page.parsed.protocol}//${page.host}/`, value: null, unit: '', nodeId: page.node.id, evidence: page.url };
  const region = regions.length ? regionVerdict(page.source, regions) : null;
  return region ? { ...deliverable, region: region.text } : deliverable;
}

export function entityDeliverables(nodes, { terms = [], not = [], kindLabel = '', regions = [] } = {}) {
  const wanted = (terms ?? []).filter(Boolean);
  const banned = (not ?? []).map((phrase) => plain(phrase).trim()).filter(Boolean);
  const anchors = anchorWords(kindLabel);
  const pages = [];
  for (const node of nodes ?? []) {
    for (const source of node.sources ?? []) {
      const url = String(source?.url ?? '');
      if (!url) continue;
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        continue;
      }
      const host = parsed.hostname.replace(/^www\./, '');
      if (!host) continue;
      pages.push({ node, source, url, host, parsed, pageText: `${source.title ?? ''} ${source.text ?? ''}` });
    }
  }
  const paths = new Map();
  const directories = new Set();
  for (const page of pages) {
    if ((page.source.listings?.length ?? 0) >= DIRECTORY_LISTINGS) directories.add(page.host);
    const path = productPath(page.parsed);
    if (!path) continue;
    const set = paths.get(page.host) ?? new Set();
    set.add(path);
    paths.set(page.host, set);
  }
  for (const [host, set] of paths) if (set.size >= DIRECTORY_PATHS) directories.add(host);
  const domains = new Map();
  for (const page of pages) {
    const domain = registrableDomain(page.host);
    const set = domains.get(domain) ?? new Set();
    set.add(page.host);
    domains.set(domain, set);
  }
  const marketplaces = new Set();
  for (const [domain, hosts] of domains) {
    if (KNOWN_B2B_MARKETPLACES.has(domain) || hosts.size >= MARKETPLACE_SUBDOMAINS) {
      for (const host of hosts) marketplaces.add(host);
    }
  }
  const wholesale = typeof kindLabel === 'string' && /wholesale/i.test(kindLabel);
  const hosts = new Map();
  for (const page of pages) {
    if (directories.has(page.host)) continue;
    if (marketplaces.has(page.host)) continue;
    if (REVIEW_NEWS_HOST.test(page.host)) continue;
    if (LISTICLE_TITLE.test(String(page.source.title ?? ''))) continue;
    if (isExcludedSurfaceUrl(page.url)) continue;
    if (wholesale && !WHOLESALE_SIGNAL.test(page.pageText)) continue;
    const { matched, ok } = matchedTerms(page.pageText, wanted);
    if (!ok) continue;
    if (!anchoredTerm(matched, anchors)) continue;
    if (wordMatch(page.pageText, banned)) continue;
    const hits = matched.length;
    const current = hosts.get(page.host);
    if (current && current.hits >= hits) continue;
    hosts.set(page.host, { hits, deliverable: entityDeliverable(page, regions) });
  }
  return [...hosts.values()].sort((a, b) => b.hits - a.hits).map((entry) => entry.deliverable);
}

const identity = (value) => value;

export function inRange(amounts, spec, itemValue, convert = identity) {
  const [min, max] = spec.valueRange;
  const wanted = currencyOf(spec.unit);
  const headline = headlinePrice(amounts);
  if (!headline) return itemValue !== null && itemValue !== undefined && Number(itemValue) >= min && Number(itemValue) <= max;
  const value = wanted ? convert(headline.value, headline.currency, wanted) : headline.value;
  return value !== null && value >= min && value <= max;
}

function isDeepLink(url) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/+$/, '').length > 1 || u.search.length > 1;
  } catch {
    return false;
  }
}

const PATH_ID = /(?:^|[/_.-])(?:\d{6,}|ID[A-Za-z0-9]{4,}|[A-Za-z]{0,6}\d[A-Za-z0-9]{5,})(?=[/_.?&#-]|$)|(?:property|listing|ad|item|ref)?id[-_=]*\d{3,}|-\d{5,}(?:\.html?)?\/?$/i;
const QUERY_ID = /(?:^|[?&])(?:id|ref|ad|adid|listing|listingid|propertyid|itemid)=[A-Za-z0-9-]{3,}/i;
const NOT_A_LISTING = /\/(?:blog|news|noticias|search|busca|buscar|cerca|category|categoria|tag|guides?|geo|list|s|q)(?:\/|$|-)/i;
const ASSET_FILE = /\.(?:jpe?g|png|webp|gif|svg|ico|css|js|pdf|mp4|webm|zip)$/i;
const NOT_A_LISTING_HOST = /^(?:wa\.me|api\.|web\.archive\.org|t\.me|(?:[a-z]+\.)?(?:facebook|instagram|twitter|x|linkedin|youtube|tiktok|pinterest|google|whatsapp)\.com)/i;
const SEARCH_QUERY = /(?:^|[?&])(?:max_?price|min_?price|price_?(?:max|min|from|to)|maximum-price|minimum-price|ordem|order|sort|ordenado-por|page|q)=/i;

export function looksLikeListing(url) {
  try {
    const u = new URL(url);
    return (PATH_ID.test(u.pathname) || QUERY_ID.test(u.search)) && !NOT_A_LISTING.test(u.pathname) && !SEARCH_QUERY.test(u.search) && !NOT_A_LISTING_HOST.test(u.hostname.replace(/^www\./, '')) && !ASSET_FILE.test(u.pathname);
  } catch {
    return false;
  }
}

export const KIND_STEM = 5;

export function kindOnPage(text, kind) {
  const words = new Set(plain(text).split(/[^a-z0-9]+/).filter(Boolean));
  const stems = new Set([...words].map((w) => w.slice(0, KIND_STEM)));
  return (kind?.terms ?? []).some((term) => {
    const parts = plain(term).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    return parts.length > 0 && parts.every((w) => (w.length <= KIND_STEM ? words.has(w) : stems.has(w.slice(0, KIND_STEM))));
  });
}

export function qualifies(item, spec) {
  const entity = Boolean(item.evidence);
  return Boolean(item.live && (entity || item.listing) && (!spec.valueRange || item.inRange) && (item.purpose ?? []).every((c) => c.passed));
}

function pageIsLive(page, item, located, allowRedirect = false) {
  const status = Number(page?.status ?? 0);
  const text = String(page?.text ?? '');
  const redirected = allowRedirect && status >= 300 && status < 400;
  return status >= 200 && status < 400 && (redirected || text.length >= MIN_LIVE_TEXT) && (!located || isDeepLink(item.url));
}

export class AcceptanceChecker {
  constructor({ readPage, convert = identity }) {
    this.readPage = readPage;
    this.convert = convert;
  }

  async inspectAll(items, spec, options = {}) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await this.inspect(items[i], spec, options);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAGE_READS_AT_ONCE, items.length) }, worker));
    return results;
  }

  async inspect(item, spec, { located = true, kind = null, purpose = [] } = {}) {
    const entity = Boolean(item.evidence);
    const root = this.readPage ? await this.readPage(item.url) : { text: '', status: 0 };
    const rootLive = pageIsLive(root, item, located, entity);
    let pageText = '';
    let live = false;
    if (entity && item.evidence && item.evidence !== item.url && this.readPage) {
      const evidence = await this.readPage(item.evidence).catch(() => null);
      if (pageIsLive(evidence, item, located, true)) {
        pageText = String(evidence.text ?? '');
        live = true;
      }
    }
    if (!pageText && rootLive) {
      pageText = String(root.text ?? '');
      live = true;
    }
    const amounts = parseAmounts(pageText);
    return {
      ...item,
      live,
      listing: located ? looksLikeListing(item.url) : !kind?.terms?.length || kindOnPage(pageText, kind),
      inRange: spec.valueRange ? live && inRange(amounts, spec, item.value, this.convert) : null,
      mentions: spec.mustMention.length ? spec.mustMention.filter((m) => pageText.toLowerCase().includes(m.toLowerCase())).length / spec.mustMention.length : null,
      purpose: purpose.map((c) => ({ id: c.id, passed: purposePass(c, pageText, item) })),
    };
  }

  async evaluate(spec, deliverables, { located = true, kind = null, purpose = [] } = {}) {
    if (!hasCriteria(spec) && !purpose.length) return null;
    const wanted = spec.itemCount ?? MAX_ITEM_CHECKS;
    const items = await this.inspectAll(deliverables.slice(0, Math.min(MAX_ITEM_CHECKS, Math.ceil(wanted * 1.5))), spec, { located, kind, purpose });
    const target = spec.itemCount ?? Math.max(1, items.length);
    const good = (predicate) => Math.min(1, items.filter(predicate).length / target);
    const checks = [];
    const valid = items.filter((i) => qualifies(i, spec)).length;
    if (spec.itemCount) checks.push({ id: 'count', label: `At least ${spec.itemCount} valid items`, value: Math.min(1, valid / spec.itemCount), detail: `${valid} of ${deliverables.length} delivered pass every check; first ${items.length} inspected (${located ? 'a single listing page that opens' : 'a page that opens and describes the asked kind'}${spec.valueRange ? ', price in range' : ''})` });
    if (spec.urlsLive) checks.push({ id: 'live', label: 'Links open a real page', value: good((i) => i.live), detail: `${items.filter((i) => i.live).length} of ${items.length} checked links are live` });
    if (spec.valueRange) checks.push({ id: 'range', label: `Value within ${spec.valueRange.join('–')} ${spec.unit}`.trim(), value: good((i) => i.inRange), detail: `${items.filter((i) => i.inRange).length} of ${items.length} pages show a value in range` });
    if (spec.mustMention.length) checks.push({ id: 'mentions', label: `Pages mention: ${spec.mustMention.join(', ')}`, value: items.length ? items.reduce((s, i) => s + (i.mentions ?? 0), 0) / target : 0, detail: 'share of required terms found on the pages' });
    for (const criterion of purpose) {
      const passed = items.filter((i) => (i.purpose ?? []).some((c) => c.id === criterion.id && c.passed)).length;
      checks.push({ id: criterion.id, label: criterion.label, value: items.length ? passed / items.length : 0, detail: `${passed} of ${items.length} delivered pages show it` });
    }
    const score = checks.reduce((s, c) => s + Math.min(1, c.value), 0) / checks.length;
    return { score: Math.round(score * 1000) / 1000, checks: checks.map((c) => ({ ...c, value: Math.round(Math.min(1, c.value) * 1000) / 1000, passed: c.value >= 0.999 })), items, checkedAt: new Date().toISOString() };
  }
}
