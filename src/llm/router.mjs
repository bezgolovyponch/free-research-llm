import { extractJson } from '../research/json.mjs';
import { ProviderError } from './provider.mjs';

export class NoModelAvailableError extends Error {}

const DEFAULT_COOLDOWN_MS = 60000;
const MAX_WAIT_ROUNDS = 3;
const REPAIR_INSTRUCTION = 'Your previous reply was not valid JSON. Reply again with ONLY the JSON object, no prose, no code fences.';

export class ModelRouter {
  constructor({ providers = [], routeOrder = null, paidCallLimit = 0, cooldownMs = DEFAULT_COOLDOWN_MS, maxWaitMs = 65000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onLedger = () => {} }) {
    this.providers = providers;
    this.routeOrder = routeOrder;
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

  ordered(tier) {
    const order = this.routeOrder?.[tier];
    if (!order) return this.providers;
    const rank = (p) => {
      const i = order.indexOf(p.id);
      return i < 0 ? order.length : i;
    };
    return [...this.providers].sort((a, b) => rank(a) - rank(b));
  }

  available({ avoid, tier = 'fast' } = {}) {
    const time = this.now();
    const usable = this.ordered(tier).filter((p) => p.ready && (this.cooldownUntil.get(p.id) ?? 0) <= time && !this.overPaidBudget(p));
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

  async waitForCooldown({ avoid, tier, purpose }) {
    const wait = this.shortestCooldownMs();
    if (wait > this.maxWaitMs) return [];
    this.record({ purpose, tier, provider: 'router', ok: false, ms: wait, error: `all providers rate-limited, waiting ${Math.ceil(wait / 1000)}s` });
    await this.sleep(wait);
    return this.available({ avoid, tier });
  }

  async tryProviders(candidates, { messages, tier, json, purpose, temperature }, errors) {
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
          this.record({ purpose, tier, provider: provider.id, ok: false, ms: this.now() - started, error: error.message.slice(0, 200) });
          errors.push(error.message);
          if (error instanceof ProviderError) {
            if (error.retryable) this.coolDown(provider, error);
            break;
          }
          attemptMessages = [...messages, { role: 'user', content: REPAIR_INSTRUCTION }];
        }
      }
    }
    return null;
  }

  async complete({ messages, tier = 'fast', json = true, purpose = 'chat', avoid, temperature }) {
    const request = { messages, tier, json, purpose, temperature };
    const errors = [];
    let candidates = this.available({ avoid, tier });
    for (let round = 0; round < MAX_WAIT_ROUNDS; round++) {
      if (!candidates.length) candidates = await this.waitForCooldown({ avoid, tier, purpose });
      if (!candidates.length) break;
      const reply = await this.tryProviders(candidates, request, errors);
      if (reply) return reply;
      if (this.shortestCooldownMs() === 0) break;
      candidates = [];
    }
    if (!errors.length) {
      throw new NoModelAvailableError(this.ready ? 'all free model quotas are cooling down after rate limits (and the paid-call budget is used up or unset); retry in a minute' : 'no model provider is configured — open Setup');
    }
    throw new NoModelAvailableError(`every provider failed for ${purpose}: ${errors.join(' || ').slice(0, 600)}`);
  }

  route() {
    const ids = (tier) => this.ordered(tier).filter((p) => p.ready && !this.overPaidBudget(p)).map((p) => p.id);
    return { fast: ids('fast'), deep: ids('deep') };
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
