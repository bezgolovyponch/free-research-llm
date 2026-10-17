import { describe, expect, it } from 'vitest';
import { CalcError, evaluate, sameNumber, toNumber } from '../../src/research/calc.mjs';

describe('evaluate', () => {
  it('respects operator precedence and parentheses', () => {
    expect(evaluate('2 + 3 * 4')).toBe(14);
    expect(evaluate('(2 + 3) * 4')).toBe(20);
    expect(evaluate('2 ^ 3 ^ 2')).toBe(512);
    expect(evaluate('-3 + 5')).toBe(2);
  });

  it('substitutes named inputs including unit-bearing objects and formatted strings', () => {
    expect(evaluate('(sell - buy - transport) / buy', { sell: 21000, buy: { value: 18000 }, transport: '1,200' })).toBeCloseTo(0.1, 6);
  });

  it('supports the whitelisted functions only', () => {
    expect(evaluate('max(1, 7, 3) + min(4, 2) + abs(-1) + round(2.345, 2)')).toBeCloseTo(12.35, 6);
    expect(() => evaluate('process(1)')).toThrow(CalcError);
  });

  it('rejects unknown variables, junk input and non-finite results', () => {
    expect(() => evaluate('a + 1')).toThrow(/unknown variable/);
    expect(() => evaluate('1 + ; 2')).toThrow(CalcError);
    expect(() => evaluate('1 / 0')).toThrow(/finite/);
  });

  it('compares numbers with a relative tolerance', () => {
    expect(sameNumber(100, 100.5)).toBe(true);
    expect(sameNumber(100, 103)).toBe(false);
    expect(toNumber('€ 1,500')).toBe(1500);
  });
});
