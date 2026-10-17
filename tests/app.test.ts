import { describe, expect, it } from 'vitest';
import { App, ProviderFactory, buildSearch } from '../src/app.mjs';
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
});
