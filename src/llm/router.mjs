import { PURPOSE_CLASS } from './ranking.mjs';
import { extractJson } from '../research/json.mjs';
import { ProviderError } from './provider.mjs';
import { MAX_PROMPT_TOKENS, familyOf } from './ranking.mjs';
import { paidDailyTokens, paidProviderIds } from './presets.mjs';

export class NoModelAvailableError extends Error {}
export class OfflineError extends NoModelAvailableError {}

const DEFAULT_COOLDOWN_MS = 60000;
export const OFFLINE_WAIT_MS = 20 * 60 * 1000;
export const OFFLINE_BACKOFF_MS = [15 * 1000, 30 * 1000, 60 * 1000, 60 * 1000];
const NETWORK_ERROR = /unreachable|fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT/i;
export const SLOW_FACTOR = 4;
export const SLOW_FLOOR_MS = 20000;
const MIN_TIMED_CALLS = 3;
export const TIER_TIMEOUT_MS = { fast: 45000, deep: 90000 };
export function tierTimeoutMs(tier) {
  return TIER_TIMEOUT_MS[tier];
}
export const EXPECTED_OUTPUT_TOKENS = { synthesize: 1500, decompose: 1500, research: 800, improve: 500, suggest: 600, critique: 300, support: 150, 'support-second': 150, rollup: 400, 'decision-model': 700 };
export const LOCAL_BUDGET_S = { synthesize: 300, decompose: 300 };
export const LOCAL_DEFAULT_BUDGET_S = 100;
export const TIMEOUTS_BEFORE_BENCH = 2;
export const TIMEOUT_BENCH_MS = 10 * 60 * 1000;
export const COMPUTE_ERROR_COOLDOWN_MS = 10 * 60 * 1000;
const TIMED_OUT = /unreachable: timed out/;
function isNetworkError(message) {
  const text = String(message ?? '');
  return NETWORK_ERROR.test(text) && !TIMED_OUT.test(text);
}
const BAD_KEY_MS = 6 * 3600 * 1000;
export const PAYMENT_REST_MS = 24 * 3600 * 1000;
const PAYMENT_REQUIRED = /payment required|subscription (?:is )?required|requires? a (?:paid|subscription)|upgrade your plan/i;
const CREDIT_EXHAUSTED = /balance_units|billing_portal|insufficient (?:credit|funds|balance)|out of credits?/i;
const SHORT_LIMIT = /^(?![\s\S]*quota window: per day)[\s\S]*(?:retry after \d+\s*(?:s|sec|seconds)\b|every \d+ seconds|per (?:second|minute)|requests per minute|tokens per minute)/i;
const DAILY = /per day|daily|\bRPD\b|\bTPD\b|tokens per day|requests per day|quota exceeded|exceeded your current quota|balance|credit|insufficient|billing/i;
const PER_MODEL_DAY = /quota window: per day, per model/;
const OVERLOADED = /overloaded|high (?:traffic|demand)|currently experiencing|over capacity|no capacity|temporarily unavailable|provider returned error|UNAVAILABLE/i;
export const OVERLOAD_REST_MS = 10 * 60 * 1000;
export const MAX_SWITCHES_PER_CALL = 3;
export const QUEUE_DEMOTE_MS = 5000;
export const FAILURE_STREAK_BENCH = 12;
export const DEAD_AFTER_CALLS = 20;
export const DEAD_WINDOW_MS = 30 * 60 * 1000;
export const STREAK_BENCH_MS = 30 * 60 * 1000;
export const STREAK_BENCH_MAX_MS = 6 * 60 * 60 * 1000;
export const MODEL_GONE_REST_MS = 24 * 3600 * 1000;
export const TRIAL_POLL_MS = 1000;
const MODEL_NOT_FOUND = /no longer available|not found|does not exist|unknown model/i;
const MODEL_RETIRED = /model\b[^\n]{0,120}\b(?:deprecated|decommissioned|retired)\b|\b(?:deprecated|decommissioned|retired)\b[^\n]{0,40}\bmodel\b/i;

export function modelGone(error) {
  const message = String(error?.message ?? '');
  return (error?.status === 404 && MODEL_NOT_FOUND.test(message)) || error?.status === 410 || MODEL_RETIRED.test(message);
}

export function nextUtcMidnight(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 60000;
}

function utcOffsetMs(timeZone, at) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600000 + Number(m[3]) * 60000) : 0;
}

export function nextMidnightIn(timeZone, now) {
  const local = new Date(now + utcOffsetMs(timeZone, now));
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  const guess = midnight - utcOffsetMs(timeZone, now);
  return midnight - utcOffsetMs(timeZone, guess) + 60000;
}

export function quotaResetAt(provider, now) {
  const timeZone = provider?.preset?.quotaResetTimeZone;
  return timeZone ? nextMidnightIn(timeZone, now) : nextUtcMidnight(now);
}

export function overloaded(error) {
  return !PER_MODEL_DAY.test(error.message) && (error.status === 503 || error.status === 529 || (error.status === 429 && OVERLOADED.test(error.message)));
}

export function estimateTokens(messages) {
  return Math.ceil((messages ?? []).reduce((n, m) => n + String(m.content ?? '').length, 0) / 3.5);
}
const MAX_WAIT_ROUNDS = 3;
const REPAIR_INSTRUCTION = 'Your previous reply was not valid JSON. Reply again with ONLY the JSON object, no prose, no code fences.';

export class ModelRouter {
  constructor({ providers = [], routeOrder = null, cooldownMs = DEFAULT_COOLDOWN_MS, maxWaitMs = 65000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onLedger = () => {}, outcomes = null, paid = null, env = process.env, paidCap = null, offlineBackoff = OFFLINE_BACKOFF_MS, offlineWaitMs = OFFLINE_WAIT_MS }) {
    this.outcomes = outcomes;
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
    this.computeErrorStreak = new Map();
    this.failureStreak = new Map();
    this.streakBenches = new Map();
    this.cooldownReason = new Map();
    this.tokenTally = new Map();
    this.ledger = [];
    this.calls = 0;
    this.paidIds = new Set(paid ?? paidProviderIds(env));
    this.paidCap = paidCap ?? paidDailyTokens(env);
    this.offlineBackoff = offlineBackoff;
    this.offlineWaitMs = offlineWaitMs;
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
    this.restPaidProviders(time);
    const open = this.ordered(tier, purpose).filter((p) => (p.canServe ? p.canServe(tier) : p.ready) && (this.cooldownUntil.get(p.id) ?? 0) <= time && !this.trialBusy(p.id, time));
    const roomy = open.filter((p) => !p.maxPromptTokens || tokens <= p.maxPromptTokens);
    const fits = roomy.filter((p) => !MAX_PROMPT_TOKENS[p.id] || tokens <= MAX_PROMPT_TOKENS[p.id]);
    const sized = fits.length ? [...fits, ...roomy.filter((p) => !fits.includes(p))] : roomy;
    const ranked = this.demoteDead(this.demoteOverBudget(this.demoteSlow(this.demoteFull(sized), tier), tokens, purpose));
    const usable = this.demotePaid([...ranked, ...this.lastResortLocals(tier, purpose, tokens, time)]);
    const avoided = new Set((Array.isArray(avoid) ? avoid : [avoid]).filter(Boolean));
    if (!avoided.size) return usable;
    const family = (p) => familyOf(p.describe?.()?.[tier] ?? p.selected?.[tier], p.id);
    const avoidedFamilies = new Set(this.providers.filter((p) => avoided.has(p.id)).map(family));
    const other = usable.filter((p) => !avoided.has(p.id) && !avoidedFamilies.has(family(p)));
    const sameFamily = usable.filter((p) => !avoided.has(p.id) && avoidedFamilies.has(family(p)));
    const preferred = [...this.demoteSlow(other, tier), ...this.demoteSlow(sameFamily, tier)];
    return preferred.length ? this.demotePaid([...preferred, ...usable.filter((p) => avoided.has(p.id))]) : usable;
  }

  isPaid(provider) {
    if (!provider) return false;
    return this.paidIds.has(provider.id) || provider.paid === true || provider.preset?.paid === true;
  }

  demotePaid(providers) {
    const paid = providers.filter((p) => this.isPaid(p));
    if (!paid.length) return providers;
    const free = providers.filter((p) => !this.isPaid(p));
    return free.length ? [...free, ...paid] : providers;
  }

  paidTokensToday(providerId, now = this.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    const tally = this.tokenTally.get(providerId);
    const counted = tally && tally.day === day ? tally.tokens : 0;
    const logged = this.ledger.filter((r) => r.provider === providerId && String(r.ts ?? '').slice(0, 10) === day).reduce((n, r) => n + (Number(r.tokens) || 0), 0);
    return Math.max(counted, logged);
  }

  cappedPaidProviders(now = this.now()) {
    const capped = new Map();
    for (const p of this.providers) {
      if (!this.isPaid(p)) continue;
      const tokens = this.paidTokensToday(p.id, now);
      if (tokens >= this.paidCap) capped.set(p.id, tokens);
    }
    return capped;
  }

  restPaidProviders(now = this.now()) {
    const until = nextUtcMidnight(now);
    const capped = this.cappedPaidProviders(now);
    for (const [id, tokens] of capped) {
      if ((this.cooldownUntil.get(id) ?? 0) >= until) continue;
      this.cooldownUntil.set(id, until);
      this.cooldownReason.set(id, `paid daily cap reached (${tokens} tokens)`);
    }
    return capped;
  }

  lastResortLocals(tier, purpose, tokens, time) {
    if (tier === 'vision') return [];
    return this.ordered(tier, purpose).filter((p) => p.preset?.local && p.state === 'too-slow' && Boolean(p.selected?.fast || p.selected?.deep) && (!p.maxPromptTokens || tokens <= p.maxPromptTokens) && (this.cooldownUntil.get(p.id) ?? 0) <= time && !this.trialBusy(p.id, time));
  }

  halfOpen(providerId, time = this.now()) {
    return this.cooldownUntil.has(providerId) && this.cooldownUntil.get(providerId) <= time;
  }

  trialBusy(providerId, time = this.now()) {
    return this.halfOpen(providerId, time) && (this.inflight.get(providerId) ?? 0) > 0;
  }

  trialPending(time = this.now()) {
    return this.providers.some((p) => p.ready && this.trialBusy(p.id, time));
  }

  closeBreaker(providerId) {
    if (!this.halfOpen(providerId)) return;
    this.cooldownUntil.delete(providerId);
    this.cooldownReason.delete(providerId);
  }

  reopenBreaker(provider, error) {
    const timedOut = TIMED_OUT.test(error.message);
    const until = timedOut ? this.now() + TIMEOUT_BENCH_MS : error.status >= 500 ? this.now() + COMPUTE_ERROR_COOLDOWN_MS : this.cooldownFor(provider, error).until;
    if ((this.cooldownUntil.get(provider.id) ?? 0) >= until) return;
    this.cooldownUntil.set(provider.id, until);
    this.cooldownReason.set(provider.id, `the trial call after a rest failed (${timedOut ? 'timed out' : `HTTP ${error.status}`}); rests ${Math.ceil((until - this.now()) / 60000)} min more`);
  }

  benchGoneModel(provider, model, error) {
    const tiers = ['fast', 'deep'].filter((t) => provider.selected?.[t] === model);
    const vars = (tiers.length ? tiers : ['fast']).map((t) => `FRL_${String(provider.id).toUpperCase()}_${t.toUpperCase()}_MODEL`).join(' / ');
    const reason = `${model ?? 'the model'} is gone (${error.status ? `HTTP ${error.status}` : 'deprecated'}) and cannot be switched; rests 24 h, set ${vars} to a model this provider still serves`;
    this.cooldownUntil.set(provider.id, Math.max(this.cooldownUntil.get(provider.id) ?? 0, this.now() + MODEL_GONE_REST_MS));
    this.cooldownReason.set(provider.id, reason);
    this.record({ purpose: 'router', tier: '', provider: provider.id, ...(model ? { model } : {}), ok: false, ms: 0, error: reason });
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

  demoteOverBudget(providers, tokens, purpose) {
    const out = EXPECTED_OUTPUT_TOKENS[purpose] ?? 500;
    const budget = LOCAL_BUDGET_S[purpose] ?? LOCAL_DEFAULT_BUDGET_S;
    const over = (p) => {
      const seconds = p.estimateSeconds?.(tokens, out);
      return seconds !== null && seconds !== undefined && seconds > budget;
    };
    return [...providers.filter((p) => !over(p)), ...providers.filter(over)];
  }

  demoteFull(providers) {
    const full = (p) => (p.maxConcurrent > 0 && (this.inflight.get(p.id) ?? 0) >= p.maxConcurrent) || (p.queueMs?.() ?? 0) > QUEUE_DEMOTE_MS;
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

  demoteDead(providers) {
    const recent = (id) => this.ledger.filter((r) => r.provider === id && r.purpose !== 'router').slice(-DEAD_AFTER_CALLS);
    const dead = (p) => {
      const rows = recent(p.id);
      const last = Date.parse(rows.at(-1)?.ts ?? '');
      return rows.length >= DEAD_AFTER_CALLS && rows.every((r) => r.ok === false) && !(this.now() - last > DEAD_WINDOW_MS);
    };
    return [...providers.filter((p) => !dead(p)), ...providers.filter(dead)];
  }

  recordOutcome({ provider, purpose, passed, model = null }) {
    const purposeClass = PURPOSE_CLASS[purpose] ?? purpose;
    this.outcomes?.record({ provider, purposeClass, model, passed: Boolean(passed) });
  }

  record(entry) {
    const row = { ts: new Date(this.now()).toISOString(), ...entry };
    if (!row.ok && row.provider && row.provider !== 'router') {
      const provider = this.providers.find((p) => p.id === row.provider);
      if (provider?.keyCount !== undefined) row.keys = provider.keyCount;
      if (!row.model && provider?.selected) row.model = provider.selected[row.tier] ?? provider.selected.fast;
    }
    this.ledger.push(row);
    if (this.ledger.length > 500) this.ledger.shift();
    if (row.provider && row.provider !== 'router') {
      const tokens = Number(row.tokens) || 0;
      if (tokens > 0) {
        const day = String(row.ts).slice(0, 10);
        const tally = this.tokenTally.get(row.provider);
        this.tokenTally.set(row.provider, { day, tokens: (tally && tally.day === day ? tally.tokens : 0) + tokens });
      }
    }
    this.onLedger(row);
  }

  switchModel(provider, model, error) {
    if (!provider.retireModel || !model) return false;
    const gone = modelGone(error);
    const usedUp = PER_MODEL_DAY.test(error.message);
    const busy = !gone && !usedUp && overloaded(error);
    if (!gone && !usedUp && !busy) return false;
    const until = gone ? Infinity : usedUp ? quotaResetAt(provider, this.now()) : this.now() + OVERLOAD_REST_MS;
    const switched = provider.retireModel(model, until);
    const why = gone ? 'is no longer available' : usedUp ? 'used its daily quota' : 'is overloaded; rests 10 min';
    if (switched) this.record({ purpose: 'router', tier: '', provider: provider.id, model, ok: false, ms: 0, error: `${model} ${why}; switched to ${provider.selected.fast} / ${provider.selected.deep}` });
    return switched;
  }

  rotateKey(provider, error) {
    if (!provider.rotateKey || overloaded(error)) return false;
    if (!(error.status === 429 || error.quotaLimited || [401, 402, 403].includes(error.status))) return false;
    const rotated = provider.rotateKey(this.cooldownFor(provider, error).until);
    if (rotated) this.record({ purpose: 'router', tier: '', provider: provider.id, ok: false, ms: 0, error: `key ${provider.keyIndex + 1} of ${provider.keyCount} in use; the previous key rests (${this.cooldownFor(provider, error).reason})` });
    return rotated;
  }

  restoreCooldowns(rows) {
    const latest = new Map();
    const byProvider = new Map();
    for (const row of rows) {
      if (!row?.provider) continue;
      latest.set(row.provider, row);
      if (row.provider === 'router') continue;
      const list = byProvider.get(row.provider) ?? [];
      list.push(row);
      byProvider.set(row.provider, list);
    }
    const restored = [];
    for (const [id, row] of latest) {
      if (row.ok || !this.providers.some((p) => p.id === id)) continue;
      const provider = this.providers.find((p) => p.id === id);
      if (provider?.keyCount !== undefined && row.keys !== undefined && provider.keyCount > row.keys) continue;
      const status = Number(/HTTP (\d{3})/.exec(String(row.error ?? ''))?.[1] ?? 0);
      const at = Date.parse(row.ts);
      const badKey = (status === 401 || status === 403) && this.now() - at < BAD_KEY_MS;
      const text = String(row.error ?? '');
      const paid = PAYMENT_REQUIRED.test(text) || (status === 402 && !SHORT_LIMIT.test(text) && !CREDIT_EXHAUSTED.test(text));
      if (paid && Number.isFinite(at) && this.now() - at < PAYMENT_REST_MS) {
        this.coolDown({ id }, { status, message: text });
        restored.push(id);
        continue;
      }
      const noCredit = !SHORT_LIMIT.test(text) && (status === 402 || CREDIT_EXHAUSTED.test(text)) && !/exceeded your current quota|per day/i.test(text);
      const daily = noCredit && nextUtcMidnight(at) > this.now();
      const modelGoneError = modelGone({ status, message: text });
      if (modelGoneError) {
        if (row.model && !this.isModelCurrent(provider, row.model)) continue;
        this.coolDown({ id }, { status, message: String(row.error ?? '') });
        restored.push(id);
        continue;
      }
      if (!badKey && !daily) continue;
      this.coolDown({ id }, { status, message: String(row.error ?? '') });
      restored.push(id);
    }
    const now = this.now();
    for (const [id, list] of byProvider) {
      if (!this.providers.some((p) => p.id === id)) continue;
      const provider = this.providers.find((p) => p.id === id);
      const calls = list.filter((row) => row.purpose !== 'router');
      const benchRows = list.filter((row) => row.purpose === 'router');
      const recent = calls.filter((row) => {
        const at = Date.parse(row.ts);
        return !Number.isNaN(at) && now - at <= STREAK_BENCH_MAX_MS;
      });
      const relevant = recent.filter((row) => !row.model || this.isModelCurrent(provider, row.model));
      let streak = 0;
      while (streak < relevant.length && relevant[relevant.length - 1 - streak].ok === false) streak++;
      if (streak < FAILURE_STREAK_BENCH) continue;
      const at = Date.parse(relevant[relevant.length - 1].ts);
      if (provider?.keyCount !== undefined && relevant[relevant.length - 1].keys !== undefined && provider.keyCount > relevant[relevant.length - 1].keys) continue;
      const benches = benchRows.filter((row) => /failed calls in a row; rests/.test(String(row.error ?? '')) && now - Date.parse(row.ts) <= STREAK_BENCH_MAX_MS && Date.parse(row.ts) < at).length;
      const rest = Math.min(STREAK_BENCH_MS * 2 ** benches, STREAK_BENCH_MAX_MS);
      const until = at + rest;
      if (until <= now) continue;
      this.cooldownUntil.set(id, Math.max(this.cooldownUntil.get(id) ?? 0, until));
      this.cooldownReason.set(id, `${streak} failed calls in a row before the restart; rests ${Math.round(rest / 60000)} min`);
      if (!restored.includes(id)) restored.push(id);
    }
    return restored;
  }

  isModelCurrent(provider, model) {
    if (!provider?.selected || !model) return false;
    return provider.selected.fast === model || provider.selected.deep === model || provider.selected.vision === model;
  }

  cooldownFor(provider, error) {
    const now = this.now();
    if (error.status === 401 || error.status === 403) return { until: now + BAD_KEY_MS, reason: 'key rejected; check it on Models & router' };
    const message = String(error.message ?? '');
    const paid = PAYMENT_REQUIRED.test(message) || (error.status === 402 && !SHORT_LIMIT.test(message) && !CREDIT_EXHAUSTED.test(message));
    if (paid) return { until: now + PAYMENT_REST_MS, reason: 'needs a paid plan (no free tier for this key); rests 24 h, add credit or remove the key' };
    const until = now + (error.retryAfterMs || this.cooldownMs);
    if (!SHORT_LIMIT.test(message) && (error.status === 402 || DAILY.test(message))) return { until: Math.max(until, quotaResetAt(provider, now)), reason: 'daily quota or credit used up; waits for the daily reset' };
    return { until, reason: 'rate limit' };
  }

  coolDown(provider, error) {
    const { until, reason } = this.cooldownFor(provider, error);
    const keyBack = provider.nextKeyAt?.() ?? 0;
    const proposed = keyBack > this.now() && keyBack < until ? keyBack : until;
    const back = Math.max(this.cooldownUntil.get(provider.id) ?? 0, proposed);
    this.cooldownUntil.set(provider.id, back);
    if (back === proposed) this.cooldownReason.set(provider.id, proposed < until ? `every key rests; the first is back in ${Math.ceil((back - this.now()) / 60000)} min` : reason);
  }

  benchComputeError(provider, error) {
    if (error.status < 500) {
      this.computeErrorStreak.delete(provider.id);
      return false;
    }
    const streak = (this.computeErrorStreak.get(provider.id) ?? 0) + 1;
    this.computeErrorStreak.set(provider.id, streak);
    if (streak < 3) return false;
    const until = this.now() + COMPUTE_ERROR_COOLDOWN_MS;
    this.cooldownUntil.set(provider.id, until);
    this.cooldownReason.set(provider.id, `compute error: ${streak} failures in a row; tried again in ${Math.round(COMPUTE_ERROR_COOLDOWN_MS / 60000)} min`);
    return true;
  }

  countFailure(provider) {
    const streak = (this.failureStreak.get(provider.id) ?? 0) + 1;
    if (streak < FAILURE_STREAK_BENCH) {
      this.failureStreak.set(provider.id, streak);
      return false;
    }
    const benches = this.streakBenches.get(provider.id) ?? 0;
    const rest = Math.min(STREAK_BENCH_MS * 2 ** benches, STREAK_BENCH_MAX_MS);
    const reason = `${streak} failed calls in a row; rests ${Math.round(rest / 60000)} min`;
    this.cooldownUntil.set(provider.id, Math.max(this.cooldownUntil.get(provider.id) ?? 0, this.now() + rest));
    this.cooldownReason.set(provider.id, reason);
    this.streakBenches.set(provider.id, benches + 1);
    this.failureStreak.set(provider.id, 0);
    this.record({ purpose: 'router', tier: '', provider: provider.id, ok: false, ms: 0, error: reason });
    return true;
  }

  shortestCooldownMs() {
    const time = this.now();
    const waits = this.providers.filter((p) => p.ready).map((p) => (this.trialBusy(p.id, time) ? TRIAL_POLL_MS : (this.cooldownUntil.get(p.id) ?? 0) - time));
    return waits.length ? Math.max(0, Math.min(...waits)) : Infinity;
  }

  snapshotProviderState(providers) {
    const snapshot = new Map();
    for (const p of providers) {
      snapshot.set(p.id, {
        failureStreak: this.failureStreak.get(p.id),
        timeoutStreak: this.timeoutStreak.get(p.id),
        computeErrorStreak: this.computeErrorStreak.get(p.id),
        streakBenches: this.streakBenches.get(p.id),
        cooldownUntil: this.cooldownUntil.get(p.id),
        cooldownReason: this.cooldownReason.get(p.id),
      });
    }
    return snapshot;
  }

  forgetBench(providerId) {
    this.failureStreak.delete(providerId);
    this.timeoutStreak.delete(providerId);
    this.computeErrorStreak.delete(providerId);
    this.streakBenches.delete(providerId);
    this.cooldownUntil.delete(providerId);
    this.cooldownReason.delete(providerId);
  }

  restoreProviderState(snapshot) {
    for (const [id, state] of snapshot) {
      if (state.failureStreak === undefined) this.failureStreak.delete(id); else this.failureStreak.set(id, state.failureStreak);
      if (state.timeoutStreak === undefined) this.timeoutStreak.delete(id); else this.timeoutStreak.set(id, state.timeoutStreak);
      if (state.computeErrorStreak === undefined) this.computeErrorStreak.delete(id); else this.computeErrorStreak.set(id, state.computeErrorStreak);
      if (state.streakBenches === undefined) this.streakBenches.delete(id); else this.streakBenches.set(id, state.streakBenches);
      if (state.cooldownUntil === undefined) this.cooldownUntil.delete(id); else this.cooldownUntil.set(id, state.cooldownUntil);
      if (state.cooldownReason === undefined) this.cooldownReason.delete(id); else this.cooldownReason.set(id, state.cooldownReason);
    }
  }

  async waitOffline(offline) {
    if (this.maxWaitMs <= 0) return false;
    const step = this.offlineBackoff[offline.step] ?? this.offlineBackoff[this.offlineBackoff.length - 1];
    if (offline.waited + step > this.offlineWaitMs) return false;
    offline.step++;
    offline.waited += step;
    await this.sleep(step);
    return true;
  }

  async waitForCooldown({ avoid, tier, purpose, tokens }) {
    let waited = 0;
    let first = true;
    for (;;) {
      const wait = first ? this.shortestCooldownMs() : Math.max(this.shortestCooldownMs(), TRIAL_POLL_MS);
      if (waited + wait > this.maxWaitMs) return [];
      if (first) this.record({ purpose, tier, provider: 'router', ok: false, ms: wait, error: `all providers rate-limited, waiting ${Math.ceil(wait / 1000)}s` });
      await this.sleep(wait);
      waited += wait;
      first = false;
      const candidates = this.available({ avoid, tier, purpose, tokens });
      if (candidates.length || !this.trialPending()) return candidates;
    }
  }

  async tryProviders(candidates, { messages, tier, json, purpose, temperature }, errors) {
    for (const provider of candidates) {
      let attemptMessages = messages;
      let repairs = 0;
      let switches = 0;
      while (repairs < 2) {
        if ((this.cooldownUntil.get(provider.id) ?? 0) > this.now() || this.trialBusy(provider.id)) break;
        const started = this.now();
        const trial = this.halfOpen(provider.id, started);
        const model = provider.selected?.[tier] ?? provider.selected?.fast;
        this.inflight.set(provider.id, (this.inflight.get(provider.id) ?? 0) + 1);
        try {
          const reply = await provider.chat({ messages: attemptMessages, tier, json, temperature, timeoutMs: provider.timeoutFor?.(estimateTokens(attemptMessages), EXPECTED_OUTPUT_TOKENS[purpose] ?? 500) ?? tierTimeoutMs(tier) });
          this.calls++;
          const data = json ? extractJson(reply.content) : null;
          const waitMs = reply.waitMs ?? 0;
          const ms = Math.max(0, (this.now() - started) - waitMs);
          this.record({ purpose, tier, provider: provider.id, model: reply.model, ok: true, ms, tokens: reply.usage?.total_tokens ?? null, ...(waitMs > 0 ? { waitMs } : {}) });
          this.timeoutStreak.delete(provider.id);
          this.computeErrorStreak.delete(provider.id);
          this.failureStreak.delete(provider.id);
          this.streakBenches.delete(provider.id);
          this.closeBreaker(provider.id);
          return { ...reply, data };
        } catch (error) {
          this.record({ purpose, tier, provider: provider.id, ok: false, ms: this.now() - started, error: error.message.slice(0, 200) });
          errors.push(error.message);
          let stop = true;
          let retry = false;
          if (error instanceof ProviderError) {
            if (this.switchModel(provider, model, error) || this.rotateKey(provider, error)) {
              switches++;
              if (switches <= MAX_SWITCHES_PER_CALL) {
                retry = true;
                stop = false;
              }
            } else if (modelGone(error)) {
              this.benchGoneModel(provider, model, error);
            } else if (!this.benchSlow(provider, error) && !this.benchComputeError(provider, error) && (error.retryable || [401, 402, 403].includes(error.status))) {
              this.coolDown(provider, error);
            }
          } else {
            repairs++;
            attemptMessages = [...messages, { role: 'user', content: REPAIR_INSTRUCTION }];
            stop = false;
          }
          this.countFailure(provider);
          if (trial && !retry && error instanceof ProviderError) this.reopenBreaker(provider, error);
          if (retry) continue;
          if (stop) break;
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
    const offline = { step: 0, waited: 0 };
    let candidates = this.available({ avoid, tier, purpose, tokens });
    let round = 0;
    let offlineExhausted = false;
    while (round < MAX_WAIT_ROUNDS) {
      if (!candidates.length) candidates = await this.waitForCooldown({ avoid, tier, purpose, tokens });
      if (!candidates.length) break;
      const stateBefore = this.snapshotProviderState(candidates);
      const reply = await this.tryProviders(candidates, request, errors);
      if (reply) return reply;
      if (errors.length && errors.every((error) => isNetworkError(error))) {
        this.restoreProviderState(stateBefore);
        if (await this.waitOffline(offline)) {
          candidates = this.available({ avoid, tier, purpose, tokens });
          continue;
        }
        offlineExhausted = true;
        break;
      }
      if (this.shortestCooldownMs() === 0) break;
      candidates = [];
      round++;
    }
    if (!errors.length) {
      throw new NoModelAvailableError(this.ready ? 'all free model quotas are cooling down after rate limits; retry in a minute' : 'no model provider is configured — open Setup');
    }
    if (offlineExhausted) {
      throw new OfflineError(`offline: every provider failed for ${purpose}: ${errors.join(' || ').slice(0, 600)}`);
    }
    throw new NoModelAvailableError(`every provider failed for ${purpose}: ${errors.join(' || ').slice(0, 600)}`);
  }

  route() {
    const ids = (tier) => this.ordered(tier).filter((p) => (p.canServe ? p.canServe(tier) : p.ready)).map((p) => p.id);
    return { fast: ids('fast'), deep: ids('deep'), vision: ids('vision') };
  }

  status() {
    const time = this.now();
    this.restPaidProviders(time);
    return this.providers.map((p) => ({
      ...p.describe(),
      coolingDownMs: Math.max(0, (this.cooldownUntil.get(p.id) ?? 0) - time),
      coolingReason: (this.cooldownUntil.get(p.id) ?? 0) > time ? this.cooldownReason.get(p.id) ?? 'rate limit' : null,
    }));
  }
}
