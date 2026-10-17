import { extractJson } from '../research/json.mjs';
import { ProviderError } from './provider.mjs';

export class NoModelAvailableError extends Error {}

const DEFAULT_COOLDOWN_MS = 60000;
const REPAIR_INSTRUCTION = 'Your previous reply was not valid JSON. Reply again with ONLY the JSON object, no prose, no code fences.';

export class ModelRouter {
  constructor({ providers = [], paidCallLimit = 0, cooldownMs = DEFAULT_COOLDOWN_MS, maxWaitMs = 65000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onLedger = () => {} }) {
    this.providers = providers;
    this.paidCallLimit = paidCallLimit;
    this.paidCalls = 0;
    this.cooldownMs = cooldownMs;
    this.maxWaitMs = maxWaitMs;
    this.now = now;
    this.sleep = sleep;
    this.onLedger = onLedger;
    this.cooldownUntil = new Map();
    this.ledger = [];
    this.calls = 0;
  }

  get ready() {
    return this.providers.some((p) => p.ready);
  }

  setProviders(providers) {
    this.providers = providers;
  }

  available({ avoid } = {}) {
    const time = this.now();
    const usable = this.providers.filter((p) => p.ready && (this.cooldownUntil.get(p.id) ?? 0) <= time && !this.overPaidBudget(p));
    if (!avoid) return usable;
    const preferred = usable.filter((p) => p.id !== avoid);
    return preferred.length ? [...preferred, ...usable.filter((p) => p.id === avoid)] : usable;
  }

  record(entry) {
    const row = { ts: new Date(this.now()).toISOString(), ...entry };
    this.ledger.push(row);
    if (this.ledger.length > 500) this.ledger.shift();
    this.onLedger(row);
  }

  overPaidBudget(provider) {
    return Boolean(provider.preset?.paid) && this.paidCalls >= this.paidCallLimit;
  }

  coolDown(provider, error) {
    const wait = error.retryAfterMs || this.cooldownMs;
    this.cooldownUntil.set(provider.id, this.now() + wait);
  }

  shortestCooldownMs() {
    const time = this.now();
    const waits = this.providers.filter((p) => p.ready && !this.overPaidBudget(p)).map((p) => (this.cooldownUntil.get(p.id) ?? 0) - time);
    return waits.length ? Math.max(0, Math.min(...waits)) : Infinity;
  }

  async complete({ messages, tier = 'fast', json = true, purpose = 'chat', avoid, temperature }) {
    let candidates = this.available({ avoid });
    const wait = candidates.length ? 0 : this.shortestCooldownMs();
    if (!candidates.length && wait <= this.maxWaitMs) {
      this.record({ purpose, tier, provider: 'router', ok: false, ms: wait, error: `all providers rate-limited, waiting ${Math.ceil(wait / 1000)}s` });
      await this.sleep(wait);
      candidates = this.available({ avoid });
    }
    if (!candidates.length) {
      throw new NoModelAvailableError(this.ready ? 'all free model quotas are cooling down after rate limits (and the paid-call budget is used up or unset); retry in a minute' : 'no model provider is configured — open Setup');
    }
    const errors = [];
    for (const provider of candidates) {
      let attemptMessages = messages;
      for (let repair = 0; repair < 2; repair++) {
        const started = this.now();
        try {
          const reply = await provider.chat({ messages: attemptMessages, tier, json, temperature });
          this.calls++;
          if (provider.preset?.paid) this.paidCalls++;
          const data = json ? extractJson(reply.content) : null;
          this.record({ purpose, tier, provider: provider.id, model: reply.model, ok: true, ms: this.now() - started, tokens: reply.usage?.total_tokens ?? null });
          return { ...reply, data };
        } catch (error) {
          const isProvider = error instanceof ProviderError;
          this.record({ purpose, tier, provider: provider.id, ok: false, ms: this.now() - started, error: error.message.slice(0, 200) });
          errors.push(error.message);
          if (isProvider) {
            if (error.retryable) this.coolDown(provider, error);
            break;
          }
          attemptMessages = [...messages, { role: 'user', content: REPAIR_INSTRUCTION }];
        }
      }
    }
    throw new NoModelAvailableError(`every provider failed for ${purpose}: ${errors.join(' || ').slice(0, 600)}`);
  }

  status() {
    const time = this.now();
    return this.providers.map((p) => ({
      ...p.describe(),
      coolingDownMs: Math.max(0, (this.cooldownUntil.get(p.id) ?? 0) - time),
      budgetExhausted: this.overPaidBudget(p),
    }));
  }
}
