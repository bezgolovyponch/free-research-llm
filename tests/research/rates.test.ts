import { describe, expect, it } from 'vitest';
import { ExchangeRates, parseEcbRates } from '../../src/research/rates.mjs';

const XML = "<Cube><Cube time='2026-10-16'><Cube currency='USD' rate='1.1'/><Cube currency='PLN' rate='4.25'/><Cube currency='CZK' rate='24.5'/></Cube></Cube>";

describe('ExchangeRates', () => {
  it('parses the ECB daily file with EUR as base', () => {
    expect(parseEcbRates(XML)).toEqual({ EUR: 1, USD: 1.1, PLN: 4.25, CZK: 24.5 });
  });

  it('converts between currencies, caches for a day and survives a failed fetch', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return new Response(XML); };
    const rates = new ExchangeRates({ fetchImpl, now: () => 0 });
    const convert = await rates.converter();
    expect(convert(8500, 'PLN', 'EUR')).toBeCloseTo(2000, 6);
    expect(convert(100, 'EUR', 'EUR')).toBe(100);
    expect(convert(1, 'XXX', 'EUR')).toBeNull();
    await rates.converter();
    expect(calls).toBe(1);
    const offline = new ExchangeRates({ fetchImpl: async () => { throw new Error('offline'); } });
    expect(await offline.rates()).toEqual({ EUR: 1 });
  });
});
