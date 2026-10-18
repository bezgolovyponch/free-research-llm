import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_PRESETS, ROUTE_ORDER, SEARCH_KEYS } from './llm/presets.mjs';
import { OpenAICompatibleProvider } from './llm/provider.mjs';
import { ModelRouter } from './llm/router.mjs';
import { ScriptedProvider } from './llm/scripted-provider.mjs';
import { ResearchEngine } from './research/engine.mjs';
import { BraveBackend, ExaBackend, FirecrawlBackend, JinaSearchBackend, LangSearchBackend, LinkupBackend, SearchService, SearxngBackend, SerperBackend, TavilyBackend, WikipediaBackend } from './search/search.mjs';
import { ProjectStore } from './store.mjs';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listEnv(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function routeOrderFrom(env) {
  const both = listEnv(env.FRL_PROVIDER_ORDER);
  return {
    fast: listEnv(env.FRL_FAST_ORDER).length ? listEnv(env.FRL_FAST_ORDER) : both.length ? both : ROUTE_ORDER.fast,
    deep: listEnv(env.FRL_DEEP_ORDER).length ? listEnv(env.FRL_DEEP_ORDER) : both.length ? both : ROUTE_ORDER.deep,
  };
}

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
    const only = listEnv(this.env.FRL_PROVIDER_ORDER);
    const ids = only.length ? only : PROVIDER_PRESETS.map((p) => p.id);
    return ids.map((id) => PROVIDER_PRESETS.find((p) => p.id === id)).filter(Boolean);
  }

  build(preset) {
    const apiKey = this.sessionKeys.get(preset.id) || (preset.keyEnv ? this.env[preset.keyEnv] : '') || (preset.optionalKeyEnv ? this.env[preset.optionalKeyEnv] : '') || '';
    const account = this.sessionKeys.get(`${preset.id}:account`) || (preset.accountEnv ? this.env[preset.accountEnv] : '') || '';
    const template = (preset.baseEnv && this.env[preset.baseEnv]) || this.sessionKeys.get(`${preset.id}:url`) || preset.baseURL;
    const baseURL = account ? template.replace('{account}', encodeURIComponent(account)) : template;
    const disabled = Boolean(preset.disableEnv) && this.env[preset.disableEnv] === '0';
    return new OpenAICompatibleProvider({ preset, apiKey, baseURL, disabled, modelOverrides: modelOverrides(this.env, preset), fetchImpl: this.fetchImpl });
  }

  async buildAll() {
    const providers = this.order().map((preset) => this.build(preset));
    await Promise.all(providers.map((p) => p.discover()));
    return providers;
  }

  setSessionKey(providerId, key, baseURL) {
    if (key) this.sessionKeys.set(providerId, key);
    if (!baseURL) return;
    if (/^https?:\/\//.test(baseURL)) this.sessionKeys.set(`${providerId}:url`, baseURL);
    else this.sessionKeys.set(`${providerId}:account`, baseURL);
  }
}

const KEYED_SEARCH_BACKENDS = [
  ['LANGSEARCH_API_KEY', LangSearchBackend],
  ['TAVILY_API_KEY', TavilyBackend],
  ['EXA_API_KEY', ExaBackend],
  ['LINKUP_API_KEY', LinkupBackend],
  ['JINA_API_KEY', JinaSearchBackend],
  ['FIRECRAWL_API_KEY', FirecrawlBackend],
  ['SERPER_API_KEY', SerperBackend],
  ['BRAVE_API_KEY', BraveBackend],
];

export function buildSearch({ env, fetchImpl }) {
  const backends = KEYED_SEARCH_BACKENDS.filter(([name]) => env[name]).map(([name, Backend]) => new Backend({ apiKey: env[name], fetchImpl }));
  if (env.SEARXNG_URL) backends.push(new SearxngBackend({ baseURL: env.SEARXNG_URL, fetchImpl }));
  if (env.FRL_WIKIPEDIA !== '0') backends.push(new WikipediaBackend({ fetchImpl, lang: env.FRL_WIKIPEDIA_LANG || 'en' }));
  return new SearchService({ backends, fetchImpl, fetchPages: env.FRL_FETCH_PAGES !== '0', jinaReader: env.FRL_JINA_READER !== '0', jinaKey: env.JINA_API_KEY || '' });
}

export class App {
  constructor({ env = process.env, fetchImpl = fetch, dataDir, providers, search } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.sessionSearchEnv = {};
    this.demo = env.FRL_DEMO === '1';
    this.factory = new ProviderFactory({ env, fetchImpl });
    this.router = new ModelRouter({ providers: providers ?? [], routeOrder: routeOrderFrom(env), paidCallLimit: Number(env.FRL_PAID_CALL_LIMIT ?? 0) || 0 });
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
    if (SEARCH_KEYS.some((k) => k.env === providerId)) {
      this.sessionSearchEnv[providerId] = String(key ?? '').trim();
      this.search = buildSearch({ env: { ...this.env, ...this.sessionSearchEnv }, fetchImpl: this.fetchImpl });
      this.engine.search = this.search;
      return this.router.status();
    }
    this.factory.setSessionKey(providerId, String(key ?? '').trim(), String(baseURL ?? '').trim());
    return this.refreshProviders();
  }

  status() {
    return {
      ready: this.router.ready,
      demo: this.engine.demo,
      providers: this.router.status(),
      route: this.router.route(),
      searchKeys: SEARCH_KEYS.map((k) => ({ ...k, set: Boolean(this.env[k.env] || this.sessionSearchEnv[k.env]) })),
      search: this.search.describe(),
      ledger: this.router.ledger.slice(-40),
      calls: this.router.calls,
      paid: { calls: this.router.paidCalls, limit: this.router.paidCallLimit },
    };
  }
}
