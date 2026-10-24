const CURRENCIES = {
  EUR: ['€', 'eur', 'euro'],
  PLN: ['zł', 'zl', 'pln'],
  CZK: ['kč', 'kc', 'czk'],
  USD: ['$', 'usd'],
  GBP: ['£', 'gbp'],
};
const CURRENCY_TOKEN = '(€|eur|euro|zł|zl|pln|kč|kc|czk|\\$|usd|£|gbp)';
const NUMBER_TOKEN = '(\\d{1,3}(?:[ .,\\u00a0\\u202f]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
const AMOUNT = new RegExp(`${CURRENCY_TOKEN}\\s?${NUMBER_TOKEN}|${NUMBER_TOKEN}\\s?(?:,-\\s?)?${CURRENCY_TOKEN}`, 'gi');
const MAX_ITEM_CHECKS = 20;
const MIN_LIVE_TEXT = 200;

function text(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function currencyOf(token) {
  const t = String(token ?? '').toLowerCase().trim();
  return Object.keys(CURRENCIES).find((code) => code.toLowerCase() === t || CURRENCIES[code].includes(t)) ?? '';
}

export function toAmount(raw) {
  const cleaned = String(raw).replace(/[\s  ]/g, '');
  const decimal = cleaned.match(/[.,](\d{1,2})$/);
  const whole = decimal ? cleaned.slice(0, -decimal[0].length) : cleaned;
  return Number(whole.replace(/[.,]/g, '') + (decimal ? `.${decimal[1]}` : ''));
}

export function parseAmounts(pageText) {
  const amounts = [];
  for (const m of String(pageText ?? '').matchAll(AMOUNT)) {
    const currency = currencyOf(m[1] ?? m[4]);
    const value = toAmount(m[2] ?? m[3]);
    if (currency && Number.isFinite(value)) amounts.push({ value, currency });
  }
  return amounts;
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

export function hasCriteria(spec) {
  return Boolean(spec && (spec.itemCount || spec.urlsLive || spec.valueRange || spec.mustMention?.length));
}

export function collectDeliverables(nodes) {
  const seen = new Set();
  const items = [];
  for (const node of nodes) {
    if (!['verified', 'supported'].includes(node.status)) continue;
    for (const item of node.finding?.items ?? []) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      items.push({ ...item, nodeId: node.id });
    }
  }
  return items;
}

const identity = (value) => value;

export function inRange(amounts, spec, itemValue, convert = identity) {
  const [min, max] = spec.valueRange;
  const wanted = currencyOf(spec.unit);
  if (!wanted) return [...amounts, ...(itemValue !== null && itemValue !== undefined ? [{ value: Number(itemValue) }] : [])].some((a) => a.value >= min && a.value <= max);
  return amounts.some((a) => {
    const value = convert(a.value, a.currency, wanted);
    return value !== null && value >= min && value <= max;
  });
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
const NOT_A_LISTING = /\/(?:blog|news|noticias|search|busca|buscar|cerca|category|categoria|tag|guides?|geo|list|s)(?:\/|$|-)/i;
const SEARCH_QUERY = /(?:^|[?&])(?:max_?price|min_?price|price_?(?:max|min|from|to)|maximum-price|minimum-price|ordem|order|sort|ordenado-por|page|q)=/i;

export function looksLikeListing(url) {
  try {
    const u = new URL(url);
    return (PATH_ID.test(u.pathname) || QUERY_ID.test(u.search)) && !NOT_A_LISTING.test(u.pathname) && !SEARCH_QUERY.test(u.search);
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
    const items = await Promise.all(deliverables.slice(0, Math.min(MAX_ITEM_CHECKS, Math.ceil(wanted * 1.5))).map((item) => this.inspect(item, spec)));
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
