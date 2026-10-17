import { NON_CHAT_MODEL } from './presets.mjs';

export class ProviderError extends Error {
  constructor(message, { status = 0, retryAfterMs = 0, provider = '' } = {}) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.provider = provider;
  }

  get retryable() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export function pickModel(models, preferences, freeOnly = false) {
  const usable = models.filter((m) => !NON_CHAT_MODEL.test(m) && (!freeOnly || m.endsWith(':free')));
  for (const wanted of preferences) {
    const exact = usable.find((m) => m === wanted);
    if (exact) return exact;
    const partial = usable.find((m) => m.includes(wanted));
    if (partial) return partial;
  }
  return usable[0] ?? null;
}

function retryAfter(res) {
  const header = Number(res.headers.get('retry-after'));
  return Number.isFinite(header) && header > 0 ? header * 1000 : 0;
}

export class OpenAICompatibleProvider {
  constructor({ preset, apiKey = '', baseURL, modelOverrides = {}, fetchImpl = fetch, timeoutMs = 120000 }) {
    this.id = preset.id;
    this.label = preset.label;
    this.preset = preset;
    this.apiKey = apiKey;
    this.baseURL = String(baseURL || preset.baseURL || '').replace(/\/$/, '');
    this.modelOverrides = modelOverrides;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.models = [];
    this.selected = { fast: modelOverrides.fast ?? null, deep: modelOverrides.deep ?? null };
    this.state = 'unknown';
    this.detail = '';
  }

  get configured() {
    return Boolean(this.baseURL) && (this.preset.keyEnv === null || Boolean(this.apiKey));
  }

  get ready() {
    return this.state === 'ready' && Boolean(this.selected.fast || this.selected.deep);
  }

  headers() {
    return {
      'content-type': 'application/json',
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...(this.id === 'openrouter' ? { 'http-referer': 'https://github.com/bezgolovyponch/free-research-llm', 'x-title': 'free-research-llm' } : {}),
    };
  }

  async request(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseURL}${path}`, { ...init, headers: this.headers(), signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ProviderError(`${this.id} HTTP ${res.status}: ${body.slice(0, 240)}`, { status: res.status, retryAfterMs: retryAfter(res), provider: this.id });
      }
      return await res.json();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const reason = error.name === 'AbortError' ? 'timed out' : error.message;
      throw new ProviderError(`${this.id} unreachable: ${reason}`, { status: 0, provider: this.id });
    } finally {
      clearTimeout(timer);
    }
  }

  async discover() {
    if (!this.configured) {
      this.state = 'not-configured';
      this.detail = this.preset.keyEnv ? `set ${this.preset.keyEnv}` : 'no base URL';
      return this;
    }
    try {
      const body = await this.request('/models', { method: 'GET', timeoutMs: 8000 });
      this.models = (body.data ?? body.models ?? []).map((m) => String(m.id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean);
      const envModel = this.modelOverrides.any;
      this.selected.fast = this.modelOverrides.fast ?? envModel ?? pickModel(this.models, this.preset.prefer.fast, this.preset.freeOnly);
      this.selected.deep = this.modelOverrides.deep ?? envModel ?? pickModel(this.models, this.preset.prefer.deep, this.preset.freeOnly) ?? this.selected.fast;
      this.selected.fast ??= this.selected.deep;
      this.state = this.selected.fast ? 'ready' : 'no-models';
      this.detail = this.selected.fast ? `fast=${this.selected.fast} deep=${this.selected.deep}` : 'no chat model available';
    } catch (error) {
      const fallback = this.preset.fallbackModels;
      const authFailed = error.status === 401 || error.status === 403;
      if (!authFailed && (this.modelOverrides.any || this.modelOverrides.fast || fallback)) {
        this.selected.fast ??= this.modelOverrides.fast ?? this.modelOverrides.any ?? fallback.fast;
        this.selected.deep ??= this.modelOverrides.deep ?? this.modelOverrides.any ?? fallback?.deep ?? this.selected.fast;
        this.state = 'ready';
        this.detail = `model list unavailable, using configured model (${error.message})`;
      } else {
        this.state = 'error';
        this.detail = error.message;
      }
    }
    return this;
  }

  async chat({ messages, tier = 'fast', json = true, temperature = 0.2, maxTokens = 2500 }) {
    const model = this.selected[tier] ?? this.selected.fast;
    const payload = { model, messages, temperature, max_tokens: maxTokens };
    const send = async (withJsonMode) => this.request('/chat/completions', {
      method: 'POST',
      body: JSON.stringify(withJsonMode ? { ...payload, response_format: { type: 'json_object' } } : payload),
    });
    let body;
    try {
      body = await send(json);
    } catch (error) {
      if (!(json && error.status === 400)) throw error;
      body = await send(false);
    }
    const choice = body.choices?.[0];
    const content = choice?.message?.content ?? '';
    if (!content) throw new ProviderError(`${this.id} returned an empty reply`, { status: 502, provider: this.id });
    return { content, model, provider: this.id, usage: body.usage ?? {} };
  }

  describe() {
    return {
      id: this.id,
      label: this.label,
      state: this.state,
      detail: this.detail,
      configured: this.configured,
      fast: this.selected.fast,
      deep: this.selected.deep,
      local: Boolean(this.preset.local),
      paid: Boolean(this.preset.paid),
      keyEnv: this.preset.keyEnv,
      signup: this.preset.signup,
      modelCount: this.models.length,
    };
  }
}
