import { describe, expect, it } from 'vitest';
import { WAIT_LINE_MS, callSummary, failureKind, routerLine } from '../../src/research/routerlog.mjs';

describe('routerLine', () => {
  it('names every resting provider with its rest and reason', () => {
    expect(routerLine({ kind: 'waiting', ms: 12000, purpose: 'research', tier: 'fast', resting: [{ provider: 'one', ms: 12000, reason: 'rate limit' }, { provider: 'two', ms: 600500, reason: 'too slow: 2 timeouts in a row; tried again in 10 min' }] })).toBe('waiting for model quota: one rests 12s (rate limit), two rests 601s (too slow: 2 timeouts in a row; tried again in 10 min)');
  });

  it('falls back to the wait when nobody is listed as resting', () => {
    expect(routerLine({ kind: 'waiting', ms: 1000, resting: [] })).toBe('waiting for model quota: 1s');
  });

  it('says which purpose got no answer and why', () => {
    expect(routerLine({ kind: 'gave-up', purpose: 'synthesize', tier: 'deep', reasons: ['one HTTP 429: slow down', 'two: rate limit'] })).toBe('no model answered synthesize: one HTTP 429: slow down; two: rate limit');
  });

  it('says a provider needs payment', () => {
    expect(routerLine({ kind: 'excluded', provider: 'one' })).toBe('one needs payment: excluded from the free route');
  });

  it('gives no line for an event it does not know', () => {
    expect(routerLine({ kind: 'other' })).toBe('');
    expect(routerLine(null)).toBe('');
    expect(WAIT_LINE_MS).toBe(60000);
  });
});

describe('failureKind', () => {
  it('reads the status and the quota window from the error text', () => {
    expect(failureKind('one HTTP 429 [quota window: per minute]: slow down')).toBe('429 per minute');
    expect(failureKind('one HTTP 429 [quota window: per day, per model]: used up')).toBe('429 per day');
    expect(failureKind('one HTTP 503: overloaded')).toBe('503');
    expect(failureKind('one unreachable: timed out after 45000 ms')).toBe('timed out');
    expect(failureKind('one unreachable: fetch failed')).toBe('unreachable');
    expect(failureKind('Unexpected token < in JSON')).toBe('unusable reply');
    expect(failureKind(undefined)).toBe('unusable reply');
  });
});

describe('callSummary', () => {
  const rows = [
    { provider: 'one', purpose: 'research', ok: true },
    { provider: 'one', purpose: 'research', ok: false, error: 'one HTTP 429 [quota window: per minute]: slow down' },
    { provider: 'one', purpose: 'critique', ok: false, error: 'one HTTP 429 [quota window: per minute]: slow down' },
    { provider: 'two', purpose: 'research', ok: false, error: 'two HTTP 503: overloaded' },
    { provider: 'two', purpose: 'research', ok: true },
    { provider: 'router', purpose: 'research', ok: false, error: 'all providers rate-limited, waiting 10s' },
    { provider: 'one', purpose: 'router', ok: false, error: '12 failed calls in a row; rests 30 min' },
  ];

  it('counts model calls and names the most frequent failure, leaving router notices out', () => {
    expect(callSummary(rows)).toEqual({ ok: 2, failed: 3, line: 'model calls this phase: 2 ok, 3 failed (top: one 429 per minute x2)' });
  });

  it('has no top failure when every call answered', () => {
    expect(callSummary(rows.filter((row) => row.ok)).line).toBe('model calls this phase: 2 ok, 0 failed');
  });

  it('gives no line when the phase made no model call', () => {
    expect(callSummary([])).toEqual({ ok: 0, failed: 0, line: '' });
    expect(callSummary(rows.slice(5)).line).toBe('');
    expect(callSummary().line).toBe('');
  });
});
