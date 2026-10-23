import { describe, expect, it } from 'vitest';
import { droppedNote, explicitTerms, groundAcceptance, groundSpec, statedNumbers } from '../../src/research/grounding.mjs';

const glamping = {
  expected: '50 Plots In EU, Vietnam and Turkey strongly feasible for Glamping business 10 minth, 1 year',
  question: 'Find appropriate plots to buy for glamping business … very low enterance investments, 20000EUR max, 10 month a year',
  constraints: { location: 'Spain, Portugal, Turkey', budget: '20000', horizon: '1 year' },
};

describe('groundAcceptance', () => {
  it('drops a must-mention word that only describes the topic, keeps the stated count and budget', () => {
    const { spec, dropped } = groundAcceptance({ itemCount: 50, urlsLive: false, valueRange: [0, 20000], unit: 'EUR', mustMention: ['plot', 'glamping'] }, glamping);
    expect(spec).toMatchObject({ itemCount: 50, valueRange: [0, 20000], mustMention: [] });
    expect(dropped).toEqual(['must mention "plot"', 'must mention "glamping"']);
    expect(droppedNote(dropped)).toMatch(/^not enforced/);
  });

  it('keeps words the user explicitly demands, quoted or after mention/contain/include', () => {
    expect(groundAcceptance({ mustMention: ['sea view', 'freehold'] }, { expected: 'listings must mention sea view and include "freehold"' }).spec.mustMention).toEqual(['sea view', 'freehold']);
    expect(groundAcceptance({ mustMention: ['vat'] }, { expected: 'prices containing VAT' }).spec.mustMention).toEqual(['vat']);
  });

  it('drops counts and ranges nobody stated', () => {
    const { spec, dropped } = groundAcceptance({ itemCount: 20, valueRange: [1000, 5000], mustMention: [] }, { expected: 'a short list of cheap plots', question: 'where to buy land' });
    expect(spec).toMatchObject({ itemCount: null, valueRange: null });
    expect(dropped).toEqual(['at least 20 items', 'value within 1000–5000']);
  });
});

describe('groundSpec', () => {
  it('keeps words the user literally wrote in the desired output of a piece', () => {
    expect(groundSpec({ mustMention: ['Brno', 'DEMO answer'], itemCount: null, valueRange: null }, { desired: 'the demo answer with the price in Brno' }).spec.mustMention).toEqual(['Brno', 'DEMO answer']);
  });

  it('drops words the user never wrote, against the desired output', () => {
    expect(groundSpec({ mustMention: ['glamping'], itemCount: 5, valueRange: null }, { desired: '5 links to plots with prices' }).spec).toMatchObject({ mustMention: [], itemCount: 5 });
  });
});

describe('helpers', () => {
  it('reads numbers with separators, k suffix and words, and explicit terms', () => {
    expect([...statedNumbers('20 000 EUR, 20k, 1.500, five, 3')].sort((a, b) => a - b)).toEqual([3, 5, 1500, 20000]);
    expect(explicitTerms('must contain: sea, beach or "ebike"')).toEqual(expect.arrayContaining(['sea', 'beach', 'ebike']));
    expect(explicitTerms('feasible for Glamping business')).toEqual([]);
  });
});
