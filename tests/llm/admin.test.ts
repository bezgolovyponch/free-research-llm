import { describe, expect, it } from 'vitest';
import { LinkVerifier, RouterAdmin, catalogRows, editableNames, linkVerdict, modelOrder } from '../../src/llm/admin.mjs';

function store() {
  const saved = new Map<string, string>();
  return { label: 'test store', saved, loaded: new Set<string>(), write: async (n: string, v: string) => (saved.set(n, v), true), remove: async (n: string) => saved.delete(n) };
}

function admin(env: Record<string, string>, verify: (n: string, v: string) => Promise<Record<string, unknown>>) {
  const secrets = store();
  let reloads = 0;
  let orders = 0;
  const a = new RouterAdmin({
    env,
    secrets,
    reload: async () => { reloads++; },
    statuses: () => [{ id: 'groq', state: 'ready', modelCount: 12, fast: 'gpt-oss-20b', deep: 'gpt-oss-120b', coolingDownMs: 0 }, { id: 'gemini', state: 'ready', modelCount: 40, coolingDownMs: 9000 }],
    ledger: () => [{ provider: 'groq', ok: true }, { provider: 'groq', ok: false }],
    applyOrder: () => { orders++; },
    checker: { verify: async (n: string, v: string) => ({ value: v.trim(), ...(await verify(n, v)) }) } as never,
    links: new LinkVerifier({ fetchImpl: (async (url: string) => ({ status: url.includes('broken') ? 404 : url.includes('cloudflare') ? 403 : 200, body: null })) as never }),
  });
  return { a, secrets, reloads: () => reloads, orders: () => orders };
}

describe('router admin', () => {
  it('lists every free model provider and search engine with its free tier, live state, calls and link check', async () => {
    const { a } = admin({ GROQ_API_KEY: 'gsk_x' }, async () => ({ ok: true }));
    const view = await a.view({ verify: true });
    const groq = view.models.find((m: { id: string }) => m.id === 'groq');
    expect(groq).toMatchObject({ env: 'GROQ_API_KEY', saved: true, state: 'ready', enabled: true, calls: { ok: 1, failed: 1 }, link: { ok: true } });
    expect(groq.free).toContain('1,000 req/day');
    expect(view.models.find((m: { id: string }) => m.id === 'gemini')).toMatchObject({ state: 'cooling' });
    expect(view.models.find((m: { id: string }) => m.id === 'mistral')).toMatchObject({ state: 'empty', saved: false });
    expect(view.models.find((m: { id: string }) => m.id === 'cloudflare').link).toMatchObject({ ok: true, detail: expect.stringContaining('sign-in') });
    expect(view.models.find((m: { id: string }) => m.id === 'pollinations')).toMatchObject({ keyless: true, env: null });
    expect(view.models.find((m: { id: string }) => m.id === 'ollama')).toMatchObject({ state: 'empty' });
    expect(view.search.map((s: { env: string }) => s.env)).toContain('TAVILY_API_KEY');
    expect(view.store).toBe('test store');
  });

  it('tests a key with the provider before saving it in the key store, and refuses a key that does not work unless forced', async () => {
    const env: Record<string, string> = {};
    const t = admin(env, async (n, v) => (v.includes('bad') ? { ok: false, detail: 'HTTP 401' } : { ok: true, detail: 'HTTP 200' }));
    expect(await t.a.save('GROQ_API_KEY', ' gsk_bad ')).toEqual({ saved: false, ok: false, detail: 'HTTP 401' });
    expect(t.secrets.saved.size).toBe(0);
    expect(await t.a.save('GROQ_API_KEY', 'gsk_good')).toMatchObject({ saved: true, stored: true, ok: true });
    expect([t.secrets.saved.get('GROQ_API_KEY'), env.GROQ_API_KEY, t.reloads()]).toEqual(['gsk_good', 'gsk_good', 1]);
    expect(await t.a.save('GROQ_API_KEY', 'gsk_bad', { force: true })).toMatchObject({ saved: true });
    expect(await t.a.save('CUSTOM_LLM_BASE_URL', 'http://localhost:3001/v1')).toMatchObject({ saved: true, detail: 'setting saved' });
    expect(await t.a.test('GROQ_API_KEY')).toMatchObject({ ok: false });
    await t.a.remove('GROQ_API_KEY');
    expect([t.secrets.saved.has('GROQ_API_KEY'), 'GROQ_API_KEY' in env]).toEqual([false, false]);
    await expect(t.a.save('PATH', '/bin')).rejects.toThrow(/unknown key name/);
    await expect(t.a.save('FRL_ACCESS_TOKEN', 'x')).rejects.toThrow(/unknown key name/);
    await expect(t.a.save('GROQ_API_KEY', '   ')).rejects.toThrow(/empty/);
  });

  it('saves the router order: listed providers in that order, unlisted ones off', async () => {
    const env: Record<string, string> = {};
    const t = admin(env, async () => ({ ok: true }));
    expect(modelOrder(env).custom).toBe(false);
    expect(await t.a.order(['cerebras', 'groq', 'nope', 'groq'])).toEqual({ order: ['cerebras', 'groq'] });
    expect([env.FRL_PROVIDER_ORDER, t.secrets.saved.get('FRL_PROVIDER_ORDER'), t.orders()]).toEqual(['cerebras,groq', 'cerebras,groq', 1]);
    expect(modelOrder(env)).toMatchObject({ enabled: ['cerebras', 'groq'], custom: true });
    expect(catalogRows({ env }).models.find((m: { id: string }) => m.id === 'gemini')).toMatchObject({ enabled: false, rank: -1 });
    await expect(t.a.order([])).rejects.toThrow(/at least one/);
  });

  it('judges a source link by its HTTP status and caches the result', async () => {
    expect([linkVerdict(200).ok, linkVerdict(403).ok, linkVerdict(404).ok, linkVerdict(0, 'timed out').ok]).toEqual([true, true, false, false]);
    let calls = 0;
    const v = new LinkVerifier({ fetchImpl: (async () => { calls++; return { status: 404, body: null }; }) as never });
    await v.check('https://x.test/broken');
    await v.check('https://x.test/broken');
    expect([calls, v.known('https://x.test/broken')?.ok]).toEqual([1, false]);
    await v.checkAll(['https://x.test/broken'], { force: true });
    expect(calls).toBe(2);
    expect(editableNames().has('CLOUDFLARE_ACCOUNT_ID')).toBe(true);
  });
});
