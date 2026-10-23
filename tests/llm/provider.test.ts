import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS } from '../../src/llm/presets.mjs';
import { OpenAICompatibleProvider, ProviderError, pickModel } from '../../src/llm/provider.mjs';
import { fakeFetch, jsonResponse } from '../helpers/fake-fetch';

const groq = PROVIDER_PRESETS.find((p) => p.id === 'groq')!;
const openrouter = PROVIDER_PRESETS.find((p) => p.id === 'openrouter')!;
const cerebras = PROVIDER_PRESETS.find((p) => p.id === 'cerebras')!;

describe('pickModel', () => {
  it('prefers exact, then partial matches, and skips non-chat models', () => {
    expect(pickModel(['whisper-large', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], ['llama-3.1-8b-instant'])).toBe('llama-3.1-8b-instant');
    expect(pickModel(['text-embedding-004', 'gemini-2.5-flash'], ['flash'])).toBe('gemini-2.5-flash');
    expect(pickModel(['text-embedding-004'], ['x'])).toBeNull();
  });

  it('keeps OpenRouter to :free models', () => {
    expect(pickModel(['deepseek/deepseek-chat', 'deepseek/deepseek-r1:free'], ['deepseek'], true)).toBe('deepseek/deepseek-r1:free');
  });
});

describe('OpenAICompatibleProvider', () => {
  it('picks a vision model only from the vision preferences', async () => {
    const gemini = PROVIDER_PRESETS.find((x) => x.id === 'gemini')!;
    const fetchImpl = fakeFetch([[/\/models$/, () => jsonResponse({ data: [{ id: 'models/gemini-3.5-flash-lite' }, { id: 'models/gemini-3.8-flash' }] })]]);
    const p = await new OpenAICompatibleProvider({ preset: gemini, apiKey: 'k', fetchImpl }).discover();
    expect(p.selected.vision).toBe('gemini-3.5-flash-lite');
    expect(p.canServe('vision')).toBe(true);
    expect(pickModel(['a', 'b'], ['zzz'], false, { strict: true })).toBeNull();
  });

  it('is not configured without its key', async () => {
    const p = await new OpenAICompatibleProvider({ preset: groq, fetchImpl: fakeFetch([]) }).discover();
    expect(p.state).toBe('not-configured');
    expect(p.ready).toBe(false);
  });

  it('discovers models, picks tiers and chats with the bearer key', async () => {
    const fetchImpl = fakeFetch([
      [/\/models$/, () => jsonResponse({ data: [{ id: 'llama-3.1-8b-instant' }, { id: 'llama-3.3-70b-versatile' }] })],
      [/\/chat\/completions$/, () => jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }], usage: { total_tokens: 9 } })],
    ]);
    const p = await new OpenAICompatibleProvider({ preset: groq, apiKey: 'k', fetchImpl }).discover();
    expect(p.selected).toEqual({ fast: 'llama-3.1-8b-instant', deep: 'llama-3.3-70b-versatile', vision: null });
    expect(p.canServe('vision')).toBe(false);
    expect(p.canServe('fast')).toBe(true);
    const reply = await p.chat({ messages: [{ role: 'user', content: 'hi' }], tier: 'deep' });
    expect(reply).toMatchObject({ content: '{"ok":true}', model: 'llama-3.3-70b-versatile', provider: 'groq' });
    const sent = fetchImpl.calls.at(-1)!;
    expect((sent.init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(String(sent.init.body)).response_format).toEqual({ type: 'json_object' });
  });

  it('retries without JSON mode when the endpoint rejects response_format', async () => {
    let n = 0;
    const fetchImpl = fakeFetch([
      [/\/models$/, () => jsonResponse({ data: [{ id: 'deepseek/deepseek-r1:free' }] })],
      [/\/chat\/completions$/, () => (++n === 1 ? new Response('bad response_format', { status: 400 }) : jsonResponse({ choices: [{ message: { content: 'x' } }] }))],
    ]);
    const p = await new OpenAICompatibleProvider({ preset: openrouter, apiKey: 'k', fetchImpl }).discover();
    await expect(p.chat({ messages: [] })).resolves.toMatchObject({ content: 'x' });
    expect(JSON.parse(String(fetchImpl.calls.at(-1)!.init.body)).response_format).toBeUndefined();
  });

  it('turns 429 into a retryable error carrying retry-after', async () => {
    const fetchImpl = fakeFetch([
      [/\/models$/, () => jsonResponse({ data: [{ id: 'llama-3.1-8b-instant' }] })],
      [/\/chat\/completions$/, () => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } })],
    ]);
    const p = await new OpenAICompatibleProvider({ preset: groq, apiKey: 'k', fetchImpl }).discover();
    const error = await p.chat({ messages: [] }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(7000);
  });

  it('uses the preset fallback model when the model list is unavailable, but not on a bad key', async () => {
    const down = fakeFetch([[/\/models$/, () => new Response('nope', { status: 404 })]]);
    const p = await new OpenAICompatibleProvider({ preset: cerebras, apiKey: 'k', fetchImpl: down }).discover();
    expect(p.state).toBe('ready');
    expect(p.selected).toEqual({ fast: 'gpt-oss-120b', deep: 'gpt-oss-120b', vision: null });
    const denied = fakeFetch([[/\/models$/, () => new Response('bad key', { status: 401 })]]);
    const q = await new OpenAICompatibleProvider({ preset: cerebras, apiKey: 'x', fetchImpl: denied }).discover();
    expect(q.state).toBe('error');
  });

  it('reports a missing local Ollama as not configured instead of an error', async () => {
    const ollama = PROVIDER_PRESETS.find((p) => p.id === 'ollama')!;
    const fetchImpl = async () => { throw new TypeError('fetch failed'); };
    const p = await new OpenAICompatibleProvider({ preset: ollama, fetchImpl }).discover();
    expect(p.describe()).toMatchObject({ state: 'not-configured', detail: expect.stringMatching(/not running/) });
  });
});

describe('provider limits', () => {
  it('treats a 402 free-limit reply as a retryable rate limit with its wait time', async () => {
    const pollinations = PROVIDER_PRESETS.find((p) => p.id === 'pollinations')!;
    const fetchImpl = fakeFetch([
      [/\/models$/, () => jsonResponse({ data: [{ id: 'openai-fast' }] })],
      [/\/chat\/completions$/, () => new Response('{"error":{"code":"FREE_LIMIT","message":"Free limit reached: 1 reply every 30 seconds per IP. Retry after 2s"}}', { status: 402 })],
    ]);
    const p = await new OpenAICompatibleProvider({ preset: { ...pollinations, minIntervalMs: 0 }, fetchImpl }).discover();
    const error = await p.chat({ messages: [] }).catch((e) => e);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(30000);
  });

  it('retries with a doubled token budget when the reply was cut off', async () => {
    const budgets: number[] = [];
    const fetchImpl = fakeFetch([
      [/\/models$/, () => jsonResponse({ data: [{ id: 'llama-3.1-8b-instant' }] })],
      [/\/chat\/completions$/, (_u, init) => {
        const max = JSON.parse(String(init.body)).max_tokens;
        budgets.push(max);
        return jsonResponse({ choices: [{ finish_reason: budgets.length === 1 ? 'length' : 'stop', message: { content: budgets.length === 1 ? '{"cut' : '{"whole":true}' } }] });
      }],
    ]);
    const p = await new OpenAICompatibleProvider({ preset: groq, apiKey: 'k', fetchImpl }).discover();
    await expect(p.chat({ messages: [], maxTokens: 1000 })).resolves.toMatchObject({ content: '{"whole":true}' });
    expect(budgets).toEqual([1000, 2000]);
  });
});

describe('quotaWindow', () => {
  it('keeps the quota window that sits past the cut-off of a long Gemini 429 body', async () => {
    const { quotaWindow, retryAfterFromText } = await import('../../src/llm/provider.mjs');
    const pad = 'x'.repeat(400);
    const minute = `[{"error":{"code":429,"message":"You exceeded your current quota ${pad}","details":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"37s"}]}}]`;
    const day = `[{"error":{"code":429,"message":"You exceeded your current quota ${pad}","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}]`;
    expect(quotaWindow(minute)).toBe(' [quota window: per minute]');
    expect(quotaWindow(day)).toBe(' [quota window: per day]');
    expect(quotaWindow('{"retryDelay": "12.5s"}')).toBe(' [retry after 13s]');
    expect(quotaWindow('plain error')).toBe('');
    expect(retryAfterFromText(minute)).toBe(37000);
  });
});

