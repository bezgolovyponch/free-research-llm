import { describe, expect, it } from 'vitest';
import { MEASURES, compare, adaptForChecklist } from '../../src/research/measures.mjs';

describe('shared measures table', () => {
  it('exports all expected measures including realTrendVsEu', () => {
    const expected = ['priceEur', 'distanceKm', 'areaM2', 'coastKm', 'beachKm', 'lakeKm', 'workableMonths', 'comfortableMonths', 'optimalDays', 'hotDays', 'hottestC', 'coldestC', 'explorePoints', 'staysNearby', 'realTrendVsEu'];
    for (const m of expected) {
      expect(MEASURES[m]).toBeDefined();
      expect(typeof MEASURES[m].read).toBe('function');
      expect(MEASURES[m].label).toBeDefined();
      expect(MEASURES[m].unit).toBeDefined();
    }
  });

  it('priceEur reads converted value from row.value', () => {
    const row = { value: 2166 };
    expect(MEASURES.priceEur.read(row)).toBe(2166);
  });

  it('distanceKm reads from row.distanceKm', () => {
    const row = { distanceKm: 42 };
    expect(MEASURES.distanceKm.read(row)).toBe(42);
  });

  it('coastKm reads from row.site.coastKm', () => {
    const row = { site: { coastKm: 2.5 } };
    expect(MEASURES.coastKm.read(row)).toBe(2.5);
  });

  it('coastKm returns undefined when site not available', () => {
    const row = {};
    expect(MEASURES.coastKm.read(row)).toBeUndefined();
  });

  it('coastKm returns Infinity when site exists but coastKm not set', () => {
    const row = { site: {} };
    expect(MEASURES.coastKm.read(row)).toBe(Infinity);
  });

  it('realTrendVsEu computes trend difference from context', () => {
    const row = { countryCode: 'PT', fit: { hpi: 15.1 } };
    const ctx = { euHpi: 2.9, trends: { PT: { real: 15.1 } } };
    expect(MEASURES.realTrendVsEu.read(row, ctx)).toBe(12.2);
  });

  it('compare function works for all operators', () => {
    expect(compare(10, '<=', 10)).toBe(true);
    expect(compare(10, '<=', 5)).toBe(false);
    expect(compare(10, '>=', 10)).toBe(true);
    expect(compare(10, '>=', 15)).toBe(false);
    expect(compare(10, '<', 15)).toBe(true);
    expect(compare(10, '>', 5)).toBe(true);
  });

  it('adaptForChecklist converts Infinity to undefined', () => {
    const adapted = adaptForChecklist(MEASURES);
    const row = {};
    expect(adapted.coastKm.read(row)).toBeUndefined();
    expect(adapted.beachKm.read(row)).toBeUndefined();
    expect(adapted.lakeKm.read(row)).toBeUndefined();
  });

  it('adaptForChecklist preserves finite values', () => {
    const adapted = adaptForChecklist(MEASURES);
    const row = { site: { coastKm: 2.5 } };
    expect(adapted.coastKm.read(row)).toBe(2.5);
  });
});
