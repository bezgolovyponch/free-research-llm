import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/llm/provider.mjs';
import { ModelRouter, NoModelAvailableError } from '../../src/llm/router.mjs';

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

  it('does not cool down on a non-retryable error but still tries the next provider', async () => {
    const a = provider('a', [new ProviderError('bad key', { status: 401 })]);
    const b = provider('b', ['{}']);
    const router = new ModelRouter({ providers: [a, b] });
    await router.complete({ messages: [] });
    expect(router.available().map((p) => p.id)).toEqual(['a', 'b']);
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
    await expect(router.complete({ messages: [] })).rejects.toBeInstanceOf(NoModelAvailableError);
    await expect(router.complete({ messages: [] })).resolves.toMatchObject({ data: { after: true } });
    expect(waits).toEqual([5000]);
  });

  it('raises a clear error when nothing is configured or everything fails', async () => {
    await expect(new ModelRouter({ providers: [] }).complete({ messages: [] })).rejects.toThrow(/no model provider/);
    const a = provider('a', [new ProviderError('down', { status: 503 })]);
    const router = new ModelRouter({ providers: [a], maxWaitMs: 0 });
    await expect(router.complete({ messages: [] })).rejects.toBeInstanceOf(NoModelAvailableError);
    await expect(router.complete({ messages: [] })).rejects.toThrow(/cooling down/);
  });
});

describe('ModelRouter paid budget', () => {
  it('uses a paid provider only up to the paid-call limit', async () => {
    const paid = Object.assign(provider('deepseek', ['{}', '{}']), { preset: { paid: true } });
    const capped = new ModelRouter({ providers: [paid], paidCallLimit: 1, maxWaitMs: 0 });
    await capped.complete({ messages: [] });
    expect(capped.status()[0]).toMatchObject({ budgetExhausted: true });
    await expect(capped.complete({ messages: [] })).rejects.toThrow(/paid-call budget/);
    const blocked = new ModelRouter({ providers: [Object.assign(provider('deepseek', ['{}']), { preset: { paid: true } })], maxWaitMs: 0 });
    await expect(blocked.complete({ messages: [] })).rejects.toThrow(/paid-call budget/);
  });
});

describe('ModelRouter route order', () => {
  it('orders providers per tier and reports the live route', async () => {
    const g = provider('gemini', ['{}']);
    const q = provider('groq', ['{}']);
    const router = new ModelRouter({ providers: [g, q], routeOrder: { fast: ['groq', 'gemini'], deep: ['gemini', 'groq'] } });
    await expect(router.complete({ messages: [], tier: 'fast' })).resolves.toMatchObject({ provider: 'groq' });
    await expect(router.complete({ messages: [], tier: 'deep' })).resolves.toMatchObject({ provider: 'gemini' });
    expect(router.route()).toEqual({ fast: ['groq', 'gemini'], deep: ['gemini', 'groq'] });
  });
});
