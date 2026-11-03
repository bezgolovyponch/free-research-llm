import { describe, expect, it, vi } from 'vitest';
import { PROVIDER_PRESETS } from '../../src/llm/presets.mjs';
import { AnthropicMessagesProvider, OpenAICompatibleProvider, ProviderError, pickModel } from '../../src/llm/provider.mjs';
import { fakeFetch, jsonResponse } from '../helpers/fake-fetch';

const groq = PROVIDER_PRESETS.find((p) => p.id === 'groq')!;
const openrouter = PROVIDER_PRESETS.find((p) => p.id === 'openrouter')!;
const cerebras = PROVIDER_PRESETS.find((p) => p.id === 'cerebras')!;

describe('OpenRouter free model choice', () => {
  const live = ['thinkingmachines/inkling-small:free', 'thinkingmachines/inkling:free', 'nvidia/nemotron-3.5-super-vl:free', 'nvidia/nemotron-3.5-lightning:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'dots-studio/dots-3-note-preview:free', 'recursive/flint-v1.0:free', 'xingchen-agi/xing4.0-29b-a4b:free', 'google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free', 'cohere/north-mini-code:free', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'nvidia/nemotron-3.5-content-safety:free', 'liquid/lfm-2.5-2.6b:free'];
  const openrouter = PROVIDER_PRESETS.find((p) => p.id === 'openrouter')!;

  it('picks a known model family from the free list of 2026-11-02, never the first unknown one', () => {
    expect(pickModel(live, openrouter.prefer.fast, true)).toBe('google/gemma-4-26b-a4b-it:free');
    expect(pickModel(live, openrouter.prefer.deep, true)).toBe('nvidia/nemotron-3-ultra-550b-a55b:free');
  });

  it('still lands on a known family when the exact ids are renamed', () => {
    const renamed = ['recursive/flint-v2.0:free', 'google/gemma-5-27b-it:free', 'deepseek/deepseek-v4-flash:free'];
    expect(pickModel(renamed, openrouter.prefer.fast, true)).toBe('google/gemma-5-27b-it:free');
    expect(pickModel(renamed, openrouter.prefer.deep, true)).toBe('deepseek/deepseek-v4-flash:free');
  });
});

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

  it('takes the larger of the retry-after header and the body window (pollinations 402)', async () => {
    const pollinations = PROVIDER_PRESETS.find((p) => p.id === 'pollinations')!;
    const fetchImpl = fakeFetch([
      [/\/models$/, () => jsonResponse({ data: [{ id: 'openai-fast' }] })],
      [/\/chat\/completions$/, () => new Response('{"error":{"code":"FREE_LIMIT","message":"Free limit reached: 1 reply every 45 seconds per IP. Retry after 14s"}}', { status: 402, headers: { 'retry-after': '14' } })],
    ]);
    const p = await new OpenAICompatibleProvider({ preset: { ...pollinations, minIntervalMs: 0 }, fetchImpl }).discover();
    const error = await p.chat({ messages: [] }).catch((e) => e);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(45000);
  });

  it('waits a full minIntervalMs after the previous reply finished before starting the next request', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const pollinations = PROVIDER_PRESETS.find((p) => p.id === 'pollinations')!;
      const replyMs = 30000;
      const starts: number[] = [];
      const fetchImpl = fakeFetch([
        [/\/models$/, () => jsonResponse({ data: [{ id: 'openai-fast' }] })],
        [/\/chat\/completions$/, async () => {
          starts.push(Date.now());
          await new Promise((r) => setTimeout(r, replyMs));
          return jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] });
        }],
      ]);
      const p = await new OpenAICompatibleProvider({ preset: { ...pollinations, minIntervalMs: 45000 }, fetchImpl }).discover();
      const first = p.chat({ messages: [] });
      await vi.advanceTimersByTimeAsync(replyMs);
      await first;
      const finishedAt = Date.now();
      expect(p.nextSlot).toBe(finishedAt + 45000);
      const second = p.chat({ messages: [] });
      await vi.advanceTimersByTimeAsync(44999);
      expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(starts).toHaveLength(2);
      expect(starts[1] - finishedAt).toBeGreaterThanOrEqual(45000);
      await vi.advanceTimersByTimeAsync(replyMs);
      await second;
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports how long the call had to wait in the queue and how much queue is left', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const pollinations = PROVIDER_PRESETS.find((p) => p.id === 'pollinations')!;
      const fetchImpl = fakeFetch([
        [/\/models$/, () => jsonResponse({ data: [{ id: 'openai-fast' }] })],
        [/\/chat\/completions$/, () => jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] })],
      ]);
      const p = await new OpenAICompatibleProvider({ preset: { ...pollinations, minIntervalMs: 45000 }, fetchImpl }).discover();
      const first = await p.chat({ messages: [] });
      expect(first.waitMs).toBe(0);
      expect(p.queueMs()).toBe(45000);
      const second = p.chat({ messages: [] });
      await vi.advanceTimersByTimeAsync(45000);
      expect((await second).waitMs).toBe(45000);
      expect(p.queueMs()).toBe(45000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('has no queue to wait for when the provider is not paced', async () => {
    const fetchImpl = fakeFetch([
      [/\/models$/, () => jsonResponse({ data: [{ id: 'llama-3.1-8b-instant' }] })],
      [/\/chat\/completions$/, () => jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] })],
    ]);
    const p = await new OpenAICompatibleProvider({ preset: groq, apiKey: 'k', fetchImpl }).discover();
    expect(p.queueMs()).toBe(0);
    expect(await p.chat({ messages: [] })).toMatchObject({ waitMs: 0 });
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
    expect(quotaWindow(day)).toBe(' [quota window: per day, per model]');
    expect(quotaWindow('{"quotaId":"GenerateRequestsPerDayPerProject-FreeTier"}')).toBe(' [quota window: per day]');
    expect(quotaWindow('{"retryDelay": "12.5s"}')).toBe(' [retry after 13s]');
    expect(quotaWindow('plain error')).toBe('');
    expect(quotaWindow('{"message":"Tokens per day limit exceeded - too many tokens processed."}')).toBe(' [quota window: per day, per model]');
    expect(quotaWindow('{"error":{"message":"Rate limit reached for model `openai/gpt-oss-20b` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 200000"}}')).toBe(' [quota window: per day, per model]');
    expect(retryAfterFromText(minute)).toBe(37000);
  });
});

describe('Ollama with no model', () => {
  it('says which command pulls a model', async () => {
    const { OpenAICompatibleProvider } = await import('../../src/llm/provider.mjs');
    const preset = { id: 'ollama', label: 'Ollama', baseURL: 'http://localhost:11434/v1', keyEnv: null, local: true, prefer: { fast: [], deep: [] } };
    const fetchImpl = (async (url: string) => (url.endsWith('/v1/models') ? new Response(JSON.stringify({ object: 'list', data: null })) : new Response('{}', { status: 404 }))) as never;
    const provider = await new OpenAICompatibleProvider({ preset, fetchImpl }).discover();
    expect(provider.state).toBe('no-models');
    expect(provider.detail).toMatch(/ollama pull qwen3:4b/);
  });
});

describe('AnthropicMessagesProvider (fcc proxy)', () => {
  const fcc = PROVIDER_PRESETS.find((p) => p.id === 'fcc')!;
  const models = ['claude-opus-4-20250514', 'claude-haiku-4-5-20251001', 'claude-opus-5-5', 'claude-fable-5'];
  const reply = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'considering', signature: '' }, { type: 'text', text: '{"ok":true,"n":4}' }],
    model: 'claude-opus-5-5',
    stop_reason: 'end_turn',
    usage: { input_tokens: 47, output_tokens: 41, cache_read_input_tokens: 0 },
  };

  it('discovers the fcc model list and picks the claude tiers', async () => {
    const fetchImpl = fakeFetch([[/\/v1\/models$/, () => jsonResponse({ object: 'list', data: models.map((id) => ({ id })) })]]);
    const p = await new AnthropicMessagesProvider({ preset: fcc, fetchImpl }).discover();
    expect(p.state).toBe('ready');
    expect(p.ready).toBe(true);
    expect(p.selected.fast).toBe('claude-haiku-4-5-20251001');
    expect(p.selected.deep).toBe('claude-opus-5-5');
  });

  it('never picks a provider-prefixed id that fcc lists but cannot serve', async () => {
    const listed = ['anthropic/anthropic/claude-haiku-4-5-20251001', 'anthropic/anthropic/claude-opus-5-5', 'claude-opus-4-20250514'];
    const fetchImpl = fakeFetch([[/\/v1\/models$/, () => jsonResponse({ object: 'list', data: listed.map((id) => ({ id })) })]]);
    const p = await new AnthropicMessagesProvider({ preset: fcc, fetchImpl }).discover();
    expect(p.selected.fast).not.toContain('/');
    expect(p.selected.deep).not.toContain('/');
  });

  it('lands on a listed claude-opus when the exact deep id is missing', async () => {
    const fetchImpl = fakeFetch([[/\/v1\/models$/, () => jsonResponse({ object: 'list', data: [{ id: 'claude-opus-4-20250514' }, { id: 'claude-fable-5' }] })]]);
    const p = await new AnthropicMessagesProvider({ preset: fcc, fetchImpl }).discover();
    expect(p.state).toBe('ready');
    expect(p.selected.deep).toBe('claude-opus-4-20250514');
  });

  it('posts to /v1/messages with fcc headers, joined system prompt and the text block only', async () => {
    const fetchImpl = fakeFetch([
      [/\/v1\/models$/, () => jsonResponse({ object: 'list', data: models.map((id) => ({ id })) })],
      [/\/v1\/messages$/, () => jsonResponse(reply)],
    ]);
    const p = await new AnthropicMessagesProvider({ preset: fcc, fetchImpl }).discover();
    const result = await p.chat({
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'system', content: 'Cite sources.' },
        { role: 'user', content: 'what is 2+2?' },
        { role: 'assistant', content: 'let me think' },
        { role: 'user', content: 'answer' },
      ],
      tier: 'deep',
    });
    expect(result).toEqual({
      content: '{"ok":true,"n":4}',
      model: 'claude-opus-5-5',
      provider: 'fcc',
      usage: { prompt_tokens: 47, completion_tokens: 41, total_tokens: 88 },
      truncated: false,
      waitMs: 0,
    });
    const sent = fetchImpl.calls.at(-1)!;
    expect(sent.url).toBe('http://127.0.0.1:8082/v1/messages');
    const headers = sent.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-api-key']).toBe('fcc-local');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(String(sent.init.body));
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.system).toBe('You are terse.\n\nCite sources.\n\nAnswer with JSON only.');
    expect(body.messages).toEqual([
      { role: 'user', content: 'what is 2+2?' },
      { role: 'assistant', content: 'let me think' },
      { role: 'user', content: 'answer' },
    ]);
  });

  it('marks a max_tokens stop as truncated', async () => {
    const fetchImpl = fakeFetch([
      [/\/v1\/models$/, () => jsonResponse({ object: 'list', data: models.map((id) => ({ id })) })],
      [/\/v1\/messages$/, () => jsonResponse({ ...reply, stop_reason: 'max_tokens' })],
    ]);
    const p = await new AnthropicMessagesProvider({ preset: fcc, fetchImpl }).discover();
    await expect(p.chat({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toMatchObject({ truncated: true });
  });

  it('throws a 429 ProviderError from /v1/messages', async () => {
    const fetchImpl = fakeFetch([
      [/\/v1\/models$/, () => jsonResponse({ object: 'list', data: models.map((id) => ({ id })) })],
      [/\/v1\/messages$/, () => new Response('rate limited', { status: 429 })],
    ]);
    const p = await new AnthropicMessagesProvider({ preset: fcc, fetchImpl }).discover();
    const error = await p.chat({ messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(429);
    expect(error.retryable).toBe(true);
  });

  it('does not treat a thinking-only reply as content', async () => {
    const fetchImpl = fakeFetch([
      [/\/v1\/models$/, () => jsonResponse({ object: 'list', data: models.map((id) => ({ id })) })],
      [/\/v1\/messages$/, () => jsonResponse({ ...reply, content: [{ type: 'thinking', thinking: 'hmm', signature: '' }] })],
    ]);
    const p = await new AnthropicMessagesProvider({ preset: fcc, fetchImpl }).discover();
    const error = await p.chat({ messages: [{ role: 'user', content: 'hi' }] }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.status).toBe(502);
  });
});

describe('call timeout of a proxy provider', () => {
  it('gives fcc its own longer call timeout, because it queues behind remote models with its own retries', () => {
    const fccPreset = PROVIDER_PRESETS.find((p) => p.id === 'fcc')!;
    const fcc = new AnthropicMessagesProvider({ preset: fccPreset, fetchImpl: fakeFetch([]) });
    expect(fcc.timeoutFor(6000, 800)).toBe(240000);
    const groq = new OpenAICompatibleProvider({ preset: PROVIDER_PRESETS.find((p) => p.id === 'groq')!, apiKey: 'k', fetchImpl: fakeFetch([]) });
    expect(groq.timeoutFor(6000, 800)).toBeUndefined();
  });
});
