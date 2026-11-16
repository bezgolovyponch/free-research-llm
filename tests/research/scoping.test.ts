import { describe, expect, it } from 'vitest';
import { MAX_SOURCES, composeQueries, perspectives, runScoping, scopeNotes, screenSources, screeningSubject, subjectLabels, subjectLevels } from '../../src/research/scoping.mjs';
import { CallBudget } from '../../src/research/semantic.mjs';
import { quoteFound } from '../../src/research/quote.mjs';
import { fakeEmbedder, fakeRouter, seq } from '../helpers/fakes';

const views = [
  { name: 'Workshop', aspects: [{ lang: 'English', phrase: 'known faults' }, { lang: 'Czech', phrase: 'časté závady' }] },
  { name: 'Owners', aspects: [{ lang: 'Czech', phrase: 'zkušenosti majitelů' }] },
];

describe('scoping queries are composed by code', () => {
  it('joins a real subject label with a phrase per market language, never a query a model wrote', () => {
    const queries = composeQueries(['Brand Alpha 1.2', 'Brand Beta'], views);
    expect(queries.map((q: { query: string }) => q.query)).toEqual(['Brand Alpha 1.2 known faults', 'Brand Beta časté závady', 'Brand Alpha 1.2 zkušenosti majitelů']);
    expect(new Set(queries.map((q: { lang: string }) => q.lang))).toEqual(new Set(['English', 'Czech']));
    expect(queries.every((q: { query: string; subject: string }) => q.query.startsWith(q.subject))).toBe(true);
    expect(composeQueries([], views)).toEqual([]);
    expect(composeQueries(['x'], views, 2)).toHaveLength(2);
  });

  it('takes the most frequent groups of the candidate table at each level, or the kind without a table', () => {
    const rows = [{ subject: ['Alpha', '1.2'] }, { subject: ['Alpha', '1.2'] }, { subject: ['Alpha', '1.4'] }, { subject: ['Beta', '1.0'] }, { subject: ['Beta'] }, {}];
    expect(subjectLabels(rows, ['make', 'engine'], 'car')).toEqual(['Alpha', 'Beta', 'Alpha 1.2', 'Alpha 1.4', 'Beta 1.0']);
    expect(subjectLabels([], ['make'], 'car')).toEqual(['car']);
    expect(screeningSubject(['car'], 'car')).toBe('car');
    expect(screeningSubject(['Alpha', 'Beta', 'Alpha 1.2'], 'car')).toBe('car (any of: Alpha; Beta; Alpha 1.2)');
    expect(screeningSubject([], 'car')).toBe('car');
  });

  it('repeats the perspectives call once when a market language has no phrase', async () => {
    const router = fakeRouter({ perspectives: seq({ perspectives: [{ name: 'Workshop', aspects: [{ lang: 'English', phrase: 'known faults' }, { lang: 'Klingon', phrase: 'x' }] }] }, { perspectives: views }) });
    const list = await perspectives({ router }, { question: 'q', languages: ['English', 'Czech'] });
    expect(router.count('perspectives')).toBe(2);
    expect(router.calls[1].messages[2].content).toContain('no aspect phrase in: Czech');
    expect(list).toEqual(views);
    expect(router.calls[0]).toMatchObject({ tier: 'deep', purpose: 'purpose-draft' });
  });

  it('keeps at most 2 phrases a language and 6 words a phrase', async () => {
    const router = fakeRouter({ perspectives: { perspectives: [{ name: 'One', aspects: [{ lang: 'english', phrase: 'a b c d e f g h' }, { lang: 'English', phrase: 'two' }, { lang: 'English', phrase: 'three' }] }] } });
    const list = await perspectives({ router }, { question: 'q', languages: ['English'] });
    expect(list[0].aspects).toEqual([{ lang: 'English', phrase: 'a b c d e f' }, { lang: 'English', phrase: 'two' }]);
  });
});

describe('subject levels', () => {
  it('uses the kind alone when there are no listing titles', async () => {
    const router = fakeRouter({});
    expect(await subjectLevels({ router }, { question: 'q', kind: 'widget', titles: [] })).toEqual(['widget']);
    expect(router.calls).toEqual([]);
  });

  it('keeps the levels 2 of 3 samples name', async () => {
    const router = fakeRouter({ 'subject-levels': seq({ levels: ['make', 'model', 'engine'] }, { levels: ['Make', 'model'] }, { levels: ['colour', 'trim'] }), 'subject-levels-match': { pick: 'N' } });
    const levels = await subjectLevels({ router, embedder: fakeEmbedder() }, { question: 'q', kind: 'widget', titles: ['Alpha 1.2 widget'] });
    expect(levels).toEqual(['make', 'model']);
    expect(router.calls[0].temperature).toBe(0.7);
  });
});

const page = (name: string) => `${name} is a workshop report on the asked model. The rear axle beam rusts at the mount. Owners in the country report it after ten years.`;
const sources = [
  { url: 'https://garage.example.cz/report', title: 'On subject', text: page('This') },
  { url: 'https://other.example.com/trax', title: 'Other subject', text: page('That') },
  { url: 'https://empty.example.com/x', title: 'Not informative', text: page('It') },
  { url: 'https://abroad.example.com/y', title: 'Other market', text: page('Abroad') },
  { url: 'https://invented.example.com/z', title: 'Invented span', text: page('Invented') },
  { url: 'https://silent.example.com/s', title: 'No answer', text: page('Silent') },
];

describe('sources are kept on a grounded judgement of subject and market', () => {
  const judge = (request: { messages: { content: string }[] }) => {
    const text = request.messages[1].content;
    if (text.includes('Source title: On subject')) return { about: 'A', market: 'B', span: 'S2' };
    if (text.includes('Source title: Other subject')) return { about: 'C', market: 'A', span: 'S1' };
    if (text.includes('Source title: Not informative')) return { about: 'D', market: 'A', span: null };
    if (text.includes('Source title: Other market')) return { about: 'B', market: 'C', span: 'S1' };
    if (text.includes('Source title: Invented span')) return { about: 'A', market: 'A', span: 'S99' };
    return { about: 'maybe' };
  };

  it('drops a source judged C or D, another market, an invented span or no answer, each with its reason', async () => {
    const router = fakeRouter({ 'source-relevance': judge });
    const { kept, dropped } = await screenSources({ router, embedder: fakeEmbedder() }, { sources, purpose: 'buy a reliable car', subject: 'Alpha 1.2', markets: ['Czechia'], regions: ['CZ'] });
    expect(kept.map((s: { url: string; about: string; market: string; span: string; spanQuote: string }) => [s.url, s.about, s.market, s.span, s.spanQuote])).toEqual([['https://garage.example.cz/report', 'A', 'B', 'S2', 'The rear axle beam rusts at the mount.']]);
    expect(dropped).toEqual([
      { url: 'https://other.example.com/trax', reason: 'off-subject: a different subject' },
      { url: 'https://empty.example.com/x', reason: 'off-subject: not informative' },
      { url: 'https://abroad.example.com/y', reason: 'off-market: describes another market' },
      { url: 'https://invented.example.com/z', reason: 'no sentence on the page shows it' },
      { url: 'https://silent.example.com/s', reason: 'not judged' },
    ]);
  });

  it('gives the page country signal to the model as one input line, and never decides by it', async () => {
    const router = fakeRouter({ 'source-relevance': { about: 'A', market: 'A', span: 'S1' } });
    const { kept } = await screenSources({ router, embedder: fakeEmbedder() }, { sources: sources.slice(0, 2), purpose: 'p', subject: 's', markets: ['Czechia'], regions: ['CZ'] });
    expect(router.userText('source-relevance', 0)).toContain('Country signal read from the page address and text: in CZ');
    expect(router.userText('source-relevance', 1)).toContain('Country signal read from the page address and text: outside CZ');
    expect(kept).toHaveLength(2);
  });

  it('screens at most 12 sources and one call each', async () => {
    const router = fakeRouter({ 'source-relevance': { about: 'A', market: 'A', span: 'S1' } });
    const many = Array.from({ length: 14 }, (_, i) => ({ url: `https://s${i}.example.com/`, title: `T${i}`, text: page('This') }));
    const { kept, dropped } = await screenSources({ router, embedder: fakeEmbedder() }, { sources: many, purpose: 'p', subject: 's' });
    expect(kept).toHaveLength(MAX_SOURCES);
    expect(router.calls).toHaveLength(MAX_SOURCES);
    expect(dropped.map((d: { reason: string }) => d.reason)).toEqual(['not screened: over the limit of 12 sources', 'not screened: over the limit of 12 sources']);
  });
});

describe('scope notes are sentences of the page', () => {
  it('builds every note from sentence ids, and drops a note with an invented id', async () => {
    const router = fakeRouter({ 'scope-notes': { notes: [{ spans: ['S2'], label: 'rust at the rear axle mount of older cars today' }, { spans: ['S2', 'S3'], label: 'two sentences' }, { spans: ['S44'], label: 'invented' }, { label: 'no ids' }] } });
    const { notes, rejected } = await scopeNotes({ router }, { sources: [sources[0]], purpose: 'p' });
    expect(notes.map((n: { id: string; quote: string; label: string }) => [n.id, n.quote, n.label])).toEqual([
      ['N1', 'The rear axle beam rusts at the mount.', 'rust at the rear axle mount of older'],
      ['N2', 'The rear axle beam rusts at the mount. Owners in the country report it after ten years.', 'two sentences'],
    ]);
    expect(notes.every((n: { quote: string }) => quoteFound(sources[0].text, n.quote))).toBe(true);
    expect(rejected).toHaveLength(2);
    expect(router.userText('scope-notes')).toContain('[S2] The rear axle beam rusts at the mount.');
  });
});

describe('runScoping', () => {
  it('searches the composed queries, stores what was kept and dropped, and says when too few sources were kept', async () => {
    const searched: string[][] = [];
    const search = { search: async (queries: string[]) => { searched.push(queries); return sources.slice(0, 2); } };
    const router = fakeRouter({
      perspectives: { perspectives: views },
      'source-relevance': (request: { messages: { content: string }[] }) => (request.messages[1].content.includes('On subject') ? { about: 'A', market: 'A', span: 'S2' } : { about: 'C', market: 'A', span: 'S1' }),
      'scope-notes': { notes: [{ spans: ['S3'], label: 'owner reports' }] },
    });
    const budget = new CallBudget();
    const { scoping, pages } = await runScoping({ router, embedder: fakeEmbedder(), search, budget }, { question: 'q', kind: 'widget', regions: ['CZ'], markets: ['Czechia'], languages: ['English', 'Czech'] });
    expect(searched[0]).toEqual(['widget known faults', 'widget časté závady', 'widget zkušenosti majitelů']);
    expect(scoping.levels).toEqual(['widget']);
    expect(scoping.sources).toEqual([{ url: 'https://garage.example.cz/report', title: 'On subject', host: 'garage.example.cz', about: 'A', market: 'A', span: 'S2', judgedBy: 'p1' }]);
    expect(scoping.dropped).toEqual([{ url: 'https://other.example.com/trax', reason: 'off-subject: a different subject' }]);
    expect(scoping.notes).toEqual([{ id: 'N1', url: 'https://garage.example.cz/report', quote: 'Owners in the country report it after ten years.', label: 'owner reports' }]);
    expect(scoping.enough).toBe(false);
    expect(scoping.embedModel).toBe('fake-embed');
    expect(pages).toHaveLength(1);
    expect(budget.report().scoping.used).toBe(4);
  });
});
