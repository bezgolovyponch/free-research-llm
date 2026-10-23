import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/llm/provider.mjs';
import { ModelRouter, NoModelAvailableError, estimateTokens, nextUtcMidnight } from '../../src/llm/router.mjs';

function provider(id: string, replies: Array<string | Error>) {
  const calls: string[] = [];
  return {
    id,
    ready: true,
    calls,
    async chat({ tier }: { tier: string }) {
      calls.push(tier);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return { content: next ?? '{"ok":true}', model: `${id}-m`, provider: id, usage: {} };
    },
    describe: () => ({ id }),
  };
}

describe('ModelRouter', () => {
  it('fails over on 429 and cools the provider down', async () => {
    let now = 1000;
    const a = provider('a', [new ProviderError('rate', { status: 429 })]);
    const b = provider('b', ['{"x":1}']);
    const router = new ModelRouter({ providers: [a, b], now: () => now, cooldownMs: 60000 });
    const reply = await router.complete({ messages: [] });
    expect(reply).toMatchObject({ provider: 'b', data: { x: 1 } });
    expect(router.available().map((p) => p.id)).toEqual(['b']);
    now += 60001;
    expect(router.available().map((p) => p.id)).toEqual(['a', 'b']);
    expect(router.ledger.map((r) => r.ok)).toEqual([false, true]);
  });

  it('repairs invalid JSON once on the same provider before moving on', async () => {
    const a = provider('a', ['not json', '{"fixed":true}']);
    const router = new ModelRouter({ providers: [a] });
    await expect(router.complete({ messages: [] })).resolves.toMatchObject({ data: { fixed: true } });
    expect(a.calls).toHaveLength(2);
  });

  it('does not cool down on a bad request but still tries the next provider', async () => {
    const a = provider('a', [new ProviderError('bad request', { status: 400 })]);
    const b = provider('b', ['{}']);
    const router = new ModelRouter({ providers: [a, b] });
    await router.complete({ messages: [] });
    expect(router.available().map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('benches a rejected key for hours and a spent daily quota or credit until the next UTC day', async () => {
    const now = Date.parse('2026-10-20T10:00:00Z');
    const key = provider('key', [new ProviderError('key HTTP 401: invalid', { status: 401 })]);
    const credit = provider('credit', [new ProviderError('credit HTTP 402: {"balance_units":0}', { status: 402 })]);
    const daily = provider('daily', [new ProviderError('daily HTTP 429: tokens per day limit exceeded', { status: 429, retryAfterMs: 1000 })]);
    const ok = provider('ok', ['{}']);
    const router = new ModelRouter({ providers: [key, credit, daily, ok], now: () => now });
    await router.complete({ messages: [] });
    const st = Object.fromEntries(router.status().map((p: { id: string; coolingDownMs: number; coolingReason: string }) => [p.id, p]));
    expect(st.key.coolingDownMs).toBe(6 * 3600 * 1000);
    expect(st.key.coolingReason).toContain('key rejected');
    expect(st.credit.coolingDownMs).toBe(Date.parse('2026-10-21T00:01:00Z') - now);
    expect(st.daily.coolingReason).toContain('daily quota');
    expect(st.ok.coolingReason).toBeNull();
    expect(nextUtcMidnight(now)).toBe(Date.parse('2026-10-21T00:01:00Z'));
  });

  it('routes each kind of call by its own order, skips providers a prompt is too big for, and avoids the author\'s model family for reviews', async () => {
    const make = (id: string, model: string) => ({ ...provider(id, ['{}', '{}', '{}']), describe: () => ({ id, fast: model, deep: model }) });
    const groq = make('groq', 'openai/gpt-oss-120b');
    const cerebras = make('cerebras', 'gpt-oss-120b');
    const gemini = make('gemini', 'gemini-3.8-flash');
    const router = new ModelRouter({ providers: [groq, cerebras, gemini], routeOrder: { fast: ['groq', 'cerebras', 'gemini'], deep: ['gemini', 'cerebras', 'groq'], byPurpose: { critique: ['groq', 'cerebras', 'gemini'], synthesize: ['gemini', 'cerebras', 'groq'] } } });
    expect(router.available({ tier: 'deep', purpose: 'synthesize' })[0].id).toBe('gemini');
    expect(router.available({ tier: 'fast', purpose: 'critique' })[0].id).toBe('groq');
    expect(router.available({ tier: 'fast', purpose: 'critique', tokens: 12000 })[0].id).toBe('cerebras');
    expect(router.available({ tier: 'fast', purpose: 'critique', avoid: 'cerebras' }).map((p: { id: string }) => p.id)).toEqual(['gemini', 'groq', 'cerebras']);
    expect(estimateTokens([{ content: 'x'.repeat(35) }])).toBe(10);
  });

  it('prefers a different provider for independent review when asked', async () => {
    const a = provider('a', ['{}']);
    const b = provider('b', ['{}']);
    const router = new ModelRouter({ providers: [a, b] });
    await expect(router.complete({ messages: [], avoid: 'a' })).resolves.toMatchObject({ provider: 'b' });
  });

  it('waits out a short cooldown instead of failing when every provider is rate-limited', async () => {
    let now = 0;
    const waits: number[] = [];
    const a = provider('a', [new ProviderError('rate', { status: 429, retryAfterMs: 5000 }), '{"after":true}']);
    const router = new ModelRouter({ providers: [a], now: () => now, sleep: async (ms: number) => { waits.push(ms); now += ms; } });
    await expect(router.complete({ messages: [] })).resolves.toMatchObject({ data: { after: true } });
    expect(waits).toEqual([5000]);
    expect(router.ledger.map((r) => r.provider)).toEqual(['a', 'router', 'a']);
  });

  it('raises a clear error when nothing is configured or everything fails', async () => {
    await expect(new ModelRouter({ providers: [] }).complete({ messages: [] })).rejects.toThrow(/no model provider/);
    const a = provider('a', [new ProviderError('down', { status: 503 })]);
    const router = new ModelRouter({ providers: [a], maxWaitMs: 0 });
    await expect(router.complete({ messages: [] })).rejects.toBeInstanceOf(NoModelAvailableError);
    await expect(router.complete({ messages: [] })).rejects.toThrow(/cooling down/);
  });
});

describe('ModelRouter route order', () => {
  it('orders providers per tier and reports the live route', async () => {
    const g = provider('gemini', ['{}']);
    const q = provider('groq', ['{}']);
    const router = new ModelRouter({ providers: [g, q], routeOrder: { fast: ['groq', 'gemini'], deep: ['gemini', 'groq'] } });
    await expect(router.complete({ messages: [], tier: 'fast' })).resolves.toMatchObject({ provider: 'groq' });
    await expect(router.complete({ messages: [], tier: 'deep' })).resolves.toMatchObject({ provider: 'gemini' });
    expect(router.route()).toEqual({ fast: ['groq', 'gemini'], deep: ['gemini', 'groq'], vision: ['gemini', 'groq'] });
  });

  it('sends vision work only to providers that have a vision model', async () => {
    const g = Object.assign(provider('gemini', ['seen']), { canServe: (tier: string) => tier !== 'vision' || true });
    const q = Object.assign(provider('groq', ['{}']), { canServe: (tier: string) => tier !== 'vision' });
    const router = new ModelRouter({ providers: [q, g] });
    await expect(router.complete({ messages: [], tier: 'vision', json: false })).resolves.toMatchObject({ provider: 'gemini' });
    expect(router.route().vision).toEqual(['gemini']);
  });
});

describe('ModelRouter.restoreCooldowns', () => {
  it('keeps a provider benched after a restart when its last call ran out of credit, had a bad key or used the daily quota', () => {
    const now = Date.parse('2026-10-23T10:00:00Z');
    const p = (id: string) => ({ id, ready: true, describe: () => ({}), chat: async () => ({}) });
    const router = new ModelRouter({ providers: [p('sambanova'), p('groq'), p('gemini'), p('cerebras'), p('old'), p('pollinations'), p('openrouter')], now: () => now });
    const restored = router.restoreCooldowns([
      { ts: '2026-10-23T09:00:00Z', provider: 'sambanova', ok: false, error: 'sambanova HTTP 402: {"error":{"balance_units":0}}' },
      { ts: '2026-10-23T09:10:00Z', provider: 'groq', ok: false, error: 'groq HTTP 429: Rate limit reached for model' },
      { ts: '2026-10-23T08:00:00Z', provider: 'gemini', ok: false, error: 'gemini HTTP 429: Requests per day limit exceeded' },
      { ts: '2026-10-23T09:30:00Z', provider: 'gemini', ok: false, error: 'gemini HTTP 429: tokens per day exhausted' },
      { ts: '2026-10-23T09:00:00Z', provider: 'cerebras', ok: false, error: 'cerebras HTTP 401: invalid key' },
      { ts: '2026-10-23T09:50:00Z', provider: 'cerebras', ok: true },
      { ts: '2026-10-22T09:00:00Z', provider: 'old', ok: false, error: 'old HTTP 402: balance' },
      { ts: '2026-10-23T09:00:00Z', provider: 'unknown', ok: false, error: 'HTTP 402' },
      { ts: '2026-10-23T09:55:00Z', provider: 'pollinations', ok: false, error: 'pollinations HTTP 402: {"error":{"code":"FREE_LIMIT","message":"Free limit reached: 1 reply every 30 seconds per IP. Retry after 5s"}}' },
      { ts: '2026-10-23T09:56:00Z', provider: 'openrouter', ok: false, error: 'openrouter HTTP 429: Rate limit exceeded: free-models-per-day. Add 10 credits' },
      { ts: '2026-10-23T09:57:00Z', provider: 'groq', ok: false, error: 'groq HTTP 429: You exceeded your current quota, please check your plan' },
    ]);
    expect(restored.sort()).toEqual(['gemini', 'openrouter', 'sambanova']);
    expect(router.cooldownReason.get('sambanova')).toMatch(/daily quota or credit/);
    expect(router.cooldownUntil.get('sambanova')).toBe(nextUtcMidnight(now));
    expect(router.cooldownUntil.has('groq')).toBe(false);
  });
});

describe('ModelRouter.coolDown', () => {
  it('treats a 402 that states a short retry as a short throttle, not a daily bench', () => {
    const now = Date.parse('2026-10-23T10:00:00Z');
    const router = new ModelRouter({ providers: [], now: () => now });
    router.coolDown({ id: 'pollinations' }, new ProviderError('pollinations HTTP 402: Free limit reached: 1 reply every 30 seconds per IP. Retry after 5s', { status: 402, retryAfterMs: 5000 }));
    expect(router.cooldownUntil.get('pollinations')).toBe(now + 5000);
    router.coolDown({ id: 'gemini-minute' }, new ProviderError('gemini HTTP 429: You exceeded your current quota [quota window: per minute]', { status: 429, retryAfterMs: 37000 }));
    expect(router.cooldownUntil.get('gemini-minute')).toBe(now + 37000);
    router.coolDown({ id: 'gemini-day' }, new ProviderError('gemini HTTP 429: You exceeded your current quota [quota window: per day]', { status: 429 }));
    expect(router.cooldownUntil.get('gemini-day')).toBe(nextUtcMidnight(now));
    router.coolDown({ id: 'sambanova' }, new ProviderError('sambanova HTTP 402: balance_units 0', { status: 402 }));
    expect(router.cooldownUntil.get('sambanova')).toBe(nextUtcMidnight(now));
  });
});

