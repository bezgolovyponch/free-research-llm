import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_PRESETS } from './llm/presets.mjs';
import { OpenAICompatibleProvider } from './llm/provider.mjs';
import { ModelRouter } from './llm/router.mjs';
import { ScriptedProvider } from './llm/scripted-provider.mjs';
import { ResearchEngine } from './research/engine.mjs';
import { BraveBackend, SearchService, SearxngBackend, TavilyBackend, WikipediaBackend } from './search/search.mjs';
import { ProjectStore } from './store.mjs';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_ORDER = ['groq', 'cerebras', 'gemini', 'openrouter', 'ollama', 'custom', 'deepseek'];

function modelOverrides(env, preset) {
  const prefix = `FRL_${preset.id.toUpperCase()}`;
  return {
    fast: env[`${prefix}_FAST_MODEL`] || undefined,
    deep: env[`${prefix}_DEEP_MODEL`] || undefined,
    any: (preset.modelEnv && env[preset.modelEnv]) || undefined,
  };
}

export class ProviderFactory {
  constructor({ env, fetchImpl }) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.sessionKeys = new Map();
  }

  order() {
    const wanted = String(this.env.FRL_PROVIDER_ORDER || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ids = wanted.length ? wanted : DEFAULT_ORDER;
    return ids.map((id) => PROVIDER_PRESETS.find((p) => p.id === id)).filter(Boolean);
  }

  build(preset) {
    const apiKey = this.sessionKeys.get(preset.id) || (preset.keyEnv ? this.env[preset.keyEnv] : '') || '';
    const baseURL = (preset.baseEnv && this.env[preset.baseEnv]) || this.sessionKeys.get(`${preset.id}:url`) || preset.baseURL;
    return new OpenAICompatibleProvider({ preset, apiKey, baseURL, modelOverrides: modelOverrides(this.env, preset), fetchImpl: this.fetchImpl });
  }

  async buildAll() {
    const providers = this.order().map((preset) => this.build(preset));
    await Promise.all(providers.map((p) => p.discover()));
    return providers;
  }

  setSessionKey(providerId, key, baseURL) {
    if (key) this.sessionKeys.set(providerId, key);
    if (baseURL) this.sessionKeys.set(`${providerId}:url`, baseURL);
  }
}

export function buildSearch({ env, fetchImpl }) {
  const backends = [];
  if (env.TAVILY_API_KEY) backends.push(new TavilyBackend({ apiKey: env.TAVILY_API_KEY, fetchImpl }));
  if (env.BRAVE_API_KEY) backends.push(new BraveBackend({ apiKey: env.BRAVE_API_KEY, fetchImpl }));
  if (env.SEARXNG_URL) backends.push(new SearxngBackend({ baseURL: env.SEARXNG_URL, fetchImpl }));
  if (env.FRL_WIKIPEDIA !== '0') backends.push(new WikipediaBackend({ fetchImpl, lang: env.FRL_WIKIPEDIA_LANG || 'en' }));
  return new SearchService({ backends, fetchImpl, fetchPages: env.FRL_FETCH_PAGES !== '0' });
}

export class App {
  constructor({ env = process.env, fetchImpl = fetch, dataDir, providers, search } = {}) {
    this.env = env;
    this.demo = env.FRL_DEMO === '1';
    this.factory = new ProviderFactory({ env, fetchImpl });
    this.router = new ModelRouter({ providers: providers ?? [], paidCallLimit: Number(env.FRL_PAID_CALL_LIMIT ?? 0) || 0 });
    this.search = search ?? buildSearch({ env, fetchImpl });
    this.store = new ProjectStore({ dir: dataDir ?? path.join(ROOT_DIR, 'data', 'projects') });
    this.engine = new ResearchEngine({ router: this.router, search: this.search, store: this.store, demo: this.demo });
    this.fixedProviders = Boolean(providers);
  }

  async refreshProviders() {
    if (this.fixedProviders) return this.router.status();
    const providers = await this.factory.buildAll();
    const live = providers.filter((p) => p.ready);
    if (this.demo && !live.length) providers.push(new ScriptedProvider());
    this.engine.demo = this.demo && !live.length;
    this.router.setProviders(providers);
    return this.router.status();
  }

  async setKey(providerId, key, baseURL) {
    this.factory.setSessionKey(providerId, String(key ?? '').trim(), String(baseURL ?? '').trim());
    return this.refreshProviders();
  }

  status() {
    return {
      ready: this.router.ready,
      demo: this.engine.demo,
      providers: this.router.status(),
      search: this.search.describe(),
      ledger: this.router.ledger.slice(-40),
      calls: this.router.calls,
      paid: { calls: this.router.paidCalls, limit: this.router.paidCallLimit },
    };
  }
}
