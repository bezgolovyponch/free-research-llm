import { describe, expect, it } from 'vitest';
import { assumedFigures, assumedInText, assumedNote, attributeClaims, attributionSummary, normalizeText, numbersIn, quoteFound, shownFigure, ungroundedNumbers } from '../../src/research/attribution.mjs';

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

  it('does not pass a finding whose every claim is an assumption (supplier research b2f5b7 D4.2)', () => {
    const assumed = attributeClaims([
      { text: 'Supplier A carries 120 distinct Ralph Lauren SKUs', value: 120, unit: 'SKUs', sourceIds: [], quote: '', assumption: true },
      { text: 'Supplier B carries 50 distinct Barbour SKUs', value: 50, unit: 'SKUs', sourceIds: [], quote: '', assumption: true },
    ], []);
    expect(attributionSummary(assumed)).toMatchObject({ factual: 0, attributed: 0, share: 0, assumedOnly: true, passed: false });
    expect(attributionSummary([])).toMatchObject({ share: 1, assumedOnly: false, passed: true });
  });

  it('flags numbers in the answer that no claim, calculation or the question supports', () => {
    const finding = { answer: 'One plot at 20,000 EUR, 6 km from the beach; about 45 plots exist.', claims: [{ text: 'The plot costs 20,000 EUR, 6 km from the beach' }], calculation: null };
    expect(ungroundedNumbers(finding, { question: 'Plots under 20,000 EUR?' })).toEqual(['45']);
    expect(ungroundedNumbers({ answer: 'In 2026 there were 3 offers', claims: [] })).toEqual(['3']);
  });

  it('with FRL_NUMBERS_OUTSIDE_URLS digits inside a cited web address are not numbers the answer states', () => {
    const finding = {
      answer: '253,789 new passenger cars were registered in Austria in 2024, according to Statistics Austria. Source: https://www.statistik.at/fileadmin/announcement/2025/01/20250114KfzNeuzulassungen2024EN.pdf (also www.example.at/table-7) but 12 more were added.',
      claims: [{ text: 'According to Statistics Austria, 253 789 new passenger cars were registered in 2024.' }],
    };
    expect(ungroundedNumbers(finding)).toEqual(expect.arrayContaining(['01', '20250114']));
    process.env.FRL_NUMBERS_OUTSIDE_URLS = '1';
    try {
      expect(ungroundedNumbers(finding)).toEqual(['12']);
    } finally {
      delete process.env.FRL_NUMBERS_OUTSIDE_URLS;
    }
  });

  it('flags small numbers like 10 camping months when ungrounded', () => {
    expect(ungroundedNumbers({ answer: 'The site has 10 camping months', claims: [] })).toEqual(['10']);
  });

  it('does not flag small numbers when supported by a claim', () => {
    const finding = { answer: 'The site has 10 camping months', claims: [{ text: '10 camping months a year' }] };
    expect(ungroundedNumbers(finding)).toEqual([]);
  });

  it('ignores ordinal list markers and years', () => {
    expect(ungroundedNumbers({ answer: '1. Prices rose\n2. Costs fell', claims: [] })).toEqual([]);
    expect(ungroundedNumbers({ answer: 'in 2025', claims: [] })).toEqual([]);
    expect(ungroundedNumbers({ answer: '(1) First item', claims: [] })).toEqual([]);
  });

  it('normalises accents, separators and punctuation the same way on both sides', () => {
    expect(normalizeText('Rústico — 20.000 €!')).toBe('rustico 20000 €');
    expect(numbersIn('20 000 € and 4,448 m² in 2026')).toEqual(['20000', '4448']);
    expect(numbersIn('D4 says D4.1 and S12 cite 300 EUR')).toEqual(['300']);
  });
});

describe('figures that rest on an assumption are traced up the tree (FRL_ASSUMED_FIGURES)', () => {
  const leaf = { id: 'D4.2', parentId: 'D4', finding: { answer: 'The EHPA 2024/2025 Market Report estimates that 12,000 residential heat pumps were sold in Czechia in 2024.', claims: [{ text: 'EHPA estimates 12,000 residential heat pumps were sold in Czechia in 2024.', value: 12000, sourceIds: ['S9'], quote: 'The table shows the number of units sold in 2024', assumption: true, attributed: null }] } };
  const sibling = { id: 'D4.1', parentId: 'D4', finding: { answer: 'SVP lists 40 members.', claims: [{ text: 'SVP lists 40 members.', sourceIds: ['S2'], quote: 'SVP has 40 members', assumption: false, attributed: true }] } };
  const parent = { id: 'D4', parentId: 'Q', finding: { answer: 'The EHPA report estimates that 12,000 residential heat pumps were sold in Czechia in 2024; SVP lists 40 members.', claims: [{ text: 'The EHPA 2024/2025 Market Report estimates that 12,000 residential heat pumps were sold in Czechia in 2024.', sourceIds: ['D4.2'], quote: 'estimates that 12,000 residential heat pumps', assumption: false, attributed: true }, { text: 'SVP lists 40 members.', sourceIds: ['D4.1'], quote: 'SVP lists 40 members.', assumption: false, attributed: true }] } };
  const asked = 'How many residential heat pumps were installed in Czechia in 2024? Give the figure with its source.';

  it('marks a figure the leaf labelled an assumption, and carries it to the parent that quotes the leaf', () => {
    const assumed = assumedFigures([parent, leaf, sibling], asked);
    expect(assumed.get('D4.2')).toEqual([{ figure: '12000', from: 'D4.2' }]);
    expect(assumed.get('D4')).toEqual([{ figure: '12000', from: 'D4.2' }]);
    expect(assumed.get('D4.1')).toEqual([]);
  });

  it('flags the figure in the memo with the leaf it rests on, unless a quoted leaf claim states it', () => {
    const nodes = [parent, leaf, sibling];
    const memo = '12,000 residential heat pumps were installed in Czechia in 2024 according to the EHPA 2024/2025 Market Report. Estimate: 12000 units.';
    const flagged = assumedInText(memo, assumedFigures(nodes, asked), nodes, asked);
    expect(flagged).toEqual([{ figure: '12000', from: 'D4.2' }]);
    expect(assumedNote(flagged)).toBe(' — 12,000 rests on an assumption (D4.2): no source read states it');
    const quoted = { id: 'D3.1', parentId: 'D3', finding: { answer: 'Eurostat gives 12,000.', claims: [{ text: 'Eurostat gives 12,000 units.', sourceIds: ['S4'], quote: 'Eurostat 12 000 units', assumption: false, attributed: true }] } };
    expect(assumedInText(memo, assumedFigures([...nodes, quoted], asked), [...nodes, quoted], asked)).toEqual([]);
  });

  it('never flags zero, a number the asker wrote, or a figure no assumption holds', () => {
    const zero = { id: 'D1', parentId: 'Q', finding: { answer: '0 agencies in Varna; 40 needed; SVP lists 40 members.', claims: [{ text: '0 agencies in Varna, 40 needed.', assumption: true }] } };
    const assumed = assumedFigures([zero, sibling], 'Find 40 agencies');
    expect(assumed.get('D1')).toEqual([]);
    expect(assumedInText('NO-GO: 0 agencies found (need 40); SVP lists 40 members.', assumed, [zero, sibling], 'Find 40 agencies')).toEqual([]);
    expect(assumedNote([])).toBe('');
    expect(shownFigure('12000')).toBe('12,000');
    expect(shownFigure('1.25')).toBe('1.25');
  });
});
