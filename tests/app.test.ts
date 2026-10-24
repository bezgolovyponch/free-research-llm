import { describe, expect, it } from 'vitest';
import { App, ProviderFactory, appNoteFor, buildSearch, localBase, routeOrderFrom } from '../src/app.mjs';
import { fakeFetch, jsonResponse } from './helpers/fake-fetch';

describe('App composition', () => {
  it('builds providers in the configured order and honours model overrides', async () => {
    const fetchImpl = fakeFetch([[/\/models$/, () => jsonResponse({ data: [{ id: 'llama-3.1-8b-instant' }] })]]);
    const factory = new ProviderFactory({ env: { FRL_PROVIDER_ORDER: 'gemini,groq', GROQ_API_KEY: 'k', FRL_GROQ_DEEP_MODEL: 'big' }, fetchImpl });
    const providers = await factory.buildAll();
    expect(providers.map((p) => p.id)).toEqual(['gemini', 'groq']);
    expect(providers[0].state).toBe('not-configured');
    expect(providers[1].selected).toEqual({ fast: 'llama-3.1-8b-instant', deep: 'big', vision: null });
  });

  it('accepts a session key without writing it anywhere and falls back to demo only when asked', async () => {
    const fetchImpl = fakeFetch([[/\/models$/, () => jsonResponse({ data: [{ id: 'gemini-2.5-flash' }] })]]);
    const app = new App({ env: { FRL_PROVIDER_ORDER: 'gemini', FRL_DEMO: '1', FRL_WIKIPEDIA: '0' }, fetchImpl, dataDir: '/tmp/frl-unused' });
    await app.refreshProviders();
    expect(app.status()).toMatchObject({ ready: true, demo: true });
    await app.setKey('gemini', 'session-key');
    expect(app.status().demo).toBe(false);
    expect(app.status().providers.map((p: { id: string }) => p.id)).toEqual(['gemini']);
    expect(JSON.stringify(app.status())).not.toContain('session-key');
  });

  it('uses a llama.cpp server on another PC when its address is saved, and leaves it off otherwise', async () => {
    const fetchImpl = fakeFetch([[/192\.168\.5\.26:8090\/v1\/models$/, () => jsonResponse({ data: [{ id: 'qwen3-14b' }] })]]);
    const on = new ProviderFactory({ env: { FRL_PROVIDER_ORDER: 'llamacpp-lan', LLAMACPP_LAN_URL: 'http://192.168.5.26:8090/v1' }, fetchImpl });
    const [lan] = await on.buildAll();
    expect(lan.id).toBe('llamacpp-lan');
    expect(lan.state).toBe('ready');
    expect(lan.selected.fast).toBe('qwen3-14b');
    const off = new ProviderFactory({ env: { FRL_PROVIDER_ORDER: 'llamacpp-lan' }, fetchImpl });
    expect((await off.buildAll())[0].state).not.toBe('ready');
  });

  it('connects a model found on the other PC and routes to it', async () => {
    const fetchImpl = fakeFetch([[/192\.168\.5\.26:8090\/v1\/models$/, () => jsonResponse({ data: [{ id: 'pc-model' }] })], [/192\.168\.5\.26:8090\/props$/, () => jsonResponse({ default_generation_settings: { n_ctx: 16384 } })], [/192\.168\.5\.26:8090\/v1\/chat\/completions$/, () => jsonResponse({ choices: [{ message: { content: 'x' } }], timings: { prompt_n: 1500, prompt_per_second: 400, predicted_per_second: 45 } })]]);
    const app = new App({ env: { FRL_PROVIDER_ORDER: 'llamacpp-lan', FRL_WIKIPEDIA: '0' }, fetchImpl, dataDir: '/tmp/frl-unused-peer' });
    await app.refreshProviders();
    expect(app.status().providers[0].state).not.toBe('ready');
    app.noteApp = () => {};
    await app.connectPeer({ id: 'llamacpp-lan', env: 'LLAMACPP_LAN_URL', label: 'llama.cpp', url: 'http://192.168.5.26:8090/v1', models: ['pc-model'] });
    expect(app.status().providers[0]).toMatchObject({ id: 'llamacpp-lan', state: 'ready', fast: 'pc-model' });
  });

  it('picks up a local model that finished loading after the app started', async () => {
    let up = false;
    const fetchImpl = (async (url: string) => {
      if (!up) throw Object.assign(new Error('refused'), { name: 'TypeError' });
      if (url.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'Qwen3-4B' }] });
      if (url.endsWith('/chat/completions')) return jsonResponse({ choices: [{ message: { content: 'x' } }], timings: { prompt_n: 1500, prompt_per_second: 300, predicted_per_second: 40 } });
      return jsonResponse({ default_generation_settings: { n_ctx: 16384 } });
    }) as never;
    const app = new App({ env: { FRL_PROVIDER_ORDER: 'llamacpp', FRL_WIKIPEDIA: '0' }, fetchImpl, dataDir: '/tmp/frl-unused-local' });
    await app.refreshProviders();
    expect(app.status().providers[0].state).not.toBe('ready');
    expect(await app.rediscoverLocal()).toEqual([]);
    up = true;
    expect(await app.rediscoverLocal()).toEqual(['llamacpp']);
    expect(app.status().providers[0]).toMatchObject({ state: 'ready', fast: 'Qwen3-4B' });
  });

  it('adds /v1 to a bare local address, as saved for Ollama', () => {
    expect(localBase('http://localhost:11434/')).toBe('http://localhost:11434/v1');
    expect(localBase('http://192.168.5.26:8090')).toBe('http://192.168.5.26:8090/v1');
    expect(localBase('http://127.0.0.1:8090/v1')).toBe('http://127.0.0.1:8090/v1');
    expect(localBase('http://127.0.0.1:8090/v1/')).toBe('http://127.0.0.1:8090/v1');
  });

  it('measures a local model and uses a too-slow one only as the last resort until it gets fast enough', async () => {
    let speed = { prompt_n: 1500, prompt_per_second: 12, predicted_per_second: 2.1 };
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'pc-model' }] });
      if (url.endsWith('/props')) return jsonResponse({ default_generation_settings: { n_ctx: 16384 }, total_slots: 1 });
      return jsonResponse({ choices: [{ message: { content: 'x' } }], timings: speed });
    }) as never;
    const app = new App({ env: { FRL_PROVIDER_ORDER: 'llamacpp-lan', LLAMACPP_LAN_URL: 'http://192.168.5.26:8090/v1', FRL_WIKIPEDIA: '0' }, fetchImpl, dataDir: '/tmp/frl-unused-speed' });
    await app.refreshProviders();
    const [slow] = await app.checkLocalSpeed();
    expect(slow.usable).toBe(false);
    expect(app.status().providers[0]).toMatchObject({ state: 'too-slow' });
    expect(app.router.available({ tier: 'fast' }).map((p: { id: string; state: string }) => `${p.id}:${p.state}`)).toEqual([`${app.router.providers[0].id}:too-slow`]);
    expect(await app.rediscoverLocal()).toEqual([]);
    await app.refreshProviders();
    expect(app.status().providers[0].state).toBe('too-slow');
    speed = { prompt_n: 1500, prompt_per_second: 300, predicted_per_second: 40 };
    const [fast] = await app.checkLocalSpeed({ force: true });
    expect(await app.isSleeping(app.router.providers[0])).toBe(false);
    expect(fast.usable).toBe(true);
    expect(app.status().providers[0].state).toBe('ready');
  });

  it('enables search backends from the environment, Wikipedia by default', () => {
    expect(buildSearch({ env: {}, fetchImpl: fetch }).describe().backends).toEqual(['wikipedia']);
    expect(buildSearch({ env: { TAVILY_API_KEY: 't', BRAVE_API_KEY: 'b', FRL_WIKIPEDIA: '0' }, fetchImpl: fetch }).describe().backends).toEqual(['tavily', 'brave']);
  });

  it('fills the Cloudflare account into the base URL and reports what is missing', async () => {
    const fetchImpl = fakeFetch([[/accounts\/acc123\/ai\/v1\/models$/, () => new Response('nope', { status: 404 })]]);
    const partial = await new ProviderFactory({ env: { FRL_PROVIDER_ORDER: 'cloudflare', CLOUDFLARE_API_TOKEN: 't' }, fetchImpl }).buildAll();
    expect(partial[0].describe()).toMatchObject({ state: 'not-configured', detail: 'set CLOUDFLARE_ACCOUNT_ID' });
    const factory = new ProviderFactory({ env: { FRL_PROVIDER_ORDER: 'cloudflare', CLOUDFLARE_API_TOKEN: 't' }, fetchImpl });
    factory.setSessionKey('cloudflare', '', 'acc123');
    const [cf] = await factory.buildAll();
    expect(cf.baseURL).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1');
    expect(cf.selected.fast).toBe('@cf/meta/llama-3.1-8b-instruct');
  });

  it('uses per-tier default routes, with env overrides', () => {
    expect(routeOrderFrom({}).deep[0]).toBe('gemini');
    expect(routeOrderFrom({}).fast[0]).toBe('groq');
    expect(routeOrderFrom({ FRL_FAST_ORDER: 'mistral,groq' }).fast).toEqual(['mistral', 'groq']);
    expect(routeOrderFrom({ FRL_PROVIDER_ORDER: 'nvidia' })).toEqual({ fast: ['nvidia'], deep: ['nvidia'] });
  });

  it('accepts a search key for the session and rebuilds search', async () => {
    const app = new App({ env: { FRL_PROVIDER_ORDER: 'groq' }, fetchImpl: fakeFetch([]), dataDir: '/tmp/frl-unused' });
    await app.setKey('EXA_API_KEY', 'ek');
    expect(app.status().search.backends).toEqual(['exa', 'wikipedia']);
    expect(app.engine.search).toBe(app.search);
    expect(app.status().searchKeys.find((k: { env: string }) => k.env === 'EXA_API_KEY').set).toBe(true);
  });
});

describe('App save and resume', () => {
  it('saves a handoff for an interrupted run on shutdown and resumes it on the next start', async () => {
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { App } = await import('../src/app.mjs');
    const { ScriptedProvider } = await import('../src/llm/scripted-provider.mjs');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frl-app-resume-'));
    const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({ backends: [] }) };
    const first = new App({ env: { FRL_MARKETPLACES: '0' }, dataDir: dir, providers: [new ScriptedProvider()], search });
    const project = await first.engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    first.engine.running.add(project.id);
    await first.shutdown();
    first.engine.running.delete(project.id);
    expect((await first.handoffs.read(project.id)).resume).toEqual({ wasRunning: true });
    expect((await first.engine.load(project.id)).chats.Q.at(-1).content).toMatch(/^Progress saved \(app stopped\)/);

    const second = new App({ env: { FRL_MARKETPLACES: '0' }, dataDir: dir, providers: [new ScriptedProvider()], search });
    expect(await second.resumeInterrupted()).toEqual([project.id]);
    for (let i = 0; i < 300 && second.engine.running.has(project.id); i++) await new Promise((r) => setTimeout(r, 10));
    expect((await second.engine.load(project.id)).phase).toBe('done');
    expect(await second.handoffs.resumable()).toEqual([]);
    await second.logs.queue;
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});

describe('App reports in the app conversation', () => {
  it('turns research events into short app notes and ignores the rest', () => {
    const project = { question: 'Cars DE to CZ?', nodes: [{ status: 'verified' }, { status: 'weak' }] };
    expect(appNoteFor({ type: 'created', message: 'x' }, project)).toBe('New research: Cars DE to CZ?');
    expect(appNoteFor({ type: 'phase', message: 'done' }, project)).toBe('Research finished — Cars DE to CZ? · 1/2 pieces pass');
    expect(appNoteFor({ type: 'improve-state', message: 'self-improving loop ended: time limit reached' }, project)).toBe('Self-improving loop ended: time limit reached — Cars DE to CZ?');
    expect(appNoteFor({ type: 'search', message: 'x' }, project)).toBeNull();
  });

  it('marks researches that were running when the app stopped as cancelled, so none look busy forever', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { ScriptedProvider } = await import('../src/llm/scripted-provider.mjs');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-stale-'));
    const app = new App({ env: {}, dataDir: dir, providers: [new ScriptedProvider()], search: { enabled: false, lastErrors: [], search: async () => [], describe: () => ({ backends: [] }) } });
    const project = await app.engine.createProject({ question: 'Which kiosk spot in Brno pays back fastest?' });
    project.phase = 'researching';
    await app.store.save(project);
    expect(await app.settleStale()).toEqual([project.id]);
    expect((await app.engine.load(project.id)).phase).toBe('cancelled');
    expect(await app.settleStale()).toEqual([]);
    await new Promise((r) => setTimeout(r, 50));
    expect((await app.appChat.thread()).map((m: { content: string }) => m.content)).toContain('New research: Which kiosk spot in Brno pays back fastest?');
    await app.logs.queue;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});
