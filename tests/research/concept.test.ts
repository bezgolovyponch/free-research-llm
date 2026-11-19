import { describe, expect, it } from 'vitest';
import { CONCEPT_MARKER, CONCEPT_PAGES, CONCEPT_QUERIES, CONCEPT_SAMPLES, MIN_PAGES, applyConceptCard, conceptCardPrompt, conceptPages, conceptQueries, conceptQueryPrompt, mergeConceptCards, mentionsPhrase } from '../../src/research/concept.mjs';

describe('concept card', () => {
  it('keeps the numbers the engine runs with', () => {
    expect([CONCEPT_QUERIES, CONCEPT_PAGES, CONCEPT_SAMPLES, MIN_PAGES]).toEqual([6, 10, 3, 2]);
    expect(CONCEPT_MARKER).toBe('TASK=CONCEPT_CARD');
  });

  it('names a phrase on word boundaries, and a single word only as a whole word or its stem', () => {
    expect(mentionsPhrase('We sell used clothing in Prague', 'used clothing')).toBe(true);
    expect(mentionsPhrase('We sell used clothes in Prague', 'used clothing')).toBe(false);
    expect(mentionsPhrase('We sell car tires', 'car')).toBe(true);
    expect(mentionsPhrase('We sell cars', 'car')).toBe(false);
    expect(mentionsPhrase('We sell cars', 'cars')).toBe(true);
    expect(mentionsPhrase('České obchody s oblečením', 'české')).toBe(true);
    expect(mentionsPhrase('Any page', '  ')).toBe(false);
    expect(mentionsPhrase('Any page', '')).toBe(false);
  });

  it('asks the model for queries that name the item in the words sellers use, in every asked language', () => {
    const prompt = conceptQueryPrompt({ kind: { label: 'plot of land', terms: ['land', 'oikopedo'] }, question: 'Where can I buy land?', languages: ['English', 'Greek'] });
    expect(prompt).toHaveLength(2);
    expect(prompt[0].role).toBe('system');
    expect(prompt[0].content).toContain('JSON only');
    expect(prompt[1].content).toContain('Item: plot of land (words sellers use: land, oikopedo)');
    expect(prompt[1].content).toContain('Where can I buy land?');
    expect(prompt[1].content).toContain(`Write ${CONCEPT_QUERIES} queries`);
    expect(prompt[1].content).toContain('one in each of these languages: Greek');
    expect(prompt[1].content).not.toContain('languages: English');
    expect(conceptQueryPrompt({ kind: { label: 'land' }, question: 'q', languages: ['English'] })[1].content).toContain('languages: none');
  });

  it('shows the pages to the model and marks the task it answers', () => {
    const prompt = conceptCardPrompt({ kind: { label: 'plot of land', terms: ['land'] }, question: 'Which land?', pages: [{ id: 'P1', title: 'Land for sale', text: 'cheap land in Crete' }] });
    expect(prompt[0].content).toContain('"terms"');
    expect(prompt[0].content).toContain('"not"');
    expect(prompt[0].content).toContain('"hubs"');
    expect(prompt[1].content).toContain(CONCEPT_MARKER);
    expect(prompt[1].content).toContain('Item asked: plot of land (first guess: land)');
    expect(prompt[1].content).toContain('[P1] Land for sale');
    expect(prompt[1].content).toContain('cheap land in Crete');
  });

  it('keeps the phrases most of the proposals name, and counts the answers that came', () => {
    const merged = mergeConceptCards([
      { data: { terms: ['land', 'oikopedo'], not: ['spares'], hubs: [] } },
      { data: { terms: ['land'], not: ['spares', 'retail shop'], hubs: ['Greece'] } },
      { data: { terms: ['land', 'parcels'], not: [], hubs: ['Greece'] } },
    ]);
    expect(merged.data).toEqual({ terms: ['land'], not: ['spares'], hubs: ['greece'] });
    expect(merged.samples).toBe(3);
    const one = mergeConceptCards([{ data: { terms: ['land'], not: [], hubs: [] } }, { provider: 'p', model: 'm' }]);
    expect(one.data.terms).toEqual(['land']);
    expect(one.samples).toBe(1);
  });

  it('keeps only the phrases the pages state, and drops the ones a single page carries', () => {
    const pages = [
      { title: 'Land for sale in Crete', text: 'cheap plots of land' },
      { title: 'Land parcels', text: 'land for sale' },
      { title: 'Cars for sale', text: 'used cars cheap' },
    ];
    expect(applyConceptCard({ terms: ['land', 'cars'], not: ['spares'], hubs: ['Crete'] }, pages)).toEqual({ terms: ['land'], not: [], hubs: [], pages: 3 });
    expect(applyConceptCard({ terms: ['land', 'land'], not: [], hubs: [] }, pages).terms).toEqual(['land']);
    expect(applyConceptCard({}, pages)).toEqual({ terms: [], not: [], hubs: [], pages: 3 });
  });

  it('builds the fallback queries from the item words and the asked languages', () => {
    const queries = conceptQueries({ label: 'plot of land', terms: ['land', 'oikopedo'] }, {}, ['English', 'Greek']);
    expect(queries).toEqual(['plot of land land supplier', 'plot of land b2b seller', 'land oikopedo wholesale', 'plot of land Greek']);
    expect(conceptQueries({ label: 'land' }, {}, ['English'])).toEqual(['land land supplier', 'land b2b seller']);
    expect(conceptQueries({}, {}, ['English'])).toEqual([]);
    expect(conceptQueries({ label: 'land', terms: ['land'] }, {}, ['English', 'Greek', 'Turkish', 'Spanish']).length).toBeLessThanOrEqual(CONCEPT_QUERIES);
  });

  it('turns search results into the pages the model reads, numbered and capped', () => {
    const sources = Array.from({ length: 12 }, (_, i) => ({ title: `Page ${i + 1}`, url: `https://example.test/${i + 1}`, snippet: 'snippet', text: 'body' }));
    const pages = conceptPages(sources);
    expect(pages).toHaveLength(CONCEPT_PAGES);
    expect(pages[0]).toEqual({ id: 'P1', title: 'Page 1', url: 'https://example.test/1', text: 'Page 1 snippet body' });
    expect(pages.at(-1)?.id).toBe('P10');
    expect(conceptPages([{ title: 'x'.repeat(300), url: 'https://example.test/long', snippet: '', text: '' }])[0].title).toHaveLength(200);
  });
});
