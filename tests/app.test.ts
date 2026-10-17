import { describe, expect, it } from 'vitest';
import { App, ProviderFactory, buildSearch, routeOrderFrom } from '../src/app.mjs';
import { fakeFetch, jsonResponse } from './helpers/fake-fetch';

describe('App composition', () => {
  it('builds providers in the configured order and honours model overrides', async () => {
    const fetchImpl = fakeFetch([[/\/models$/, () => jsonResponse({ data: [{ id: 'llama-3.1-8b-instant' }] })]]);
    const factory = new ProviderFactory({ env: { FRL_PROVIDER_ORDER: 'gemini,groq', GROQ_API_KEY: 'k', FRL_GROQ_DEEP_MODEL: 'big' }, fetchImpl });
    const providers = await factory.buildAll();
    expect(providers.map((p) => p.id)).toEqual(['gemini', 'groq']);
    expect(providers[0].state).toBe('not-configured');
    expect(providers[1].selected).toEqual({ fast: 'llama-3.1-8b-instant', deep: 'big' });
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
