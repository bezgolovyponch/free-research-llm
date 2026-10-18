import { describe, expect, it } from 'vitest';
import { BraveBackend, ExaBackend, FirecrawlBackend, JinaSearchBackend, LangSearchBackend, LinkupBackend, SearchService, SerperBackend, TavilyBackend, WikipediaBackend, htmlToText } from '../../src/search/search.mjs';
import { fakeFetch, jsonResponse } from '../helpers/fake-fetch';

describe('search', () => {
  it('strips scripts and tags from HTML', () => {
    expect(htmlToText('<p>Hi&amp;bye</p><script>x()</script><b>there</b>')).toBe('Hi&bye\n there');
  });

  it('dedupes results, falls back across backends and records errors', async () => {
    const fetchImpl = fakeFetch([
      [/tavily/, () => new Response('quota', { status: 432 })],
      [/search\.brave/, () => jsonResponse({ web: { results: [{ title: 'A', url: 'https://a.cz/1', description: '<b>x</b>' }, { title: 'A again', url: 'https://a.cz/1' }] } })],
      [/a\.cz/, () => new Response('<html><body><p>Price 100</p></body></html>', { headers: { 'content-type': 'text/html' } })],
    ]);
    const service = new SearchService({ fetchImpl, backends: [new TavilyBackend({ apiKey: 't', fetchImpl }), new BraveBackend({ apiKey: 'b', fetchImpl })] });
    const sources = await service.search(['q1']);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ kind: 'web', url: 'https://a.cz/1', domain: 'a.cz', provider: 'brave', snippet: 'x', text: 'Price 100' });
    expect(service.lastErrors.join()).toMatch(/tavily: HTTP 432/);
  });

  it('reads Wikipedia without a key', async () => {
    const fetchImpl = fakeFetch([
      [/rest\.php\/v1\/search\/page/, () => jsonResponse({ pages: [{ key: 'Glamping', title: 'Glamping', excerpt: '<span>glamorous</span> camping', description: 'camping' }] })],
      [/page\/summary\/Glamping/, () => jsonResponse({ extract: 'Glamping is glamorous camping.' })],
    ]);
    const sources = await new SearchService({ fetchImpl, backends: [new WikipediaBackend({ fetchImpl })] }).search(['glamping']);
    expect(sources[0]).toMatchObject({ url: 'https://en.wikipedia.org/wiki/Glamping', text: 'Glamping is glamorous camping.' });
  });

  it('maps Exa and Serper results and sends their auth headers', async () => {
    const fetchImpl = fakeFetch([
      [/api\.exa\.ai/, () => jsonResponse({ results: [{ title: 'E', url: 'https://e.example/', text: 'exa text' }] })],
      [/google\.serper\.dev/, () => jsonResponse({ organic: [{ title: 'S', link: 'https://s.example/', snippet: 'serp' }] })],
    ]);
    expect(await new ExaBackend({ apiKey: 'ek', fetchImpl }).search('q', 3)).toEqual([{ title: 'E', url: 'https://e.example/', snippet: 'exa text', text: 'exa text' }]);
    expect(await new SerperBackend({ apiKey: 'sk', fetchImpl }).search('q', 3)).toEqual([{ title: 'S', url: 'https://s.example/', snippet: 'serp' }]);
    expect((fetchImpl.calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('ek');
    expect(JSON.parse(String(fetchImpl.calls[1].init.body))).toEqual({ q: 'q', num: 3 });
  });

  it('maps LangSearch, Linkup, Jina and Firecrawl results with bearer auth', async () => {
    const fetchImpl = fakeFetch([
      [/langsearch/, () => jsonResponse({ data: { webPages: { value: [{ name: 'L', url: 'https://l.example/', text: 'lang text' }] } } })],
      [/linkup/, () => jsonResponse({ results: [{ type: 'text', name: 'K', url: 'https://k.example/', content: 'link text' }] })],
      [/s\.jina\.ai/, () => jsonResponse({ data: [{ title: 'J', url: 'https://j.example/', description: 'd', content: 'jina text' }] })],
      [/firecrawl/, () => jsonResponse({ success: true, data: { web: [{ title: 'F', url: 'https://f.example/', description: 'fire' }] } })],
    ]);
    expect(await new LangSearchBackend({ apiKey: 'lk', fetchImpl }).search('q', 3)).toEqual([{ title: 'L', url: 'https://l.example/', snippet: 'lang text', text: 'lang text' }]);
    expect(await new LinkupBackend({ apiKey: 'kk', fetchImpl }).search('q', 3)).toEqual([{ title: 'K', url: 'https://k.example/', snippet: 'link text', text: 'link text' }]);
    expect(await new JinaSearchBackend({ apiKey: 'jk', fetchImpl }).search('q', 3)).toEqual([{ title: 'J', url: 'https://j.example/', snippet: 'd', text: 'jina text' }]);
    expect(await new FirecrawlBackend({ apiKey: 'fk', fetchImpl }).search('q', 3)).toEqual([{ title: 'F', url: 'https://f.example/', snippet: 'fire' }]);
    expect(fetchImpl.calls.map((c) => (c.init.headers as Record<string, string>).authorization)).toEqual(['Bearer lk', 'Bearer kk', 'Bearer jk', 'Bearer fk']);
    expect(JSON.parse(String(fetchImpl.calls[0].init.body))).toMatchObject({ query: 'q', count: 3 });
    expect(JSON.parse(String(fetchImpl.calls[1].init.body))).toEqual({ q: 'q', depth: 'fast', outputType: 'searchResults' });
  });

  it('rotates the first backend per query, keeps Wikipedia last and blocks exhausted backends', async () => {
    let now = 0;
    const hit = (id: string) => ({ id, async search(q: string) { return [{ title: id, url: `https://${id}.example/${q}`, text: 'x' }]; } });
    const broken = { id: 'broken', async search() { const { SearchHttpError } = await import('../../src/search/search.mjs'); throw new SearchHttpError(429); } };
    const wiki = { ...hit('wiki'), fallback: true };
    const service = new SearchService({ backends: [broken, hit('a'), hit('b'), wiki], fetchPages: false, now: () => now });
    const sources = await service.search(['q1', 'q2', 'q3'], { maxSources: 3 });
    expect(sources.map((s) => s.provider)).toEqual(['a', 'b', 'a']);
    expect(service.describe().blocked).toEqual(['broken']);
    now = 2 * 60 * 60 * 1000;
    expect(service.rotation().map((b) => b.id)).toContain('broken');
    expect(service.rotation().at(-1).id).toBe('wiki');
  });

  it('skips excluded URLs', async () => {
    const backend = { id: 'a', async search() { return [{ title: 'old', url: 'https://old.example' }, { title: 'new', url: 'https://new.example', text: 't' }]; } };
    const sources = await new SearchService({ backends: [backend], fetchPages: false }).search(['q'], { exclude: ['https://old.example'] });
    expect(sources.map((s) => s.url)).toEqual(['https://new.example']);
  });

  it('falls back to the Jina reader when a page yields too little text', async () => {
    const fetchImpl = fakeFetch([
      [/r\.jina\.ai/, () => new Response('Reader text '.repeat(50), { headers: { 'content-type': 'text/plain' } })],
      [/spa\.example/, () => new Response('<div id=app></div>', { headers: { 'content-type': 'text/html' } })],
    ]);
    const { text } = await new SearchService({ fetchImpl, backends: [] }).readPage('https://spa.example/');
    expect(text.startsWith('Reader text')).toBe(true);
    expect((await new SearchService({ fetchImpl, backends: [], jinaReader: false }).readPage('https://spa.example/')).text).toBe('');
  });
});

describe('encyclopedia queries', () => {
  it('strips web-search syntax and falls back to shorter topic queries', async () => {
    const { encyclopediaQueries } = await import('../../src/search/search.mjs');
    expect(encyclopediaQueries('"Toyota RAV4 hybrid" 2018 price Germany mobile.de median')).toEqual(['Toyota RAV4 hybrid Germany', 'Toyota RAV4 hybrid', 'Toyota RAV4']);
    expect(encyclopediaQueries('"margin scheme" used car VAT Poland')).toEqual(['margin scheme used car VAT Poland', 'margin scheme used', 'margin scheme']);
  });
});

describe('links and relevance', () => {
  it('extracts absolute links and ranks listing-like ones first', async () => {
    const { extractLinks, extractMarkdownLinks } = await import('../../src/search/search.mjs');
    const html = '<a href="/login">Login</a><a href="/hilfe">Hilfe</a><a href="/angebot/1234567">VW Golf 1.4 · 2.900 €</a><a href="https://other.example/x">Other</a><a href="#top">top</a>';
    const links = extractLinks(html, 'https://cars.example/list');
    expect(links[0]).toEqual({ url: 'https://cars.example/angebot/1234567', text: 'VW Golf 1.4 · 2.900 €' });
    expect(links.map((l) => l.url)).not.toContain('https://cars.example/list#top');
    expect(links.at(-1).url).toBe('https://cars.example/login');
    expect(extractMarkdownLinks('![img](https://x.example/a.png) [Opel Astra 3 500 €](https://cars.example/ad/77777)', 'https://cars.example')).toEqual([{ url: 'https://cars.example/ad/77777', text: 'Opel Astra 3 500 €' }]);
  });

  it('drops off-topic fallback results and keeps on-topic ones', async () => {
    const { isRelevant, keywords } = await import('../../src/search/search.mjs');
    expect(keywords('What is the price of used cars in Germany 2026?')).toEqual(['used', 'cars', 'germany']);
    expect(isRelevant({ title: 'Hits Radio', snippet: 'a radio station' }, 'used cars Germany')).toBe(false);
    expect(isRelevant({ title: 'Used car market in Germany', snippet: '' }, 'used cars Germany')).toBe(true);
  });
});

describe('search health', () => {
  it('benches an engine with an invalid key for the whole session and reports why', async () => {
    const { SearchService, SearchHttpError } = await import('../../src/search/search.mjs');
    const bad = { id: 'langsearch', async search() { throw new SearchHttpError(401); } };
    const good = { id: 'tavily', async search(q: string) { return [{ title: 't', url: `https://t.example/${q}`, text: 'x' }]; } };
    let now = 0;
    const service = new SearchService({ backends: [bad, good], fetchPages: false, now: () => now });
    await service.search(['q1']);
    now = 10 * 60 * 60 * 1000;
    expect(service.rotation().map((b) => b.id)).toEqual(['tavily']);
    const health = service.describe().health;
    expect(health.langsearch).toMatchObject({ ok: false, error: expect.stringMatching(/invalid key/) });
    expect(health.tavily).toMatchObject({ ok: true, results: 1 });
  });
});

describe('relevance on every engine', () => {
  it('drops off-topic results from keyed engines too', async () => {
    const { SearchService } = await import('../../src/search/search.mjs');
    const engine = { id: 'langsearch', async search() { return [
      { title: 'Brno population', url: 'https://wpr.example/czechia/brno', text: 'Brno population 2025 is about 400,000' },
      { title: 'Rio Branco population', url: 'https://wpr.example/brazil/rio-branco', text: 'population of Rio Branco' },
    ]; } };
    const service = new SearchService({ backends: [engine], fetchPages: false });
    const sources = await service.search(['Brno population 2025']);
    expect(sources.map((s) => s.url)).toEqual(['https://wpr.example/czechia/brno']);
  });
});

