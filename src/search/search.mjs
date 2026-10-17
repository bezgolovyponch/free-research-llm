const USER_AGENT = 'free-research-llm/1.0 (+https://github.com/bezgolovyponch/free-research-llm)';
const PAGE_TEXT_LIMIT = 3500;

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

async function fetchJson(fetchImpl, url, init = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

export class WikipediaBackend {
  constructor({ fetchImpl, lang = 'en' }) {
    this.id = 'wikipedia';
    this.fetchImpl = fetchImpl;
    this.lang = lang;
    this.fullText = true;
  }

  async search(query, limit) {
    const host = `https://${this.lang}.wikipedia.org`;
    const found = await fetchJson(this.fetchImpl, `${host}/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${limit}`, { headers: { 'user-agent': USER_AGENT } });
    const pages = (found.pages ?? []).slice(0, limit);
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

export class SearchService {
  constructor({ backends = [], fetchImpl = fetch, fetchPages = true, jinaReader = true, resultsPerQuery = 4 }) {
    this.backends = backends;
    this.fetchImpl = fetchImpl;
    this.fetchPages = fetchPages;
    this.jinaReader = jinaReader;
    this.resultsPerQuery = resultsPerQuery;
    this.lastErrors = [];
  }

  get enabled() {
    return this.backends.length > 0;
  }

  async fetchText(url, accept) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await this.fetchImpl(url, { headers: { 'user-agent': USER_AGENT, accept }, signal: controller.signal });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !/text\/(html|plain|markdown)/.test(type)) return '';
      const body = await res.text();
      return (/html/.test(type) ? htmlToText(body) : body.trim()).slice(0, PAGE_TEXT_LIMIT);
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  async pageText(url) {
    const direct = await this.fetchText(url, 'text/html,text/plain');
    if (direct.length >= 400 || !this.jinaReader) return direct;
    const viaReader = await this.fetchText(`https://r.jina.ai/${url}`, 'text/plain');
    return viaReader.length > direct.length ? viaReader : direct;
  }

  async search(queries, { maxSources = 6 } = {}) {
    const seen = new Set();
    const collected = [];
    this.lastErrors = [];
    for (const query of queries.filter(Boolean)) {
      for (const backend of this.backends) {
        try {
          const results = await backend.search(query, this.resultsPerQuery);
          for (const r of results) {
            if (!r.url || seen.has(r.url)) continue;
            seen.add(r.url);
            collected.push({ ...r, provider: backend.id, query, fullText: Boolean(backend.fullText) });
          }
          if (results.length) break;
        } catch (error) {
          this.lastErrors.push(`${backend.id}: ${error.message}`);
        }
      }
      if (collected.length >= maxSources) break;
    }
    const sources = collected.slice(0, maxSources);
    if (this.fetchPages) {
      await Promise.all(sources.filter((s) => !s.text).slice(0, 3).map(async (s) => {
        s.text = await this.pageText(s.url);
      }));
    }
    return sources.map((s) => ({
      kind: 'web',
      title: String(s.title ?? s.url).slice(0, 160),
      url: s.url,
      domain: domainOf(s.url),
      snippet: String(s.snippet ?? '').slice(0, 400),
      text: String(s.text || s.snippet || '').slice(0, PAGE_TEXT_LIMIT),
      provider: s.provider,
      query: s.query,
    }));
  }

  describe() {
    return { enabled: this.enabled, backends: this.backends.map((b) => b.id), lastErrors: this.lastErrors };
  }
}
