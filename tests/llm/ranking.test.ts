import { describe, expect, it } from 'vitest';
import { CAPABILITY, STRATEGIES, providerStats, rankRole, routeFor } from '../../src/llm/ranking.mjs';

const now = Date.parse('2026-10-19T12:00:00Z');
const ts = (min: number) => new Date(now - min * 60000).toISOString();
const calls = (provider: string, tier: string, n: number, ms: number, ok = true, error = '') => Array.from({ length: n }, (_, i) => ({ ts: ts(i + 1), provider, tier, ok, ms, error }));

const providers = [
  { id: 'gemini', label: 'Gemini', state: 'ready', deep: 'gemini-3.8-flash', fast: 'gemini-3.5-flash-lite', coolingDownMs: 0 },
  { id: 'cerebras', label: 'Cerebras', state: 'ready', deep: 'gpt-oss-120b', fast: 'gpt-oss-120b', coolingDownMs: 0 },
  { id: 'pollinations', label: 'Pollinations', state: 'ready', deep: 'openai-fast', fast: 'openai-fast', coolingDownMs: 0 },
  { id: 'mistral', label: 'Mistral', state: 'missing', detail: 'set MISTRAL_API_KEY', coolingDownMs: 0 },
];

const ledger = [
  ...calls('gemini', 'deep', 2, 5000),
  ...calls('gemini', 'deep', 8, 300, false, 'gemini HTTP 429: quota'),
  ...calls('cerebras', 'deep', 10, 1000),
  ...calls('cerebras', 'fast', 10, 800),
  ...calls('pollinations', 'fast', 10, 25000),
  { ts: ts(60 * 30), provider: 'cerebras', tier: 'fast', ok: false, ms: 1 },
];

describe('router ranking', () => {
  it('measures reliability and median speed per provider over the last 24 h, counting rate limits', () => {
    const s = providerStats(ledger, { now });
    expect(s.gemini).toMatchObject({ calls: 10, ok: 2, failed: 8, rateLimited: 8, reliability: 0.25, medianMs: { deep: 5000 } });
    expect(s.cerebras).toMatchObject({ calls: 20, ok: 20, medianMs: { deep: 1000, fast: 800 } });
    expect(s.pollinations.medianMs.deep).toBe(25000);
  });

  it('balanced: a capable provider that keeps failing moves down, and every place has a reason', () => {
    const rows = rankRole({ role: 'deep', strategy: 'balanced', providers, stats: providerStats(ledger, { now }) });
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['cerebras', 'pollinations', 'gemini', 'mistral']);
    expect(rows[0]).toMatchObject({ rank: 1, model: 'gpt-oss-120b', capability: 4, reliability: 0.95 });
    expect(rows[0].why).toMatch(/^score 0\.\d+: capability 4\/5, reliability 95%, 1\.0 s$/);
    expect(rows[2].why).toContain('moved down: only 25% of calls worked');
    expect(rows[3]).toMatchObject({ rank: null, why: 'set MISTRAL_API_KEY' });
  });

  it('fastest sorts by median reply time, smartest by capability, custom keeps your order', () => {
    const stats = providerStats(ledger, { now });
    expect(rankRole({ role: 'fast', strategy: 'fastest', providers, stats }).map((r: { id: string }) => r.id).slice(0, 3)).toEqual(['cerebras', 'pollinations', 'gemini']);
    expect(rankRole({ role: 'deep', strategy: 'smartest', providers, stats }).map((r: { id: string }) => r.id).slice(0, 3)).toEqual(['gemini', 'cerebras', 'pollinations']);
    const custom = rankRole({ role: 'deep', strategy: 'custom', providers, stats, customOrder: ['pollinations', 'gemini', 'cerebras'] });
    expect(custom.map((r: { id: string }) => r.id).slice(0, 3)).toEqual(['pollinations', 'gemini', 'cerebras']);
    expect(custom[0].why).toBe('your position 1');
  });

  it('builds the route only from providers that are switched on, per role', () => {
    const route = routeFor({ strategy: 'balanced', providers, ledger, enabled: ['cerebras', 'gemini'], customOrder: [], now });
    expect(route.order).toEqual({ deep: ['cerebras', 'gemini'], fast: ['cerebras', 'gemini'] });
    const cooling = rankRole({ role: 'deep', strategy: 'balanced', providers: [{ ...providers[1], coolingDownMs: 40000 }], stats: {} });
    expect(cooling[0].why).toContain('cooling 40 s, skipped until then');
    expect(Object.keys(STRATEGIES)).toEqual(['balanced', 'fastest', 'smartest', 'custom']);
    expect(CAPABILITY.gemini[0]).toBe(5);
  });
});
