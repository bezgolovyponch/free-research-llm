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

const COUNT_NOUNS = 'links?|listings?|items?|results?|offers?|cars?|plots?|properties?|options?|[a-z]{3,}s';
const COUNT_PHRASE = /\b(?:at least|top|list of)\s+(\d{1,4})(?!\d)/gi;
const COUNT_NOUN = new RegExp(`(?<![\\d.,])(\\d{1,4})(?![\\d.,])\\s+(?:${COUNT_NOUNS})(?![a-z])`, 'gi');
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

export function qualifies(item, spec) {
  return Boolean(item.live && item.listing && (!spec.valueRange || item.inRange));
}

export class AcceptanceChecker {
  constructor({ readPage, convert = identity }) {
    this.readPage = readPage;
    this.convert = convert;
  }

  async inspectAll(items, spec) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await this.inspect(items[i], spec);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAGE_READS_AT_ONCE, items.length) }, worker));
    return results;
  }

  async inspect(item, spec) {
    const page = this.readPage ? await this.readPage(item.url) : { text: '', status: 0 };
    const pageText = String(page.text ?? '');
    const live = page.status >= 200 && page.status < 400 && pageText.length >= MIN_LIVE_TEXT && isDeepLink(item.url);
    const amounts = parseAmounts(pageText);
    return {
      ...item,
      live,
      listing: looksLikeListing(item.url),
      inRange: spec.valueRange ? live && inRange(amounts, spec, item.value, this.convert) : null,
      mentions: spec.mustMention.length ? spec.mustMention.filter((m) => pageText.toLowerCase().includes(m.toLowerCase())).length / spec.mustMention.length : null,
    };
  }

  async evaluate(spec, deliverables) {
    if (!hasCriteria(spec)) return null;
    const wanted = spec.itemCount ?? MAX_ITEM_CHECKS;
    const items = await this.inspectAll(deliverables.slice(0, Math.min(MAX_ITEM_CHECKS, Math.ceil(wanted * 1.5))), spec);
    const target = spec.itemCount ?? Math.max(1, items.length);
    const good = (predicate) => Math.min(1, items.filter(predicate).length / target);
    const checks = [];
    const valid = items.filter((i) => qualifies(i, spec)).length;
    if (spec.itemCount) checks.push({ id: 'count', label: `At least ${spec.itemCount} valid items`, value: Math.min(1, valid / spec.itemCount), detail: `${valid} of ${deliverables.length} delivered pass every check (a single listing page that opens${spec.valueRange ? ', price in range' : ''})` });
    if (spec.urlsLive) checks.push({ id: 'live', label: 'Links open a real page', value: good((i) => i.live), detail: `${items.filter((i) => i.live).length} of ${items.length} checked links are live` });
    if (spec.valueRange) checks.push({ id: 'range', label: `Value within ${spec.valueRange.join('–')} ${spec.unit}`.trim(), value: good((i) => i.inRange), detail: `${items.filter((i) => i.inRange).length} of ${items.length} pages show a value in range` });
    if (spec.mustMention.length) checks.push({ id: 'mentions', label: `Pages mention: ${spec.mustMention.join(', ')}`, value: items.length ? items.reduce((s, i) => s + (i.mentions ?? 0), 0) / target : 0, detail: 'share of required terms found on the pages' });
    const score = checks.reduce((s, c) => s + Math.min(1, c.value), 0) / checks.length;
    return { score: Math.round(score * 1000) / 1000, checks: checks.map((c) => ({ ...c, value: Math.round(Math.min(1, c.value) * 1000) / 1000, passed: c.value >= 0.999 })), items, checkedAt: new Date().toISOString() };
  }
}
