import { describe, expect, it } from 'vitest';
import { attributeClaims, attributionSummary, normalizeText, numbersIn, quoteFound, ungroundedNumbers } from '../../src/research/attribution.mjs';

const sources = [
  { id: 'S1', title: 'Terreno rústico', text: 'Terreno rústico com 4 448 m² em Pinhal e Mato, por 20 000 €. A 6 km da praia de Monte Gordo.' },
  { id: 'S2', title: 'INE', text: 'Average summer high in Faro: 29 °C; 300 sunny days per year.' },
];

describe('claim attribution (verified quotes, as in GopherCite and ALCE)', () => {
  it('accepts a claim whose quote is really in the cited source and holds its number', () => {
    expect(quoteFound('por 20 000 €. A 6 km da praia', sources, ['S1'])).toBe(true);
    expect(quoteFound('por 20 000 €', sources, ['S2'])).toBe(false);
    expect(quoteFound('short', sources, ['S1'])).toBe(false);
    const [ok, wrongSource, invented, noNumber, assumed] = attributeClaims([
      { text: 'The plot costs 20,000 EUR', quote: 'por 20 000 €. A 6 km da praia', sourceIds: ['S1'] },
      { text: 'The plot costs 20,000 EUR', quote: 'por 20 000 €. A 6 km da praia', sourceIds: ['S2'] },
      { text: 'The plot is 2 km from the beach', quote: 'a 2 km da praia de Monte Gordo', sourceIds: ['S1'] },
      { text: 'Faro has 310 sunny days', quote: 'Average summer high in Faro: 29 °C', sourceIds: ['S2'] },
      { text: 'Preparation costs 3,000 EUR', sourceIds: [], assumption: true },
    ], sources);
    expect([ok.attributed, wrongSource.attributed, invented.attributed, noNumber.attributed, assumed.attributed]).toEqual([true, false, false, false, null]);
    expect(noNumber.attributionNote).toMatch(/does not contain the claim's number/);
  });

  it('passes a finding only when most claims are attributed and every numeric claim is', () => {
    const claims = attributeClaims([
      { text: 'The plot costs 20,000 EUR', quote: 'Pinhal e Mato, por 20 000 €', sourceIds: ['S1'] },
      { text: 'It is near Monte Gordo beach', quote: 'A 6 km da praia de Monte Gordo', sourceIds: ['S1'] },
      { text: 'The area is sunny', quote: 'nothing like this', sourceIds: ['S2'] },
    ], sources);
    expect(attributionSummary(claims)).toMatchObject({ factual: 3, attributed: 2, passed: true });
    const bad = attributeClaims([{ text: 'It has 300 sunny days', quote: 'made up', sourceIds: ['S2'] }, { text: 'Near the beach', quote: 'A 6 km da praia de Monte Gordo', sourceIds: ['S1'] }], sources);
    expect(attributionSummary(bad)).toMatchObject({ passed: false });
    expect(attributionSummary(bad).numericMissing).toHaveLength(1);
  });

  it('flags numbers in the answer that no claim, calculation or the question supports', () => {
    const finding = { answer: 'One plot at 20,000 EUR, 6 km from the beach; about 45 plots exist.', claims: [{ text: 'The plot costs 20,000 EUR, 6 km from the beach' }], calculation: null };
    expect(ungroundedNumbers(finding, { question: 'Plots under 20,000 EUR?' })).toEqual(['45']);
    expect(ungroundedNumbers({ answer: 'In 2026 there were 3 offers', claims: [] })).toEqual([]);
  });

  it('normalises accents, separators and punctuation the same way on both sides', () => {
    expect(normalizeText('Rústico — 20.000 €!')).toBe('rustico 20000 €');
    expect(numbersIn('20 000 € and 4,448 m² in 2026')).toEqual(['20000', '4448']);
    expect(numbersIn('D4 says D4.1 and S12 cite 300 EUR')).toEqual(['300']);
  });
});
