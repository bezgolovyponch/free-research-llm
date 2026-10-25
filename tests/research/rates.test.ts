import { describe, expect, it } from 'vitest';
import { ExchangeRates, WIDE_DAILY, parseEcbRates, parseWideRates } from '../../src/research/rates.mjs';

const XML = "<Cube><Cube time='2026-10-16'><Cube currency='USD' rate='1.1'/><Cube currency='PLN' rate='4.25'/><Cube currency='CZK' rate='24.5'/></Cube></Cube>";
const WIDE = { result: 'success', base_code: 'EUR', rates: { EUR: 1, USD: 1.2, VND: 30000, TRY: 55 } };

function serve({ ecb = true, wide = true } = {}) {
  const calls = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url === WIDE_DAILY) return wide ? Response.json(WIDE) : new Response('', { status: 503 });
    return ecb ? new Response(XML) : new Response('', { status: 503 });
  };
  return { calls, fetchImpl };
}

describe('ExchangeRates', () => {
  it('parses the ECB daily file with EUR as base', () => {
    expect(parseEcbRates(XML)).toEqual({ EUR: 1, USD: 1.1, PLN: 4.25, CZK: 24.5 });
  });

  it('reads the wide daily table only when it is EUR-based and successful', () => {
    expect(parseWideRates(WIDE)).toEqual({ EUR: 1, USD: 1.2, VND: 30000, TRY: 55 });
    expect(parseWideRates({ ...WIDE, base_code: 'USD' })).toEqual({});
    expect(parseWideRates({ result: 'error' })).toEqual({});
  });

  it('converts between currencies, caches for a day and survives a failed fetch', async () => {
    const { calls, fetchImpl } = serve();
    const rates = new ExchangeRates({ fetchImpl, now: () => 0 });
    const convert = await rates.converter();
    expect(convert(8500, 'PLN', 'EUR')).toBeCloseTo(2000, 6);
    expect(convert(100, 'EUR', 'EUR')).toBe(100);
    expect(convert(1, 'XXX', 'EUR')).toBeNull();
    await rates.converter();
    expect(calls).toHaveLength(2);
    const offline = new ExchangeRates({ fetchImpl: async () => { throw new Error('offline'); } });
    expect(await offline.rates()).toEqual({ EUR: 1 });
  });

  it('prices currencies the ECB does not list, such as the dong, while ECB rates win where both exist', async () => {
    const convert = await new ExchangeRates({ fetchImpl: serve().fetchImpl, now: () => 0 }).converter();
    expect(convert(600_000_000, 'VND', 'EUR')).toBeCloseTo(20000, 6);
    expect(convert(110, 'USD', 'EUR')).toBeCloseTo(100, 6);
  });

  it('still converts the dong when the ECB is down', async () => {
    const convert = await new ExchangeRates({ fetchImpl: serve({ ecb: false }).fetchImpl, now: () => 0 }).converter();
    expect(convert(30000, 'VND', 'EUR')).toBeCloseTo(1, 6);
  });
});
