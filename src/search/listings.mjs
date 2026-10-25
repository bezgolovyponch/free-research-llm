import { headlinePrice, looksLikeListing, parseAmounts } from '../research/acceptance.mjs';
import { absoluteUrl, domainOf, htmlToText } from './html.mjs';

export const METHODS = ['json-ld', 'embedded-json', 'cards'];
const MIN_GROUP = 3;
const MAX_LISTINGS = 120;
const CARD_SPAN = 12000;
const SKIPPED_TYPES = /^(?:WebPage|WebSite|Organization|BreadcrumbList|SearchResultsPage|CollectionPage|SiteNavigationElement|ImageObject|Person|RealEstateAgent|LocalBusiness|Brand|AggregateOffer|PostalAddress|GeoCoordinates|QuantitativeValue|UnitPriceSpecification|ListItem|ItemList|AggregateRating|Review|FAQPage|Question|Answer)$/i;
const TITLE_KEYS = ['title', 'name', 'headline', 'subject', 'label'];
const URL_KEYS = ['url', 'href', 'link', 'permalink', 'canonicalUrl', 'detailUrl', 'shareUrl', 'slug'];
const PRICE_KEY = /^(?:total_?price|price|prices|offers?|amount|sale_?price|asking_?price|price_?value|list_?price)$/i;
const AREA_KEY = /^(?:area|area_?in_?square_?meters|terrain_?area_?in_?square_?meters|land_?area|plot_?size|size|surface|sqm|square_?meters|floor_?size|lot_?size)$/i;
const PLACE_KEY = /^(?:city|town|locality|address_?locality|region|address_?region|district|municipality|location|address|place|full_?name)$/i;
const AREA_TEXT = /(\d{1,3}(?:[ ., ]\d{3})+|\d+(?:[.,]\d+)?)\s?(m²|m2|sqm|sq\.?\s?m|ha\b|hectares?|acres?|dönüm|donum)/i;
const NEXT_TEXT = /^(?:next|next page|seguinte|próxima|proxima|siguiente|suivant|weiter|nächste|successiva|avanti|sonraki|ileri|tiếp|trang sau|›|»|→|>)$/i;
const PAGE_PARAM = /([?&](?:page|pagina|pag|p|sayfa|trang)=)(\d+)/i;
const PAGE_PATH = /(\/(?:page|pagina|pag|sayfa|trang)[/-]?)(\d+)(\/?)$/i;

function clean(value, max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[^\d.,]/g, '');
  if (!/\d/.test(digits)) return null;
  const decimal = digits.match(/[.,](\d{1,2})$/);
  const whole = decimal ? digits.slice(0, -decimal[0].length) : digits;
  const n = Number(whole.replace(/[.,]/g, '') + (decimal ? `.${decimal[1]}` : ''));
  return Number.isFinite(n) ? n : null;
}

function priceOf(value, depth = 0) {
  if (value === null || value === undefined || depth > 3) return null;
  if (Array.isArray(value)) return value.map((v) => priceOf(v, depth + 1)).find(Boolean) ?? null;
  if (typeof value === 'object') {
    const amount = numberOf(value.value ?? value.amount ?? value.price ?? value.lowPrice ?? value.total ?? null);
    const currency = clean(value.currency ?? value.currencyCode ?? value.priceCurrency ?? '', 8).toUpperCase();
    if (amount !== null && amount > 0) return { value: amount, unit: currency };
    for (const [key, inner] of Object.entries(value)) if (PRICE_KEY.test(key) || key === 'priceSpecification') {
      const found = priceOf(inner, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const n = numberOf(value);
  if (n === null || n <= 0) return null;
  const [parsed] = parseAmounts(String(value));
  return { value: n, unit: parsed?.currency ?? '' };
}

function areaOf(value) {
  if (value && typeof value === 'object') return numberOf(value.value ?? value.amount ?? null);
  return numberOf(value);
}

const LAT_KEYS = ['latitude', 'lat'];
const LON_KEYS = ['longitude', 'lng', 'lon', 'long'];

export function coordsOf(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return null;
  const lat = Number(LAT_KEYS.map((k) => value[k]).find((v) => v !== undefined && v !== null && v !== ''));
  const lon = Number(LON_KEYS.map((k) => value[k]).find((v) => v !== undefined && v !== null && v !== ''));
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat !== 0 || lon !== 0)) return { lat, lon };
  for (const key of ['geo', 'location', 'coordinates', 'position', 'address', 'geoPoint', 'point']) {
    const found = coordsOf(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

const TITLE_PLACE = /\b(?:in|em|en|à|u|na|di|a)\s+([A-ZÀ-ÝĐČŠŽ][\p{L}.'’ -]{1,40}(?:,\s*[\p{L}.'’ -]{2,40}){0,3})/u;

function addressOf(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return '';
  if (Array.isArray(value)) {
    for (const inner of value) {
      const found = addressOf(inner, depth + 1);
      if (found) return found;
    }
    return '';
  }
  const parts = [value.addressLocality, value.addressRegion, value.addressCountry].filter((p) => typeof p === 'string' && p.trim());
  if (parts.length >= 2 || (parts.length && value['@type'] === 'PostalAddress')) return clean(parts.join(', '), 80);
  for (const inner of Object.values(value)) {
    const found = addressOf(inner, depth + 1);
    if (found) return found;
  }
  return '';
}

export function pagePlace(html) {
  for (const script of scripts(html, /application\/ld\+json/i)) {
    const found = addressOf(parseJson(script));
    if (found) return found;
  }
  const title = String(html ?? '').match(/<title[^>]*>([^<]{3,200})<\/title>/i)?.[1] ?? '';
  const m = title.replace(/&amp;/g, '&').match(TITLE_PLACE);
  return m ? clean(m[1].replace(/\s+(?:for sale|à vendre|para venda|en venta)\b.*$/i, '').trim(), 80) : '';
}

function placeOf(value, depth = 0) {
  if (!value || depth > 3) return '';
  if (typeof value === 'string') return clean(value, 80);
  if (Array.isArray(value)) return clean(value.map((v) => placeOf(v, depth + 1)).filter(Boolean).slice(-1)[0] ?? '', 80);
  if (typeof value === 'object') {
    const named = value.fullName ?? value.name ?? value.addressLocality ?? value.city ?? value.addressRegion ?? null;
    if (typeof named === 'string') return clean(named, 80);
    for (const [key, inner] of Object.entries(value)) if (PLACE_KEY.test(key) || key === 'reverseGeocoding' || key === 'locations') {
      const found = placeOf(inner, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function field(record, keys) {
  for (const key of keys) if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
  return '';
}

function fieldBy(record, pattern, read) {
  for (const [key, value] of Object.entries(record)) if (pattern.test(key)) {
    const found = read(value);
    if (found) return found;
  }
  return null;
}

function anchorsOf(html, base) {
  const anchors = [];
  for (const m of String(html ?? '').matchAll(/<a\s[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absoluteUrl(m[1], base);
    if (url) anchors.push({ url, text: clean(htmlToText(m[2]), 160), index: m.index });
  }
  return anchors;
}

function markdownAnchorsOf(markdown, base) {
  const anchors = [];
  for (const m of String(markdown ?? '').matchAll(/(?<!!)\[([^\]]{0,200})\]\((https?:\/\/[^)\s]+)\)/g)) {
    const url = absoluteUrl(m[2], base);
    if (url) anchors.push({ url, text: clean(m[1].replace(/!\[[^\]]*\]\([^)]*\)/g, ''), 160), index: m.index });
  }
  return anchors;
}

function resolveUrl(raw, base, anchors) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value) || value.startsWith('/')) {
    const url = absoluteUrl(value, base);
    if (url && looksLikeListing(url)) return url;
    if (/^https?:\/\//i.test(value)) return '';
  }
  const tail = value.split('/').filter(Boolean).pop() ?? '';
  if (tail.length < 5 || !/\d/.test(tail)) return '';
  return anchors.find((a) => looksLikeListing(a.url) && a.url.includes(tail))?.url ?? '';
}

function fromRecord(record, base, anchors) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const type = Array.isArray(record['@type']) ? record['@type'][0] : record['@type'];
  if (type && SKIPPED_TYPES.test(String(type))) return null;
  let url = '';
  for (const key of URL_KEYS) {
    url = resolveUrl(record[key], base, anchors);
    if (url) break;
  }
  if (!url && record.id !== undefined) url = resolveUrl(String(record.id), base, anchors);
  if (!url) return null;
  const price = fieldBy(record, PRICE_KEY, priceOf);
  const currency = clean(record.priceCurrency ?? record.currency ?? record.offers?.priceCurrency ?? '', 8).toUpperCase();
  return {
    title: clean(field(record, TITLE_KEYS) || url),
    url,
    value: price?.value ?? null,
    unit: price?.unit || (price ? currency : ''),
    area: fieldBy(record, AREA_KEY, areaOf),
    place: placeOf(record.location ?? record.address ?? record.geo ?? null) || clean(fieldBy(record, PLACE_KEY, (v) => (typeof v === 'string' ? v : '')) ?? '', 80),
    ...coordsOf(record),
  };
}

function walk(value, visit, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return;
  visit(value);
  for (const inner of Array.isArray(value) ? value : Object.values(value)) walk(inner, visit, depth + 1);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function scripts(html, typePattern) {
  const found = [];
  for (const m of String(html ?? '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (typePattern.test(m[1])) found.push(m[2].trim());
  return found;
}

export function fromJsonLd(html, base, anchors = anchorsOf(html, base)) {
  const items = [];
  for (const body of scripts(html, /application\/ld\+json/i)) {
    walk(parseJson(body), (node) => {
      if (Array.isArray(node)) return;
      const item = fromRecord(node.item && typeof node.item === 'object' ? node.item : node, base, anchors);
      if (item) items.push(item);
    });
  }
  return items;
}

const STATE_ASSIGNMENT = /(?:window\.)?__[A-Z_]{3,}__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/;

function embeddedRoots(html) {
  return [
    ...scripts(html, /application\/json|id=["']__NEXT_DATA__["']|id=["']__NUXT_DATA__["']/i).map(parseJson),
    ...scripts(html, /^(?![\s\S]*\bsrc=)(?![\s\S]*ld\+json)/i).map((body) => body.match(STATE_ASSIGNMENT)?.[1]).filter(Boolean).map(parseJson),
  ].filter(Boolean);
}

const CURRENT_PAGE_KEYS = ['currentPage', 'current_page', 'page', 'pageNumber'];
const LAST_PAGE_KEYS = ['totalPages', 'total_pages', 'pageCount', 'lastPage', 'last_page', 'pages'];

export function pagedNext(html, base) {
  let found = '';
  for (const root of embeddedRoots(html)) {
    walk(root, (node) => {
      if (found || Array.isArray(node)) return;
      const current = CURRENT_PAGE_KEYS.map((k) => node[k]).find((v) => Number.isInteger(v));
      const last = LAST_PAGE_KEYS.map((k) => node[k]).find((v) => Number.isInteger(v));
      if (!current || !last || current >= last) return;
      try {
        const u = new URL(base);
        u.searchParams.set('page', String(current + 1));
        found = u.toString();
      } catch {
        found = '';
      }
    });
    if (found) break;
  }
  return found;
}

export function fromEmbeddedJson(html, base, anchors = anchorsOf(html, base)) {
  const roots = [
    ...scripts(html, /application\/json|id=["']__NEXT_DATA__["']|id=["']__NUXT_DATA__["']/i).map(parseJson),
    ...scripts(html, /^(?![\s\S]*\bsrc=)(?![\s\S]*ld\+json)/i).map((body) => body.match(STATE_ASSIGNMENT)?.[1]).filter(Boolean).map(parseJson),
  ].filter(Boolean);
  let best = [];
  for (const root of roots) {
    walk(root, (node) => {
      if (!Array.isArray(node) || node.length < MIN_GROUP) return;
      const items = node.map((record) => fromRecord(record, base, anchors)).filter((i) => i && (i.value !== null || i.title !== i.url));
      if (items.length >= MIN_GROUP && items.length > best.length) best = items;
    });
  }
  return best;
}

const SLUG = /[-+_].*[-+_]/;

export function pathTemplate(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const shape = parts.slice(0, -1).map((p) => (/\d/.test(p) ? '#' : SLUG.test(p) ? '~' : p));
    return `${u.hostname.replace(/^www\./, '')}/${[...shape, '*'].join('/')}`;
  } catch {
    return '';
  }
}

const ELEMENT_END = /<\/(?:div|span|p|li|td|th|a|strong|b|em|dd|dt|h\d|section|article)>/gi;

function cardText(source, from, to, isHtml) {
  const raw = source.slice(from, Math.min(to, from + CARD_SPAN));
  const text = isHtml ? htmlToText(raw.replace(ELEMENT_END, '\n')) : raw.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\]\([^)]*\)/g, '\n').replace(/[[\]*#_|]/g, ' ');
  return text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim().slice(0, 600);
}

export function fromCards(source, base, { isHtml = true, template = '' } = {}) {
  const anchors = isHtml ? anchorsOf(source, base) : markdownAnchorsOf(source, base);
  const host = domainOf(base);
  const firsts = new Map();
  const titles = new Map();
  for (const a of anchors) {
    if (!looksLikeListing(a.url) || !domainOf(a.url).endsWith(host.split('.').slice(-2).join('.'))) continue;
    if (!firsts.has(a.url)) firsts.set(a.url, a.index);
    if (a.text.length > (titles.get(a.url) ?? '').length) titles.set(a.url, a.text);
  }
  const groups = new Map();
  for (const url of firsts.keys()) {
    const key = pathTemplate(url);
    groups.set(key, [...(groups.get(key) ?? []), url]);
  }
  const chosen = template && groups.has(template) ? groups.get(template) : [...groups.values()].filter((g) => g.length >= MIN_GROUP).sort((a, b) => b.length - a.length)[0] ?? [];
  if (chosen.length < MIN_GROUP && !(template && chosen.length)) return { items: [], template: '' };
  const order = chosen.map((url) => [url, firsts.get(url)]).sort((a, b) => a[1] - b[1]);
  const items = order.map(([url, at], i) => {
    const text = cardText(source, at, order[i + 1]?.[1] ?? source.length, isHtml);
    const price = headlinePrice(parseAmounts(text));
    const area = text.match(AREA_TEXT);
    return { title: clean(titles.get(url) || text.slice(0, 100)) || url, url, value: price?.value ?? null, unit: price?.currency ?? '', area: area ? numberOf(area[1]) : null, areaUnit: area ? area[2].toLowerCase() : '', place: '', card: clean(text, 300) };
  });
  return { items, template: pathTemplate(order[0][0]) };
}

const LISTING_ID = /(?:ID[A-Za-z0-9]{4,}|[a-z]?\d{4,})/g;

export function listingKey(url) {
  try {
    const u = new URL(url);
    const ids = `${u.pathname}${u.search}`.match(LISTING_ID);
    return `${u.hostname.replace(/^www\./, '')}#${ids ? ids[ids.length - 1].toLowerCase() : u.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch {
    return String(url ?? '');
  }
}

function merge(lists, onPage) {
  const byKey = new Map();
  for (const [method, items] of lists) for (const item of items) {
    const key = listingKey(item.url);
    const known = byKey.get(key);
    if (!known) {
      byKey.set(key, { ...item, via: [method] });
      continue;
    }
    if (!onPage.has(known.url) && onPage.has(item.url)) known.url = item.url;
    for (const key of ['value', 'unit', 'area', 'areaUnit', 'place', 'card']) if ((known[key] === null || known[key] === '' || known[key] === undefined) && item[key] !== undefined) known[key] = item[key];
    if (known.title === known.url && item.title !== item.url) known.title = item.title;
    if (!known.via.includes(method)) known.via.push(method);
  }
  return [...byKey.values()].slice(0, MAX_LISTINGS);
}

export function nextPageUrl(source, base, { isHtml = true } = {}) {
  const text = String(source ?? '');
  if (isHtml) {
    const link = text.match(/<link\b[^>]*rel=["']next["'][^>]*>/i)?.[0].match(/href=["']([^"']+)["']/i)?.[1];
    if (link) return absoluteUrl(link, base);
  }
  const anchors = isHtml ? anchorsOf(text, base) : markdownAnchorsOf(text, base);
  const byText = anchors.find((a) => NEXT_TEXT.test(a.text) && a.url !== absoluteUrl(base, base));
  if (byText) return byText.url;
  const current = Number(base.match(PAGE_PARAM)?.[2] ?? base.match(PAGE_PATH)?.[2] ?? 1);
  const wanted = String(current + 1);
  const byNumber = anchors.find((a) => {
    const n = a.url.match(PAGE_PARAM)?.[2] ?? a.url.match(PAGE_PATH)?.[2];
    return n === wanted && domainOf(a.url) === domainOf(base);
  });
  return byNumber?.url ?? '';
}

export function extractListings(source, base, { isHtml = true, recipe = null } = {}) {
  const anchors = isHtml ? anchorsOf(source, base) : markdownAnchorsOf(source, base);
  const lists = [];
  if (isHtml) {
    lists.push(['json-ld', fromJsonLd(source, base, anchors)]);
    lists.push(['embedded-json', fromEmbeddedJson(source, base, anchors)]);
  }
  const cards = fromCards(source, base, { isHtml, template: recipe?.template ?? '' });
  lists.push(['cards', cards.items]);
  const items = merge(lists.filter(([, found]) => found.length), new Set(anchors.map((a) => a.url)));
  const methods = lists.filter(([, found]) => found.length).map(([method]) => method);
  return { items, methods, template: cards.template || recipe?.template || '', next: nextPageUrl(source, base, { isHtml }) || (isHtml && items.length ? pagedNext(source, base) : '') };
}
