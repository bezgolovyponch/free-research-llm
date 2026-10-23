import { describe, expect, it } from 'vitest';
import { NO_ITEMS_DETAIL, asksForItems, deliversItems, missingItems } from '../../src/research/deliverable.mjs';
import { effectiveGrade } from '../../src/research/result.mjs';

const piece = (question: string, items: Array<{ url?: string }> = [], status = 'verified') => ({ id: 'D9', title: '', question, status, finding: { answer: 'x', items } });

describe('listing pieces', () => {
  it('knows which pieces ask for specific listings', () => {
    expect(asksForItems(piece('Which coastal land parcels in Spain are listed for sale under 20,000 EUR?'))).toBe(true);
    expect(asksForItems(piece('Identify specific plots under 20 000 EUR with direct URLs'))).toBe(true);
    expect(asksForItems(piece('What is the average summer temperature in Algarve?'))).toBe(false);
    expect(asksForItems({ ...piece('average price'), deliverable: true })).toBe(true);
  });

  it('grades a listing piece that found nothing as weak, however good its citations', () => {
    const empty = piece('Which coastal land parcels in Turkey are listed for sale under 20,000 EUR?');
    expect(missingItems(empty)).toBe(true);
    expect(effectiveGrade(empty)).toBe('weak');
    const found = piece('Which coastal land parcels in Turkey are listed for sale under 20,000 EUR?', [{ url: 'https://www.sahibinden.com/ilan/1' }]);
    expect(deliversItems(found)).toBe(true);
    expect(effectiveGrade(found)).toBe('verified');
    expect(effectiveGrade(piece('What is the average summer temperature in Algarve?'))).toBe('verified');
    expect(NO_ITEMS_DETAIL).toMatch(/returned none/);
  });
});
