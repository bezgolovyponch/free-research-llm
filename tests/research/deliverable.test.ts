import { describe, expect, it } from 'vitest';
import { NO_ITEMS_DETAIL, asksForItems, deliversItems, missingItems, contractClass, listCount } from '../../src/research/deliverable.mjs';
import { effectiveGrade } from '../../src/research/result.mjs';

const piece = (question: string, items: Array<{ url?: string }> = [], status = 'verified') => ({ id: 'D9', title: '', question, status, finding: { answer: 'x', items } });

describe('contractClass', () => {
  it('classifies list projects from itemCount in expected', () => {
    const b7772e = {
      question: 'Find appropriate plots to buy for a low-entry glamping business in the EU: affordable and valuable, with a scenic location and future upside',
      acceptance: { expected: '50 Plots In EU, Vietnam and Turkey strongly feasible for Glamping business 10 minth, 1 year' },
    };
    expect(contractClass(b7772e)).toBe('list');
  });

  it('classifies list projects from decisionModel kind', () => {
    const b2f5b7 = {
      question: 'Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren, Monclair, North face, Barbour with highest price/value ratio , proven good quality, assortiment for the appropriate retail second hand shop business in Czech Republic',
      acceptance: { expected: '20 direct links to the providers with proposal and proof that those particular companies do have highest proce/value ratio, quality, assortiment and appropriate setup for local Prague branded second hand shop retail' },
      decisionModel: { kind: { label: 'wholesale clothing provider', terms: ['wholesale second-hand clothing', 'used clothing wholesale'] } },
    };
    expect(contractClass(b2f5b7)).toBe('list');
  });

  it('classifies list projects from itemCount in question', () => {
    const c0c750f = {
      question: 'Find accurate and verified car listings on available marketplaces for at least 20 cars as fit and up to 80 as a trade off to purchase within 300km from prague, hatchback, with highest price/value ratio, considering the engines informations, usage trends and empirical data and all important details of the particular car, considering the professional and car enthusiast trustful sources and communities, with all the crucial metrics considered, price up to 65000CZK or equivalent',
      acceptance: { expected: 'The list of 20 highest possible price/value ratio to buy, working links, no broken links, verified with the research logic, recently posted, 80 trade offs to confirm and review' },
      decisionModel: { kind: { label: 'used car', terms: ['hatchback'] } },
    };
    expect(contractClass(c0c750f)).toBe('list');
  });

  it('classifies analysis projects without itemCount or kind', () => {
    const analysis = {
      question: 'Is buying fermented bean paste for resale in Poland profitable?',
      acceptance: {},
    };
    expect(contractClass(analysis)).toBe('analysis');
  });
});

describe('listing pieces', () => {
  it('knows which pieces ask for specific listings', () => {
    expect(asksForItems(piece('Which coastal land parcels in Spain are listed for sale under 20,000 EUR?'))).toBe(true);
    expect(asksForItems(piece('Identify specific plots under 20 000 EUR with direct URLs'))).toBe(true);
    expect(asksForItems(piece('What is the average summer temperature in Algarve?'))).toBe(false);
    expect(asksForItems(piece('What is the average nightly rate (EUR) for glamping listings located within 5 km of the sea?'))).toBe(false);
    expect(asksForItems(piece('Affordable coastal plot listings for glamping'))).toBe(true);
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

describe('listCount and contractClass with FRL_ANSWER_UNIT', () => {
  const baseProject = (overrides: Record<string, any> = {}) => ({
    question: 'How many residential heat pumps were installed in Czechia in 2024? Give the figure with its source.',
    acceptance: { expected: 'one figure for 2024 with its source and link', itemCount: 1 },
    decisionModel: { answerUnit: null, answerUnitQuote: '' },
    ...overrides,
  });

  it('listCount returns null for grounded number unit under the flag and itemCount without it', () => {
    const project = baseProject({
      decisionModel: { answerUnit: 'number', answerUnitQuote: 'one figure for 2024' },
    });
    expect(listCount(project)).toBe(1);
    process.env.FRL_ANSWER_UNIT = '1';
    try {
      expect(listCount(project)).toBeNull();
    } finally {
      delete process.env.FRL_ANSWER_UNIT;
    }
  });

  it('listCount returns itemCount for non-number unit', () => {
    const project = baseProject({
      decisionModel: { answerUnit: 'items', answerUnitQuote: 'list of heat pumps' },
    });
    expect(listCount(project)).toBe(1);
  });

  it('listCount returns itemCount when unit is null', () => {
    const project = baseProject({ decisionModel: { answerUnit: null, answerUnitQuote: '' } });
    expect(listCount(project)).toBe(1);
  });

  it('contractClass turns a kind-bearing list into analysis only for a grounded number unit under the flag', () => {
    const project = baseProject({
      decisionModel: { kind: { label: 'heat pump', terms: ['heat pump'] }, answerUnit: 'number', answerUnitQuote: 'one figure for 2024' },
    });
    expect(contractClass(project)).toBe('list');
    process.env.FRL_ANSWER_UNIT = '1';
    try {
      expect(contractClass(project)).toBe('analysis');
    } finally {
      delete process.env.FRL_ANSWER_UNIT;
    }
  });

  it('contractClass leaves a non-number unit to the existing rule under the flag', () => {
    const project = baseProject({
      decisionModel: { kind: { label: 'heat pump', terms: ['heat pump'] }, answerUnit: 'items', answerUnitQuote: 'list of heat pumps' },
    });
    process.env.FRL_ANSWER_UNIT = '1';
    try {
      expect(contractClass(project)).toBe('list');
    } finally {
      delete process.env.FRL_ANSWER_UNIT;
    }
  });

  it('contractClass returns analysis for itemCount 1 when flag off (uses itemCountFromWords)', () => {
    const project = baseProject({
      decisionModel: { answerUnit: 'number', answerUnitQuote: 'one figure for 2024' },
    });
    expect(contractClass(project)).toBe('analysis');
  });
});

describe('answersWithNumber with FRL_UNIT_EVERY_QUESTION', () => {
  const asked = { answerUnit: 'number', answerUnitQuote: 'Give the figure in EUR', answerUnitShare: 1, question: 'q', guidance: '', samples: 3 };
  const withFlags = (flags: string[], body: () => void) => {
    for (const flag of flags) process.env[flag] = '1';
    try {
      body();
    } finally {
      for (const flag of flags) delete process.env[flag];
    }
  };

  it('reads the unit voted for a question without an item count', async () => {
    const { answersWithNumber, askedUnit } = await import('../../src/research/deliverable.mjs');
    const project = { question: 'What was the average gross monthly wage in Slovakia in 2024? Give the figure in EUR with its source.', acceptance: { expected: '', itemCount: null }, answerUnit: asked };
    expect(answersWithNumber(project)).toBe(false);
    withFlags(['FRL_ANSWER_UNIT'], () => expect(answersWithNumber(project)).toBe(false));
    withFlags(['FRL_ANSWER_UNIT', 'FRL_UNIT_EVERY_QUESTION'], () => {
      expect(askedUnit(project)).toBe('number');
      expect(answersWithNumber(project)).toBe(true);
      expect(contractClass(project)).toBe('analysis');
      expect(answersWithNumber({ ...project, answerUnit: { ...asked, answerUnitQuote: '' } })).toBe(false);
      expect(answersWithNumber({ ...project, answerUnit: { ...asked, answerUnit: 'claim' } })).toBe(false);
    });
  });

  it('lets a grounded decision-model unit win over the question unit', async () => {
    const { answersWithNumber, askedUnit } = await import('../../src/research/deliverable.mjs');
    const project = { question: 'q', acceptance: { itemCount: 3 }, decisionModel: { answerUnit: 'items', answerUnitQuote: 'Find 3' }, answerUnit: asked };
    withFlags(['FRL_ANSWER_UNIT', 'FRL_UNIT_EVERY_QUESTION'], () => {
      expect(askedUnit(project)).toBe('items');
      expect(answersWithNumber(project)).toBe(false);
    });
  });
});
