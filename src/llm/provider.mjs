import { NON_CHAT_MODEL } from './presets.mjs';

const MAX_TOKEN_BUDGET = 16000;

export class ProviderError extends Error {
  constructor(message, { status = 0, retryAfterMs = 0, provider = '' } = {}) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.provider = provider;
    this.quotaLimited = status === 402 && /limit|retry after|quota/i.test(message);
  }

  get retryable() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500 || this.quotaLimited;
  }
}

export function pickModel(models, preferences, freeOnly = false, { strict = false } = {}) {
  const usable = models.filter((m) => !NON_CHAT_MODEL.test(m) && (!freeOnly || m.endsWith(':free')));
  for (const wanted of preferences) {
    const exact = usable.find((m) => m === wanted);
    if (exact) return exact;
    const partial = usable.find((m) => m.includes(wanted));
    if (partial) return partial;
  }
  return strict ? null : (usable[0] ?? null);
}

export function quotaWindow(body) {
  const text = String(body);
  if (/PerDay|per day|daily/i.test(text)) return ' [quota window: per day]';
  if (/PerMinute|per minute/i.test(text)) return ' [quota window: per minute]';
  const delay = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return delay ? ` [retry after ${Math.ceil(Number(delay[1]))}s]` : '';
}

export function retryAfterFromText(body, floorMs = 0) {
  const seconds = String(body).match(/retry after (\d+(?:\.\d+)?)\s*s/i) ?? String(body).match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  const window = String(body).match(/every (\d+) seconds/i);
  const ms = Math.max(seconds ? Number(seconds[1]) * 1000 : 0, window ? Number(window[1]) * 1000 : 0, /limit/i.test(body) ? floorMs : 0);
  return ms;
}

function retryAfter(res) {
  const header = Number(res.headers.get('retry-after'));
  return Number.isFinite(header) && header > 0 ? header * 1000 : 0;
}

export class OpenAICompatibleProvider {
  constructor({ preset, apiKey = '', baseURL, modelOverrides = {}, fetchImpl = fetch, timeoutMs = 120000, disabled = false }) {
    this.disabled = disabled;
    this.id = preset.id;
    this.label = preset.label;
    this.preset = preset;
    this.apiKey = apiKey;
    this.baseURL = String(baseURL || preset.baseURL || '').replace(/\/$/, '');
    this.modelOverrides = modelOverrides;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.models = [];
    this.selected = { fast: modelOverrides.fast ?? null, deep: modelOverrides.deep ?? null, vision: null };
    this.state = 'unknown';
    this.detail = '';
    this.minIntervalMs = preset.minIntervalMs ?? 0;
    this.nextSlot = 0;
  }

  async throttle() {
    if (!this.minIntervalMs) return;
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  get configured() {
    return Boolean(this.baseURL) && !this.baseURL.includes('{account}') && (this.preset.keyEnv === null || Boolean(this.apiKey));
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
        throw new ProviderError(`${this.id} HTTP ${res.status}: ${body.slice(0, 240)}${quotaWindow(body)}`, { status: res.status, retryAfterMs: retryAfter(res) || retryAfterFromText(body, this.minIntervalMs), provider: this.id });
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
    if (this.disabled) {
      this.state = 'not-configured';
      this.detail = `disabled by ${this.preset.disableEnv}=0`;
      return this;
    }
    if (!this.configured) {
      this.state = 'not-configured';
      const missing = [this.preset.keyEnv && !this.apiKey ? this.preset.keyEnv : '', this.baseURL.includes('{account}') ? this.preset.accountEnv : ''].filter(Boolean);
      this.detail = missing.length ? `set ${missing.join(' and ')}` : 'no base URL';
      return this;
    }
    try {
      const body = await this.request('/models', { method: 'GET', timeoutMs: 8000 });
      this.models = (body.data ?? body.models ?? []).map((m) => String(m.id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean);
      const envModel = this.modelOverrides.any;
      this.selected.fast = this.modelOverrides.fast ?? envModel ?? pickModel(this.models, this.preset.prefer.fast, this.preset.freeOnly);
      this.selected.deep = this.modelOverrides.deep ?? envModel ?? pickModel(this.models, this.preset.prefer.deep, this.preset.freeOnly) ?? this.selected.fast;
      this.selected.fast ??= this.selected.deep;
      this.selected.vision = this.preset.prefer.vision ? pickModel(this.models, this.preset.prefer.vision, this.preset.freeOnly, { strict: true }) : null;
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
      } else if (this.preset.local && error.status === 0) {
        this.state = 'not-configured';
        this.detail = 'not running (optional: install from ollama.com)';
      } else {
        this.state = 'error';
        this.detail = error.message;
      }
    }
    return this;
  }

  canServe(tier) {
    return this.ready && (tier !== 'vision' || Boolean(this.selected.vision));
  }

  async chat({ messages, tier = 'fast', json = true, temperature = 0.2, maxTokens = 4000 }) {
    const model = this.selected[tier] ?? this.selected.fast;
    const cap = this.preset.maxOutputTokens ?? MAX_TOKEN_BUDGET;
    let budget = Math.min(maxTokens, cap);
    let jsonMode = json;
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.throttle();
      const payload = { model, messages, temperature, max_tokens: budget, ...(this.preset.extraBody ?? {}), ...(jsonMode ? { response_format: { type: 'json_object' } } : {}) };
      let body;
      try {
        body = await this.request('/chat/completions', { method: 'POST', body: JSON.stringify(payload) });
      } catch (error) {
        if (jsonMode && error.status === 400) {
          jsonMode = false;
          continue;
        }
        throw error;
      }
      const choice = body.choices?.[0];
      const content = choice?.message?.content ?? '';
      const truncated = choice?.finish_reason === 'length';
      if (truncated && budget < cap) {
        budget = Math.min(budget * 2, cap);
        continue;
      }
      if (!content) throw new ProviderError(`${this.id} returned an empty reply${truncated ? ' (token limit reached)' : ''}`, { status: 502, provider: this.id });
      return { content, model, provider: this.id, usage: body.usage ?? {}, truncated };
    }
    throw new ProviderError(`${this.id} gave no usable reply after retries`, { status: 502, provider: this.id });
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
      vision: this.selected.vision,
      local: Boolean(this.preset.local),
      keyEnv: this.preset.keyEnv,
      accountEnv: this.preset.accountEnv ?? null,
      signup: this.preset.signup,
      modelCount: this.models.length,
    };
  }
}
