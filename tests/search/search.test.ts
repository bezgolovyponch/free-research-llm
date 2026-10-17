import { describe, expect, it } from 'vitest';
import { BraveBackend, SearchService, TavilyBackend, WikipediaBackend, htmlToText } from '../../src/search/search.mjs';
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
});
