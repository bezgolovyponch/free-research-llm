import { extractJson } from '../research/json.mjs';
import { ProviderError } from './provider.mjs';
import { MAX_PROMPT_TOKENS, familyOf } from './ranking.mjs';

export class NoModelAvailableError extends Error {}

const DEFAULT_COOLDOWN_MS = 60000;
export const SLOW_FACTOR = 4;
export const SLOW_FLOOR_MS = 20000;
const MIN_TIMED_CALLS = 3;
export const TIMEOUTS_BEFORE_BENCH = 2;
export const TIMEOUT_BENCH_MS = 10 * 60 * 1000;
const TIMED_OUT = /unreachable: timed out/;
const BAD_KEY_MS = 6 * 3600 * 1000;
const SHORT_LIMIT = /^(?![\s\S]*quota window: per day)[\s\S]*(?:retry after \d+\s*(?:s|sec|seconds)\b|every \d+ seconds|per (?:second|minute)|requests per minute|tokens per minute)/i;
const DAILY = /per day|daily|\bRPD\b|\bTPD\b|tokens per day|requests per day|quota exceeded|exceeded your current quota|balance|credit|insufficient|billing/i;

export function nextUtcMidnight(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 60000;
}

export function estimateTokens(messages) {
  return Math.ceil((messages ?? []).reduce((n, m) => n + String(m.content ?? '').length, 0) / 3.5);
}
const MAX_WAIT_ROUNDS = 3;
const REPAIR_INSTRUCTION = 'Your previous reply was not valid JSON. Reply again with ONLY the JSON object, no prose, no code fences.';

export class ModelRouter {
  constructor({ providers = [], routeOrder = null, cooldownMs = DEFAULT_COOLDOWN_MS, maxWaitMs = 65000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onLedger = () => {} }) {
    this.providers = providers;
    this.routeOrder = routeOrder;
    this.cooldownMs = cooldownMs;
    this.maxWaitMs = maxWaitMs;
    this.now = now;
    this.sleep = sleep;
    this.onLedger = onLedger;
    this.cooldownUntil = new Map();
    this.inflight = new Map();
    this.timeoutStreak = new Map();
    this.cooldownReason = new Map();
    this.ledger = [];
    this.calls = 0;
  }

  get ready() {
    return this.providers.some((p) => p.ready);
  }

  setProviders(providers) {
    this.providers = providers;
  }

  ordered(tier, purpose) {
    const plan = this.routeOrder?.byPurpose;
    const order = (purpose && plan && (plan[`${purpose}:${tier}`] ?? plan[purpose])) || this.routeOrder?.[tier];
    if (!order) return this.providers;
    const rank = (p) => {
      const i = order.indexOf(p.id);
      return i < 0 ? order.length : i;
    };
    return [...this.providers].sort((a, b) => rank(a) - rank(b));
  }

  available({ avoid, tier = 'fast', purpose, tokens = 0 } = {}) {
    const time = this.now();
    const open = this.ordered(tier, purpose).filter((p) => (p.canServe ? p.canServe(tier) : p.ready) && (this.cooldownUntil.get(p.id) ?? 0) <= time);
    const roomy = open.filter((p) => !p.maxPromptTokens || tokens <= p.maxPromptTokens);
    const fits = roomy.filter((p) => !MAX_PROMPT_TOKENS[p.id] || tokens <= MAX_PROMPT_TOKENS[p.id]);
    const sized = fits.length ? [...fits, ...roomy.filter((p) => !fits.includes(p))] : roomy;
    const usable = this.demoteSlow(this.demoteFull(sized), tier);
    if (!avoid) return usable;
    const author = this.providers.find((p) => p.id === avoid);
    const family = (p) => familyOf(p.describe?.()?.[tier] ?? p.selected?.[tier], p.id);
    const authorFamily = author ? family(author) : null;
    const other = usable.filter((p) => p.id !== avoid && family(p) !== authorFamily);
    const sameFamily = usable.filter((p) => p.id !== avoid && family(p) === authorFamily);
    const preferred = [...this.demoteSlow(other, tier), ...this.demoteSlow(sameFamily, tier)];
    return preferred.length ? [...preferred, ...usable.filter((p) => p.id === avoid)] : usable;
  }

  benchSlow(provider, error) {
    if (!TIMED_OUT.test(error.message)) {
      this.timeoutStreak.delete(provider.id);
      return false;
    }
    const streak = (this.timeoutStreak.get(provider.id) ?? 0) + 1;
    this.timeoutStreak.set(provider.id, streak);
    if (streak < TIMEOUTS_BEFORE_BENCH) return false;
    this.cooldownUntil.set(provider.id, this.now() + TIMEOUT_BENCH_MS);
    this.cooldownReason.set(provider.id, `too slow: ${streak} timeouts in a row; tried again in 10 min`);
    this.timeoutStreak.set(provider.id, 0);
    return true;
  }

  demoteFull(providers) {
    const full = (p) => p.maxConcurrent > 0 && (this.inflight.get(p.id) ?? 0) >= p.maxConcurrent;
    return [...providers.filter((p) => !full(p)), ...providers.filter(full)];
  }

  medianMs(providerId, tier) {
    const times = this.ledger.filter((r) => (r.ok || TIMED_OUT.test(r.error ?? '')) && r.provider === providerId && (!tier || r.tier === tier) && r.ms > 0).slice(-20).map((r) => r.ms).sort((a, b) => a - b);
    return times.length >= MIN_TIMED_CALLS ? times[Math.floor(times.length / 2)] : null;
  }

  demoteSlow(providers, tier) {
    const timed = providers.map((p) => [p, this.medianMs(p.id, tier)]);
    const known = timed.map(([, ms]) => ms).filter((ms) => ms !== null);
    if (!known.length) return providers;
    const fastest = Math.min(...known);
    const slow = (ms) => ms !== null && ms >= SLOW_FLOOR_MS && ms >= fastest * SLOW_FACTOR;
    return [...timed.filter(([, ms]) => !slow(ms)), ...timed.filter(([, ms]) => slow(ms))].map(([p]) => p);
  }

  record(entry) {
    const row = { ts: new Date(this.now()).toISOString(), ...entry };
    this.ledger.push(row);
    if (this.ledger.length > 500) this.ledger.shift();
    this.onLedger(row);
  }

  switchModel(provider, model, error) {
    if (!provider.retireModel || !model) return false;
    const gone = error.status === 404 && /no longer available|not found|does not exist|unknown model/i.test(error.message);
    const usedUp = /quota window: per day, per model/.test(error.message);
    if (!gone && !usedUp) return false;
    const switched = provider.retireModel(model, gone ? Infinity : nextUtcMidnight(this.now()));
    if (switched) this.record({ purpose: 'router', tier: '', provider: provider.id, model, ok: false, ms: 0, error: `${model} ${gone ? 'is no longer available' : 'used its daily quota'}; switched to ${provider.selected.fast} / ${provider.selected.deep}` });
    return switched;
  }

  restoreCooldowns(rows) {
    const latest = new Map();
    for (const row of rows) if (row?.provider) latest.set(row.provider, row);
    const restored = [];
    for (const [id, row] of latest) {
      if (row.ok || !this.providers.some((p) => p.id === id)) continue;
      const status = Number(/HTTP (\d{3})/.exec(String(row.error ?? ''))?.[1] ?? 0);
      const at = Date.parse(row.ts);
      const badKey = (status === 401 || status === 403) && this.now() - at < BAD_KEY_MS;
      const text = String(row.error ?? '');
      const noCredit = !SHORT_LIMIT.test(text) && (status === 402 || /balance_units|billing_portal|insufficient (?:credit|funds|balance)|out of credits?/i.test(text)) && !/exceeded your current quota|per day/i.test(text);
      const daily = noCredit && nextUtcMidnight(at) > this.now();
      if (!badKey && !daily) continue;
      this.coolDown({ id }, { status, message: String(row.error ?? '') });
      restored.push(id);
    }
    return restored;
  }

  coolDown(provider, error) {
    const now = this.now();
    let until = now + (error.retryAfterMs || this.cooldownMs);
    let reason = 'rate limit';
    if (error.status === 401 || error.status === 403) {
      until = now + BAD_KEY_MS;
      reason = 'key rejected; check it on Models & router';
    } else if (!SHORT_LIMIT.test(error.message) && (error.status === 402 || DAILY.test(error.message))) {
      until = Math.max(until, nextUtcMidnight(now));
      reason = 'daily quota or credit used up; waits for the daily reset';
    }
    this.cooldownUntil.set(provider.id, until);
    this.cooldownReason.set(provider.id, reason);
  }

  shortestCooldownMs() {
    const time = this.now();
    const waits = this.providers.filter((p) => p.ready).map((p) => (this.cooldownUntil.get(p.id) ?? 0) - time);
    return waits.length ? Math.max(0, Math.min(...waits)) : Infinity;
  }

  async waitForCooldown({ avoid, tier, purpose, tokens }) {
    const wait = this.shortestCooldownMs();
    if (wait > this.maxWaitMs) return [];
    this.record({ purpose, tier, provider: 'router', ok: false, ms: wait, error: `all providers rate-limited, waiting ${Math.ceil(wait / 1000)}s` });
    await this.sleep(wait);
    return this.available({ avoid, tier, purpose, tokens });
  }

  async tryProviders(candidates, { messages, tier, json, purpose, temperature }, errors) {
    for (const provider of candidates) {
      let attemptMessages = messages;
      for (let repair = 0; repair < 2; repair++) {
        const started = this.now();
        const model = provider.selected?.[tier] ?? provider.selected?.fast;
        this.inflight.set(provider.id, (this.inflight.get(provider.id) ?? 0) + 1);
        try {
          const reply = await provider.chat({ messages: attemptMessages, tier, json, temperature });
          this.calls++;
          const data = json ? extractJson(reply.content) : null;
          this.record({ purpose, tier, provider: provider.id, model: reply.model, ok: true, ms: this.now() - started, tokens: reply.usage?.total_tokens ?? null });
          this.timeoutStreak.delete(provider.id);
          return { ...reply, data };
        } catch (error) {
          this.record({ purpose, tier, provider: provider.id, ok: false, ms: this.now() - started, error: error.message.slice(0, 200) });
          errors.push(error.message);
          if (error instanceof ProviderError) {
            if (this.switchModel(provider, model, error)) break;
            if (this.benchSlow(provider, error)) break;
            if (error.retryable || [401, 402, 403].includes(error.status)) this.coolDown(provider, error);
            break;
          }
          attemptMessages = [...messages, { role: 'user', content: REPAIR_INSTRUCTION }];
        } finally {
          this.inflight.set(provider.id, Math.max(0, (this.inflight.get(provider.id) ?? 1) - 1));
        }
      }
    }
    return null;
  }

  async complete({ messages, tier = 'fast', json = true, purpose = 'chat', avoid, temperature }) {
    const request = { messages, tier, json, purpose, temperature };
    const errors = [];
    const tokens = estimateTokens(messages);
    let candidates = this.available({ avoid, tier, purpose, tokens });
    for (let round = 0; round < MAX_WAIT_ROUNDS; round++) {
      if (!candidates.length) candidates = await this.waitForCooldown({ avoid, tier, purpose, tokens });
      if (!candidates.length) break;
      const reply = await this.tryProviders(candidates, request, errors);
      if (reply) return reply;
      if (this.shortestCooldownMs() === 0) break;
      candidates = [];
    }
    if (!errors.length) {
      throw new NoModelAvailableError(this.ready ? 'all free model quotas are cooling down after rate limits; retry in a minute' : 'no model provider is configured — open Setup');
    }
    throw new NoModelAvailableError(`every provider failed for ${purpose}: ${errors.join(' || ').slice(0, 600)}`);
  }

  route() {
    const ids = (tier) => this.ordered(tier).filter((p) => (p.canServe ? p.canServe(tier) : p.ready)).map((p) => p.id);
    return { fast: ids('fast'), deep: ids('deep'), vision: ids('vision') };
  }

  status() {
    const time = this.now();
    return this.providers.map((p) => ({
      ...p.describe(),
      coolingDownMs: Math.max(0, (this.cooldownUntil.get(p.id) ?? 0) - time),
      coolingReason: (this.cooldownUntil.get(p.id) ?? 0) > time ? this.cooldownReason.get(p.id) ?? 'rate limit' : null,
    }));
  }
}
