import { describe, expect, it } from 'vitest';
import { quoteFound } from '../../src/research/quote.mjs';

describe('quoteFound', () => {
  it('finds exact quote', () => {
    expect(quoteFound('The price is 100 EUR', '100 EUR')).toBe(true);
  });

  it('finds quote with different spacing', () => {
    expect(quoteFound('The  price   is  100  EUR', '100 EUR')).toBe(true);
  });

  it('finds quote case insensitive', () => {
    expect(quoteFound('THE PRICE IS 100 EUR', '100 eur')).toBe(true);
  });

  it('finds quote with accents', () => {
    expect(quoteFound('Área máxima do terreno: 5 000 m²', 'Área máxima')).toBe(true);
  });

  it('returns false for missing quote', () => {
    expect(quoteFound('nothing here', '£729')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(quoteFound('', 'test')).toBe(false);
    expect(quoteFound('test', '')).toBe(true);
  });

  it('handles null/undefined', () => {
    expect(quoteFound(null, 'test')).toBe(false);
    expect(quoteFound('test', null)).toBe(true);
  });
});