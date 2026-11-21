import { describe, expect, it } from 'vitest';
import { OutcomeBook } from '../../src/llm/outcomes.mjs';
import { ProviderError } from '../../src/llm/provider.mjs';
import { PROVIDER_PRESETS } from '../../src/llm/presets.mjs';
import { PURPOSE_CLASS } from '../../src/llm/ranking.mjs';
import { EXPECTED_OUTPUT_TOKENS, COMPUTE_ERROR_COOLDOWN_MS, DEAD_WINDOW_MS, MODEL_GONE_REST_MS, ModelRouter, NoModelAvailableError, OfflineError, OFFLINE_WAIT_MS, OVERLOAD_REST_MS, PAYMENT_REST_MS, TIMEOUT_BENCH_MS, TRIAL_POLL_MS, WAIT_NOTICE_MS, estimateTokens, modelGone, nextMidnightIn, nextUtcMidnight, nextUtcMonth, overloaded, paymentRequired, planGated, quotaResetAt, tierTimeoutMs } from '../../src/llm/router.mjs';

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

describe('NVIDIA preset', () => {
  it('prefers only the three served models', () => {
    const nvidia = PROVIDER_PRESETS.find((p) => p.id === 'nvidia');
    expect(nvidia?.prefer.fast).toEqual(['nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia/nemotron-3-ultra-550b-a55b', 'mistralai/mistral-large-4-1t-a52b']);
    expect(nvidia?.prefer.deep).toEqual(['nvidia/nemotron-3-ultra-550b-a55b', 'mistralai/mistral-large-4-1t-a52b', 'nvidia/nemotron-3.5-lightning-30b-a3b']);
    expect(nvidia?.fallbackModels).toEqual({ fast: 'nvidia/nemotron-3.5-lightning-30b-a3b', deep: 'nvidia/nemotron-3-ultra-550b-a55b' });
  });
});

describe('tierTimeoutMs', () => {
  it('gives fast calls a shorter timeout than deep calls', () => {
    expect(tierTimeoutMs('fast')).toBe(45000);
    expect(tierTimeoutMs('deep')).toBe(90000);
    expect(tierTimeoutMs('vision')).toBeUndefined();
  });
});

describe('provider families and closed-choice letters', () => {
  const served = (id: string, model: string, reply = '{"pick":"A"}') => ({ ...provider(id, []), selected: { fast: model, deep: model }, async chat() { return { content: reply, model, provider: id, usage: {} }; } });

  it('exposes one family per vendor and serving stack', () => {
    const router = new ModelRouter({ providers: [served('groq', 'openai/gpt-oss-120b'), served('cerebras', 'gpt-oss-120b'), served('gemini', 'gemini-flash'), served('mine', 'my-own-model')], env: {} });
    expect(router.familyOf('groq')).toEqual({ stack: 'groq', vendor: 'gpt-oss' });
    expect(router.familyOf('groq', { model: 'llama-3.3-70b' })).toEqual({ stack: 'groq', vendor: 'llama' });
    expect(router.familyOf('mine')).toEqual({ stack: 'mine', vendor: 'mine' });
    expect(router.families().map((family: { stack: string }) => family.stack)).toEqual(['groq', 'gemini', 'mine']);
    expect(new ModelRouter({ providers: [served('groq', 'openai/gpt-oss-120b'), served('cerebras', 'gpt-oss-120b')], env: {} }).families()).toHaveLength(1);
  });

  it('writes the task, the chosen letter and the number of options into the call ledger row', async () => {
    const router = new ModelRouter({ providers: [served('a', 'llama-3.3-70b', '{"pick":"b"}')], env: {} });
    await router.complete({ messages: [{ role: 'user', content: 'x' }], purpose: 'purpose-judge', task: 'trace', choice: { field: 'pick', options: 3 } });
    await router.complete({ messages: [{ role: 'user', content: 'x' }], purpose: 'purpose-judge', task: 'trace', choice: { field: 'other', options: 3 } });
    await router.complete({ messages: [{ role: 'user', content: 'x' }], purpose: 'purpose-judge', task: 'facts' });
    expect(router.ledger.map((row: { task?: string; letter?: string; options?: number }) => [row.task, row.letter, row.options])).toEqual([['trace', 'B', 3], ['trace', undefined, 3], ['facts', undefined, undefined]]);
    expect(router.letterBias()).toMatchObject([{ provider: 'a', model: 'llama-3.3-70b', task: 'trace', options: 3, n: 1, counts: [0, 1, 0], tested: false, biased: false }]);
  });

  it('ranks a model whose letters fail the chi-square test down for closed-choice calls only', async () => {
    const lean = served('lean', 'llama-3.3-70b');
    const even = served('even', 'gemini-flash');
    const router = new ModelRouter({ providers: [lean, even], env: {} });
    const rows = (id: string, model: string, letters: string) => [...letters].map((letter) => ({ provider: id, model, task: 'trace', letter, options: 3, ok: true }));
    expect(router.restoreLetters([...rows('lean', 'llama-3.3-70b', 'A'.repeat(24) + 'BBBCCC'), ...rows('even', 'gemini-flash', 'ABC'.repeat(10))]).map((row: { provider: string }) => row.provider)).toEqual(['lean']);
    const order = (closed: boolean) => router.available({ closed }).map((p: { id: string }) => p.id);
    expect(order(false)).toEqual(['lean', 'even']);
    expect(order(true)).toEqual(['even', 'lean']);
    const closed = await router.complete({ messages: [{ role: 'user', content: 'x' }], purpose: 'purpose-judge', task: 'trace', choice: { field: 'pick', options: 3 } });
    expect(closed.provider).toBe('even');
    const open = await router.complete({ messages: [{ role: 'user', content: 'x' }], purpose: 'purpose-judge', task: 'facts' });
    expect(open.provider).toBe('lean');
    const fresh = new ModelRouter({ providers: [served('lean', 'llama-4'), even], env: {} });
    fresh.restoreLetters(rows('lean', 'llama-3.3-70b', 'A'.repeat(30)));
    expect(fresh.available({ closed: true }).map((p: { id: string }) => p.id)).toEqual(['lean', 'even']);
  });
});

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

  it('benches a rejected key for hours, used-up credit for 24 h as a payment state, and a spent daily quota until the next UTC day', async () => {
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
    expect(st.credit.coolingDownMs).toBe(PAYMENT_REST_MS);
    expect(st.credit.coolingReason).toBe('credits used up (needs payment); rests 24 h, add credit or remove the key');
    expect(router.needsPayment('credit')).toBe(true);
    expect(st.daily.coolingDownMs).toBe(Date.parse('2026-10-21T00:01:00Z') - now);
    expect(st.daily.coolingReason).toContain('daily quota');
    expect(st.ok.coolingReason).toBeNull();
    expect(nextUtcMidnight(now)).toBe(Date.parse('2026-10-21T00:01:00Z'));
  });

  it('benches a provider that needs a paid plan for 24 h, not only until the next midnight', async () => {
    const now = Date.parse('2026-11-03T10:00:00Z');
    const cerebras = provider('cerebras', [new ProviderError('cerebras HTTP 402: Payment required', { status: 402 })]);
    const puter = provider('puter', [new ProviderError('puter HTTP 429: A subscription is required', { status: 429 })]);
    const ok = provider('ok', ['{}']);
    const router = new ModelRouter({ providers: [cerebras, puter, ok], now: () => now });
    await router.complete({ messages: [] });
    const st = Object.fromEntries(router.status().map((p: { id: string; coolingDownMs: number; coolingReason: string }) => [p.id, p]));
    expect(PAYMENT_REST_MS).toBe(24 * 3600 * 1000);
    expect(st.cerebras.coolingDownMs).toBe(PAYMENT_REST_MS);
    expect(st.cerebras.coolingReason).toBe('needs a paid plan (no free tier for this key); rests 24 h, add credit or remove the key');
    expect(st.puter.coolingDownMs).toBe(PAYMENT_REST_MS);
    expect(st.puter.coolingReason).toContain('rests 24 h');
    expect(st.ok.coolingReason).toBeNull();
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

  it('avoids every provider in a list, so a second reviewer is neither the author nor the first reviewer', async () => {
    const make = (id: string, model: string) => ({ ...provider(id, ['{}', '{}']), describe: () => ({ id, fast: model, deep: model }) });
    const gemini = make('gemini', 'gemini-3.1-flash-lite');
    const pollinations = make('pollinations', 'openai-fast');
    const groq = make('groq', 'openai/gpt-oss-20b');
    const router = new ModelRouter({ providers: [gemini, pollinations, groq], routeOrder: { fast: ['gemini', 'pollinations', 'groq'], deep: ['gemini', 'pollinations', 'groq'] } });
    expect(router.available({ tier: 'fast', purpose: 'support-second', avoid: 'pollinations' })[0].id).toBe('gemini');
    expect(router.available({ tier: 'fast', purpose: 'support-second', avoid: ['gemini', 'pollinations'] }).map((p: { id: string }) => p.id)).toEqual(['groq', 'gemini', 'pollinations']);
    await expect(router.complete({ messages: [], purpose: 'support-second', avoid: ['gemini', 'pollinations'] })).resolves.toMatchObject({ provider: 'groq' });
    expect(router.available({ tier: 'fast', avoid: [undefined, undefined] }).map((p: { id: string }) => p.id)).toEqual(['gemini', 'pollinations', 'groq']);
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
  it('keeps a provider benched after a restart only for lasting causes (no credit, bad key); a daily 429 is re-checked by the first live call', () => {
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
    expect(restored.sort()).toEqual(['sambanova']);
    expect(router.cooldownReason.get('sambanova')).toBe('credits used up (needs payment); rests 24 h, add credit or remove the key');
    expect(router.cooldownUntil.get('sambanova')).toBe(now + PAYMENT_REST_MS);
    expect(router.needsPayment('sambanova')).toBe(true);
    expect(router.cooldownUntil.has('groq')).toBe(false);
  });
});

const COHERE_MONTH_BODY = '{"error":{"message":"You are using a Trial key, which is limited to 1000 API calls / month. You can continue to use the Trial key for free or upgrade to a Production key with higher r';
const COHERE_MONTH = `cohere HTTP 429: ${COHERE_MONTH_BODY}`;
const SAMBANOVA_CREDITS_BODY = '{"error":{"code":"CREDITS_EXHAUSTED","message":"You have run out of credits..."}}';
const SAMBANOVA_CREDITS = `sambanova HTTP 402: ${SAMBANOVA_CREDITS_BODY}`;

describe('ModelRouter used-up credits', () => {
  it('excludes a provider whose credits ran out from the free route like one that needs payment, says why once, and calls it no more', async () => {
    const { OpenAICompatibleProvider } = await import('../../src/llm/provider.mjs');
    const clock = { now: Date.parse('2026-11-19T08:10:13Z') };
    const asked: string[] = [];
    const fetchImpl = async (url: string, init: { body?: string }) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-oss-120b' }, { id: 'DeepSeek-V3.2' }] }));
      asked.push(JSON.parse(init.body ?? '{}').model);
      return new Response(SAMBANOVA_CREDITS_BODY, { status: 402 });
    };
    const preset = { id: 'sambanova', label: 's', baseURL: 'https://s.example/v1', keyEnv: 'K', prefer: { fast: ['gpt-oss-120b'], deep: ['DeepSeek-V3.2', 'gpt-oss-120b'] } };
    const sambanova = await new OpenAICompatibleProvider({ preset, apiKey: 'k', fetchImpl: fetchImpl as never, now: () => clock.now }).discover();
    expect(sambanova.state).toBe('ready');
    const events: Array<{ kind: string }> = [];
    const router = new ModelRouter({ providers: [sambanova, provider('free', [])], now: () => clock.now, sleep: async () => {}, onWait: (event: { kind: string }) => events.push(event) });
    for (let i = 0; i < 3; i++) {
      await expect(router.complete({ purpose: 'research', messages: [{ role: 'user', content: 'x' }] })).resolves.toMatchObject({ provider: 'free' });
      clock.now += 60 * 60 * 1000;
    }
    expect(asked).toEqual(['gpt-oss-120b']);
    expect(router.needsPayment('sambanova')).toBe(true);
    expect(router.route().fast).toEqual(['free']);
    expect(router.cooldownReason.get('sambanova')).toBe('credits used up (needs payment); rests 24 h, add credit or remove the key');
    expect(router.ledger.filter((row: { purpose: string }) => row.purpose === 'router').map((row: { error: string }) => row.error)).toEqual(['sambanova needs payment: excluded from the free route']);
    expect(events.filter((event) => event.kind === 'excluded')).toEqual([{ kind: 'excluded', provider: 'sambanova', message: 'sambanova needs payment: excluded from the free route' }]);
  });

  it('keeps that exclusion after a restart from the raw error in the call log', () => {
    const now = Date.parse('2026-11-19T11:16:07Z');
    const p = (id: string) => ({ id, ready: true, keyCount: 1, describe: () => ({ id }), chat: async () => ({}) });
    const router = new ModelRouter({ providers: [p('sambanova'), p('free')], now: () => now });
    expect(router.restoreCooldowns([{ ts: '2026-11-19T08:10:13.789Z', purpose: 'research', tier: 'fast', provider: 'sambanova', ok: false, ms: 190, error: SAMBANOVA_CREDITS, keys: 1, model: 'gpt-oss-120b' }])).toEqual(['sambanova']);
    expect(router.needsPayment('sambanova')).toBe(true);
    expect(router.route().fast).toEqual(['free']);
    expect(router.cooldownUntil.get('sambanova')).toBe(now + PAYMENT_REST_MS);
    expect(router.cooldownReason.get('sambanova')).toBe('credits used up (needs payment); rests 24 h, add credit or remove the key');
  });
});

describe('ModelRouter monthly quota window', () => {
  it('rests a provider whose trial key used its month until the next month starts (UTC), after one call', async () => {
    const { OpenAICompatibleProvider } = await import('../../src/llm/provider.mjs');
    let now = Date.parse('2026-11-19T08:10:17Z');
    const asked: string[] = [];
    const fetchImpl = async (url: string, init: { body?: string }) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'command-a-plus-05-2026' }] }));
      asked.push(JSON.parse(init.body ?? '{}').model);
      return new Response(COHERE_MONTH_BODY, { status: 429 });
    };
    const preset = { id: 'cohere', label: 'c', baseURL: 'https://c.example/v1', keyEnv: 'K', prefer: { fast: ['command-a'], deep: ['command-a'] } };
    const cohere = await new OpenAICompatibleProvider({ preset, apiKey: 'k', fetchImpl: fetchImpl as never, now: () => now }).discover();
    const b = provider('b', []);
    const router = new ModelRouter({ providers: [cohere, b], now: () => now, sleep: async () => {} });
    for (let i = 0; i < 3; i++) {
      await expect(router.complete({ purpose: 'checklist', tier: 'deep', messages: [{ role: 'user', content: 'x' }] })).resolves.toMatchObject({ provider: 'b' });
      now += 31 * 60 * 1000;
    }
    expect(asked).toEqual(['command-a-plus-05-2026']);
    expect(router.ledger[0].error).toMatch(/^cohere HTTP 429 \[quota window: per month\]: /);
    expect(nextUtcMonth(Date.parse('2026-11-19T08:10:17Z'))).toBe(Date.parse('2026-12-01T00:01:00Z'));
    expect(router.cooldownUntil.get('cohere')).toBe(Date.parse('2026-12-01T00:01:00Z'));
    expect(router.cooldownReason.get('cohere')).toBe('monthly quota used up; waits for the monthly reset (2026-12-01 UTC)');
    expect(router.status().find((s: { id: string }) => s.id === 'cohere')).toMatchObject({ coolingReason: 'monthly quota used up; waits for the monthly reset (2026-12-01 UTC)' });
  });

  it('keeps that rest after a restart from the raw call log, with its own reason, until the month is over', () => {
    const now = Date.parse('2026-11-19T08:53:05Z');
    const p = (id: string) => ({ id, ready: true, keyCount: 1, selected: { fast: 'command-a-plus-05-2026', deep: 'command-a-plus-05-2026' }, describe: () => ({}), chat: async () => ({}) });
    const rows = Array.from({ length: 25 }, (_, i) => ({ ts: new Date(Date.parse('2026-11-19T08:10:17Z') + i * 60000).toISOString(), purpose: 'checklist', tier: 'deep', provider: 'cohere', ok: false, ms: 201, error: COHERE_MONTH, keys: 1, model: 'command-a-plus-05-2026' }));
    const router = new ModelRouter({ providers: [p('cohere')], now: () => now });
    expect(router.restoreCooldowns(rows)).toEqual(['cohere']);
    expect(router.cooldownUntil.get('cohere')).toBe(Date.parse('2026-12-01T00:01:00Z'));
    expect(router.cooldownReason.get('cohere')).toBe('monthly quota used up; waits for the monthly reset (2026-12-01 UTC)');
    const december = new ModelRouter({ providers: [p('cohere')], now: () => Date.parse('2026-12-01T00:02:00Z') });
    expect(december.restoreCooldowns(rows.slice(-1))).toEqual([]);
  });
});

describe('ModelRouter.restoreCooldowns paid plan', () => {
  it('keeps a provider that needs a paid plan benched for the rest of the 24 h after a restart', () => {
    const now = Date.parse('2026-11-03T10:00:00Z');
    const p = (id: string) => ({ id, ready: true, describe: () => ({}), chat: async () => ({}) });
    const router = new ModelRouter({ providers: [p('cerebras'), p('puter'), p('old')], now: () => now });
    const restored = router.restoreCooldowns([
      { ts: '2026-11-03T09:00:00Z', provider: 'cerebras', ok: false, error: 'cerebras HTTP 402: Payment required' },
      { ts: '2026-11-03T08:00:00Z', provider: 'puter', ok: false, error: 'puter HTTP 429: A subscription is required' },
      { ts: '2026-11-01T09:00:00Z', provider: 'old', ok: false, error: 'old HTTP 402: Payment required' },
    ]);
    expect(restored.sort()).toEqual(['cerebras', 'puter']);
    expect(router.cooldownUntil.get('cerebras')).toBe(now + PAYMENT_REST_MS);
    expect(router.cooldownReason.get('cerebras')).toContain('needs a paid plan');
    expect(router.cooldownUntil.get('puter')).toBe(now + PAYMENT_REST_MS);
    expect(router.cooldownReason.get('puter')).toContain('rests 24 h');
    expect(router.cooldownUntil.has('old')).toBe(false);
  });
});

describe('ModelRouter.restoreCooldowns failure streak', () => {
  it('benches a provider whose last 12 rows before the restart all failed, and leaves one with a recent success alone', () => {
    const now = Date.parse('2026-11-03T13:21:00Z');
    const p = (id: string) => ({ id, ready: true, describe: () => ({}), chat: async () => ({}) });
    const router = new ModelRouter({ providers: [p('sambanova'), p('groq')], now: () => now });
    const failures = (id: string, n: number, end: number) => Array.from({ length: n }, (_, i) => ({ ts: new Date(end - (n - 1 - i) * 60000).toISOString(), provider: id, ok: false, error: `${id} HTTP 429: model is currently experiencing high traffic` }));
    const rows = [
      ...failures('sambanova', 12, now - 60000),
      ...failures('groq', 4, now - 120000),
      { ts: new Date(now - 30000).toISOString(), provider: 'groq', ok: true, error: undefined },
    ];
    expect(router.restoreCooldowns(rows)).toEqual(['sambanova']);
    expect(router.cooldownUntil.get('sambanova')).toBe(now - 60000 + 30 * 60 * 1000);
    expect(router.cooldownReason.get('sambanova')).toBe('12 failed calls in a row before the restart; rests 30 min');
    expect(router.cooldownUntil.has('groq')).toBe(false);
  });

  it('doubles the restored rest for each earlier streak bench of that provider', () => {
    const now = Date.parse('2026-11-03T13:21:00Z');
    const router = new ModelRouter({ providers: [{ id: 'sambanova', ready: true, describe: () => ({}), chat: async () => ({}) }], now: () => now });
    const rows = [
      { ts: new Date(now - 3 * 3600 * 1000).toISOString(), provider: 'sambanova', ok: false, purpose: 'router', ms: 0, error: '12 failed calls in a row; rests 30 min' },
      ...Array.from({ length: 12 }, (_, i) => ({ ts: new Date(now - 60000 - (11 - i) * 60000).toISOString(), provider: 'sambanova', ok: false, error: 'sambanova HTTP 429: model is currently experiencing high traffic' })),
    ];
    expect(router.restoreCooldowns(rows)).toEqual(['sambanova']);
    expect(router.cooldownReason.get('sambanova')).toBe('12 failed calls in a row before the restart; rests 60 min');
    expect(router.cooldownUntil.get('sambanova')).toBe(now - 60000 + 60 * 60 * 1000);
  });
});

describe('ModelRouter dead providers', () => {
  it('orders a provider with 20 failures and no success in its recent records after a healthy one, even when the route order lists it first', () => {
    const samba = provider('sambanova', []);
    const groq = provider('groq', []);
    const router = new ModelRouter({ providers: [samba, groq], routeOrder: { fast: ['sambanova', 'groq'] } });
    expect(router.available({ tier: 'fast' }).map((p: { id: string }) => p.id)).toEqual(['sambanova', 'groq']);
    for (let i = 0; i < 20; i++) router.record({ provider: 'sambanova', tier: 'fast', ok: false, ms: 100, error: 'sambanova HTTP 429: model is currently experiencing high traffic' });
    expect(router.demoteDead([samba, groq]).map((p: { id: string }) => p.id)).toEqual(['groq', 'sambanova']);
    expect(router.available({ tier: 'fast' }).map((p: { id: string }) => p.id)).toEqual(['groq', 'sambanova']);
    router.record({ provider: 'sambanova', tier: 'fast', ok: true, ms: 100 });
    expect(router.available({ tier: 'fast' }).map((p: { id: string }) => p.id)).toEqual(['sambanova', 'groq']);
  });
});

describe('ModelRouter.coolDown', () => {
  it('treats a 402 that states a short retry as a short throttle, one that states a day as a daily bench, and used-up credit as a payment state', () => {
    const now = Date.parse('2026-10-23T10:00:00Z');
    const router = new ModelRouter({ providers: [], now: () => now });
    router.coolDown({ id: 'pollinations' }, new ProviderError('pollinations HTTP 402: Free limit reached: 1 reply every 30 seconds per IP. Retry after 5s', { status: 402, retryAfterMs: 5000 }));
    expect(router.cooldownUntil.get('pollinations')).toBe(now + 5000);
    router.coolDown({ id: 'gemini-minute' }, new ProviderError('gemini HTTP 429: You exceeded your current quota [quota window: per minute]', { status: 429, retryAfterMs: 37000 }));
    expect(router.cooldownUntil.get('gemini-minute')).toBe(now + 37000);
    router.coolDown({ id: 'gemini-day' }, new ProviderError('gemini HTTP 429: You exceeded your current quota [quota window: per day]', { status: 429 }));
    expect(router.cooldownUntil.get('gemini-day')).toBe(nextUtcMidnight(now));
    router.coolDown({ id: 'sambanova' }, new ProviderError('sambanova HTTP 402: balance_units 0', { status: 402 }));
    expect(router.cooldownUntil.get('sambanova')).toBe(now + PAYMENT_REST_MS);
    router.coolDown({ id: 'daily-credit' }, new ProviderError('x HTTP 402 [quota window: per day]: daily credits used up', { status: 402 }));
    expect(router.cooldownUntil.get('daily-credit')).toBe(nextUtcMidnight(now));
  });
});

describe('ModelRouter cooldowns keep the longer rest', () => {
  it('does not let a following 429 shorten a 30-minute failure bench', async () => {
    let now = 1000000;
    const samba = provider('sambanova', Array.from({ length: 12 }, () => new ProviderError('sambanova HTTP 429: rate limited', { status: 429 })));
    const groq = provider('groq', []);
    const router = new ModelRouter({ providers: [samba, groq], now: () => now });
    for (let i = 0; i < 12; i++) {
      if (i) now += 60001;
      await router.complete({ messages: [] });
    }
    expect(router.cooldownUntil.get('sambanova')).toBe(now + 30 * 60 * 1000);
    router.coolDown(samba, new ProviderError('sambanova HTTP 429: rate limited', { status: 429, retryAfterMs: 60000 }));
    expect(router.cooldownUntil.get('sambanova')).toBe(now + 30 * 60 * 1000);
    expect(router.cooldownReason.get('sambanova')).toBe('12 failed calls in a row; rests 30 min');
  });

  it('skips a provider rested by another call while a long request was in flight', async () => {
    const now = 1000000;
    let release = () => {};
    const inFlight = {
      id: 'slow',
      ready: true,
      describe: () => ({ id: 'slow' }),
      chat: () => new Promise((_, reject) => {
        release = () => reject(new ProviderError('slow HTTP 429: rate limited', { status: 429, retryAfterMs: 5000 }));
      }),
    };
    const backup = provider('backup', ['{"ok":true}']);
    const router = new ModelRouter({ providers: [inFlight, backup], now: () => now, maxWaitMs: 0 });
    const call = router.complete({ messages: [] });
    await new Promise((r) => setTimeout(r, 5));
    router.coolDown({ id: 'backup' }, new ProviderError('backup HTTP 429: rate limited', { status: 429, retryAfterMs: 60000 }));
    release();
    await expect(call).rejects.toBeInstanceOf(NoModelAvailableError);
    expect(backup.calls).toHaveLength(0);
  });
});

describe('ModelRouter model switching', () => {
  it('moves a provider to its next model when one model used its own daily quota or was withdrawn, and benches it only when none is left', async () => {
    const { OpenAICompatibleProvider } = await import('../../src/llm/provider.mjs');
    const preset = { id: 'gemini', label: 'g', baseURL: 'https://g.example/v1', keyEnv: 'K', prefer: { fast: ['m-lite', 'm-lite-2'], deep: ['m-big', 'm-mid'] } };
    const calls: string[] = [];
    const fetchImpl = async (url: string, init: { body?: string }) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm-lite' }, { id: 'm-lite-2' }, { id: 'm-big' }, { id: 'm-mid' }] }));
      const model = JSON.parse(init.body ?? '{}').model;
      calls.push(model);
      if (model === 'm-big') return new Response('{"error":{"code":429,"details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}', { status: 429 });
      if (model === 'm-lite') return new Response('{"error":{"message":"This model models/m-lite is no longer available to new users."}}', { status: 404 });
      if (model === 'm-mid') return new Response('{"error":{"code":429,"details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], model }));
    };
    const provider = await new OpenAICompatibleProvider({ preset, apiKey: 'k', fetchImpl: fetchImpl as never }).discover();
    const router = new ModelRouter({ providers: [provider], sleep: async () => {} });
    const reply = await router.complete({ purpose: 'research', tier: 'deep', messages: [{ role: 'user', content: 'x' }] });
    expect(reply.model).toBe('m-lite-2');
    expect(calls).toEqual(['m-big', 'm-mid', 'm-lite', 'm-lite-2']);
    expect(provider.selected).toMatchObject({ fast: 'm-lite-2', deep: 'm-lite-2' });
    expect(router.cooldownUntil.has('gemini')).toBe(false);
    const spent = await new OpenAICompatibleProvider({ preset: { ...preset, prefer: { fast: ['m-big'], deep: ['m-mid'] } }, apiKey: 'k', fetchImpl: (async (url: string, init: { body?: string }) => (url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'm-big' }, { id: 'm-mid' }] })) : fetchImpl(url, init))) as never }).discover();
    const benching = new ModelRouter({ providers: [spent], sleep: async () => {}, maxWaitMs: 0 });
    await expect(benching.complete({ purpose: 'research', tier: 'deep', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow();
    expect(benching.cooldownReason.get('gemini')).toMatch(/daily quota/);
  });
});

describe('ModelRouter local context size', () => {
  it('never sends a local server a prompt bigger than its context, and reads that size from llama-server', async () => {
    const { OpenAICompatibleProvider } = await import('../../src/llm/provider.mjs');
    const preset = { id: 'llamacpp', label: 'l', baseURL: 'http://127.0.0.1:8090/v1', keyEnv: null, local: true, prefer: { fast: [], deep: [] } };
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'Qwen3-4B' }] }));
      if (url.endsWith('/props')) return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 4096 }, total_slots: 2 }));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], model: 'Qwen3-4B' }));
    };
    const local = await new OpenAICompatibleProvider({ preset, fetchImpl: fetchImpl as never }).discover();
    expect(local.maxPromptTokens).toBe(1096);
    expect(local.maxConcurrent).toBe(2);
    const router = new ModelRouter({ providers: [local] });
    expect(router.available({ tier: 'fast', tokens: 1000 }).map((p: { id: string }) => p.id)).toEqual(['llamacpp']);
    expect(router.available({ tier: 'fast', tokens: 7000 })).toEqual([]);
  });
});

describe('ModelRouter speed and capacity', () => {
  const provider = (id: string, extra: object = {}) => ({ id, ready: true, describe: () => ({}), selected: { fast: `${id}-m` }, chat: async () => ({ content: '{"ok":true}', model: `${id}-m` }), ...extra });

  it('puts a provider 4x slower than the fastest (and over 20 s) behind the faster ones', () => {
    const router = new ModelRouter({ providers: [provider('pollinations'), provider('gemini'), provider('groq')] });
    for (let i = 0; i < 3; i++) {
      router.record({ provider: 'pollinations', tier: 'fast', ok: true, ms: 51000 });
      router.record({ provider: 'gemini', tier: 'fast', ok: true, ms: 2000 });
      router.record({ provider: 'groq', tier: 'fast', ok: true, ms: 15000 });
    }
    expect(router.available({ tier: 'fast' }).map((p: { id: string }) => p.id)).toEqual(['gemini', 'groq', 'pollinations']);
  });

  it('keeps the order while too few calls are timed', () => {
    const router = new ModelRouter({ providers: [provider('pollinations'), provider('gemini')] });
    router.record({ provider: 'pollinations', tier: 'fast', ok: true, ms: 90000 });
    expect(router.available({ tier: 'fast' }).map((p: { id: string }) => p.id)).toEqual(['pollinations', 'gemini']);
  });

  it('sends work past a local server whose slots are all busy, and back once one frees up', async () => {
    let release = () => {};
    const busy = provider('llamacpp', { maxConcurrent: 1, chat: () => new Promise((r) => { release = () => r({ content: '{"ok":true}', model: 'q' }); }) });
    const router = new ModelRouter({ providers: [busy, provider('cerebras')] });
    const first = router.complete({ purpose: 'critique', tier: 'fast', messages: [{ role: 'user', content: 'x' }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(router.available({ tier: 'fast' }).map((p: { id: string }) => p.id)).toEqual(['cerebras', 'llamacpp']);
    expect((await router.complete({ purpose: 'critique', tier: 'fast', messages: [{ role: 'user', content: 'x' }] })).model).toBe('cerebras-m');
    release();
    await first;
    expect(router.available({ tier: 'fast' }).map((p: { id: string }) => p.id)).toEqual(['llamacpp', 'cerebras']);
  });
});

describe('ModelRouter timeouts', () => {
  it('benches a provider for 10 minutes after 2 timeouts in a row, and counts timeouts as slow', async () => {
    const { ProviderError } = await import('../../src/llm/provider.mjs');
    let now = 1000000;
    const slow = { id: 'llamacpp-lan', ready: true, describe: () => ({}), selected: { fast: 'pc' }, chat: async () => { throw new ProviderError('llamacpp-lan unreachable: timed out', { status: 0, provider: 'llamacpp-lan' }); } };
    const fast = { id: 'groq', ready: true, describe: () => ({}), selected: { fast: 'g' }, chat: async () => ({ content: '{"ok":true}', model: 'g' }) };
    const router = new ModelRouter({ providers: [slow, fast], now: () => now });
    for (let i = 0; i < 3; i++) router.record({ provider: 'groq', tier: 'fast', ok: true, ms: 1000 });
    expect((await router.complete({ purpose: 'critique', tier: 'fast', messages: [{ role: 'user', content: 'x' }] })).model).toBe('g');
    expect(router.cooldownReason.get('llamacpp-lan') ?? '').not.toMatch(/too slow/);
    expect(router.timeoutStreak.get('llamacpp-lan')).toBe(1);
    for (let i = 0; i < 3; i++) router.record({ provider: 'llamacpp-lan', tier: 'fast', ok: false, ms: 120000, error: 'llamacpp-lan unreachable: timed out' });
    expect(router.medianMs('llamacpp-lan', 'fast')).toBe(120000);
    expect(router.available({ tier: 'fast' })[0].id).toBe('groq');
    expect(router.benchSlow(slow, new ProviderError('llamacpp-lan unreachable: timed out', { status: 0 }))).toBe(true);
    expect(router.cooldownUntil.get('llamacpp-lan')).toBe(now + 10 * 60 * 1000);
    expect(router.cooldownReason.get('llamacpp-lan')).toMatch(/too slow: 2 timeouts in a row/);
    expect(router.available({ tier: 'fast' }).map((p: { id: string }) => p.id)).toEqual(['groq']);
    now += 10 * 60 * 1000 + 1;
    expect(router.available({ tier: 'fast' }).map((p: { id: string }) => p.id)).toContain('llamacpp-lan');
  });
});

describe('ModelRouter compute errors', () => {
  const computeProvider = (id: string, replies: Array<string | Error>) => {
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
  };

  it('benches a local server for 10 minutes after 3 consecutive compute errors, so a broken GPU does not retry every minute', async () => {
    const { ProviderError } = await import('../../src/llm/provider.mjs');
    const { COMPUTE_ERROR_COOLDOWN_MS } = await import('../../src/llm/router.mjs');
    let now = 1000000;
    const broken = { id: 'llamacpp', ready: true, describe: () => ({}), selected: { fast: 'pc' }, chat: async () => { throw new ProviderError('HTTP 500: Compute error. off = 0', { status: 500 }); } };
    const router = new ModelRouter({ providers: [broken], now: () => now });
    expect(router.computeErrorStreak.get('llamacpp')).toBeUndefined();
    expect(router.benchComputeError(broken, new ProviderError('HTTP 500: Compute error', { status: 500 }))).toBe(false);
    expect(router.computeErrorStreak.get('llamacpp')).toBe(1);
    expect(router.benchComputeError(broken, new ProviderError('HTTP 500: Compute error', { status: 500 }))).toBe(false);
    expect(router.computeErrorStreak.get('llamacpp')).toBe(2);
    expect(router.benchComputeError(broken, new ProviderError('HTTP 500: Compute error', { status: 500 }))).toBe(true);
    expect(router.cooldownUntil.get('llamacpp')).toBe(now + COMPUTE_ERROR_COOLDOWN_MS);
    expect(router.cooldownReason.get('llamacpp')).toMatch(/compute error: 3 failures in a row/);
  });

  it('resets the compute error streak when a provider succeeds, so a transient failure does not bench it forever', async () => {
    const router = new ModelRouter({ providers: [], now: () => 1000000 });
    const p = { id: 'llamacpp', ready: true, describe: () => ({}), selected: { fast: 'pc' }, chat: async () => ({ content: '{"ok":true}', model: 'pc' }) };
    router.computeErrorStreak.set('llamacpp', 2);
    router.cooldownUntil.set('llamacpp', 1000000 + 600000);
    expect(router.computeErrorStreak.get('llamacpp')).toBe(2);
    router.computeErrorStreak.delete('llamacpp');
    expect(router.computeErrorStreak.get('llamacpp')).toBeUndefined();
  });

  it('does not bench for non-500 errors and does not count them toward the streak', async () => {
    const router = new ModelRouter({ providers: [], now: () => 1000000 });
    const p = { id: 'llamacpp', ready: true, describe: () => ({}), selected: { fast: 'pc' }, chat: async () => ({ content: '{"ok":true}', model: 'pc' }) };
    expect(router.benchComputeError(p, new ProviderError('bad request', { status: 400 }))).toBe(false);
    expect(router.computeErrorStreak.get('llamacpp')).toBeUndefined();
    expect(router.benchComputeError(p, new ProviderError('rate limited', { status: 429 }))).toBe(false);
    expect(router.computeErrorStreak.get('llamacpp')).toBeUndefined();
  });

  it('through complete: 3 consecutive 500s from the only provider benches it for 10 minutes instead of 1-minute retries', async () => {
    const { ProviderError } = await import('../../src/llm/provider.mjs');
    const { COMPUTE_ERROR_COOLDOWN_MS } = await import('../../src/llm/router.mjs');
    let now = 1000000;
    const broken = computeProvider('llamacpp', [
      new ProviderError('HTTP 500: Compute error', { status: 500 }),
      new ProviderError('HTTP 500: Compute error', { status: 500 }),
      new ProviderError('HTTP 500: Compute error', { status: 500 }),
    ]);
    const router = new ModelRouter({ providers: [broken], now: () => now, maxWaitMs: 0 });
    await expect(router.complete({ messages: [] })).rejects.toThrow();
    expect(router.computeErrorStreak.get('llamacpp')).toBe(1);
    expect(router.cooldownUntil.get('llamacpp')).toBe(now + 60000);
    now += 60001;
    await expect(router.complete({ messages: [] })).rejects.toThrow();
    expect(router.computeErrorStreak.get('llamacpp')).toBe(2);
    expect(router.cooldownUntil.get('llamacpp')).toBe(now + COMPUTE_ERROR_COOLDOWN_MS);
    expect(router.cooldownReason.get('llamacpp')).toMatch(/trial call after a rest failed \(HTTP 500\)/);
    now += COMPUTE_ERROR_COOLDOWN_MS + 1;
    await expect(router.complete({ messages: [] })).rejects.toThrow();
    expect(router.computeErrorStreak.get('llamacpp')).toBe(3);
    expect(router.cooldownUntil.get('llamacpp')).toBeGreaterThan(now + COMPUTE_ERROR_COOLDOWN_MS - 1000);
    expect(router.cooldownReason.get('llamacpp')).toMatch(/compute error: 3 failures in a row/);
  });
});

describe('ModelRouter provider failure streak bench', () => {
  const rateLimited = () => new ProviderError('sambanova HTTP 429: rate limited', { status: 429 });
  const badRequest = () => new ProviderError('sambanova HTTP 400: bad request', { status: 400 });

  it('benches a provider for 30 minutes after 12 failed calls in a row, and the next call goes to another provider', async () => {
    let now = 1000000;
    const samba = provider('sambanova', Array.from({ length: 12 }, rateLimited));
    const groq = provider('groq', []);
    const router = new ModelRouter({ providers: [samba, groq], now: () => now });
    for (let i = 0; i < 12; i++) {
      if (i) now += 60001;
      expect((await router.complete({ messages: [] })).provider).toBe('groq');
    }
    expect(samba.calls).toHaveLength(12);
    expect(router.failureStreak.get('sambanova')).toBe(0);
    expect(router.streakBenches.get('sambanova')).toBe(1);
    expect(router.cooldownUntil.get('sambanova')).toBe(now + 30 * 60 * 1000);
    expect(router.cooldownReason.get('sambanova')).toBe('12 failed calls in a row; rests 30 min');
    expect(router.ledger.find((r) => r.purpose === 'router' && r.provider === 'sambanova')).toMatchObject({ ok: false, ms: 0, error: '12 failed calls in a row; rests 30 min' });
    expect((await router.complete({ messages: [] })).provider).toBe('groq');
    expect(samba.calls).toHaveLength(12);
    expect(groq.calls).toHaveLength(13);
  });

  it('doubles the rest each time the provider is benched again: 30 minutes, then 60', async () => {
    let now = 1000000;
    const samba = provider('sambanova', Array.from({ length: 24 }, rateLimited));
    const groq = provider('groq', []);
    const router = new ModelRouter({ providers: [samba, groq], now: () => now });
    const fail = async () => expect((await router.complete({ messages: [] })).provider).toBe('groq');
    for (let i = 0; i < 12; i++) {
      if (i) now += 60001;
      await fail();
    }
    expect(router.cooldownUntil.get('sambanova')).toBe(now + 30 * 60 * 1000);
    expect(router.streakBenches.get('sambanova')).toBe(1);
    now = router.cooldownUntil.get('sambanova') + 1;
    for (let i = 0; i < 12; i++) {
      if (i) now += 60001;
      router.countFailure(samba);
    }
    expect(router.streakBenches.get('sambanova')).toBe(2);
    expect(router.cooldownUntil.get('sambanova')).toBe(now + 60 * 60 * 1000);
    expect(router.cooldownReason.get('sambanova')).toBe('12 failed calls in a row; rests 60 min');
  });

  it('resets the streak and the bench count when a call succeeds (11 failures, 1 success, 11 failures is not benched)', async () => {
    const now = 1000000;
    const samba = provider('sambanova', [...Array.from({ length: 11 }, badRequest), '{"ok":true}', ...Array.from({ length: 11 }, badRequest)]);
    const groq = provider('groq', []);
    const router = new ModelRouter({ providers: [samba, groq], now: () => now });
    for (let i = 0; i < 11; i++) await router.complete({ messages: [] });
    expect(router.failureStreak.get('sambanova')).toBe(11);
    router.streakBenches.set('sambanova', 3);
    expect((await router.complete({ messages: [] })).provider).toBe('sambanova');
    expect(router.failureStreak.get('sambanova')).toBeUndefined();
    expect(router.streakBenches.has('sambanova')).toBe(false);
    for (let i = 0; i < 11; i++) await router.complete({ messages: [] });
    expect(router.failureStreak.get('sambanova')).toBe(11);
    expect(router.streakBenches.has('sambanova')).toBe(false);
    expect(router.cooldownUntil.has('sambanova')).toBe(false);
    expect(router.ledger.some((r) => r.purpose === 'router' && r.provider === 'sambanova')).toBe(false);
  });

  it('caps the rest at 6 hours however many times it is benched', async () => {
    const now = 1000000;
    const samba = provider('sambanova', Array.from({ length: 12 }, badRequest));
    const groq = provider('groq', []);
    const router = new ModelRouter({ providers: [samba, groq], now: () => now });
    router.streakBenches.set('sambanova', 4);
    for (let i = 0; i < 12; i++) await router.complete({ messages: [] });
    expect(router.cooldownUntil.get('sambanova')).toBe(now + 6 * 60 * 60 * 1000);
    expect(router.cooldownReason.get('sambanova')).toBe('12 failed calls in a row; rests 360 min');
    expect(router.streakBenches.get('sambanova')).toBe(5);
  });

  it('does not count the router\'s own note rows toward a provider\'s streak', async () => {
    let now = 1000000;
    const samba = provider('sambanova', Array.from({ length: 9 }, () => new ProviderError('sambanova HTTP 429: rate limited', { status: 429, retryAfterMs: 5000 })));
    const router = new ModelRouter({ providers: [samba], now: () => now, sleep: async (ms: number) => { now += ms; } });
    for (let i = 0; i < 3; i++) await expect(router.complete({ messages: [] })).rejects.toBeInstanceOf(NoModelAvailableError);
    expect(router.ledger.filter((r) => r.provider === 'router')).toHaveLength(8);
    expect(router.failureStreak.get('sambanova')).toBe(9);
    expect(router.streakBenches.has('sambanova')).toBe(false);
    expect(router.ledger.some((r) => r.purpose === 'router' && r.provider === 'sambanova')).toBe(false);
  });
});

describe('ModelRouter local models by measured speed', () => {
  it('gives a local model only the calls that fit its speed, keeps it as last resort, and sizes its time limit to the call', async () => {
    const { OpenAICompatibleProvider } = await import('../../src/llm/provider.mjs');
    const preset = { id: 'llamacpp', label: 'l', baseURL: 'http://127.0.0.1:8090/v1', keyEnv: null, local: true, prefer: { fast: [], deep: [] } };
    const mac = new OpenAICompatibleProvider({ preset, fetchImpl: (async () => new Response('{}')) as never });
    mac.state = 'ready';
    mac.selected = { fast: 'Qwen3-4B', deep: 'Qwen3-4B', vision: null };
    mac.speed = { prefill: 102, decode: 19.2 };
    const cloud = { id: 'groq', ready: true, describe: () => ({}), selected: { fast: 'g' }, chat: async () => ({ content: '{}', model: 'g' }) };
    const router = new ModelRouter({ providers: [mac, cloud] });
    expect(router.available({ tier: 'fast', purpose: 'rollup', tokens: 1500 }).map((p: { id: string }) => p.id)).toEqual(['llamacpp', 'groq']);
    expect(router.available({ tier: 'fast', purpose: 'research', tokens: 9000 }).map((p: { id: string }) => p.id)).toEqual(['groq', 'llamacpp']);
    expect(router.available({ tier: 'deep', purpose: 'synthesize', tokens: 8400 }).map((p: { id: string }) => p.id)[0]).toBe('llamacpp');
    expect(mac.estimateSeconds(8400, 1500)).toBeCloseTo(160.5, 0);
    expect(mac.timeoutFor(8400, 1500)).toBe(Math.round(mac.estimateSeconds(8400, 1500) * 1500 + 10000));
    expect(mac.timeoutFor(500, 50)).toBe(60000);
    expect(mac.timeoutFor(60000, 4000)).toBe(480000);
    delete mac.speed;
    expect(mac.timeoutFor(8400, 1500)).toBeUndefined();
  });
});


describe('ModelRouter last-resort local models', () => {
  it('uses a local model rated too slow after every cloud provider, so research never runs out of models', async () => {
    let now = 1000;
    const cloud = provider('gemini', [new ProviderError('quota', { status: 429 })]);
    const slow = { ...provider('llamacpp-lan', ['{"answer":"from the PC"}']), ready: false, state: 'too-slow', preset: { local: true }, selected: { fast: 'pc-model', deep: 'pc-model' } };
    const unconfigured = { ...provider('llamacpp', []), ready: false, state: 'failed', preset: { local: true }, selected: {} };
    const router = new ModelRouter({ providers: [slow, cloud, unconfigured], now: () => now, cooldownMs: 60000 });
    expect(router.available().map((p: { id: string }) => p.id)).toEqual(['gemini', 'llamacpp-lan']);
    const reply = await router.complete({ messages: [] });
    expect(reply).toMatchObject({ provider: 'llamacpp-lan', data: { answer: 'from the PC' } });
    expect(router.available({ tier: 'vision' }).map((p: { id: string }) => p.id)).toEqual([]);
  });
});

describe('ModelRouter paced providers', () => {
  it('keeps a provider that would have to queue behind the free ones', () => {
    const queued = { ...provider('pollinations', ['{}']), queueMs: () => 30000 };
    const free = provider('groq', ['{}']);
    const router = new ModelRouter({ providers: [queued, free] });
    expect(router.available({ tier: 'fast' }).map((p: { id: string }) => p.id)).toEqual(['groq', 'pollinations']);
  });

  it('records the service time without the queue wait the provider sat through', async () => {
    let now = 1000;
    const paced = { id: 'pollinations', ready: true, describe: () => ({ id: 'pollinations' }), selected: { fast: 'm' }, chat: async () => { now += 40000; return { content: '{"ok":true}', model: 'm', waitMs: 30000 }; } };
    const router = new ModelRouter({ providers: [paced], now: () => now });
    await router.complete({ messages: [] });
    expect(router.ledger[0]).toMatchObject({ provider: 'pollinations', ok: true, ms: 10000, waitMs: 30000 });
  });
});

describe('router outcomes', () => {
  it('records a graded answer under the purpose class the routing plan uses', async () => {
    const { OutcomeBook } = await import('../../src/llm/outcomes.mjs');
    const { ModelRouter } = await import('../../src/llm/router.mjs');
    const outcomes = new OutcomeBook({ now: () => 1000 });
    const router = new ModelRouter({ providers: [], outcomes });
    router.recordOutcome({ provider: 'groq', purpose: 'research', passed: true });
    router.recordOutcome({ provider: 'groq', purpose: 'synthesize', passed: false });
    expect(outcomes.posterior('groq', 'research', 4)).toMatchObject({ pass: 1, fail: 0 });
    expect(outcomes.posterior('groq', 'top', 4)).toMatchObject({ pass: 0, fail: 1 });
    expect(() => new ModelRouter({ providers: [] }).recordOutcome({ provider: 'x', purpose: 'research', passed: true })).not.toThrow();
  });

  it('records a graded answer under the model that wrote it, so a new model starts from its prior', () => {
    const outcomes = new OutcomeBook({ now: () => 1000 });
    const router = new ModelRouter({ providers: [], outcomes });
    for (let i = 0; i < 5; i++) router.recordOutcome({ provider: 'groq', model: 'openai/gpt-oss-20b', purpose: 'research', passed: false });
    expect(outcomes.posterior('groq', 'research', 4, 'openai/gpt-oss-20b')).toMatchObject({ pass: 0, fail: 5 });
    expect(outcomes.posterior('groq', 'research', 4, 'openai/gpt-oss-120b')).toMatchObject({ observed: 0, mean: 0.8 });
  });
});

const CLOUDFLARE_410 = 'cloudflare HTTP 410: {"errors":[{"message":"AiError: Model has been deprecated: @cf/meta/infire-llama-3.1-8b-instruct was deprecated on 2026-05-30. See the model catalog for alternatives: https://deve';
const CLOUDFLARE_410_BODY = CLOUDFLARE_410.slice('cloudflare HTTP 410: '.length);
const GROQ_429 = 'groq HTTP 429 [quota window: per minute]: {"error":{"message":"Rate limit reached for model `openai/gpt-oss-20b`';
const COHERE_500 = 'cohere HTTP 500: {"id":"cddb413c-d9eb-4993-b6e4-7af1930dbef5","message":"internal server error, this has been reported to our developers. id d9ae694e81ceeffa254ec7ff5e94c7e4"}';
const CEREBRAS_400 = 'cerebras HTTP 400: {"message":": Invalid JSON: unexpected end of hex escape at line 1 column 15189","type":"invalid_request_error","param":"validation_error","code":"wrong_api_format"}';
const NVIDIA_TIMEOUT = 'nvidia unreachable: timed out';

describe('ModelRouter deprecated models', () => {
  it('modelGone reads the real cloudflare 410, a 404 for a withdrawn model, and leaves limits and server errors alone', () => {
    expect(modelGone(new ProviderError(CLOUDFLARE_410, { status: 410 }))).toBe(true);
    expect(modelGone(new ProviderError(CLOUDFLARE_410, { status: 400 }))).toBe(true);
    expect(modelGone(new ProviderError('gone', { status: 410 }))).toBe(true);
    expect(modelGone(new ProviderError('nvidia HTTP 404: {"status":404,"title":"Not Found"', { status: 404 }))).toBe(true);
    expect(modelGone(new ProviderError(GROQ_429, { status: 429 }))).toBe(false);
    expect(modelGone(new ProviderError(COHERE_500, { status: 500 }))).toBe(false);
    expect(modelGone(new ProviderError(CEREBRAS_400, { status: 400 }))).toBe(false);
    expect(modelGone(new ProviderError(NVIDIA_TIMEOUT, { status: 0 }))).toBe(false);
  });

  it('the real cloudflare 410 deprecated error benches a provider whose model cannot switch, for 24 h, naming the model and the env var', async () => {
    let now = Date.parse('2026-11-02T12:26:22Z');
    const model = '@cf/meta/infire-llama-3.1-8b-instruct';
    const cloudflare = { ...provider('cloudflare', Array.from({ length: 38 }, () => new ProviderError(CLOUDFLARE_410, { status: 410 }))), selected: { fast: model, deep: 'other-deep' } };
    const b = provider('b', []);
    const router = new ModelRouter({ providers: [cloudflare, b], now: () => now });
    for (let i = 0; i < 5; i++) await expect(router.complete({ purpose: 'critique', messages: [] })).resolves.toMatchObject({ provider: 'b' });
    expect(cloudflare.calls).toHaveLength(1);
    expect(router.cooldownUntil.get('cloudflare')).toBe(now + MODEL_GONE_REST_MS);
    expect(MODEL_GONE_REST_MS).toBe(24 * 3600 * 1000);
    const reason = router.cooldownReason.get('cloudflare');
    expect(reason).toContain(model);
    expect(reason).toContain('FRL_CLOUDFLARE_FAST_MODEL');
    expect(reason).not.toContain('FRL_CLOUDFLARE_DEEP_MODEL');
    expect(router.ledger.filter((r) => r.purpose === 'router')).toEqual([expect.objectContaining({ provider: 'cloudflare', model, ok: false, error: reason })]);
    expect(router.status().find((s) => s.id === 'cloudflare')).toMatchObject({ coolingDownMs: MODEL_GONE_REST_MS, coolingReason: reason });
    now += MODEL_GONE_REST_MS - 1000;
    expect(router.available().map((p) => p.id)).toEqual(['b']);
  });

  it('rests a provider whose last model is gone only until its other models\' quota resets, not 24 h', async () => {
    let now = Date.parse('2026-11-18T05:40:00Z');
    const reset = Date.parse('2026-11-18T08:00:00Z');
    const model = 'gemini-2.5-flash';
    const gemini = { ...provider('gemini', [new ProviderError('gemini HTTP 404: models/gemini-2.5-flash is not found', { status: 404 })]), selected: { fast: 'gemini-3.1-flash-lite', deep: model }, retired: new Map([['gemini-3.5-flash', reset], ['gemini-flash-latest', reset], ['old-one', Infinity]]) };
    const b = provider('b', []);
    const router = new ModelRouter({ providers: [gemini, b], now: () => now });
    router.benchGoneModel(gemini as never, model, new ProviderError('gone', { status: 404 }));
    expect(router.cooldownUntil.get('gemini')).toBe(reset);
    expect(router.cooldownReason.get('gemini')).toBe('gemini-2.5-flash is gone (HTTP 404) and cannot be switched; every other model of this provider rests for its quota, so it rests until the first of them resets (140 min), set FRL_GEMINI_DEEP_MODEL to a model this provider still serves');
  });

  it('benches a provider whose deprecated model is pinned by an env override, and retires and switches the model when the provider can', async () => {
    const { OpenAICompatibleProvider } = await import('../../src/llm/provider.mjs');
    const dead = '@cf/meta/infire-llama-3.1-8b-instruct';
    const live = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    const preset = { id: 'cloudflare', label: 'c', baseURL: 'https://c.example/v1', keyEnv: 'K', prefer: { fast: [dead, live], deep: [live] } };
    const asked: string[] = [];
    const fetchImpl = async (url: string, init: { body?: string }) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: dead }, { id: live }] }));
      const model = JSON.parse(init.body ?? '{}').model;
      asked.push(model);
      if (model === dead) return new Response(CLOUDFLARE_410_BODY, { status: 410 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], model }));
    };
    const free = await new OpenAICompatibleProvider({ preset, apiKey: 'k', fetchImpl: fetchImpl as never }).discover();
    expect(free.selected.fast).toBe(dead);
    const switching = new ModelRouter({ providers: [free], sleep: async () => {} });
    await expect(switching.complete({ purpose: 'critique', messages: [{ role: 'user', content: 'x' }] })).resolves.toMatchObject({ model: live });
    expect(asked).toEqual([dead, live]);
    expect(free.selected.fast).toBe(live);
    expect(free.retired.get(dead)).toBe(Infinity);
    expect(switching.cooldownUntil.has('cloudflare')).toBe(false);
    expect(switching.ledger.find((r) => r.purpose === 'router')?.error).toBe(`${dead} is no longer available; switched to ${live} / ${live}`);
    asked.length = 0;
    const pinned = await new OpenAICompatibleProvider({ preset, apiKey: 'k', modelOverrides: { fast: dead }, fetchImpl: fetchImpl as never }).discover();
    const benching = new ModelRouter({ providers: [pinned], sleep: async () => {}, maxWaitMs: 0 });
    await expect(benching.complete({ purpose: 'critique', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/Model has been deprecated/);
    await expect(benching.complete({ purpose: 'critique', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(NoModelAvailableError);
    expect(asked).toEqual([dead]);
    expect(pinned.selected.fast).toBe(dead);
    expect(benching.cooldownReason.get('cloudflare')).toMatch(/infire-llama-3\.1-8b-instruct is gone \(HTTP 410\).*rests 24 h, set FRL_CLOUDFLARE_FAST_MODEL /);
  });
});

const CLOUDFLARE_PLAN_BODY = '{"errors":[{"message":"AiError: Model @cf/zai-org/glm-5.3 is not available on the Workers Free plan: Model @cf/zai-org/glm-5.3 is not available on the Workers Free plan. Upgrade t';
const CLOUDFLARE_PLAN = `cloudflare HTTP 403: ${CLOUDFLARE_PLAN_BODY}`;
const CEREBRAS_PAYMENT = 'cerebras HTTP 402: {"message":"Payment required to access this resource. Visit your billing tab.","type":"payment_required_error","param":"quota","code":"payment_required"}';

describe('ModelRouter models the account plan does not allow', () => {
  const glm = '@cf/zai-org/glm-5.3';
  const oss = '@cf/openai/gpt-oss-120b';
  const qwen = '@cf/qwen/qwen3.8-27b';
  const preset = { id: 'cloudflare', label: 'c', baseURL: 'https://c.example/v1', keyEnv: 'K', prefer: { fast: ['@cf/meta/llama-3.1-8b-instruct'], deep: [oss, '@cf/meta/llama-3.3-70b-instruct-fp8-fast'] }, fallbackModels: { fast: '@cf/meta/llama-3.1-8b-instruct', deep: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' } };
  const account = (asked: string[], models = [glm, oss, qwen]) => async (url: string, init: { body?: string }) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }));
    const model = JSON.parse(init.body ?? '{}').model;
    asked.push(model);
    if (model === glm) return new Response(CLOUDFLARE_PLAN_BODY, { status: 403 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], model }));
  };
  const deep = (router: ModelRouter) => router.complete({ purpose: 'decision-model', tier: 'deep', messages: [{ role: 'user', content: 'x' }] });

  it('reads the raw cloudflare 403 as a model the plan does not allow, and no rejected key, payment, quota or gone model as one', () => {
    expect(planGated(new ProviderError(CLOUDFLARE_PLAN, { status: 403 }))).toBe(true);
    expect(planGated(new ProviderError(CEREBRAS_PAYMENT, { status: 402 }))).toBe(false);
    expect(planGated(new ProviderError(COHERE_MONTH, { status: 429 }))).toBe(false);
    expect(planGated(new ProviderError(CLOUDFLARE_410, { status: 410 }))).toBe(false);
    expect(planGated(new ProviderError('cerebras HTTP 401: invalid key', { status: 401 }))).toBe(false);
    expect(planGated(new ProviderError(GROQ_429, { status: 429 }))).toBe(false);
  });

  it('marks the model unusable for that provider and answers with its next model in the same call, without resting the provider', async () => {
    const asked: string[] = [];
    const { OpenAICompatibleProvider } = await import('../../src/llm/provider.mjs');
    const cloudflare = await new OpenAICompatibleProvider({ preset, apiKey: 'k', modelOverrides: { fast: qwen, deep: glm }, fetchImpl: account(asked) as never }).discover();
    expect(cloudflare.selected).toMatchObject({ fast: qwen, deep: glm });
    const router = new ModelRouter({ providers: [cloudflare], sleep: async () => {}, maxWaitMs: 0 });
    await expect(deep(router)).resolves.toMatchObject({ provider: 'cloudflare', model: oss });
    await expect(deep(router)).resolves.toMatchObject({ provider: 'cloudflare', model: oss });
    expect(asked).toEqual([glm, oss, oss]);
    expect(cloudflare.selected).toMatchObject({ fast: qwen, deep: oss });
    expect(router.cooldownUntil.has('cloudflare')).toBe(false);
    expect(router.ledger.filter((row: { purpose: string }) => row.purpose === 'router')).toEqual([expect.objectContaining({ provider: 'cloudflare', model: glm, ok: false, error: `model ${glm} is not available on this account's plan (HTTP 403); switched to ${qwen} / ${oss}` })]);
    const rebuilt = await new OpenAICompatibleProvider({ preset, apiKey: 'k', modelOverrides: { fast: qwen, deep: glm }, fetchImpl: account(asked) as never }).discover();
    expect(rebuilt.selected.deep).toBe(glm);
    router.setProviders([rebuilt]);
    expect(rebuilt.selected).toMatchObject({ fast: qwen, deep: oss });
    expect(rebuilt.describe().detail).toBe(`fast=${qwen} deep=${oss} · ${glm} is not available on this account's plan`);
    router.forgetBench('cloudflare');
    const newKey = await new OpenAICompatibleProvider({ preset, apiKey: 'k2', modelOverrides: { fast: qwen, deep: glm }, fetchImpl: account(asked) as never }).discover();
    router.setProviders([newKey]);
    expect(newKey.selected.deep).toBe(glm);
  });

  it('takes the mark from the raw call log after a restart and neither rests the provider nor counts the row as a failure', async () => {
    const now = Date.parse('2026-11-19T11:16:07Z');
    const { OpenAICompatibleProvider } = await import('../../src/llm/provider.mjs');
    const cloudflare = await new OpenAICompatibleProvider({ preset, apiKey: 'k', modelOverrides: { fast: qwen, deep: glm }, fetchImpl: account([]) as never, now: () => now }).discover();
    const router = new ModelRouter({ providers: [cloudflare], now: () => now });
    const row = (ts: string, purpose: string) => ({ ts, purpose, tier: 'deep', provider: 'cloudflare', ok: false, ms: 356, error: CLOUDFLARE_PLAN, project: 'find-40-activity-providers-in-gr-fbadb7', keys: 1, model: glm });
    const restored = router.restoreCooldowns([...Array.from({ length: 12 }, (_, i) => row(new Date(now - (20 - i) * 60000).toISOString(), 'checklist')), row('2026-11-19T08:10:14.145Z', 'decision-model')].sort((a, b) => a.ts.localeCompare(b.ts)));
    expect(restored).toEqual([]);
    expect(router.cooldownUntil.has('cloudflare')).toBe(false);
    expect(cloudflare.selected).toMatchObject({ fast: qwen, deep: oss });
    expect(router.available({ tier: 'deep' }).map((p: { id: string }) => p.id)).toEqual(['cloudflare']);
    const upgraded = new ModelRouter({ providers: [cloudflare], now: () => now });
    const fresh = await new OpenAICompatibleProvider({ preset, apiKey: 'k', modelOverrides: { fast: qwen, deep: glm }, fetchImpl: account([]) as never, now: () => now }).discover();
    upgraded.setProviders([fresh]);
    upgraded.restoreCooldowns([row('2026-11-19T08:10:14.145Z', 'decision-model'), { ts: '2026-11-19T09:00:00Z', purpose: 'research', tier: 'deep', provider: 'cloudflare', model: glm, ok: true, ms: 900 }]);
    expect(fresh.selected.deep).toBe(glm);
  });

  it('rests the provider with the plan as the reason when no other model is left, never as a rejected key', async () => {
    const now = Date.parse('2026-11-19T08:10:14Z');
    const asked: string[] = [];
    const { OpenAICompatibleProvider } = await import('../../src/llm/provider.mjs');
    const only = { ...preset, prefer: { fast: [glm], deep: [glm] }, fallbackModels: undefined };
    const cloudflare = await new OpenAICompatibleProvider({ preset: only, apiKey: 'k', fetchImpl: account(asked, [glm]) as never, now: () => now }).discover();
    const b = provider('b', []);
    const router = new ModelRouter({ providers: [cloudflare, b], now: () => now, sleep: async () => {} });
    await expect(deep(router)).resolves.toMatchObject({ provider: 'b' });
    expect(asked).toEqual([glm]);
    expect(router.cooldownUntil.get('cloudflare')).toBe(now + MODEL_GONE_REST_MS);
    expect(router.cooldownReason.get('cloudflare')).toBe(`${glm} is not available on this account's plan (HTTP 403) and no other model is; rests 24 h, set FRL_CLOUDFLARE_FAST_MODEL / FRL_CLOUDFLARE_DEEP_MODEL to a model the plan allows`);
  });
});

function gated(id: string) {
  const waiting: Array<(value: string | Error) => void> = [];
  const state = { started: 0 };
  return {
    id,
    ready: true,
    waiting,
    state,
    async chat() {
      state.started++;
      const next = await new Promise<string | Error>((resolve) => waiting.push(resolve));
      if (next instanceof Error) throw next;
      return { content: next, model: `${id}-m`, provider: id, usage: {} };
    },
    describe: () => ({ id }),
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

describe('ModelRouter half-open after a bench', () => {
  it('half-open admits one trial call after a bench lapses and closes on success', async () => {
    let now = 1000;
    const groq = gated('groq');
    const b = provider('b', []);
    const router = new ModelRouter({ providers: [groq, b], now: () => now, cooldownMs: 60000 });
    const first = router.complete({ messages: [] });
    await tick();
    groq.waiting.shift()?.(new ProviderError(GROQ_429, { status: 429 }));
    await expect(first).resolves.toMatchObject({ provider: 'b' });
    expect(router.available().map((p) => p.id)).toEqual(['b']);
    now += 60001;
    expect(router.halfOpen('groq')).toBe(true);
    expect(router.available().map((p) => p.id)).toEqual(['groq', 'b']);
    const stale = router.available();
    const trial = router.complete({ messages: [] });
    await tick();
    expect(groq.state.started).toBe(2);
    expect(router.available().map((p) => p.id)).toEqual(['b']);
    await expect(router.complete({ messages: [] })).resolves.toMatchObject({ provider: 'b' });
    await expect(router.tryProviders(stale, { messages: [], tier: 'fast', json: true, purpose: 'chat' }, [])).resolves.toMatchObject({ provider: 'b' });
    expect(groq.state.started).toBe(2);
    groq.waiting.shift()?.('{"x":1}');
    await expect(trial).resolves.toMatchObject({ provider: 'groq', data: { x: 1 } });
    expect(router.halfOpen('groq')).toBe(false);
    expect(router.cooldownUntil.has('groq')).toBe(false);
    expect(router.cooldownReason.has('groq')).toBe(false);
    const both = [router.complete({ messages: [] }), router.complete({ messages: [] })];
    await tick();
    expect(groq.state.started).toBe(4);
    groq.waiting.splice(0).forEach((resolve) => resolve('{}'));
    await Promise.all(both);
  });

  it('half-open re-opens on a failed trial: 10 min after one compute error or one timeout, the normal cooldown otherwise', async () => {
    let now = 1000;
    const cohere = provider('cohere', [new ProviderError(GROQ_429, { status: 429 }), new ProviderError(COHERE_500, { status: 500 }), new ProviderError(NVIDIA_TIMEOUT, { status: 0 }), new ProviderError(CEREBRAS_400, { status: 400 }), '{"back":true}']);
    const b = provider('b', []);
    const router = new ModelRouter({ providers: [cohere, b], now: () => now, cooldownMs: 60000 });
    await expect(router.complete({ messages: [] })).resolves.toMatchObject({ provider: 'b' });
    expect(router.cooldownUntil.get('cohere')).toBe(now + 60000);
    now += 60001;
    await expect(router.complete({ messages: [] })).resolves.toMatchObject({ provider: 'b' });
    expect(router.cooldownUntil.get('cohere')).toBe(now + COMPUTE_ERROR_COOLDOWN_MS);
    expect(router.cooldownReason.get('cohere')).toMatch(/trial call after a rest failed \(HTTP 500\); rests 10 min more/);
    now += COMPUTE_ERROR_COOLDOWN_MS + 1;
    await expect(router.complete({ messages: [] })).resolves.toMatchObject({ provider: 'b' });
    expect(router.cooldownUntil.get('cohere')).toBe(now + TIMEOUT_BENCH_MS);
    expect(router.cooldownReason.get('cohere')).toMatch(/trial call after a rest failed \(timed out\)/);
    now += TIMEOUT_BENCH_MS + 1;
    await expect(router.complete({ messages: [] })).resolves.toMatchObject({ provider: 'b' });
    expect(router.cooldownUntil.get('cohere')).toBe(now + 60000);
    expect(router.available().map((p) => p.id)).toEqual(['b']);
    now += 60001;
    await expect(router.complete({ messages: [] })).resolves.toMatchObject({ provider: 'cohere', data: { back: true } });
    expect(router.cooldownUntil.has('cohere')).toBe(false);
    expect(cohere.calls).toHaveLength(5);
  });

  it('a second call waits for the trial instead of failing when every provider is cooling, and gives up after the wait limit', async () => {
    let now = 1000;
    const groq = gated('groq');
    const sleeps: number[] = [];
    let release = true;
    const router = new ModelRouter({ providers: [groq], now: () => now, cooldownMs: 60000, maxWaitMs: 65000, sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
      if (ms === TRIAL_POLL_MS && release) groq.waiting.shift()?.('{"trial":true}');
      await tick();
    } });
    const first = router.complete({ messages: [] });
    await tick();
    groq.waiting.shift()?.(new ProviderError(GROQ_429, { status: 429 }));
    await settle();
    expect(sleeps).toEqual([60000]);
    expect(groq.state.started).toBe(2);
    expect(router.available()).toEqual([]);
    expect(router.shortestCooldownMs()).toBe(TRIAL_POLL_MS);
    const second = router.complete({ messages: [] });
    await settle();
    expect(sleeps).toEqual([60000, TRIAL_POLL_MS]);
    await expect(first).resolves.toMatchObject({ provider: 'groq', data: { trial: true } });
    expect(groq.state.started).toBe(3);
    groq.waiting.shift()?.('{"second":true}');
    await expect(second).resolves.toMatchObject({ provider: 'groq', data: { second: true } });
    expect(router.shortestCooldownMs()).toBe(0);
    release = false;
    router.cooldownUntil.set('groq', now - 1);
    const stuck = router.complete({ messages: [] });
    await settle();
    await expect(router.complete({ messages: [] })).rejects.toThrow(NoModelAvailableError);
    expect(sleeps.slice(2)).toEqual(Array.from({ length: 65 }, () => TRIAL_POLL_MS));
    groq.waiting.shift()?.('{}');
    await stuck;
  });

  it('an all-network outage during the trial leaves the provider half-open instead of re-opening the bench', async () => {
    let now = 1000;
    const a = provider('a', [new ProviderError(GROQ_429, { status: 429 }), new ProviderError('a unreachable: fetch failed', { status: 0 }), '{"ok":true}']);
    const router = new ModelRouter({ providers: [a], now: () => now, cooldownMs: 60000, sleep: async (ms: number) => {
      now += ms;
    }, offlineBackoff: [10] });
    await expect(router.complete({ messages: [] })).resolves.toMatchObject({ provider: 'a' });
    expect(a.calls).toHaveLength(3);
    expect(router.cooldownUntil.has('a')).toBe(false);
  });
});

describe('ModelRouter capacity inside one provider', () => {
  const chatReply = (model: string) => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], model }));
  const ask = (router: ModelRouter) => router.complete({ purpose: 'research', tier: 'fast', messages: [{ role: 'user', content: 'x' }] });

  it('treats a busy model as overloaded, but a plain rate limit or a daily quota as a limit', () => {
    expect(overloaded(new ProviderError('gemini HTTP 503: This model is currently experiencing high demand', { status: 503 }))).toBe(true);
    expect(overloaded(new ProviderError('sambanova HTTP 429: DeepSeek-V3.2-16k is currently experiencing high traffic', { status: 429 }))).toBe(true);
    expect(overloaded(new ProviderError('openrouter HTTP 429: Provider returned error', { status: 429 }))).toBe(true);
    expect(overloaded(new ProviderError('groq HTTP 429 [quota window: per minute]: Rate limit reached for model', { status: 429 }))).toBe(false);
    expect(overloaded(new ProviderError('groq HTTP 429 [quota window: per day, per model]: Rate limit reached', { status: 429 }))).toBe(false);
  });

  it('moves an overloaded model aside for 10 minutes and answers with the next model in the same call', async () => {
    const { OpenAICompatibleProvider } = await import('../../src/llm/provider.mjs');
    let now = Date.parse('2026-11-02T09:00:00Z');
    const calls: string[] = [];
    const fetchImpl = async (url: string, init: { body?: string }) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'flash' }, { id: 'flash-2' }] }));
      const model = JSON.parse(init.body ?? '{}').model;
      calls.push(model);
      return model === 'flash' ? new Response('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}', { status: 503 }) : chatReply(model);
    };
    const preset = { id: 'gemini', label: 'g', baseURL: 'https://g.example/v1', keyEnv: 'K', prefer: { fast: ['flash', 'flash-2'], deep: ['flash'] } };
    const provider = await new OpenAICompatibleProvider({ preset, apiKey: 'k', fetchImpl: fetchImpl as never, now: () => now }).discover();
    const router = new ModelRouter({ providers: [provider], sleep: async () => {}, now: () => now });
    expect((await ask(router)).model).toBe('flash-2');
    expect(calls).toEqual(['flash', 'flash-2']);
    expect(provider.retired.get('flash')).toBe(now + OVERLOAD_REST_MS);
    expect(router.cooldownUntil.has('gemini')).toBe(false);
    expect(router.computeErrorStreak.has('gemini')).toBe(false);
    now += OVERLOAD_REST_MS + 1;
    expect(provider.retireModel('flash-2', now + OVERLOAD_REST_MS)).toBe(true);
    expect(provider.selected.fast).toBe('flash');
  });

  it('hands a rate-limited key over to the next key of the same provider, and rests the provider only when every key rests', async () => {
    const { OpenAICompatibleProvider } = await import('../../src/llm/provider.mjs');
    const now = Date.parse('2026-11-02T09:00:00Z');
    const used: string[] = [];
    let limited = new Set(['k1']);
    const fetchImpl = async (url: string, init: { headers?: Record<string, string> }) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-oss-120b' }] }));
      const key = String(init.headers?.authorization).replace('Bearer ', '');
      used.push(key);
      return limited.has(key) ? new Response('{"error":{"message":"Rate limit reached for model on requests per minute (RPM). Please try again in 20s"}}', { status: 429, headers: { 'retry-after': '20' } }) : chatReply('gpt-oss-120b');
    };
    const preset = { id: 'groq', label: 'q', baseURL: 'https://q.example/v1', keyEnv: 'K', prefer: { fast: ['gpt-oss-120b'], deep: ['gpt-oss-120b'] } };
    const provider = await new OpenAICompatibleProvider({ preset, apiKey: 'k1, k2,k1', fetchImpl: fetchImpl as never, now: () => now }).discover();
    expect(provider.keyCount).toBe(2);
    const router = new ModelRouter({ providers: [provider], sleep: async () => {}, now: () => now, maxWaitMs: 0 });
    expect((await ask(router)).model).toBe('gpt-oss-120b');
    expect(used).toEqual(['k1', 'k2']);
    expect(router.cooldownUntil.has('groq')).toBe(false);
    expect(provider.describe()).toMatchObject({ keys: 2, keysResting: 1 });
    limited = new Set(['k1', 'k2']);
    await expect(ask(router)).rejects.toThrow(NoModelAvailableError);
    expect(router.cooldownUntil.get('groq')).toBe(now + 20000);
    expect(router.cooldownReason.get('groq')).toBe('rate limit');
  });

  it('brings a provider back when its first key is free again, not when the last limit ends', async () => {
    const { OpenAICompatibleProvider } = await import('../../src/llm/provider.mjs');
    const now = Date.parse('2026-11-02T09:00:00Z');
    const preset = { id: 'cerebras', label: 'c', baseURL: 'https://c.example/v1', keyEnv: 'K', prefer: { fast: ['m'], deep: ['m'] } };
    const provider = new OpenAICompatibleProvider({ preset, apiKey: 'a,b', now: () => now });
    expect(provider.rotateKey(now + 60000)).toBe(true);
    expect(provider.apiKey).toBe('b');
    expect(provider.rotateKey(now + 3600000)).toBe(false);
    const router = new ModelRouter({ providers: [provider], now: () => now });
    router.coolDown(provider, new ProviderError('cerebras HTTP 429: tokens per day limit exceeded', { status: 429 }));
    expect(router.cooldownUntil.get('cerebras')).toBe(now + 60000);
    expect(router.cooldownReason.get('cerebras')).toMatch(/every key rests; the first is back in 1 min/);
    expect(new OpenAICompatibleProvider({ preset, apiKey: 'a,b', now: () => now + 61000 }).apiKey).toBe('a');
  });

  it('waits for the Gemini daily reset at midnight Pacific time, across both daylight-saving changes', () => {
    expect(new Date(nextMidnightIn('America/Los_Angeles', Date.parse('2026-11-02T09:05:00Z'))).toISOString()).toBe('2026-11-03T08:01:00.000Z');
    expect(new Date(nextMidnightIn('America/Los_Angeles', Date.parse('2026-11-02T07:30:00Z'))).toISOString()).toBe('2026-11-02T08:01:00.000Z');
    expect(new Date(nextMidnightIn('America/Los_Angeles', Date.parse('2026-03-08T07:00:00Z'))).toISOString()).toBe('2026-03-08T08:01:00.000Z');
    expect(new Date(nextMidnightIn('America/Los_Angeles', Date.parse('2026-03-08T12:00:00Z'))).toISOString()).toBe('2026-03-09T07:01:00.000Z');
    expect(new Date(nextMidnightIn('America/Los_Angeles', Date.parse('2026-11-01T06:00:00Z'))).toISOString()).toBe('2026-11-01T07:01:00.000Z');
    const now = Date.parse('2026-11-02T05:00:00Z');
    expect(quotaResetAt({ preset: { quotaResetTimeZone: 'America/Los_Angeles' } }, now)).toBe(Date.parse('2026-11-02T08:01:00Z'));
    expect(quotaResetAt({ preset: {} }, now)).toBe(nextUtcMidnight(now));
    const router = new ModelRouter({ providers: [], now: () => now });
    router.coolDown({ id: 'gemini', preset: { quotaResetTimeZone: 'America/Los_Angeles' } }, new ProviderError('gemini HTTP 429 [quota window: per day]: exceeded your current quota', { status: 429 }));
    expect(router.cooldownUntil.get('gemini')).toBe(Date.parse('2026-11-02T08:01:00Z'));
  });

  it('after three switches and a fourth failure in one call moves on to the next provider, keeping the switched one available', async () => {
    const { OpenAICompatibleProvider } = await import('../../src/llm/provider.mjs');
    const models = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const calls: string[] = [];
    const fetchImpl = async (url: string, init: { body?: string }) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }));
      calls.push(JSON.parse(init.body ?? '{}').model);
      return new Response('{"error":{"code":429,"details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}', { status: 429 });
    };
    const preset = { id: 'gemini', label: 'g', baseURL: 'https://g.example/v1', keyEnv: 'K', prefer: { fast: models, deep: models } };
    const busy = await new OpenAICompatibleProvider({ preset, apiKey: 'k', fetchImpl: fetchImpl as never }).discover();
    const backup = provider('groq', ['{"ok":true}']);
    const router = new ModelRouter({ providers: [busy, backup as never], sleep: async () => {} });
    expect((await ask(router)).provider).toBe('groq');
    expect(calls).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(busy.selected.fast).toBe('m5');
    expect(router.cooldownUntil.has('gemini')).toBe(false);
  });
});

describe('ModelRouter paid providers', () => {
  it('keeps a paid provider behind the free ones even when the route order puts it first', () => {
    const fcc = provider('fcc', []);
    const custom = provider('custom', []);
    const gemini = provider('gemini', []);
    const router = new ModelRouter({ providers: [fcc, custom, gemini], routeOrder: { fast: ['fcc', 'custom', 'gemini'] }, env: {} });
    expect(router.available().map((p) => p.id)).toEqual(['gemini', 'fcc', 'custom']);
  });

  it('rests a paid provider when its tokens today reach the daily cap, and lets it back after the UTC day turns', () => {
    let time = Date.parse('2026-11-04T10:00:00Z');
    const fcc = provider('fcc', []);
    const gemini = provider('gemini', []);
    const router = new ModelRouter({ providers: [fcc, gemini], routeOrder: { fast: ['gemini', 'fcc'] }, now: () => time, env: { FRL_PAID_PROVIDERS: 'fcc', FRL_PAID_DAILY_TOKENS: '1000' } });
    router.record({ provider: 'fcc', ts: '2026-11-03T09:00:00.000Z', tier: 'fast', ok: true, ms: 10, tokens: 999999 });
    router.record({ provider: 'fcc', tier: 'fast', ok: true, ms: 100, tokens: 600 });
    expect(router.available().map((p) => p.id)).toEqual(['gemini', 'fcc']);
    router.record({ provider: 'fcc', tier: 'fast', ok: true, ms: 100, tokens: 400 });
    expect(router.available().map((p) => p.id)).toEqual(['gemini']);
    const capped = router.status().find((p: { id: string }) => p.id === 'fcc');
    expect(capped.coolingReason).toBe('paid daily cap reached (1000 tokens)');
    expect(capped.coolingDownMs).toBeGreaterThan(0);
    time = Date.parse('2026-11-05T00:02:00Z');
    expect(router.available().map((p) => p.id)).toEqual(['gemini', 'fcc']);
  });

  it('keeps a local provider on the paid list behind the free ones but never rests it on the daily cap, since it spends no money', async () => {
    const time = Date.parse('2026-11-04T10:00:00Z');
    const local = { ...provider('llamacpp', ['{"ok":true}']), preset: { local: true } };
    const gemini = provider('gemini', []);
    const router = new ModelRouter({ providers: [local, gemini], routeOrder: { fast: ['llamacpp', 'gemini'] }, now: () => time, env: { FRL_PAID_PROVIDERS: 'llamacpp', FRL_PAID_DAILY_TOKENS: '1000' } });
    router.record({ provider: 'llamacpp', tier: 'fast', ok: true, ms: 100, tokens: 5000 });
    expect(router.available().map((p) => p.id)).toEqual(['gemini', 'llamacpp']);
    expect(router.status().find((p: { id: string }) => p.id === 'llamacpp').coolingReason).toBeNull();
    router.coolDown({ id: 'gemini', preset: {} }, new ProviderError('gemini HTTP 429: slow down', { status: 429, retryAfterMs: 1000 }));
    const reply = await router.complete({ messages: [], purpose: 'chat' });
    expect(reply.provider).toBe('llamacpp');
  });

  it('serves a paid provider under the cap when every free provider rests', async () => {
    const time = Date.parse('2026-11-04T10:00:00Z');
    const fcc = provider('fcc', ['{"ok":true}']);
    const gemini = provider('gemini', []);
    const router = new ModelRouter({ providers: [fcc, gemini], routeOrder: { fast: ['gemini', 'fcc'] }, now: () => time, env: { FRL_PAID_PROVIDERS: 'fcc', FRL_PAID_DAILY_TOKENS: '1000' } });
    router.record({ provider: 'fcc', tier: 'fast', ok: true, ms: 100, tokens: 500 });
    router.coolDown({ id: 'gemini', preset: {} }, new ProviderError('gemini HTTP 429: slow down', { status: 429, retryAfterMs: 1000 }));
    expect(router.available().map((p) => p.id)).toEqual(['fcc']);
    const reply = await router.complete({ messages: [], purpose: 'chat' });
    expect(reply.provider).toBe('fcc');
    expect(fcc.calls).toEqual(['fast']);
  });
});

describe('ModelRouter dead providers recover', () => {
  it('stops treating a provider as dead once its last failure is older than the dead window, so it gets calls again', () => {
    let time = Date.parse('2026-11-03T14:00:00Z');
    const fcc = provider('fcc', []);
    const gemini = provider('gemini', []);
    const router = new ModelRouter({ providers: [fcc, gemini], routeOrder: { fast: ['fcc', 'gemini'] }, now: () => time });
    for (let i = 0; i < 20; i++) router.record({ provider: 'fcc', tier: 'fast', ok: false, ms: 90000, error: 'fcc unreachable: timed out' });
    expect(router.demoteDead([fcc, gemini]).map((p: { id: string }) => p.id)).toEqual(['gemini', 'fcc']);
    time += DEAD_WINDOW_MS + 1000;
    expect(router.demoteDead([fcc, gemini]).map((p: { id: string }) => p.id)).toEqual(['fcc', 'gemini']);
  });
});

function netProvider(id: string, networkFailures: number, okReply = '{"ok":true}') {
  let n = 0;
  return {
    id,
    ready: true,
    calls: [],
    async chat() {
      this.calls.push(1);
      n++;
      if (n <= networkFailures) throw new ProviderError(`${id} unreachable: fetch failed`, { status: 0, provider: id });
      return { content: okReply, model: `${id}-m`, provider: id, usage: {} };
    },
    describe: () => ({ id }),
  };
}

describe('ModelRouter network outages', () => {
  it('treats an all-network outage as offline: waits with backoff, does not bench providers, and succeeds when one recovers', async () => {
    const waits: number[] = [];
    let now = 1000000;
    const a = netProvider('a', 2);
    const b = netProvider('b', 2);
    const router = new ModelRouter({ providers: [a, b], now: () => now, sleep: async (ms: number) => { waits.push(ms); now += ms; } });
    const reply = await router.complete({ messages: [] });
    expect(reply).toMatchObject({ provider: 'a' });
    expect(waits).toEqual([15000, 30000]);
    expect(router.cooldownUntil.get('a')).toBeFalsy();
    expect(router.cooldownUntil.get('b')).toBeFalsy();
    expect(router.failureStreak.get('a')).toBeFalsy();
    expect(router.failureStreak.get('b')).toBeFalsy();
    expect(router.timeoutStreak.get('a')).toBeFalsy();
    expect(router.timeoutStreak.get('b')).toBeFalsy();
    expect(router.computeErrorStreak.get('a')).toBeFalsy();
    expect(router.computeErrorStreak.get('b')).toBeFalsy();
  });

  it('throws OfflineError after the offline wait limit is exhausted, without benching providers', async () => {
    const waits: number[] = [];
    let now = 1000000;
    const a = netProvider('a', Number.POSITIVE_INFINITY);
    const router = new ModelRouter({ providers: [a], now: () => now, sleep: async (ms: number) => { waits.push(ms); now += ms; } });
    await expect(router.complete({ messages: [] })).rejects.toBeInstanceOf(OfflineError);
    await expect(router.complete({ messages: [] })).rejects.toThrow(/^offline:/);
    const total = waits.reduce((s, w) => s + w, 0);
    expect(total).toBeGreaterThanOrEqual(20 * 60 * 1000 - 60000);
    expect(router.cooldownUntil.get('a')).toBeFalsy();
    expect(router.failureStreak.get('a')).toBeFalsy();
  });

  it('a provider that times out is benched, not waited for as if the network were down', async () => {
    const waits: number[] = [];
    let now = Date.parse('2026-11-04T11:49:56Z');
    const slow = (id: string) => ({ id, ready: true, calls: [] as number[], async chat() { this.calls.push(1); now += 240000; throw new ProviderError(`${id} unreachable: timed out`, { status: 0, provider: id }); }, describe: () => ({ id }) });
    const fcc = slow('fcc');
    const router = new ModelRouter({ providers: [fcc], now: () => now, sleep: async (ms: number) => { waits.push(ms); now += ms; } });
    const failure = await router.complete({ tier: 'deep', purpose: 'research', messages: [] }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(NoModelAvailableError);
    expect(failure).not.toBeInstanceOf(OfflineError);
    expect((failure as Error).message).toMatch(/^every provider failed for research: fcc unreachable: timed out/);
    expect(fcc.calls.length).toBeLessThanOrEqual(2);
    expect(waits.reduce((s, w) => s + w, 0)).toBeLessThanOrEqual(65000);
    if (fcc.calls.length < 2) await router.complete({ tier: 'deep', purpose: 'research', messages: [] }).catch(() => null);
    expect(fcc.calls.length).toBe(2);
    expect(router.cooldownUntil.get('fcc')).toBe(now + TIMEOUT_BENCH_MS);
    expect(router.status().find((p: { coolingReason: string | null }) => p.coolingReason)?.coolingReason).toMatch(/too slow: 2 timeouts in a row/);

    const three = ['fcc', 'pollinations', 'openrouter'].map(slow);
    const rollup = new ModelRouter({ providers: three, now: () => now, sleep: async (ms: number) => { waits.push(ms); now += ms; } });
    const all = await rollup.complete({ tier: 'deep', purpose: 'rollup', messages: [] }).catch((error: Error) => error);
    expect(all).not.toBeInstanceOf(OfflineError);
    for (const id of ['fcc', 'pollinations', 'openrouter']) expect((all as Error).message).toContain(`${id} unreachable: timed out`);
    expect(three.reduce((n, p) => n + p.calls.length, 0)).toBeLessThanOrEqual(6);
  });

  it('keeps today behaviour when a mix of network and HTTP errors happens', async () => {
    const waits: number[] = [];
    let now = 1000000;
    const a = netProvider('a', Number.POSITIVE_INFINITY);
    const b = { id: 'b', ready: true, calls: [], async chat() { this.calls.push(1); throw new ProviderError('b HTTP 429: rate limited', { status: 429, retryAfterMs: 1000, provider: 'b' }); }, describe: () => ({ id }) };
    const router = new ModelRouter({ providers: [a, b], now: () => now, sleep: async (ms: number) => { waits.push(ms); now += ms; }, maxWaitMs: 0 });
    await expect(router.complete({ messages: [] })).rejects.toBeInstanceOf(NoModelAvailableError);
    await expect(router.complete({ messages: [] })).rejects.toBeInstanceOf(NoModelAvailableError);
    expect(waits).toEqual([]);
  });
});

describe('ModelRouter.forgetBench', () => {
  it('clears all streak and cooldown state for a provider', () => {
    const router = new ModelRouter({ providers: [], now: () => 1000 });
    router.failureStreak.set('groq', 5);
    router.timeoutStreak.set('groq', 1);
    router.computeErrorStreak.set('groq', 2);
    router.streakBenches.set('groq', 3);
    router.cooldownUntil.set('groq', 2000);
    router.cooldownReason.set('groq', 'daily quota');
    router.forgetBench('groq');
    expect(router.failureStreak.has('groq')).toBe(false);
    expect(router.timeoutStreak.has('groq')).toBe(false);
    expect(router.computeErrorStreak.has('groq')).toBe(false);
    expect(router.streakBenches.has('groq')).toBe(false);
    expect(router.cooldownUntil.has('groq')).toBe(false);
    expect(router.cooldownReason.has('groq')).toBe(false);
  });
});

describe('ModelRouter.restoreCooldowns model-aware streak', () => {
  it('ignores failures on models no longer selected by the provider (old dead models)', () => {
    const now = Date.parse('2026-11-13T15:19:00Z');
    const p = (id: string) => ({ id, ready: true, selected: { fast: 'nvidia/nemotron-3.5-lightning-30b-a3b', deep: 'nvidia/nemotron-3-ultra-550b-a55b', vision: null }, preset: {}, describe: () => ({}), chat: async () => ({}) });
    const router = new ModelRouter({ providers: [p('nvidia')], now: () => now });
    const oldModelFailures = Array.from({ length: 17 }, (_, i) => ({
      ts: new Date(now - 60000 - (16 - i) * 60000).toISOString(),
      provider: 'nvidia',
      ok: false,
      error: 'nvidia HTTP 404: model not found',
      model: '01-ai/yi-large',
    }));
    const restored = router.restoreCooldowns(oldModelFailures);
    expect(restored).toEqual([]);
    expect(router.cooldownUntil.has('nvidia')).toBe(false);
  });

  it('benches when failures are on the current selected model', () => {
    const now = Date.parse('2026-11-13T15:19:00Z');
    const p = (id: string) => ({ id, ready: true, selected: { fast: 'nvidia/nemotron-3.5-lightning-30b-a3b', deep: 'nvidia/nemotron-3-ultra-550b-a55b', vision: null }, preset: {}, describe: () => ({}), chat: async () => ({}) });
    const router = new ModelRouter({ providers: [p('nvidia')], now: () => now });
    const currentModelFailures = Array.from({ length: 17 }, (_, i) => ({
      ts: new Date(now - 60000 - (16 - i) * 60000).toISOString(),
      provider: 'nvidia',
      ok: false,
      error: 'nvidia HTTP 429: rate limited',
      model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    }));
    const restored = router.restoreCooldowns(currentModelFailures);
    expect(restored).toEqual(['nvidia']);
    expect(router.cooldownUntil.get('nvidia')).toBe(now - 60000 + 30 * 60 * 1000);
    expect(router.cooldownReason.get('nvidia')).toBe('17 failed calls in a row before the restart; rests 30 min');
  });

  it('benches when failures have no model field (legacy rows)', () => {
    const now = Date.parse('2026-11-13T15:19:00Z');
    const p = (id: string) => ({ id, ready: true, selected: { fast: 'nvidia/nemotron-3.5-lightning-30b-a3b', deep: 'nvidia/nemotron-3-ultra-550b-a55b', vision: null }, preset: {}, describe: () => ({}), chat: async () => ({}) });
    const router = new ModelRouter({ providers: [p('nvidia')], now: () => now });
    const legacyFailures = Array.from({ length: 17 }, (_, i) => ({
      ts: new Date(now - 60000 - (16 - i) * 60000).toISOString(),
      provider: 'nvidia',
      ok: false,
      error: 'nvidia unreachable: timed out',
    }));
    const restored = router.restoreCooldowns(legacyFailures);
    expect(restored).toEqual(['nvidia']);
    expect(router.cooldownUntil.get('nvidia')).toBe(now - 60000 + 30 * 60 * 1000);
    expect(router.cooldownReason.get('nvidia')).toBe('17 failed calls in a row before the restart; rests 30 min');
  });

  it('ignores model-gone error on old model in single-row restore, but restores for current model', () => {
    const now = Date.parse('2026-11-13T15:19:00Z');
    const p = (id: string) => ({ id, ready: true, selected: { fast: 'nvidia/nemotron-3.5-lightning-30b-a3b', deep: 'nvidia/nemotron-3-ultra-550b-a55b', vision: null }, preset: {}, describe: () => ({}), chat: async () => ({}) });
    const router = new ModelRouter({ providers: [p('nvidia')], now: () => now });
    const oldModelGone = [
      { ts: '2026-11-13T14:00:00Z', provider: 'nvidia', ok: false, error: 'nvidia HTTP 404: {"status":404,"title":"Not Found"}', model: '01-ai/yi-large' },
    ];
    let restored = router.restoreCooldowns(oldModelGone);
    expect(restored).toEqual([]);
    expect(router.cooldownUntil.has('nvidia')).toBe(false);

    router.cooldownUntil.delete('nvidia');
    router.cooldownReason.delete('nvidia');

    const currentModelGone = [
      { ts: '2026-11-13T14:00:00Z', provider: 'nvidia', ok: false, error: 'nvidia HTTP 404: {"status":404,"title":"Not Found"}', model: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
    ];
    restored = router.restoreCooldowns(currentModelGone);
    expect(restored).toEqual(['nvidia']);
    expect(router.cooldownReason.get('nvidia')).toBe('rate limit');
  });

  it('restores bad-key errors regardless of model (provider-wide), but not daily-quota 429', () => {
    const now = Date.parse('2026-11-13T15:19:00Z');
    const p = (id: string) => ({ id, ready: true, selected: { fast: 'nvidia/nemotron-3.5-lightning-30b-a3b', deep: 'nvidia/nemotron-3-ultra-550b-a55b', vision: null }, preset: {}, describe: () => ({}), chat: async () => ({}) });
    const router = new ModelRouter({ providers: [p('nvidia')], now: () => now });

    const dailyQuotaOldModel = [
      { ts: '2026-11-13T14:00:00Z', provider: 'nvidia', ok: false, error: 'nvidia HTTP 429: tokens per day limit exceeded', model: '01-ai/yi-large' },
    ];
    let restored = router.restoreCooldowns(dailyQuotaOldModel);
    expect(restored).toEqual([]);
    expect(router.cooldownUntil.has('nvidia')).toBe(false);

    router.cooldownUntil.delete('nvidia');
    router.cooldownReason.delete('nvidia');

    const badKeyOldModel = [
      { ts: '2026-11-13T14:00:00Z', provider: 'nvidia', ok: false, error: 'nvidia HTTP 401: invalid key', model: '01-ai/yi-large' },
    ];
    restored = router.restoreCooldowns(badKeyOldModel);
    expect(restored).toEqual(['nvidia']);
    expect(router.cooldownReason.get('nvidia')).toContain('key rejected');
  });
});

describe('ModelRouter.restoreCooldowns key count', () => {

  it('restores a used-up-credit bench when the provider has the same number of keys as the ledger row', () => {
    const now = Date.parse('2026-11-13T10:00:00Z');
    const p = (id: string, keyCount: number) => ({ id, ready: true, keyCount, preset: {}, describe: () => ({}), chat: async () => ({}) });
    const router = new ModelRouter({ providers: [p('groq', 2)], now: () => now });
    const restored = router.restoreCooldowns([
      { ts: '2026-11-13T09:00:00Z', provider: 'groq', ok: false, error: 'groq HTTP 402: {"balance_units":0}', keys: 2 },
    ]);
    expect(restored).toEqual(['groq']);
    expect(router.cooldownUntil.get('groq')).toBe(now + PAYMENT_REST_MS);
    expect(router.cooldownReason.get('groq')).toContain('needs payment');
  });

  it('restores a used-up-credit bench when the ledger row has no keys field', () => {
    const now = Date.parse('2026-11-13T10:00:00Z');
    const p = (id: string, keyCount: number) => ({ id, ready: true, keyCount, preset: {}, describe: () => ({}), chat: async () => ({}) });
    const router = new ModelRouter({ providers: [p('groq', 2)], now: () => now });
    const restored = router.restoreCooldowns([
      { ts: '2026-11-13T09:00:00Z', provider: 'groq', ok: false, error: 'groq HTTP 402: {"balance_units":0}' },
    ]);
    expect(restored).toEqual(['groq']);
    expect(router.cooldownUntil.get('groq')).toBe(now + PAYMENT_REST_MS);
  });

  it('skips restoring a failure-streak bench when the provider now has more keys than the last failed row', () => {
    const now = Date.parse('2026-11-13T13:21:00Z');
    const p = (id: string, keyCount: number) => ({ id, ready: true, keyCount, preset: {}, describe: () => ({}), chat: async () => ({}) });
    const router = new ModelRouter({ providers: [p('sambanova', 2)], now: () => now });
    const failures = Array.from({ length: 12 }, (_, i) => ({ ts: new Date(now - 60000 - (11 - i) * 60000).toISOString(), provider: 'sambanova', ok: false, error: 'sambanova HTTP 429: model is currently experiencing high traffic', keys: 1 }));
    const restored = router.restoreCooldowns(failures);
    expect(restored).toEqual([]);
    expect(router.cooldownUntil.has('sambanova')).toBe(false);
  });

  it('restores a failure-streak bench when the provider has the same number of keys as the last failed row', () => {
    const now = Date.parse('2026-11-13T13:21:00Z');
    const p = (id: string, keyCount: number) => ({ id, ready: true, keyCount, preset: {}, describe: () => ({}), chat: async () => ({}) });
    const router = new ModelRouter({ providers: [p('sambanova', 2)], now: () => now });
    const failures = Array.from({ length: 12 }, (_, i) => ({ ts: new Date(now - 60000 - (11 - i) * 60000).toISOString(), provider: 'sambanova', ok: false, error: 'sambanova HTTP 429: model is currently experiencing high traffic', keys: 2 }));
    const restored = router.restoreCooldowns(failures);
    expect(restored).toEqual(['sambanova']);
    expect(router.cooldownUntil.get('sambanova')).toBe(now - 60000 + 30 * 60 * 1000);
    expect(router.cooldownReason.get('sambanova')).toBe('12 failed calls in a row before the restart; rests 30 min');
  });
});

describe('ModelRouter banned model families', () => {
  const make = (id: string, model: string) => ({ id, ready: true, describe: () => ({ fast: model, deep: model }), selected: { fast: model, deep: model }, chat: async () => ({ content: '{"ok":true}', model, provider: id }) });
  const providers = () => [make('a', 'deepseek-chat'), make('b', 'llama-3.3-70b'), make('c', 'qwen3-32b')];

  it('never offers a provider whose model family is in FRL_BANNED_FAMILIES', async () => {
    const router = new ModelRouter({ providers: providers(), env: { FRL_BANNED_FAMILIES: ' DeepSeek , qwen' } });
    expect(router.available({ tier: 'fast' }).map((p: { id: string }) => p.id)).toEqual(['b']);
    expect(router.available({ tier: 'deep', avoid: 'b' }).map((p: { id: string }) => p.id)).toEqual(['b']);
    for (let i = 0; i < 3; i++) await expect(router.complete({ messages: [] })).resolves.toMatchObject({ provider: 'b' });
    expect(router.ledger.map((row: { provider: string }) => row.provider)).toEqual(['b', 'b', 'b']);
  });

  it('fails the call instead of using a banned family when nothing else is left', async () => {
    const router = new ModelRouter({ providers: providers(), env: { FRL_BANNED_FAMILIES: 'deepseek,qwen,llama' }, maxWaitMs: 0 });
    await expect(router.complete({ messages: [] })).rejects.toThrow();
    expect(router.ledger.filter((row: { provider: string }) => row.provider !== 'router')).toEqual([]);
  });

  it('bans nothing when the variable is empty or unset, and reads it at each call', async () => {
    const env: Record<string, string> = { FRL_BANNED_FAMILIES: '' };
    const router = new ModelRouter({ providers: providers(), env });
    expect(router.available({ tier: 'fast' }).map((p: { id: string }) => p.id)).toEqual(['a', 'b', 'c']);
    expect(new ModelRouter({ providers: providers(), env: {} }).available({ tier: 'fast' })).toHaveLength(3);
    env.FRL_BANNED_FAMILIES = 'deepseek';
    expect(router.available({ tier: 'fast' }).map((p: { id: string }) => p.id)).toEqual(['b', 'c']);
  });

  it('knows the two purposes of the semantic layer', () => {
    expect(EXPECTED_OUTPUT_TOKENS['purpose-judge']).toBe(120);
    expect(EXPECTED_OUTPUT_TOKENS['purpose-draft']).toBe(900);
    expect([PURPOSE_CLASS['purpose-judge'], PURPOSE_CLASS['purpose-draft']]).toEqual(['volume', 'top']);
  });
});

describe('ModelRouter wait, give-up and payment events', () => {
  const limited = (id: string, retryAfterMs: number) => ({
    id,
    ready: true,
    describe: () => ({ id }),
    async chat() {
      throw new ProviderError(`${id} HTTP 429 [quota window: per minute]: slow down`, { status: 429, retryAfterMs });
    },
  });
  type Seen = { at: number; kind: string; purpose?: string; reasons?: string[] };
  type Row = { provider: string; error?: string; project?: string; purpose?: string };
  const clocked = (providers: object[], options: object = {}) => {
    const clock = { now: Date.parse('2026-11-16T10:00:00Z') };
    const events: Seen[] = [];
    const ledger: Row[] = [];
    const sleep = async (ms: number) => {
      clock.now += ms;
    };
    const router = new ModelRouter({ providers, now: () => clock.now, sleep, onWait: (event: { kind: string }) => events.push({ at: clock.now, ...event }), onLedger: (row: Row) => ledger.push(row), ...options });
    return { router, clock, events, ledger, start: clock.now };
  };

  it('reports a wait once when it starts, with the purpose, the tier and every resting provider', async () => {
    const { router, events, start } = clocked([limited('a', 30000)]);
    await expect(router.complete({ messages: [], purpose: 'research', tier: 'deep' })).rejects.toThrow(NoModelAvailableError);
    const waiting = events.filter((event) => event.kind === 'waiting');
    expect(waiting).toEqual([{ at: start, kind: 'waiting', ms: 30000, purpose: 'research', tier: 'deep', resting: [{ provider: 'a', ms: 30000, reason: 'rate limit' }] }]);
  });

  it('reports a longer wait again, never sooner than 60 s after the last report', async () => {
    expect(WAIT_NOTICE_MS).toBe(60000);
    const { router, events, start } = clocked([limited('a', 61000)]);
    await expect(router.complete({ messages: [], purpose: 'research' })).rejects.toThrow(NoModelAvailableError);
    expect(events.filter((event) => event.kind === 'waiting').map((event) => event.at - start)).toEqual([0, 61000]);
    const short = clocked([limited('a', 20000)]);
    await expect(short.router.complete({ messages: [], purpose: 'research' })).rejects.toThrow(NoModelAvailableError);
    expect(short.events.filter((event) => event.kind === 'waiting').map((event) => event.at - short.start)).toEqual([0]);
    expect(short.clock.now - short.start).toBe(40000);
  });

  it('reports a give-up with the failures when the rest is longer than maxWaitMs, and with who rests when nobody was tried', async () => {
    const { router, events, clock, start } = clocked([limited('a', 120000)], { maxWaitMs: 65000 });
    await expect(router.complete({ messages: [], purpose: 'synthesize', tier: 'deep' })).rejects.toThrow(/every provider failed for synthesize/);
    expect(events).toEqual([{ at: start, kind: 'gave-up', purpose: 'synthesize', tier: 'deep', reasons: ['a HTTP 429 [quota window: per minute]: slow down'] }]);
    expect(clock.now).toBe(start);
    await expect(router.complete({ messages: [], purpose: 'research' })).rejects.toThrow(/cooling down/);
    expect(events[1]).toEqual({ at: start, kind: 'gave-up', purpose: 'research', tier: 'fast', reasons: ['a: rate limit'] });
    const none = clocked([]);
    await expect(none.router.complete({ messages: [], purpose: 'research' })).rejects.toThrow(/no model provider is configured/);
    expect(none.events.map((event) => event.reasons)).toEqual([['no model provider is configured']]);
  });

  it('reports no give-up when a provider answers after the wait', async () => {
    const slow = provider('slow', [new ProviderError('slow HTTP 429: retry', { status: 429, retryAfterMs: 5000 }), '{"ok":true}']);
    const { router, events } = clocked([slow]);
    const reply = await router.complete({ messages: [], purpose: 'research' });
    expect(reply.data).toEqual({ ok: true });
    expect(events.map((event) => event.kind)).toEqual(['waiting']);
  });

  it('gives each scope only its own events and marks its ledger rows with its project', async () => {
    const shared = limited('a', 10000);
    const { router, ledger } = clocked([shared]);
    router.coolDown(shared, new ProviderError('a HTTP 429: slow down', { status: 429, retryAfterMs: 10000 }));
    const seen: Record<string, { events: Seen[]; rows: Row[] }> = { A: { events: [], rows: [] }, B: { events: [], rows: [] } };
    const scope = (project: string) => ({ project, onWait: (event: Seen) => seen[project].events.push(event), onCall: (row: Row) => seen[project].rows.push(row) });
    await Promise.allSettled([
      router.scoped(scope('A'), () => router.complete({ messages: [], purpose: 'research' })),
      router.scoped(scope('B'), () => router.complete({ messages: [], purpose: 'synthesize' })),
    ]);
    for (const [project, own, other] of [['A', 'research', 'synthesize'], ['B', 'synthesize', 'research']]) {
      const { events, rows } = seen[project];
      expect(events[0].kind).toBe('waiting');
      expect(events.filter((event) => event.kind === 'gave-up')).toHaveLength(1);
      expect(new Set(events.map((event) => event.purpose))).toEqual(new Set([own]));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.project === project && row.purpose !== other)).toBe(true);
      expect(ledger.filter((row) => row.project === project)).toEqual(rows);
    }
    const before = [seen.A.events.length, seen.B.events.length, seen.A.rows.length, seen.B.rows.length];
    await expect(router.complete({ messages: [], purpose: 'chat' })).rejects.toThrow(NoModelAvailableError);
    expect(ledger.at(-1)?.project).toBeUndefined();
    expect([seen.A.events.length, seen.B.events.length, seen.A.rows.length, seen.B.rows.length]).toEqual(before);
  });

  it('excludes a provider that needs payment from the free route for 24 h and says so once', async () => {
    const pay = provider('pay', [new ProviderError('pay HTTP 402: Payment required', { status: 402 }), new ProviderError('pay HTTP 402: Payment required', { status: 402 })]);
    const free = provider('free', []);
    const { router, events, ledger, clock } = clocked([pay, free]);
    expect(router.route().fast).toEqual(['pay', 'free']);
    await router.complete({ messages: [] });
    await router.complete({ messages: [] });
    const said = () => ledger.filter((row) => row.error === 'pay needs payment: excluded from the free route');
    expect(said()).toHaveLength(1);
    expect(said()[0]).toMatchObject({ provider: 'pay', purpose: 'router', ok: false });
    expect(events.filter((event) => event.kind === 'excluded')).toEqual([{ at: clock.now, kind: 'excluded', provider: 'pay', message: 'pay needs payment: excluded from the free route' }]);
    expect(router.needsPayment('pay')).toBe(true);
    expect(router.route().fast).toEqual(['free']);
    expect(router.available().map((p: { id: string }) => p.id)).toEqual(['free']);
    router.cooldownUntil.delete('pay');
    expect(router.available().map((p: { id: string }) => p.id)).toEqual(['free']);
    expect(pay.calls).toHaveLength(1);
    clock.now += PAYMENT_REST_MS - 1000;
    expect(router.needsPayment('pay')).toBe(true);
    clock.now += 2000;
    expect(router.needsPayment('pay')).toBe(false);
    expect(router.route().fast).toEqual(['pay', 'free']);
    await router.complete({ messages: [] });
    expect(pay.calls).toHaveLength(2);
    expect(said()).toHaveLength(2);
  });

  it('never falls back to a paid provider that answered payment required', async () => {
    const pay = provider('pay', [new ProviderError('pay HTTP 402: Payment required', { status: 402 }), '{"paid":true}']);
    const free = provider('free', [new ProviderError('free HTTP 500: boom', { status: 500 }), new ProviderError('free HTTP 500: boom', { status: 500 })]);
    const { router, clock } = clocked([pay, free], { paid: ['pay'], maxWaitMs: 0 });
    await expect(router.complete({ messages: [] })).rejects.toThrow(NoModelAvailableError);
    expect([free.calls.length, pay.calls.length]).toEqual([1, 1]);
    clock.now += 2 * 60 * 1000;
    await expect(router.complete({ messages: [] })).rejects.toThrow(NoModelAvailableError);
    expect([free.calls.length, pay.calls.length]).toEqual([2, 1]);
  });

  it('keeps a provider with another key coming back on the free route', () => {
    const { router, clock, ledger } = clocked([]);
    router.coolDown({ id: 'keys', nextKeyAt: () => clock.now + 60000 }, new ProviderError('keys HTTP 402: Payment required', { status: 402 }));
    expect(router.needsPayment('keys')).toBe(false);
    expect(router.cooldownUntil.get('keys')).toBe(clock.now + 60000);
    expect(ledger).toEqual([]);
  });

  it('restores the exclusion after a restart without saying it again, also when its own notice is the last ledger row', () => {
    const p = (id: string) => ({ id, ready: true, describe: () => ({ id }), chat: async () => ({}) });
    const { router, ledger, events, clock } = clocked([p('pay'), p('free')]);
    const restored = router.restoreCooldowns([
      { ts: '2026-11-16T09:00:00Z', provider: 'pay', ok: false, error: 'pay HTTP 402: Payment required' },
      { ts: '2026-11-16T09:00:00Z', provider: 'pay', purpose: 'router', ok: false, error: 'pay needs payment: excluded from the free route' },
    ]);
    expect(restored).toEqual(['pay']);
    expect(router.needsPayment('pay')).toBe(true);
    expect(router.cooldownUntil.get('pay')).toBe(clock.now + PAYMENT_REST_MS);
    expect(router.route().fast).toEqual(['free']);
    expect(ledger).toEqual([]);
    expect(events).toEqual([]);
    router.forgetBench('pay');
    expect(router.needsPayment('pay')).toBe(false);
    expect(router.route().fast).toEqual(['pay', 'free']);
  });

  it('tells payment required and used-up credit from a short limit and from a stated quota window', () => {
    expect(paymentRequired({ status: 402, message: 'x HTTP 402: Payment required' })).toBe(true);
    expect(paymentRequired({ status: 429, message: 'x HTTP 429: A subscription is required' })).toBe(true);
    expect(paymentRequired({ status: 402, message: 'Free limit reached: 1 reply every 30 seconds per IP. Retry after 5s' })).toBe(false);
    expect(paymentRequired({ status: 402, message: 'x HTTP 402: insufficient credit' })).toBe(true);
    expect(paymentRequired({ status: 402, message: SAMBANOVA_CREDITS })).toBe(true);
    expect(paymentRequired({ status: 402, message: 'x HTTP 402 [quota window: per day]: daily credits used up' })).toBe(false);
    expect(paymentRequired({ status: 429, message: COHERE_MONTH })).toBe(false);
    expect(paymentRequired({ status: 403, message: CLOUDFLARE_PLAN })).toBe(false);
    expect(paymentRequired({ status: 429, message: 'x HTTP 429: slow down' })).toBe(false);
  });
});

describe('a later vote call kept apart from the families that already answered', () => {
  const make = (id: string, model: string) => ({ ...provider(id, ['{"pick":"A"}', '{"pick":"A"}']), selected: { fast: model, deep: model }, describe: () => ({ id, fast: model, deep: model }) });

  it('asks only another model family, and waits for one to come back instead of asking the same family again', async () => {
    let now = 0;
    const waits: number[] = [];
    const groq = make('groq', 'qwen/qwen3.8-27b');
    const cloudflare = make('cloudflare', '@cf/qwen/qwen3.8-27b');
    const gemini = make('gemini', 'gemini-3.8-flash');
    const router = new ModelRouter({ providers: [groq, cloudflare, gemini], routeOrder: { fast: ['groq', 'cloudflare', 'gemini'], deep: ['groq', 'cloudflare', 'gemini'] }, now: () => now, sleep: async (ms: number) => { waits.push(ms); now += ms; } });
    router.cooldownUntil.set('gemini', 5000);
    expect(router.available({ tier: 'fast', avoid: ['groq'] }).map((p: { id: string }) => p.id)).toEqual(['cloudflare', 'groq']);
    expect(router.available({ tier: 'fast', avoid: ['groq'], apart: true })).toEqual([]);
    expect(router.families({ tier: 'fast' })).toHaveLength(1);
    expect(router.families({ tier: 'fast', within: 65000 })).toHaveLength(2);
    await expect(router.complete({ messages: [], avoid: ['groq'], apart: true })).resolves.toMatchObject({ provider: 'gemini' });
    expect(waits).toEqual([5000]);
    expect(cloudflare.calls).toEqual([]);
    expect(router.ledger.map((r: { provider: string; error?: string }) => [r.provider, r.error ?? ''])).toEqual([['router', 'every other model family rate-limited, waiting 5s'], ['gemini', '']]);
  });

  it('gives up at once when no other family can answer within the wait, and never asks the same family', async () => {
    let now = 0;
    const waits: number[] = [];
    const groq = make('groq', 'qwen/qwen3.8-27b');
    const cloudflare = make('cloudflare', '@cf/qwen/qwen3.8-27b');
    const gemini = make('gemini', 'gemini-3.8-flash');
    const router = new ModelRouter({ providers: [groq, cloudflare, gemini], routeOrder: { fast: ['groq', 'cloudflare', 'gemini'], deep: ['groq', 'cloudflare', 'gemini'] }, now: () => now, sleep: async (ms: number) => { waits.push(ms); now += ms; } });
    router.cooldownUntil.set('gemini', 3600000);
    expect(router.families({ tier: 'fast', within: 65000 })).toHaveLength(1);
    await expect(router.complete({ messages: [], avoid: ['groq'], apart: true })).rejects.toThrow(/no other model family answered/);
    expect([waits, cloudflare.calls, gemini.calls]).toEqual([[], [], []]);
    await expect(router.complete({ messages: [], avoid: ['groq'] })).resolves.toMatchObject({ provider: 'cloudflare' });
  });

  it('asks the first call of a vote as before, with nothing to keep apart from', async () => {
    const groq = make('groq', 'qwen/qwen3.8-27b');
    const gemini = make('gemini', 'gemini-3.8-flash');
    const router = new ModelRouter({ providers: [groq, gemini], routeOrder: { fast: ['groq', 'gemini'], deep: ['groq', 'gemini'] } });
    await expect(router.complete({ messages: [], apart: true })).resolves.toMatchObject({ provider: 'groq' });
  });
});
