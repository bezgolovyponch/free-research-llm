import { PROVIDER_PRESETS } from './llm/presets.mjs';
import { KEYED_SEARCH_BACKENDS } from './search/search.mjs';

export const KEY_PREFIXES = {
  GEMINI_API_KEY: 'AIza',
  GROQ_API_KEY: 'gsk_',
  OPENROUTER_API_KEY: 'sk-or-',
  CEREBRAS_API_KEY: 'csk-',
  NVIDIA_API_KEY: 'nvapi-',
  TAVILY_API_KEY: 'tvly-',
  LANGSEARCH_API_KEY: 'sk-',
  JINA_API_KEY: 'jina_',
  FIRECRAWL_API_KEY: 'fc-',
};

export function cleanKey(raw) {
  return String(raw ?? '')
    .replace(/\u001b\[20[01]~/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

export function formatHint(name, value) {
  const prefix = KEY_PREFIXES[name];
  if (!prefix || !value || value.startsWith(prefix)) return null;
  for (let cut = 1; cut < prefix.length; cut++) {
    if (value.startsWith(prefix.slice(cut))) {
      return { problem: 'cut', fixed: prefix.slice(0, cut) + value, message: `starts with "${value.slice(0, 4)}…" but ${name} keys start with "${prefix}": the first ${cut} character(s) were lost when pasting` };
    }
  }
  return { problem: 'prefix', message: `${name} keys usually start with "${prefix}"` };
}

async function statusOf(fetchImpl, url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = await res.text();
    return { ok: res.ok, detail: res.ok ? `HTTP ${res.status}` : `HTTP ${res.status}: ${body.replace(/\s+/g, ' ').slice(0, 120)}` };
  } catch (error) {
    return { ok: false, detail: error.name === 'AbortError' ? 'timed out' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

export class KeyChecker {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetchImpl = fetchImpl;
  }

  async check(name, value) {
    if (!value) return { ok: false, detail: 'empty' };
    const preset = PROVIDER_PRESETS.find((p) => p.keyEnv === name && p.baseURL && !p.baseURL.includes('{'));
    if (preset) return statusOf(this.fetchImpl, `${preset.baseURL}/models`, { headers: { authorization: `Bearer ${value}` } });
    const backend = KEYED_SEARCH_BACKENDS.find(([env]) => env === name);
    if (backend) {
      try {
        const results = await new backend[1]({ apiKey: value, fetchImpl: this.fetchImpl }).search('weather forecast', 1);
        return { ok: true, detail: `search works (${results.length} result)` };
      } catch (error) {
        return { ok: false, detail: error.message };
      }
    }
    if (name === 'SEARXNG_URL') return statusOf(this.fetchImpl, `${value.replace(/\/$/, '')}/search?q=test&format=json`, {});
    return { ok: null, detail: 'no automatic check for this key' };
  }

  async verify(name, raw) {
    const value = cleanKey(raw);
    const hint = formatHint(name, value);
    const result = await this.check(name, value);
    if (result.ok === false && hint?.problem === 'cut') {
      const repaired = await this.check(name, hint.fixed);
      if (repaired.ok) return { ...repaired, value: hint.fixed, repaired: hint.message };
    }
    return { ...result, value, hint: result.ok ? null : hint?.message ?? null };
  }
}
