import { describe, expect, it } from 'vitest';
import { KeyChecker, cleanKey, formatHint } from '../src/keycheck.mjs';
import { fakeFetch, jsonResponse } from './helpers/fake-fetch';

describe('cleanKey and formatHint', () => {
  it('strips bracketed-paste markers, control characters, quotes and spaces', () => {
    expect(cleanKey('\u001b[200~ "sk-abc123"\n\u001b[201~')).toBe('sk-abc123');
  });

  it('spots a key whose first characters were lost when pasting', () => {
    expect(formatHint('LANGSEARCH_API_KEY', 'k-c0ffee')).toMatchObject({ problem: 'cut', fixed: 'sk-c0ffee' });
    expect(formatHint('GROQ_API_KEY', 'sk_abc')).toMatchObject({ problem: 'cut', fixed: 'gsk_abc' });
    expect(formatHint('TAVILY_API_KEY', 'zzz')).toMatchObject({ problem: 'prefix' });
    expect(formatHint('GEMINI_API_KEY', 'AQ.newformat')).toBeNull();
    expect(formatHint('GROQ_API_KEY', 'gsk_ok')).toBeNull();
  });
});

describe('KeyChecker', () => {
  it('repairs a cut-off key only when the provider accepts the repaired one', async () => {
    const fetchImpl = fakeFetch([[/langsearch/, (url, init) => ((init.headers as Record<string, string>).authorization === 'Bearer sk-good' ? jsonResponse({ data: { webPages: { value: [] } } }) : jsonResponse({ message: 'Invalid API KEY' }, 401))]]);
    const checker = new KeyChecker({ fetchImpl });
    expect(await checker.verify('LANGSEARCH_API_KEY', ' k-good ')).toMatchObject({ ok: true, value: 'sk-good', repaired: expect.stringMatching(/first 1 character/) });
    expect(await checker.verify('LANGSEARCH_API_KEY', 'k-bad')).toMatchObject({ ok: false, value: 'k-bad', hint: expect.stringMatching(/lost when pasting/) });
  });

  it('checks model keys against the provider model list and SearXNG by URL', async () => {
    const fetchImpl = fakeFetch([
      [/api\.groq\.com\/openai\/v1\/models/, (url, init) => ((init.headers as Record<string, string>).authorization === 'Bearer gsk_x' ? jsonResponse({ data: [] }) : jsonResponse({ error: 'bad' }, 401))],
      [/127\.0\.0\.1:8888\/search/, () => jsonResponse({ results: [] })],
    ]);
    const checker = new KeyChecker({ fetchImpl });
    expect((await checker.verify('GROQ_API_KEY', 'gsk_x')).ok).toBe(true);
    expect((await checker.verify('GROQ_API_KEY', 'gsk_y')).detail).toMatch(/HTTP 401/);
    expect((await checker.verify('SEARXNG_URL', 'http://127.0.0.1:8888/')).ok).toBe(true);
    expect((await checker.verify('CLOUDFLARE_ACCOUNT_ID', 'abc')).ok).toBeNull();
  });
});
