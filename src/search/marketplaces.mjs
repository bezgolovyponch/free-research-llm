import { parseAmounts } from '../research/acceptance.mjs';
import { htmlToText } from './search.mjs';

const USER_AGENT = 'Mozilla/5.0 (compatible; free-research-llm/1.0; +https://github.com/bezgolovyponch/free-research-llm)';
const MAX_LISTINGS = 60;

function slug(text) {
  return String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const PAGES = 3;
const MIN_SAMPLE = 3;
export const DEFAULT_SCAN_MODELS = [
  ['Skoda', 'Octavia'], ['Skoda', 'Fabia'], ['Volkswagen', 'Golf'], ['Volkswagen', 'Passat'], ['Volkswagen', 'Polo'],
  ['Ford', 'Focus'], ['Opel', 'Astra'], ['Opel', 'Corsa'], ['Toyota', 'Yaris'], ['Hyundai', 'i30'], ['Renault', 'Megane'], ['Peugeot', '308'],
];
const DEEP_PAGES = 8;

function query(make, model) {
  return [make, model].filter(Boolean).map(slug).join('-');
}

export const MARKETPLACES = [
  {
    id: 'kleinanzeigen',
    country: 'DE',
    currency: 'EUR',
    listing: /\/s-anzeige\/[^"'#?\s]+/,
    urls: ({ make, model }) => {
      const q = query(make, model) || 'auto';
      return Array.from({ length: PAGES }, (_, i) => `https://www.kleinanzeigen.de/s-autos/${i ? `seite:${i + 1}/` : ''}${q}/k0c216`);
    },
  },
  {
    id: 'bazos',
    country: 'CZ',
    currency: 'CZK',
    listing: /\/inzerat\/\d+\/[^"'#?\s]+/,
    urls: ({ make }) => Array.from({ length: DEEP_PAGES }, (_, i) => `https://auto.bazos.cz/${make ? `${slug(make)}/` : ''}${i ? `${i * 20}/` : ''}`),
  },
  {
    id: 'aaaauto',
    country: 'CZ',
    currency: 'CZK',
    listing: /\/detail\/[a-z0-9-]+\/[a-z0-9-]+\/\d+/,
    urls: ({ make, model }) => [`https://www.aaaauto.cz/ojete-vozy/${make ? `${slug(make)}/${model ? `${slug(model)}/` : ''}` : ''}`],
  },
];

function titleFrom(card, url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p).replace(/\.php$/, '')).filter((p) => !/^(s-anzeige|inzerat|detail)$/.test(p) && !/^[\d-]+$/.test(p));
  const fromSlug = parts.sort((a, b) => b.length - a.length)[0]?.replace(/-/g, ' ') ?? '';
  return (fromSlug.length >= 6 ? fromSlug : card.replace(/\s+/g, ' ').trim()).slice(0, 90);
}

export function yearOf(card, currentYear = new Date().getFullYear()) {
  const withoutDates = card.replace(/\b\d{1,2}\.\s?\d{1,2}\.\s?\d{4}\b/g, ' ').replace(/(t[üu]v|hu|stk)\D{0,12}\d{1,2}[./]\s?\d{2,4}/gi, ' ');
  const years = [...withoutDates.matchAll(/\b(19[89]\d|20[0-3]\d)\b/g)].map((m) => Number(m[1])).filter((y) => y <= currentYear);
  return years.length ? years[0] : null;
}

function walk(value, visit) {
  if (Array.isArray(value)) return value.forEach((v) => walk(v, visit));
  if (value && typeof value === 'object') {
    visit(value);
    Object.values(value).forEach((v) => walk(v, visit));
  }
}

function typesOf(node) {
  return [].concat(node['@type'] ?? []).map(String);
}

export function extractStructuredListings(html, base, market) {
  const found = new Map();
  for (const block of String(html ?? '').matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(block[1]);
    } catch {
      continue;
    }
    walk(data, (node) => {
      if (!typesOf(node).some((t) => /^(Car|Vehicle|Product|Motorcycle)$/.test(t))) return;
      const offer = [].concat(node.offers ?? [])[0];
      const price = Number(offer?.price ?? offer?.lowPrice);
      const link = String(node.url ?? offer?.url ?? node['@id'] ?? '').replace(/[?#].*$/, '');
      if (!link || !Number.isFinite(price) || !market.listing.test(new URL(link, base).pathname)) return;
      const url = new URL(link, base).toString();
      const year = Number(String(node.dateVehicleFirstRegistered ?? node.productionDate ?? node.modelDate ?? '').slice(0, 4)) || null;
      found.set(url, {
        title: String(node.name ?? '').slice(0, 90),
        url,
        price,
        currency: String(offer?.priceCurrency ?? market.currency),
        year,
        km: Number(node.mileageFromOdometer?.value) || null,
        marketplace: market.id,
        country: market.country,
        structured: true,
      });
    });
  }
  return [...found.values()].slice(0, MAX_LISTINGS);
}

export function extractListings(html, base, market) {
  const structured = extractStructuredListings(html, base, market);
  if (structured.length) return structured;
  const pattern = new RegExp(`href=["']((?:https?://[^"'/]+)?${market.listing.source})[^"']*["']`, 'g');
  const hits = [];
  const seen = new Set();
  for (const m of String(html ?? '').matchAll(pattern)) {
    const url = new URL(m[1].replace(/#.*$/, ''), base).toString();
    if (seen.has(url)) continue;
    seen.add(url);
    hits.push({ url, at: m.index });
  }
  return hits.slice(0, MAX_LISTINGS).map((hit, i) => {
    const card = htmlToText(String(html).slice(hit.at, hits[i + 1]?.at ?? hit.at + 4000)).replace(/^[^>]*>/, '').replace(/\s+/g, ' ');
    const price = parseAmounts(card).find((a) => a.currency === market.currency && a.value >= 100) ?? null;
    const year = yearOf(card);
    const km = card.match(/(?<![\d.,])(\d{1,3}(?:\.\d{3})+|\d{1,3}(?:[ \u00a0]\d{3})+|\d{4,6})\s?km\b/i);
    return {
      title: titleFrom(card, hit.url),
      url: hit.url,
      price: price?.value ?? null,
      currency: market.currency,
      year,
      km: km ? Number(km[1].replace(/[ .\u00a0]/g, '')) : null,
      marketplace: market.id,
      country: market.country,
    };
  });
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function listingStats(listings) {
  const prices = listings.map((l) => l.priceEur).filter((v) => v !== null && v !== undefined);
  return { count: listings.length, priced: prices.length, medianEur: median(prices), minEur: prices.length ? Math.min(...prices) : null, maxEur: prices.length ? Math.max(...prices) : null };
}

export class MarketplaceService {
  constructor({ fetchImpl = fetch, robots, rates, markets = MARKETPLACES }) {
    this.fetchImpl = fetchImpl;
    this.robots = robots;
    this.rates = rates;
    this.markets = markets;
    this.lastErrors = [];
  }

  async page(url, cache) {
    if (cache?.has(url)) return cache.get(url);
    if (this.robots && !(await this.robots.allowed(url))) throw new Error(`robots.txt disallows ${url}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await this.fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' }, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const html = await res.text();
      cache?.set(url, html);
      return html;
    } finally {
      clearTimeout(timer);
    }
  }

  async scanModels({ from = 'DE', to = 'CZ', minEur = 0, maxEur = 1000000, models = DEFAULT_SCAN_MODELS } = {}) {
    const cache = new Map();
    const rows = [];
    for (const [make, model] of models) {
      const results = await this.search({ countries: [from, to], minEur, maxEur, make, model }, cache);
      const side = (country) => results.filter((r) => r.country === country).flatMap((r) => r.listings);
      const fromListings = side(from);
      const toListings = side(to);
      const a = listingStats(fromListings);
      const b = listingStats(toListings);
      const comparable = a.count >= MIN_SAMPLE && b.count >= MIN_SAMPLE;
      rows.push({
        make,
        model,
        from: { country: from, ...a },
        to: { country: to, ...b },
        gapPct: comparable ? Math.round(((b.medianEur - a.medianEur) / a.medianEur) * 1000) / 10 : null,
        cheapest: fromListings.filter((l) => l.priceEur !== null).sort((x, y) => x.priceEur - y.priceEur).slice(0, 3),
      });
    }
    return rows.sort((x, y) => (y.gapPct ?? -Infinity) - (x.gapPct ?? -Infinity));
  }

  async search({ countries = [], minEur = 0, maxEur = 1000000, make = '', model = '' } = {}, cache = null) {
    const convert = this.rates ? await this.rates.converter() : (v) => v;
    const markets = this.markets.filter((m) => !countries.length || countries.includes(m.country));
    this.lastErrors = [];
    const results = [];
    for (const market of markets) {
      const listings = [];
      const fetched = [];
      for (const url of market.urls({ make, model })) {
        try {
          listings.push(...extractListings(await this.page(url, cache), url, market));
          fetched.push(url);
        } catch (error) {
          this.lastErrors.push(`${market.id}: ${error.message}`);
        }
      }
      const unique = [...new Map(listings.map((l) => [l.url, l])).values()].map((l) => ({ ...l, priceEur: l.price === null ? null : Math.round(convert(l.price, market.currency, 'EUR') ?? l.price) }));
      const wanted = new RegExp(slug(model || make).replace(/-/g, '.?') || '.', 'i');
      const inRange = unique.filter((l) => l.priceEur !== null && l.priceEur >= minEur && l.priceEur <= maxEur && wanted.test(slug(`${l.title} ${l.url}`)));
      results.push({ market: market.id, country: market.country, currency: market.currency, pages: fetched, listings: inRange, stats: listingStats(inRange) });
    }
    return results;
  }
}

export function trendLine(history, stats) {
  const previous = history.filter((h) => h.medianEur !== null && h.medianEur !== undefined);
  if (!previous.length || stats.medianEur === null) return 'trend: first snapshot, no history yet';
  const first = previous[0];
  const change = ((stats.medianEur - first.medianEur) / first.medianEur) * 100;
  return `trend: median ${first.medianEur} EUR on ${String(first.ts).slice(0, 10)} → ${stats.medianEur} EUR now (${change >= 0 ? '+' : ''}${change.toFixed(1)}%, ${previous.length + 1} snapshots); listings ${first.count} → ${stats.count}`;
}

export function scanSource(rows, spec, id, histories = {}) {
  const lines = rows.map((r, i) => `${i + 1}. ${r.make} ${r.model} | ${r.from.country} n=${r.from.count} median ${r.from.medianEur ?? 'n/a'} EUR | ${r.to.country} n=${r.to.count} median ${r.to.medianEur ?? 'n/a'} EUR | gap ${r.gapPct === null ? `not comparable (needs ${MIN_SAMPLE}+ listings each side)` : `${r.gapPct >= 0 ? '+' : ''}${r.gapPct}%`} | ${trendLine(histories[`${r.make} ${r.model}`] ?? [], r.from)}`);
  const picks = rows.filter((r) => r.gapPct !== null && r.gapPct > 0).flatMap((r) => r.cheapest.map((l) => ({ ...l, model: `${r.make} ${r.model}` })));
  const header = `Model price-gap scan read by code (robots.txt-allowed pages only), ${spec.from}→${spec.to}, ${spec.minEur}-${spec.maxEur} EUR, prices converted at ECB rates. Gap = (${spec.to} median − ${spec.from} median) / ${spec.from} median, before transport, registration and taxes.`;
  return {
    id,
    kind: 'data',
    title: `Model price-gap scan ${spec.from}→${spec.to}`,
    url: '',
    domain: 'marketplace-scan',
    snippet: header,
    text: `${header}\n${lines.join('\n')}\nCheapest ${spec.from} listings of models with a positive gap:\n${picks.map((l) => `- ${l.model} | ${l.title} | ${l.price} ${l.currency} | ${l.year ?? '?'} | ${l.km ?? '?'} km | ${l.url}`).join('\n') || 'none'}`,
    links: picks.map((l) => ({ url: l.url, text: `${l.model} ${l.title} ${l.price} ${l.currency}` })),
    provider: 'marketplace',
    listings: picks,
    scan: rows,
  };
}

export function listingsSource(result, id, history = []) {
  const s = result.stats;
  const header = `${result.market} (${result.country}) — ${s.count} listings in the price range, read by code from ${result.pages.length} page(s) allowed by robots.txt; median ${s.medianEur ?? 'n/a'} EUR, range ${s.minEur ?? 'n/a'}–${s.maxEur ?? 'n/a'} EUR (converted at ECB rates).`;
  const rows = result.listings.slice(0, 25).map((l) => `- ${l.title} | ${l.price ?? '?'} ${l.currency}${l.priceEur !== null && l.currency !== 'EUR' ? ` (≈${l.priceEur} EUR)` : ''} | ${l.year ?? '?'} | ${l.km ?? '?'} km | ${l.url}`);
  return {
    id,
    kind: 'data',
    title: `${result.market} listings (${result.country})`,
    url: result.pages[0] ?? '',
    domain: new URL(result.pages[0] ?? 'https://unknown.invalid').hostname.replace(/^www\./, ''),
    snippet: header,
    text: `${header}\n${rows.join('\n')}`,
    links: result.listings.map((l) => ({ url: l.url, text: `${l.title} ${l.price ?? ''} ${l.currency}` })),
    provider: 'marketplace',
    listings: result.listings,
    stats: result.stats,
  };
}
