import { describe, expect, it } from 'vitest';
import { CAPABILITY, PAID_REASON, PURPOSE_CLASS, STRATEGIES, capabilityOf, familyOf, purposePlan, localCapability, providerStats, rankRole, routeFor, usageInfo } from '../../src/llm/ranking.mjs';
import { paidDailyTokens, paidProviderIds } from '../../src/llm/presets.mjs';

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
  ...calls('gemini', 'deep', 8, 300, false, 'gemini unreachable: timed out'),
  ...calls('cerebras', 'deep', 10, 1000),
  ...calls('cerebras', 'fast', 10, 800),
  ...calls('pollinations', 'fast', 10, 25000),
  { ts: ts(60 * 30), provider: 'cerebras', tier: 'fast', ok: false, ms: 1 },
];

describe('router ranking', () => {
  it('measures reliability and median speed per provider over the last 24 h, counting rate limits', () => {
    const s = providerStats(ledger, { now });
    expect(s.gemini).toMatchObject({ calls: 10, ok: 2, failed: 8, rateLimited: 0, reliability: 0.25, medianMs: { deep: 5000 } });
    expect(s.cerebras).toMatchObject({ calls: 20, ok: 20, medianMs: { deep: 1000, fast: 800 } });
    expect(s.pollinations.medianMs.deep).toBe(25000);
  });

  it('providerStats does not lower reliability for 429/413 and does not count "generate" as a rate limit', () => {
    const groq429 = 'groq HTTP 429 [quota window: per minute]: {"error":{"message":"Rate limit reached for model `openai/gpt-oss-20b`';
    const groq413 = 'groq HTTP 413 [quota window: per minute]: {"error":{"message":"Request too large for model `openai/gpt-oss-20b`';
    const cerebras429 = 'cerebras HTTP 429 [quota window: per minute]: {"message":"Tokens per minute limit exceeded - too many tokens processed.","type":"too_many_tokens_error","param":"quota","code":"token_quota_exceeded"}';
    const cohere422 = 'cohere HTTP 422: {"error":{"message":"No valid response generated. Try updating messages","type":"Unprocessable Entity","param":null,"code":422},"error_type":"NO_VALID_RESPONSE_GENERATED"';
    const cohere500 = 'cohere HTTP 500: {"id":"cddb413c-d9eb-4993-b6e4-7af1930dbef5","message":"internal server error, this has been reported to our developers. id d9ae694e81ceeffa254ec7ff5e94c7e4"}';
    const s = providerStats([
      ...calls('groq', 'fast', 75, 600),
      ...calls('groq', 'fast', 28, 120, false, groq429),
      ...calls('groq', 'fast', 8, 100, false, groq413),
      ...calls('cerebras', 'fast', 10, 800),
      ...calls('cerebras', 'fast', 27, 220, false, cerebras429),
      ...calls('cohere', 'deep', 4, 3000),
      ...calls('cohere', 'deep', 2, 1800, false, cohere422),
      ...calls('cohere', 'deep', 2, 30000, false, cohere500),
    ], { now });
    expect(s.groq).toMatchObject({ calls: 111, ok: 75, failed: 36, rateLimited: 36 });
    expect(s.groq.reliability).toBeCloseTo(76 / 77, 6);
    expect(s.cerebras).toMatchObject({ calls: 37, ok: 10, rateLimited: 27 });
    expect(s.cerebras.reliability).toBeCloseTo(11 / 12, 6);
    expect(s.cohere).toMatchObject({ calls: 8, ok: 4, failed: 4, rateLimited: 0 });
    expect(s.cohere.reliability).toBeCloseTo(5 / 10, 6);
  });

  it('rankRole uses p[modelRole] for the posterior and the shown model', () => {
    const ps = [{ id: 'groq', label: 'Groq', state: 'ready', deep: 'openai/gpt-oss-120b', fast: 'openai/gpt-oss-20b', coolingDownMs: 0 }];
    const seen: Array<string | null> = [];
    const outcomes = {
      posterior: (_id: string, _cls: string, capability: number, model: string | null = null) => {
        seen.push(model);
        return { mean: model === 'openai/gpt-oss-20b' ? 0.9 : 0.1, observed: 10, pass: 9, fail: 1, a: capability, b: 1 };
      },
      sample: (_id: string, _cls: string, _capability: number, _rng: () => number, model: string | null = null) => (model === 'openai/gpt-oss-20b' ? 0.9 : 0.1),
    };
    const own = rankRole({ role: 'deep', strategy: 'balanced', providers: ps, stats: {}, outcomes, purposeClass: 'research' })[0];
    expect(own).toMatchObject({ model: 'openai/gpt-oss-120b', quality: 0.1 });
    const fastArm = rankRole({ role: 'deep', modelRole: 'fast', strategy: 'balanced', providers: ps, stats: {}, outcomes, purposeClass: 'research' })[0];
    expect(fastArm).toMatchObject({ model: 'openai/gpt-oss-20b', quality: 0.9 });
    expect(seen).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  });

  it('purposePlan research order uses the fast model\'s posterior, since first research attempts run on the fast tier', async () => {
    const { OutcomeBook } = await import('../../src/llm/outcomes.mjs');
    const ps = [
      { id: 'alpha', label: 'Alpha', state: 'ready', deep: 'alpha-deep', fast: 'alpha-fast', coolingDownMs: 0 },
      { id: 'beta', label: 'Beta', state: 'ready', deep: 'beta-deep', fast: 'beta-fast', coolingDownMs: 0 },
    ];
    const book = new OutcomeBook({ now: () => 1000 });
    for (let i = 0; i < 40; i++) {
      book.record({ provider: 'alpha', model: 'alpha-fast', purposeClass: 'research', passed: false });
      book.record({ provider: 'alpha', model: 'alpha-deep', purposeClass: 'research', passed: true });
      book.record({ provider: 'beta', model: 'beta-fast', purposeClass: 'research', passed: true });
      book.record({ provider: 'beta', model: 'beta-deep', purposeClass: 'research', passed: false });
    }
    for (const seed of [1, 2, 3, 4, 5]) {
      let s = seed;
      const rng = () => {
        s = (s * 16807) % 2147483647;
        return (s - 1) / 2147483646;
      };
      const plan = purposePlan({ providers: ps, stats: {}, enabled: ['alpha', 'beta'], outcomes: book, rng });
      expect(plan.byPurpose.research).toEqual(['beta', 'alpha']);
    }
  });

  it('counts the time lost on failed calls too, so speed means time per useful answer', () => {
    const s = providerStats([...calls('pollinations', 'fast', 10, 40000), ...calls('pollinations', 'fast', 10, 40000, false, 'pollinations HTTP 500: boom')], { now });
    expect(s.pollinations).toMatchObject({ calls: 20, ok: 10, failed: 10, spentMs: 800000, msPerAnswer: 80000 });
    const none = providerStats([...calls('pollinations', 'fast', 3, 40000, false, 'pollinations HTTP 500: boom')], { now });
    expect(none.pollinations.msPerAnswer).toBeNull();
  });

  it('balanced: a capable provider that keeps failing moves down, and every place has a reason', () => {
    const rows = rankRole({ role: 'deep', strategy: 'balanced', providers, stats: providerStats(ledger, { now }) });
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['cerebras', 'pollinations', 'gemini', 'mistral']);
    expect(rows[0]).toMatchObject({ rank: 1, model: 'gpt-oss-120b', capability: 4, reliability: 0.95 });
    expect(rows[0].why).toMatch(/^score 0\.\d+: no graded answers yet: prior 4\/5 \(gpt-oss-120b\), reliability 95%, 1\.0 s$/);
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
    expect(Object.keys(STRATEGIES)).toEqual(['max', 'balanced', 'fastest', 'smartest', 'custom']);
    expect(CAPABILITY.gemini[0]).toBe(5);
  });

  it('describes each provider in use: share of calls, outcomes, hourly calls, models, purposes and today against the free daily limit', () => {
    const rows = [
      ...calls('groq', 'fast', 3, 700).map((r) => ({ ...r, model: 'gpt-oss-20b', purpose: 'research', tokens: 100 })),
      { ts: ts(5), provider: 'groq', tier: 'fast', ok: false, error: 'groq HTTP 413: Request too large', purpose: 'research' },
      { ts: ts(130), provider: 'groq', tier: 'deep', ok: false, error: 'socket hang up', purpose: 'critique' },
      { ts: ts(20), provider: 'cerebras', tier: 'deep', ok: true, ms: 900, tokens: 400000, model: 'gpt-oss-120b', purpose: 'synthesize' },
      { ts: ts(60 * 30), provider: 'groq', tier: 'fast', ok: true, ms: 1 },
    ];
    const u = usageInfo(rows, { now });
    expect(u.total).toBe(6);
    expect(u.providers.groq).toMatchObject({ calls: 5, ok: 3, rateLimited: 1, errors: 1, share: 0.833, medianMs: 700, models: [{ model: 'gpt-oss-20b', calls: 3 }], purposes: [{ purpose: 'research', calls: 4 }, { purpose: 'critique', calls: 1 }] });
    expect(u.providers.groq.hourly[23]).toBe(4);
    expect(u.providers.groq.hourly[21]).toBe(1);
    expect(u.providers.groq.today).toMatchObject({ limit: 1000, unit: 'requests', requests: 5, used: 0.005 });
    expect(u.providers.cerebras.today).toMatchObject({ limit: 1000000, unit: 'tokens', tokens: 400000, used: 0.4 });
  });

  it('rates a local model by its size, so a small one never outranks a strong free provider on capability', () => {
    expect([localCapability('Qwen3-32B'), localCapability('gpt-oss-20b'), localCapability('Qwen3-4B'), localCapability('gemma-3-270m'), localCapability('local')]).toEqual([4, 3, 2, 1, null]);
    expect(capabilityOf({ id: 'llamacpp', deep: 'gpt-oss-20b', local: true })).toEqual([3, 'gpt-oss-20b on your own hardware']);
    expect(capabilityOf({ id: 'llamacpp', deep: 'local', local: true })).toEqual([2, 'depends on the model you run']);
    const tiny = { id: 'llamacpp', label: 'local', state: 'ready', deep: 'gemma-3-270m-it', fast: 'gemma-3-270m-it', local: true, coolingDownMs: 0 };
    const stats = providerStats([...calls('llamacpp', 'fast', 20, 50), ...calls('cerebras', 'fast', 10, 900)], { now });
    const rows = rankRole({ role: 'fast', strategy: 'balanced', providers: [tiny, providers[1]], stats });
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['cerebras', 'llamacpp']);
    expect(rows[1].why).toContain('kept last: too small for research');
  });

  it('maximum capability: strongest for memo/tree/code, capable volume for research, fast other-family models for reviews, and the strongest model\'s quota kept for what matters', () => {
    const ps = [
      { id: 'gemini', label: 'Gemini', state: 'ready', deep: 'gemini-3.8-flash', fast: 'gemini-3.5-flash-lite', coolingDownMs: 0 },
      { id: 'cerebras', label: 'Cerebras', state: 'ready', deep: 'gpt-oss-120b', fast: 'gpt-oss-120b', coolingDownMs: 0 },
      { id: 'groq', label: 'Groq', state: 'ready', deep: 'openai/gpt-oss-120b', fast: 'openai/gpt-oss-20b', coolingDownMs: 0 },
      { id: 'pollinations', label: 'Pollinations', state: 'ready', deep: 'openai-fast', fast: 'openai-fast', coolingDownMs: 0 },
    ];
    const stats = providerStats([...calls('cerebras', 'fast', 10, 800), ...calls('groq', 'fast', 10, 600), ...calls('gemini', 'deep', 10, 2000), ...calls('pollinations', 'fast', 10, 25000)], { now });
    const plan = purposePlan({ providers: ps, stats, enabled: ps.map((p) => p.id) });
    expect(plan.reserved).toBe('gemini');
    expect(plan.byPurpose.synthesize[0]).toBe('gemini');
    expect(plan.byPurpose.code[0]).toBe('gemini');
    expect(plan.byPurpose['research:deep'][0]).toBe('gemini');
    expect(plan.byPurpose.critique.at(-1)).toBe('gemini');
    expect(plan.byPurpose.critique.slice(0, 2).sort()).toEqual(['cerebras', 'groq']);
    const tight = purposePlan({ providers: ps, stats, usage: { gemini: { today: { used: 0.8 } } }, enabled: ps.map((p) => p.id) });
    expect(tight.byPurpose.research[0]).not.toBe('gemini');
    expect(tight.byPurpose.synthesize[0]).toBe('gemini');
    expect(PURPOSE_CLASS.rollup).toBe('volume');
    expect([familyOf('openai/gpt-oss-120b'), familyOf('gpt-oss-120b'), familyOf('gemini-3.8-flash'), familyOf('DeepSeek-V3.2'), familyOf('x', 'p')]).toEqual(['gpt-oss', 'gpt-oss', 'gemini', 'deepseek', 'p']);
  });

  it('volume order follows time per useful answer, so a slow provider with many failures drops below a fast reliable one', () => {
    const ps = [
      { id: 'cerebras', label: 'Cerebras', state: 'ready', deep: 'gpt-oss-120b', fast: 'gpt-oss-120b', coolingDownMs: 0 },
      { id: 'pollinations', label: 'Pollinations', state: 'ready', deep: 'openai-fast', fast: 'openai-fast', coolingDownMs: 0 },
      { id: 'groq', label: 'Groq', state: 'ready', deep: 'openai/gpt-oss-120b', fast: 'openai/gpt-oss-20b', coolingDownMs: 0 },
    ];
    const stats = providerStats([
      ...calls('cerebras', 'fast', 10, 45000),
      ...calls('cerebras', 'fast', 8, 45000, false, 'cerebras HTTP 500: boom'),
      ...calls('pollinations', 'fast', 10, 1000),
      ...calls('groq', 'fast', 10, 600),
    ], { now });
    const plan = purposePlan({ providers: ps, stats, enabled: ps.map((p) => p.id) });
    expect(plan.orders.volume.indexOf('pollinations')).toBeLessThan(plan.orders.volume.indexOf('cerebras'));
    expect(plan.orders.volume.at(-1)).toBe('groq');
    expect(plan.reserved).toBe('groq');
  });
});

describe('daily limits against the measured ledger (2026-11-03)', () => {
  it('a provider still answering is not ranked as spent: SambaNova answered 38 of 38 calls that day', async () => {
    const fs = await import('node:fs/promises');
    const rows = JSON.parse(await fs.readFile(new URL('../fixtures/model-calls-2026-11-03.json', import.meta.url), 'utf8'));
    const at = Date.parse('2026-11-03T23:59:00Z');
    const sambanova = rows.filter((r: { provider: string }) => r.provider === 'sambanova');
    expect([sambanova.length, sambanova.filter((r: { ok: boolean }) => r.ok).length]).toEqual([38, 38]);
    const usage = usageInfo(rows, { now: at }).providers;
    expect(usage.sambanova.today).toMatchObject({ requests: 38, limit: null, used: null });
    const ps = [
      { id: 'gemini', label: 'Gemini', state: 'ready', deep: 'gemini-3.5-flash-lite', fast: 'gemini-3.5-flash-lite', coolingDownMs: 0 },
      { id: 'cerebras', label: 'Cerebras', state: 'ready', deep: 'gpt-oss-120b', fast: 'gpt-oss-120b', coolingDownMs: 0 },
      { id: 'sambanova', label: 'SambaNova', state: 'ready', deep: 'DeepSeek-V3.2', fast: 'gpt-oss-120b', coolingDownMs: 0 },
      { id: 'groq', label: 'Groq', state: 'ready', deep: 'openai/gpt-oss-120b', fast: 'openai/gpt-oss-20b', coolingDownMs: 0 },
      { id: 'cohere', label: 'Cohere', state: 'ready', deep: 'command-a-03-2025', fast: 'command-a-03-2025', coolingDownMs: 0 },
      { id: 'pollinations', label: 'Pollinations', state: 'ready', deep: 'openai-fast', fast: 'openai-fast', coolingDownMs: 0 },
    ];
    const plan = (u: Record<string, unknown>) => purposePlan({ providers: ps, stats: providerStats(rows, { now: at }), usage: u as never, enabled: ps.map((p) => p.id), rng: () => 0.5, env: {} }).orders;
    const measured = plan(usage);
    const withoutItsUsage = plan({ ...usage, sambanova: undefined });
    for (const cls of ['top', 'research', 'volume']) expect(measured[cls].indexOf('sambanova'), cls).toBe(withoutItsUsage[cls].indexOf('sambanova'));
    expect(measured.volume.indexOf('sambanova')).toBeLessThan(measured.volume.length - 1);
  });

  it('states the Pollinations pace its own error names: 1 reply every 45 seconds per IP', async () => {
    const fs = await import('node:fs/promises');
    const rows = JSON.parse(await fs.readFile(new URL('../fixtures/model-calls-2026-11-03.json', import.meta.url), 'utf8'));
    const refusal = rows.find((r: { provider: string; error?: string }) => r.provider === 'pollinations' && /every \d+ seconds/.test(r.error ?? ''));
    expect(refusal.error).toContain('1 reply every 45 seconds per IP');
    const { DAILY_LIMITS } = await import('../../src/llm/ranking.mjs');
    const { FREE_TIERS: FREE_TIER } = await import('../../src/llm/admin.mjs');
    const { PROVIDER_PRESETS } = await import('../../src/llm/presets.mjs');
    expect(PROVIDER_PRESETS.find((p: { id: string }) => p.id === 'pollinations').minIntervalMs).toBe(45000);
    for (const text of [DAILY_LIMITS.pollinations.note, CAPABILITY.pollinations[1], FREE_TIER.pollinations]) {
      expect(text).toContain('45 s');
      expect(text).not.toContain('30 s');
    }
    for (const text of [DAILY_LIMITS.sambanova.note, FREE_TIER.sambanova, PROVIDER_PRESETS.find((p: { id: string }) => p.id === 'sambanova').label]) expect(text).not.toMatch(/20 (?:req|requests)\/day/);
  });
});

describe('providers that never answered', () => {
  it('ranks a provider whose calls all failed after ones that answered and never reserves it, whatever its prior', () => {
    const ps = [
      { id: 'puter', label: 'Puter', state: 'ready', deep: 'gpt-5.4-nano', fast: 'gemini-3.5-flash-lite', coolingDownMs: 0 },
      { id: 'fcc', label: 'fcc', state: 'ready', deep: 'claude-opus-5-5', fast: 'claude-haiku-4-5', coolingDownMs: 0 },
      { id: 'pollinations', label: 'Pollinations', state: 'ready', deep: 'openai-fast', fast: 'openai-fast', coolingDownMs: 0 },
    ];
    const stats = providerStats([...calls('puter', 'deep', 1, 500, false, 'puter HTTP 402: A subscription is required'), ...calls('fcc', 'deep', 6, 9000), ...calls('pollinations', 'deep', 6, 40000)], { now });
    const plan = purposePlan({ providers: ps, stats, enabled: ps.map((p) => p.id) });
    expect(plan.reserved).not.toBe('puter');
    expect(plan.orders.top.at(-1)).toBe('fcc');
    expect(plan.orders.top.indexOf('puter')).toBeLessThan(plan.orders.top.indexOf('fcc'));
    expect(plan.orders.research.at(-1)).toBe('fcc');
    expect(plan.orders.research.indexOf('puter')).toBeLessThan(plan.orders.research.indexOf('fcc'));
    const rows = rankRole({ role: 'deep', strategy: 'balanced', providers: ps, stats });
    expect(rows.at(-1).id).toBe('fcc');
    expect(rows.at(-2).id).toBe('puter');
  });
});

describe('paid providers', () => {
  it('takes the paid list from the settings, with the presets that say so, and the daily cap', () => {
    expect(paidProviderIds({})).toEqual(expect.arrayContaining(['fcc', 'custom']));
    expect(paidProviderIds({ FRL_PAID_PROVIDERS: 'alpha, beta' })).toEqual(expect.arrayContaining(['alpha', 'beta', 'fcc']));
    expect(paidDailyTokens({})).toBe(1000000);
    expect(paidDailyTokens({ FRL_PAID_DAILY_TOKENS: '500' })).toBe(500);
  });

  it('puts a paid provider behind every ready free one, whatever its score, and says why', () => {
    const ps = [
      { id: 'fcc', label: 'fcc', state: 'ready', deep: 'claude-opus-5-5', fast: 'claude-haiku-4-5', coolingDownMs: 0 },
      { id: 'pollinations', label: 'Pollinations', state: 'ready', deep: 'openai-fast', fast: 'openai-fast', coolingDownMs: 0 },
      { id: 'mistral', label: 'Mistral', state: 'missing', detail: 'set MISTRAL_API_KEY', coolingDownMs: 0 },
    ];
    const stats = providerStats([...calls('pollinations', 'deep', 6, 40000)], { now });
    const rows = rankRole({ role: 'deep', strategy: 'balanced', providers: ps, stats });
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['pollinations', 'fcc', 'mistral']);
    expect(rows[1].why).toBe(PAID_REASON);
    expect(rows[1].why).toBe('paid: used only when every free provider is resting');
    expect(rows[1].rank).toBe(2);
    expect(rows[2].why).toBe('set MISTRAL_API_KEY');
  });

  it('marks the providers named in the settings as paid, even with a better prior', () => {
    const ps = [
      { id: 'custom', label: 'Custom', state: 'ready', deep: 'my-model', fast: 'my-model', coolingDownMs: 0 },
      { id: 'pollinations', label: 'Pollinations', state: 'ready', deep: 'openai-fast', fast: 'openai-fast', coolingDownMs: 0 },
    ];
    const stats = providerStats([...calls('pollinations', 'deep', 6, 40000)], { now });
    const rows = rankRole({ role: 'deep', strategy: 'balanced', providers: ps, stats, env: { FRL_PAID_PROVIDERS: 'custom' } });
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['pollinations', 'custom']);
    expect(rows[1].why).toBe(PAID_REASON);
  });

  it('keeps the paid provider last in every purpose plan and never reserves it', () => {
    const ps = [
      { id: 'fcc', label: 'fcc', state: 'ready', deep: 'claude-opus-5-5', fast: 'claude-haiku-4-5', coolingDownMs: 0 },
      { id: 'gemini', label: 'Gemini', state: 'ready', deep: 'gemini-3.8-flash', fast: 'gemini-3.5-flash-lite', coolingDownMs: 0 },
      { id: 'pollinations', label: 'Pollinations', state: 'ready', deep: 'openai-fast', fast: 'openai-fast', coolingDownMs: 0 },
    ];
    const stats = providerStats([...calls('gemini', 'deep', 10, 2000), ...calls('pollinations', 'fast', 10, 25000)], { now });
    const plan = purposePlan({ providers: ps, stats, enabled: ps.map((p) => p.id) });
    expect(plan.reserved).toBe('gemini');
    expect(plan.orders.top.at(-1)).toBe('fcc');
    expect(plan.orders.research.at(-1)).toBe('fcc');
    expect(plan.orders.volume.at(-1)).toBe('fcc');
    expect(plan.byPurpose.synthesize.at(-1)).toBe('fcc');
    expect(plan.byPurpose.critique.at(-1)).toBe('fcc');
  });
});
