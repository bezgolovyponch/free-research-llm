import { absoluteUrl, domainOf, htmlToText } from './html.mjs';
import { sourceCountry } from '../research/brief.mjs';
import { extractListings, listingKey } from './listings.mjs';
import { selectDiverse } from './selection.mjs';
import { pageCoordinates } from '../research/site.mjs';
const USER_AGENT = 'free-research-llm/1.0 (+https://github.com/bezgolovyponch/free-research-llm)';
const PAGE_TEXT_LIMIT = 6000;
const MAX_LINKS = 60;
const MIN_LISTINGS_FOR_RECIPE = 3;
export const PAGE_CACHE_TTL_MS = 6 * 3600 * 1000;
export const PAGE_CACHE_SIZE = 300;

export function pageLocale(html) {
  const head = String(html ?? '').slice(0, 20000);
  const og = head.match(/<meta[^>]+property=["']og:locale["'][^>]+content=["']([A-Za-z]{2,3}[-_][A-Za-z]{2})["']/i)?.[1] ?? head.match(/<meta[^>]+content=["']([A-Za-z]{2,3}[-_][A-Za-z]{2})["'][^>]+property=["']og:locale["']/i)?.[1];
  return og ?? head.match(/<html[^>]*\blang=["']([A-Za-z]{2,3}(?:[-_][A-Za-z]{2})?)["']/i)?.[1] ?? '';
}

export class SearchHttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }

  get exhausted() {
    return [401, 402, 403, 429, 432, 433].includes(this.status);
  }

  get invalidKey() {
    return [401, 403].includes(this.status);
  }
}

const STOPWORDS = new Set('the a an and or of in on for to with by from at is are was be what which how many much who when where why does do this that these those per vs into about over under than price prices cost costs current currently 2024 2025 2026 2027'.split(' '));

export function tokens(textValue) {
  return String(textValue ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export function keywords(textValue) {
  return [...new Set(tokens(textValue))];
}

export function isRelevant(result, query) {
  const wanted = keywords(query);
  if (!wanted.length) return true;
  const haystack = new Set(keywords(`${result.title ?? ''} ${result.snippet ?? ''} ${String(result.text ?? '').slice(0, 1500)} ${result.url ?? ''}`));
  const hits = wanted.filter((w) => haystack.has(w)).length;
  return hits >= Math.min(2, wanted.length);
}

function itemScore(link) {
  let score = 0;
  if (/\d[\d .,]*\s?(€|eur|zł|pln|kč|czk|\$|£)/i.test(link.text)) score += 3;
  if (/\d{5,}|[a-z0-9]{8,}\.html?$|\/(id|offer|oferta|inzerat|detail|angebot|listing|ad)[/-]/i.test(link.url)) score += 2;
  if (link.text.split(' ').length >= 3) score += 1;
  if (/login|register|cookie|privacy|impressum|kontakt|contact|help|faq|terms|agb|newsletter|app-store|play\.google/i.test(link.url + link.text)) score -= 4;
  return score;
}

function rankLinks(links, base) {
  const host = domainOf(base);
  const seen = new Set([absoluteUrl(base, base)]);
  const unique = links.filter((l) => l.url && l.text && !seen.has(l.url) && seen.add(l.url));
  const sameSite = unique.filter((l) => domainOf(l.url).endsWith(host) || host.endsWith(domainOf(l.url)));
  const deep = (l) => new URL(l.url).pathname.split('/').filter(Boolean).length >= 2 || /\d{4,}/.test(l.url);
  const ordered = [...sameSite.filter(deep), ...sameSite.filter((l) => !deep(l)), ...unique.filter((l) => !sameSite.includes(l))];
  return ordered.map((l, i) => ({ l, i, s: itemScore(l) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.l).slice(0, MAX_LINKS);
}

export function extractLinks(html, base) {
  const links = [];
  for (const m of String(html ?? '').matchAll(/<a\s[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    links.push({ url: absoluteUrl(m[1], base), text: htmlToText(m[2]).replace(/\s+/g, ' ').slice(0, 100) });
  }
  return rankLinks(links, base);
}

export function extractMarkdownLinks(markdown, base) {
  const links = [];
  for (const m of String(markdown ?? '').matchAll(/(?<!!)\[([^\]]{1,160})\]\((https?:\/\/[^)\s]+)\)/g)) {
    links.push({ url: absoluteUrl(m[2], base), text: m[1].replace(/\s+/g, ' ').trim().slice(0, 100) });
  }
  return rankLinks(links, base);
}

async function fetchJson(fetchImpl, url, init = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new SearchHttpError(res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class TavilyBackend {
  constructor({ apiKey, fetchImpl }) {
    this.id = 'tavily';
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.fullText = true;
  }

  async search(query, limit) {
    const body = await fetchJson(this.fetchImpl, 'https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query, max_results: limit, search_depth: 'basic', include_raw_content: 'text' }),
    });
    return (body.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '', text: String(r.raw_content ?? r.content ?? '').slice(0, PAGE_TEXT_LIMIT) }));
  }
}

export class BraveBackend {
  constructor({ apiKey, fetchImpl }) {
    this.id = 'brave';
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async search(query, limit) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
    const body = await fetchJson(this.fetchImpl, url, { headers: { accept: 'application/json', 'x-subscription-token': this.apiKey } });
    return (body.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: htmlToText(r.description ?? '') }));
  }
}

export class ExaBackend {
  constructor({ apiKey, fetchImpl }) {
    this.id = 'exa';
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.fullText = true;
  }

  async search(query, limit) {
    const body = await fetchJson(this.fetchImpl, 'https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
      body: JSON.stringify({ query, numResults: limit, contents: { text: { maxCharacters: PAGE_TEXT_LIMIT } } }),
    });
    return (body.results ?? []).map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: String(r.text ?? '').slice(0, 300), text: String(r.text ?? '').slice(0, PAGE_TEXT_LIMIT) }));
  }
}

export class SerperBackend {
  constructor({ apiKey, fetchImpl }) {
    this.id = 'serper';
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async search(query, limit) {
    const body = await fetchJson(this.fetchImpl, 'https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
      body: JSON.stringify({ q: query, num: limit }),
    });
    return (body.organic ?? []).slice(0, limit).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet ?? '' }));
  }
}

export class LangSearchBackend {
  constructor({ apiKey, fetchImpl }) {
    this.id = 'langsearch';
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.fullText = true;
  }

  async search(query, limit) {
    const body = await fetchJson(this.fetchImpl, 'https://api.langsearch.com/v1/web-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query, count: limit, freshness: 'noLimit', contents: { text: { maxCharacters: PAGE_TEXT_LIMIT } } }),
    }, 20000);
    return (body.data?.webPages?.value ?? []).map((r) => ({ title: r.name ?? r.url, url: r.url, snippet: String(r.snippet ?? r.text ?? '').slice(0, 300), text: String(r.text ?? r.snippet ?? '').slice(0, PAGE_TEXT_LIMIT) }));
  }
}

export class LinkupBackend {
  constructor({ apiKey, fetchImpl }) {
    this.id = 'linkup';
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async search(query, limit) {
    const body = await fetchJson(this.fetchImpl, 'https://api.linkup.so/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ q: query, depth: 'fast', outputType: 'searchResults' }),
    }, 20000);
    return (body.results ?? []).filter((r) => r.url).slice(0, limit).map((r) => ({ title: r.name ?? r.url, url: r.url, snippet: String(r.content ?? '').slice(0, 400), text: String(r.content ?? '').slice(0, PAGE_TEXT_LIMIT) }));
  }
}

export class JinaSearchBackend {
  constructor({ apiKey, fetchImpl }) {
    this.id = 'jina';
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.fullText = true;
  }

  async search(query, limit) {
    const body = await fetchJson(this.fetchImpl, `https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${this.apiKey}` },
    }, 30000);
    return (body.data ?? []).slice(0, limit).map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: String(r.description ?? '').slice(0, 400), text: String(r.content ?? r.description ?? '').slice(0, PAGE_TEXT_LIMIT) }));
  }
}

export class FirecrawlBackend {
  constructor({ apiKey, fetchImpl }) {
    this.id = 'firecrawl';
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async search(query, limit) {
    const body = await fetchJson(this.fetchImpl, 'https://api.firecrawl.dev/v2/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query, limit }),
    }, 20000);
    const web = Array.isArray(body.data) ? body.data : body.data?.web ?? [];
    return web.slice(0, limit).map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: String(r.description ?? '').slice(0, 400) }));
  }
}

export class SearxngBackend {
  constructor({ baseURL, fetchImpl }) {
    this.id = 'searxng';
    this.baseURL = baseURL.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async search(query, limit) {
    const body = await fetchJson(this.fetchImpl, `${this.baseURL}/search?q=${encodeURIComponent(query)}&format=json`, { headers: { accept: 'application/json' } });
    return (body.results ?? []).slice(0, limit).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
  }
}

export function encyclopediaQueries(query) {
  const cleaned = String(query)
    .replace(/["“”]/g, ' ')
    .replace(/\b[\w-]+\.(?:de|pl|cz|com|org|net|eu|co\.uk)\b/gi, ' ')
    .replace(/\b(?:price|prices|median|average|cost|costs|current|rate|per|day|how|much|what|is|the|in|of|for|and|vs)\b/gi, ' ')
    .replace(/\b\d+(?:[-–]\d+)?k?\s*(?:km)?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter(Boolean);
  return [...new Set([cleaned, words.slice(0, 3).join(' '), words.slice(0, 2).join(' ')].filter((q) => q.length > 2))];
}

export class WikipediaBackend {
  constructor({ fetchImpl, lang = 'en' }) {
    this.id = 'wikipedia';
    this.fallback = true;
    this.fetchImpl = fetchImpl;
    this.lang = lang;
    this.fullText = true;
  }

  async findPages(query, limit) {
    const host = `https://${this.lang}.wikipedia.org`;
    for (const q of encyclopediaQueries(query)) {
      const found = await fetchJson(this.fetchImpl, `${host}/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=${limit}`, { headers: { 'user-agent': USER_AGENT } });
      if (found.pages?.length) return found.pages.slice(0, limit);
    }
    return [];
  }

  async search(query, limit) {
    const host = `https://${this.lang}.wikipedia.org`;
    const pages = await this.findPages(query, limit);
    const results = [];
    for (const page of pages) {
      let text = htmlToText(page.excerpt ?? '');
      try {
        const summary = await fetchJson(this.fetchImpl, `${host}/api/rest_v1/page/summary/${encodeURIComponent(page.key)}`, { headers: { 'user-agent': USER_AGENT } }, 6000);
        text = summary.extract || text;
      } catch {
        text ||= page.description ?? '';
      }
      results.push({ title: page.title, url: `${host}/wiki/${encodeURIComponent(page.key)}`, snippet: page.description ?? '', text: text.slice(0, PAGE_TEXT_LIMIT) });
    }
    return results;
  }
}

export const KEYED_SEARCH_BACKENDS = [
  ['LANGSEARCH_API_KEY', LangSearchBackend],
  ['TAVILY_API_KEY', TavilyBackend],
  ['EXA_API_KEY', ExaBackend],
  ['LINKUP_API_KEY', LinkupBackend],
  ['JINA_API_KEY', JinaSearchBackend],
  ['FIRECRAWL_API_KEY', FirecrawlBackend],
  ['SERPER_API_KEY', SerperBackend],
  ['BRAVE_API_KEY', BraveBackend],
];

export class SearchService {
  constructor({ backends = [], fetchImpl = fetch, fetchPages = true, jinaReader = true, resultsPerQuery = 4, jinaKey = '', now = () => Date.now(), blockMs = 60 * 60 * 1000, recipes = null }) {
    this.backends = backends;
    this.recipes = recipes;
    this.pages = new Map();
    this.jinaKey = jinaKey;
    this.now = now;
    this.blockMs = blockMs;
    this.blockedUntil = new Map();
    this.health = new Map();
    this.cursor = 0;
    this.fetchImpl = fetchImpl;
    this.fetchPages = fetchPages;
    this.jinaReader = jinaReader;
    this.resultsPerQuery = resultsPerQuery;
    this.lastErrors = [];
  }

  get enabled() {
    return this.backends.length > 0;
  }

  async fetchPage(url, accept, extraHeaders = {}, listingBase = url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await this.fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept, ...extraHeaders }, signal: controller.signal });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !/text\/(html|plain|markdown)/.test(type)) return { text: '', links: [], listings: [], next: '', status: res.status };
      const body = await res.text();
      const html = /html/.test(type);
      const base = html ? res.url || url : listingBase;
      const found = extractListings(body, base, { isHtml: html, recipe: this.recipes?.get(base) ?? null });
      return {
        text: (html ? htmlToText(body) : body.trim()).slice(0, PAGE_TEXT_LIMIT),
        links: html ? extractLinks(body, base) : extractMarkdownLinks(body, base),
        listings: found.items,
        next: found.next,
        template: found.template,
        methods: found.methods,
        locale: html ? pageLocale(body) : '',
        coords: html ? pageCoordinates(body) : null,
        status: res.status,
      };
    } catch {
      return { text: '', links: [], listings: [], next: '', status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  async readRaw(url) {
    const direct = await this.fetchPage(url, 'text/html,text/plain');
    if ((direct.text.length >= 400 && direct.listings.length) || !this.jinaReader) return direct;
    if (direct.text.length >= 400 && !this.recipes?.get(url)) return direct;
    const viaReader = await this.fetchPage(`https://r.jina.ai/${url}`, 'text/plain', this.jinaKey ? { authorization: `Bearer ${this.jinaKey}` } : {}, url);
    if (viaReader.text.length <= direct.text.length && viaReader.listings.length <= direct.listings.length) return direct;
    return { ...viaReader, via: 'jina' };
  }

  async readPage(url) {
    const hit = this.pages.get(url);
    if (hit && this.now() - hit.at < PAGE_CACHE_TTL_MS) return hit.page;
    const page = await this.readFresh(url);
    this.pages.delete(url);
    if (page.status >= 200 && page.status < 400) this.pages.set(url, { at: this.now(), page });
    while (this.pages.size > PAGE_CACHE_SIZE) this.pages.delete(this.pages.keys().next().value);
    return page;
  }

  async readFresh(url) {
    await this.recipes?.load();
    const page = await this.readRaw(url);
    if (!this.recipes) return page;
    const priced = page.listings.filter((l) => l.value !== null && l.value !== undefined).length;
    if (priced >= MIN_LISTINGS_FOR_RECIPE) this.recipes.learn(url, { template: page.template, methods: page.methods, count: page.listings.length, country: sourceCountry({ url, locale: page.locale, text: page.text }), sample: page.listings.map((l) => l.title) });
    else if (page.status >= 200 && page.status < 400 && this.recipes.get(url) && !page.listings.length && page.next) this.recipes.miss(url);
    if (priced < MIN_LISTINGS_FOR_RECIPE || !page.next || !this.recipes.needsCheck(url)) return page;
    const second = await this.readRaw(page.next);
    const ok = this.recipes.verify(url, { count: second.listings.length, template: second.template });
    if (!ok) return page;
    const seen = new Set(page.listings.map((l) => listingKey(l.url)));
    const more = second.listings.filter((l) => !seen.has(listingKey(l.url))).map((l) => ({ ...l, page: page.next }));
    return { ...page, listings: [...page.listings, ...more], next: second.next || page.next, pagesRead: 2 };
  }

  async readPages(urls) {
    const pages = await Promise.all(urls.slice(0, 4).map(async (url) => ({ url, ...(await this.readPage(url)) })));
    return pages.filter((p) => p.text).map((p) => ({
      kind: 'web',
      title: `${domainOf(p.url)} page`,
      url: p.url,
      domain: domainOf(p.url),
      snippet: p.text.slice(0, 300),
      text: p.text,
      links: p.links,
      listings: p.listings ?? [],
      locale: p.locale ?? '',
      provider: p.via ? `direct+${p.via}` : 'direct',
      query: '',
    }));
  }

  rotation() {
    const live = this.backends.filter((b) => (this.blockedUntil.get(b.id) ?? 0) <= this.now());
    const primary = live.filter((b) => !b.fallback);
    const start = primary.length ? this.cursor++ % primary.length : 0;
    return [...primary.slice(start), ...primary.slice(0, start), ...live.filter((b) => b.fallback)];
  }

  async search(queries, { maxSources = 6, exclude = [], wanted = [], entities = [], usedDomains = {}, names = [] } = {}) {
    const seen = new Set(exclude);
    const collected = [];
    this.lastErrors = [];
    for (const query of queries.filter(Boolean)) {
      for (const backend of this.rotation()) {
        try {
          const results = await backend.search(query, this.resultsPerQuery);
          this.health.set(backend.id, { ok: true, at: new Date(this.now()).toISOString(), results: results.length });
          for (const r of results) {
            if (!r.url || seen.has(r.url)) continue;
            if (!isRelevant(r, query)) {
              this.lastErrors.push(`${backend.id}: dropped off-topic "${String(r.title).slice(0, 40)}"`);
              continue;
            }
            seen.add(r.url);
            collected.push({ ...r, provider: backend.id, query, fullText: Boolean(backend.fullText) });
          }
          if (results.length) break;
        } catch (error) {
          this.lastErrors.push(`${backend.id}: ${error.message}`);
          if (error.exhausted) this.blockedUntil.set(backend.id, error.invalidKey ? Infinity : this.now() + this.blockMs);
          this.health.set(backend.id, { ok: false, at: new Date(this.now()).toISOString(), error: error.invalidKey ? `invalid key (${error.message}) — fix it with ./keys.command check` : error.message });
        }
      }
      if (collected.length >= maxSources * 3) break;
    }
    const sources = selectDiverse(collected, { max: maxSources, wanted, entities, usedDomains, names });
    if (this.fetchPages) {
      await Promise.all(sources.slice(0, 5).map(async (s) => {
        const page = await this.readPage(s.url);
        s.links = page.links;
        s.listings = page.listings ?? [];
        s.locale = page.locale ?? '';
        if (page.text.length > String(s.text ?? '').length) s.text = page.text;
      }));
    }
    return sources.map((s) => ({
      kind: 'web',
      title: String(s.title ?? s.url).slice(0, 160),
      url: s.url,
      domain: domainOf(s.url),
      snippet: String(s.snippet ?? '').slice(0, 400),
      text: String(s.text || s.snippet || '').slice(0, PAGE_TEXT_LIMIT),
      links: s.links ?? [],
      listings: s.listings ?? [],
      locale: s.locale ?? '',
      provider: s.provider,
      query: s.query,
      tier: s.tier,
    }));
  }

  describe() {
    const blocked = this.backends.filter((b) => (this.blockedUntil.get(b.id) ?? 0) > this.now()).map((b) => b.id);
    return { enabled: this.enabled, backends: this.backends.map((b) => b.id), blocked, health: Object.fromEntries(this.health), lastErrors: this.lastErrors, recipes: this.recipes?.describe() ?? [] };
  }
}
