import { describe, expect, it } from 'vitest';
import { COST_BASIS, COST_GOAL, VALUE_BASIS, VALUE_GOAL } from '../../src/research/purpose.mjs';
import { MAX_SOURCES, MIN_HOSTS, MIN_PERSPECTIVES, SUBJECT_CHARS, askedSubject, composeQueries, diversityOf, findSources, fixedPerspectives, pageKey, perspectives, relevanceReason, requirementSubjects, runScoping, scopeNotes, scopingCap, screenSources, screeningSubject, subjectLabels, subjectLevels } from '../../src/research/scoping.mjs';
import { CallBudget } from '../../src/research/semantic.mjs';
import { quoteFound } from '../../src/research/quote.mjs';
import { fakeEmbedder, fakeRouter, lettersOf, seq } from '../helpers/fakes';

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
    const asked = [{ id: 'C1', kind: 'clause', text: 'Find open-source PDF parsing  libraries for Node.js' }, { id: 'C2', kind: 'clause', text: 'actively maintained' }, { id: 'H1', kind: 'hint', text: 'ask the forum' }];
    expect(screeningSubject(['library'], 'library', asked)).toBe('library, as asked: Find open-source PDF parsing libraries for Node.js; actively maintained');
    expect(screeningSubject([], '', asked)).toBe('Find open-source PDF parsing libraries for Node.js; actively maintained');
    expect(screeningSubject(['Alpha', 'Beta'], 'car', asked)).toBe('car (any of: Alpha; Beta)');
    expect(screeningSubject([], 'library', [{ id: 'H1', kind: 'hint', text: 'ask the forum' }])).toBe('library');
    expect(askedSubject('k', [{ id: 'C1', kind: 'clause', text: 'x'.repeat(500) }])).toHaveLength('k, as asked: '.length + SUBJECT_CHARS);
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

  it('drops a source judged C or D, a market source of another market, an invented span or no answer, each with its reason', async () => {
    const router = fakeRouter({ 'source-relevance': judge, 'source-role': { role: 'B' } });
    const { kept, dropped } = await screenSources({ router, embedder: fakeEmbedder() }, { sources, purpose: 'buy a reliable car', subject: 'Alpha 1.2', markets: ['Czechia'], regions: ['CZ'] });
    expect(kept.map((s: { url: string; about: string; market: string; span: string; spanQuote: string; role: string }) => [s.url, s.about, s.market, s.span, s.spanQuote, s.role])).toEqual([['https://garage.example.cz/report', 'A', 'B', 'S2', 'The rear axle beam rusts at the mount.', 'market']]);
    expect(dropped).toEqual([
      { url: 'https://other.example.com/trax', reason: 'off-subject: a different subject' },
      { url: 'https://empty.example.com/x', reason: 'off-subject: not informative' },
      { url: 'https://abroad.example.com/y', reason: 'off-market: describes another market', role: 'market', roleVotes: { B: 2 } },
      { url: 'https://invented.example.com/z', reason: 'no sentence on the page shows it' },
      { url: 'https://silent.example.com/s', reason: 'not judged' },
    ]);
    expect(router.count('source-role')).toBe(4);
    expect(router.userText('source-relevance', 3)).toContain('Source title: Other market');
  });

  it('keeps a knowledge source about another market, drops a market source about another market, and never drops on an undecided role', async () => {
    const abroad = [
      { url: 'https://guide.example.com/how', title: 'How to choose', text: page('Guide') },
      { url: 'https://offers.example.com/list', title: 'Offers abroad', text: page('Offers') },
      { url: 'https://split.example.com/x', title: 'Split vote', text: page('Split') },
    ];
    const role = (request: { messages: { content: string }[] }, index: number) => {
      const text = request.messages[1].content;
      if (text.includes('Source title: How to choose')) return { role: 'A' };
      if (text.includes('Source title: Offers abroad')) return { role: 'b' };
      return [{ role: 'A' }, { role: 'B' }, { role: 'neither' }, { role: 'neither' }][index - 4];
    };
    const router = fakeRouter({ 'source-relevance': { about: 'B', market: 'C', span: 'S2' }, 'source-role': role });
    const { kept, dropped } = await screenSources({ router, embedder: fakeEmbedder() }, { sources: abroad, purpose: 'buy a reliable car', subject: 'Alpha 1.2', markets: ['Czechia'], regions: ['CZ'] });
    expect(kept.map((s: { url: string; market: string; role: string; roleVotes: object }) => [s.url, s.market, s.role, s.roleVotes])).toEqual([
      ['https://guide.example.com/how', 'C', 'knowledge', { A: 2 }],
      ['https://split.example.com/x', 'C', 'undecided', { A: 1, B: 1 }],
    ]);
    expect(dropped).toEqual([{ url: 'https://offers.example.com/list', reason: 'off-market: describes another market', role: 'market', roleVotes: { B: 2 } }]);
    const asked = router.userText('source-role');
    expect(lettersOf(router.calls.filter((call) => call.task === 'source-role')[0])).toEqual(expect.objectContaining({ 'explains how to judge or choose such a thing: what decides, methods, criteria, risks, whatever place it describes': expect.stringMatching(/^[AB]$/), 'describes a market: offers, prices, availability or local rules': expect.stringMatching(/^[AB]$/) }));
    const roleCalls = router.calls.filter((call) => call.task === 'source-role');
    expect(roleCalls[0].choice).toMatchObject({ field: 'role', options: 2 });
    expect(roleCalls[1].choice!.ids).toEqual([...roleCalls[0].choice!.ids!].reverse());
    expect(asked).toContain('[S2] The rear axle beam rusts at the mount.');
    expect(asked).not.toContain('Asked market');
    expect(router.calls.filter((call) => call.task === 'source-role').slice(0, 2).map((call) => call.avoid)).toEqual([undefined, ['p1']]);
    expect(relevanceReason({ about: 'A', market: 'C', span: 'S1' })).toBe('off-market: describes another market');
    expect(relevanceReason({ about: 'A', market: 'C', span: 'S1' }, 'knowledge')).toBe('');
    expect(relevanceReason({ about: 'C', market: 'A', span: 'S1' }, 'knowledge')).toBe('off-subject: a different subject');
  });

  it('never drops a source on a role only one provider family gave: the role stays undecided', async () => {
    const offers = [{ url: 'https://offers.example.com/list', title: 'Offers abroad', text: page('Offers') }];
    const script = { 'source-relevance': { about: 'B', market: 'C', span: 'S2' }, 'source-role': { role: 'B' } };
    const alone = fakeRouter(script, { providers: ['p1'] });
    const one = await screenSources({ router: alone, embedder: fakeEmbedder() }, { sources: offers, purpose: 'buy a reliable car', subject: 'Alpha 1.2', markets: ['Czechia'], regions: ['CZ'] });
    expect(one.dropped).toEqual([]);
    expect(one.kept.map((s: { url: string; role: string }) => [s.url, s.role])).toEqual([['https://offers.example.com/list', 'undecided']]);
    const two = await screenSources({ router: fakeRouter(script), embedder: fakeEmbedder() }, { sources: offers, purpose: 'buy a reliable car', subject: 'Alpha 1.2', markets: ['Czechia'], regions: ['CZ'] });
    expect(two.dropped.map((s: { role: string }) => s.role)).toEqual(['market']);
  });

  it('gives the page country signal to the model as one input line, and never decides by it', async () => {
    const router = fakeRouter({ 'source-relevance': { about: 'A', market: 'A', span: 'S1' } });
    const { kept } = await screenSources({ router, embedder: fakeEmbedder() }, { sources: sources.slice(0, 2), purpose: 'p', subject: 's', markets: ['Czechia'], regions: ['CZ'] });
    expect(router.userText('source-relevance', 0)).toContain('Country signal read from the page address and text: in CZ');
    expect(router.userText('source-relevance', 1)).toContain('Country signal read from the page address and text: outside CZ');
    expect(kept).toHaveLength(2);
  });

  it('screens at most 12 sources: one judgement each, and two agreeing role votes for a source on subject', async () => {
    const router = fakeRouter({ 'source-relevance': { about: 'A', market: 'A', span: 'S1' }, 'source-role': { role: 'A' } });
    const many = Array.from({ length: 14 }, (_, i) => ({ url: `https://s${i}.example.com/`, title: `T${i}`, text: page('This') }));
    const { kept, dropped } = await screenSources({ router, embedder: fakeEmbedder() }, { sources: many, purpose: 'p', subject: 's' });
    expect(kept).toHaveLength(MAX_SOURCES);
    expect(router.count('source-relevance')).toBe(MAX_SOURCES);
    expect(router.count('source-role')).toBe(2 * MAX_SOURCES);
    expect(dropped.map((d: { reason: string }) => d.reason)).toEqual(['not screened: over the limit of 12 sources', 'not screened: over the limit of 12 sources']);
    const few = await screenSources({ router: fakeRouter({ 'source-relevance': { about: 'A', market: 'A', span: 'S1' }, 'source-role': { role: 'A' } }), embedder: fakeEmbedder() }, { sources: many.slice(0, 3), purpose: 'p', subject: 's', limit: 2 });
    expect(few.dropped).toEqual([{ url: 'https://s2.example.com/', reason: 'not screened: over the limit of 2 sources' }]);
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

const fixed = {
  value: [{ lang: 'English', phrase: 'what makes one good' }, { lang: 'Czech', phrase: 'jak poznat kvalitu' }],
  cost: [{ lang: 'English', phrase: 'all costs of owning' }, { lang: 'Czech', phrase: 'celkové náklady' }],
};

describe('a value perspective and a cost perspective are always present', () => {
  it('asks a model only for their phrases in the market languages; the names and the basis are set by code', async () => {
    const router = fakeRouter({ 'fixed-perspectives': seq({ value: fixed.value, cost: [{ lang: 'English', phrase: 'all costs of owning' }] }, fixed) });
    const list = await fixedPerspectives({ router }, { question: 'q', languages: ['English', 'Czech'] });
    expect(router.count('fixed-perspectives')).toBe(2);
    expect(router.calls[1].messages[2].content).toContain('"cost" has no aspect phrase in: Czech');
    expect(list).toEqual([
      { name: VALUE_GOAL, role: 'value', basis: VALUE_BASIS, aspects: fixed.value },
      { name: COST_GOAL, role: 'cost', basis: COST_BASIS, aspects: fixed.cost },
    ]);
    expect(router.calls[0].messages[0].content).toContain('"value": what the result must do for the purpose');
    expect(router.calls[0].messages[0].content).toContain('"cost": everything it takes to obtain and use the result');
  });

  it('keeps both with one phrase set by code when no model answers, and says so', async () => {
    const log: string[] = [];
    const list = await fixedPerspectives({ router: fakeRouter({}), log: (line: string) => log.push(line) }, { question: 'q', languages: ['English', 'Czech'] });
    expect(list.map((view: { role: string; aspects: unknown; fallback?: boolean }) => [view.role, view.aspects, view.fallback])).toEqual([
      ['value', [{ lang: 'English', phrase: 'how to choose' }], true],
      ['cost', [{ lang: 'English', phrase: 'total cost' }], true],
    ]);
    expect(log).toEqual(['scoping: no model phrased the value and cost perspectives; each keeps one phrase set by code']);
  });

  it('gives every perspective a query before any perspective gets a second one', () => {
    const many = [
      { name: 'V', aspects: [{ lang: 'English', phrase: 'v1' }, { lang: 'English', phrase: 'v2' }] },
      { name: 'C', aspects: [{ lang: 'English', phrase: 'c1' }, { lang: 'English', phrase: 'c2' }] },
      { name: 'P', aspects: [{ lang: 'English', phrase: 'p1' }, { lang: 'English', phrase: 'p2' }] },
    ];
    expect(composeQueries(['x'], many, 4).map((q: { query: string; perspective: string }) => [q.query, q.perspective])).toEqual([['x v1', 'V'], ['x c1', 'C'], ['x p1', 'P'], ['x v2', 'V']]);
    expect(composeQueries(['x'], many, 12, { used: ['x v1', 'x c1', 'x p1', 'x v2'], first: ['P'], shift: 1 }).map((q: { query: string }) => q.query)).toEqual(['x p2', 'x c2']);
    expect(composeQueries(['x', 'y'], many.slice(0, 1), 12, { used: ['x v1', 'y v2'], shift: 1 }).map((q: { query: string }) => q.query)).toEqual(['y v1', 'x v2']);
    expect(composeQueries(['x'], many.slice(0, 1), 12, { used: ['x v1', 'x v2'], shift: 1 })).toEqual([]);
  });
});

describe('queries are composed from what the requirements mean', () => {
  const requirements = [
    { id: 'C1', kind: 'clause', text: 'Find open-source PDF parsing libraries for Node.js' },
    { id: 'C2', kind: 'clause', text: 'actively maintained and well documented' },
    { id: 'H1', kind: 'hint', text: 'ask the forum' },
  ];
  const good = { subjects: [
    { anchor: 'C1', phrase: 'PDF parsing libraries for Node.js', translations: [{ lang: 'Czech', phrase: 'knihovny pro čtení PDF v Node.js' }, { lang: 'Klingon', phrase: 'x' }] },
    { anchor: 'C2', phrase: 'well documented PDF libraries', translations: [{ lang: 'Czech', phrase: 'dobře zdokumentované knihovny PDF' }] },
  ] };
  const nearest = (wanted: Record<string, number>) => fakeEmbedder((query, candidates) => [wanted[query] ?? 0, ...candidates.map((_, index) => index)]);

  it('takes one phrase per requirement, only of words of the requirements, and a translation only when it is nearest to its own phrase', async () => {
    const router = fakeRouter({ 'requirement-subjects': good });
    const embedder = nearest({ 'knihovny pro čtení PDF v Node.js': 0, 'dobře zdokumentované knihovny PDF': 0 });
    const drawn = await requirementSubjects({ router, embedder }, { requirements, languages: ['English', 'Czech'] });
    expect(drawn.subjects).toEqual([
      { anchor: 'C1', label: 'PDF parsing libraries for Node.js', translations: { Czech: 'knihovny pro čtení PDF v Node.js' } },
      { anchor: 'C2', label: 'well documented PDF libraries', translations: {} },
    ]);
    expect(drawn.rejected).toEqual([{ anchor: 'C2', lang: 'Czech', phrase: 'dobře zdokumentované knihovny PDF', reason: 'nearer in meaning to another requirement than to its own' }]);
    expect(router.count('requirement-subjects')).toBe(1);
    expect(router.calls[0]).toMatchObject({ tier: 'deep' });
    expect(router.userText('requirement-subjects')).toContain('[C2] actively maintained and well documented\nLanguages: English, Czech');
    expect(router.userText('requirement-subjects')).not.toContain('ask the forum');
    expect(embedder.calls.map((call) => [call.query, call.candidates])).toEqual([['knihovny pro čtení PDF v Node.js', ['PDF parsing libraries for Node.js', 'well documented PDF libraries']], ['dobře zdokumentované knihovny PDF', ['PDF parsing libraries for Node.js', 'well documented PDF libraries']]]);
  });

  it('asks once more when a phrase holds a word nobody wrote, then drops the phrases that still do; a translation that cannot be checked is not used', async () => {
    const invented = { subjects: [{ anchor: 'C1', phrase: 'best JavaScript PDF tools' }, { anchor: 'C2', phrase: 'PDF parsing libraries' }, { anchor: 'C9', phrase: 'PDF' }] };
    const router = fakeRouter({ 'requirement-subjects': seq(invented, { subjects: [{ anchor: 'C1', phrase: 'Node.js PDF parsing libraries open-source Find for', translations: [{ lang: 'Czech', phrase: 'knihovny PDF' }] }, { anchor: 'C2', phrase: 'PDF parsing libraries' }, { anchor: 'C1', phrase: 'PDF' }] }) });
    const drawn = await requirementSubjects({ router, embedder: fakeEmbedder() }, { requirements, languages: ['English', 'Czech'] });
    expect(router.calls[1].messages[2].content).toContain('the phrase for C1 has words that are not in the requirements: best, javascript, tools; the phrase for C2 has no word of its own requirement');
    expect(router.count('requirement-subjects')).toBe(2);
    expect(drawn.subjects).toEqual([{ anchor: 'C1', label: 'Node.js PDF parsing libraries open-source Find', translations: {} }]);
    expect(drawn.rejected).toEqual([{ anchor: 'C2', phrase: 'PDF parsing libraries', reason: 'no word of its own requirement' }, { anchor: 'C1', lang: 'Czech', phrase: 'knihovny PDF', reason: 'a translation that code could not check' }]);
  });

  it('falls back to nothing when the call fails or no phrase passes, and makes no call without requirements', async () => {
    expect(await requirementSubjects({ router: fakeRouter({}) }, { requirements })).toEqual({ subjects: [], rejected: [], failed: true });
    expect(await requirementSubjects({ router: fakeRouter({ 'requirement-subjects': { subjects: [{ anchor: 'C1', phrase: 'lending rules' }] } }) }, { requirements })).toEqual({ subjects: [], rejected: [], failed: true });
    const silent = fakeRouter({});
    expect(await requirementSubjects({ router: silent }, { requirements: [requirements[2]] })).toEqual({ subjects: [], rejected: [] });
    expect(silent.calls).toEqual([]);
  });

  it('puts the phrase of the query language in front of the aspect phrase', () => {
    const subjects = [{ anchor: 'C1', label: 'PDF parsing libraries for Node.js', translations: { Czech: 'knihovny pro čtení PDF v Node.js' } }];
    expect(composeQueries(subjects, views).map((q: { query: string; subject: string; lang: string }) => [q.query, q.subject, q.lang])).toEqual([
      ['PDF parsing libraries for Node.js known faults', 'PDF parsing libraries for Node.js', 'English'],
      ['knihovny pro čtení PDF v Node.js časté závady', 'knihovny pro čtení PDF v Node.js', 'Czech'],
      ['knihovny pro čtení PDF v Node.js zkušenosti majitelů', 'knihovny pro čtení PDF v Node.js', 'Czech'],
    ]);
  });

  const english = { value: [{ lang: 'English', phrase: 'what makes one good' }], cost: [{ lang: 'English', phrase: 'all costs of owning' }] };
  const script = (more: Record<string, unknown> = {}) => ({ 'fixed-perspectives': english, perspectives: { perspectives: [{ name: 'Maintainers', aspects: [{ lang: 'English', phrase: 'release history' }] }] }, 'source-relevance': { about: 'A', market: 'B', span: 'S1' }, 'source-role': { role: 'A' }, 'scope-notes': { notes: [] }, ...more });
  const run = async (router: ReturnType<typeof fakeRouter>, input: Record<string, unknown>) => {
    const searched: string[] = [];
    const log: string[] = [];
    const search = { search: async (queries: string[]) => { searched.push(...queries); return []; } };
    const { scoping } = await runScoping({ router, embedder: fakeEmbedder(), search, budget: new CallBudget(), log: (line: string) => log.push(line) }, { question: 'q', kind: 'library', languages: ['English'], ...input });
    return { scoping, searched, log: log.filter((line) => line.startsWith('scoping: ')) };
  };

  it('searches the library question for PDF parsing in Node.js, not for the kind word', async () => {
    const { scoping, searched, log } = await run(fakeRouter(script({ 'requirement-subjects': { subjects: [{ anchor: 'C1', phrase: 'PDF parsing libraries for Node.js' }, { anchor: 'C2', phrase: 'lending rules of libraries' }] } })), { requirements });
    expect(searched.slice(0, 3)).toEqual(['PDF parsing libraries for Node.js what makes one good', 'PDF parsing libraries for Node.js all costs of owning', 'PDF parsing libraries for Node.js release history']);
    expect(searched.every((query) => query.startsWith('PDF parsing libraries for Node.js ') && !query.startsWith('library '))).toBe(true);
    expect(scoping.subjects).toEqual(['PDF parsing libraries for Node.js']);
    expect(scoping.subjectsFrom).toBe('requirements');
    expect(scoping.askedSubjects.rejected).toEqual([{ anchor: 'C2', phrase: 'lending rules of libraries', reason: 'words that are not in the requirements: lending, rules, of' }]);
    expect(scoping.screened.subject).toBe('library, as asked: Find open-source PDF parsing libraries for Node.js; actively maintained and well documented');
    expect(log).toEqual(['scoping: subject phrase "lending rules of libraries" for C2 is not used: words that are not in the requirements: lending, rules, of']);
  });

  it('falls back to the kind label only when the call fails, and keeps the candidate labels when a table exists', async () => {
    const failed = await run(fakeRouter(script()), { requirements });
    expect(failed.searched.slice(0, 3)).toEqual(['library what makes one good', 'library all costs of owning', 'library release history']);
    expect(failed.scoping.subjectsFrom).toBe('kind');
    expect(failed.log).toEqual(['scoping: no subject phrase was drawn from the requirements; the queries use the kind label "library"']);
    const router = fakeRouter(script({ 'requirement-subjects': good, 'subject-levels': { levels: ['make', 'engine'] } }));
    const table = await run(router, { requirements, rows: [{ title: 'Alpha 1.2', subject: ['Alpha'] }, { title: 'Alpha 1.4', subject: ['Alpha'] }], titles: ['Alpha 1.2', 'Alpha 1.4'] });
    expect(router.count('requirement-subjects')).toBe(0);
    expect(table.searched.slice(0, 3)).toEqual(['Alpha what makes one good', 'Alpha all costs of owning', 'Alpha release history']);
    expect(table.scoping.subjectsFrom).toBe('table');
    expect(table.scoping.askedSubjects).toBeUndefined();
    expect(table.scoping.screened.subject).toBe('library (any of: Alpha)');
  });
});

describe('sources are found per perspective and counted by host', () => {
  it('searches each perspective on its own, merges a page two perspectives found, and puts the first page of each host first', async () => {
    const searched: { queries: string[]; maxSources: number }[] = [];
    const hits: Record<string, { url: string; title: string }[]> = {
      'x v1': [{ url: 'https://a.example.com/1', title: 'a1' }, { url: 'https://a.example.com/2', title: 'a2' }, { url: '', title: 'no address' }],
      'x c1': [{ url: 'https://a.example.com/1', title: 'a1' }, { url: 'https://www.b.example.com/1', title: 'b1' }],
      'x p1': [{ url: 'https://seen.example.com/1', title: 'seen' }, { url: 'https://c.example.com/1', title: 'c1' }],
    };
    const search = { search: async (queries: string[], options: { maxSources: number }) => { searched.push({ queries, maxSources: options.maxSources }); return queries.flatMap((query) => hits[query] ?? []); } };
    const queries = [{ query: 'x v1', perspective: 'V' }, { query: 'x c1', perspective: 'C' }, { query: 'x p1', perspective: 'P' }];
    const found = await findSources({ search }, queries, { max: 6, seen: ['https://seen.example.com/1'] });
    expect(searched).toEqual([{ queries: ['x v1'], maxSources: 3 }, { queries: ['x c1'], maxSources: 3 }, { queries: ['x p1'], maxSources: 3 }]);
    expect(found.map((source: { url: string; perspectives: string[] }) => [source.url, source.perspectives])).toEqual([
      ['https://a.example.com/1', ['V', 'C']],
      ['https://www.b.example.com/1', ['C']],
      ['https://c.example.com/1', ['P']],
      ['https://a.example.com/2', ['V']],
    ]);
    expect((await findSources({ search }, queries, { max: 2 })).map((source: { url: string }) => source.url)).toEqual(['https://a.example.com/1', 'https://seen.example.com/1']);
    const slashed = { search: async (list: string[]) => (list[0] === 'x v1' ? [{ url: 'https://shop.example.com', title: 'bare' }] : [{ url: 'https://www.shop.example.com/', title: 'slash' }, { url: 'http://seen.example.com/1/', title: 'seen' }]) };
    expect((await findSources({ search: slashed }, queries.slice(0, 2), { seen: ['https://seen.example.com/1'] })).map((source: { url: string; perspectives: string[] }) => [source.url, source.perspectives])).toEqual([['https://shop.example.com', ['V', 'C']]]);
    expect([pageKey('https://www.Shop.example.com/a/?q=1#top'), pageKey('not an address')]).toEqual(['shop.example.com/a?q=1', 'not an address']);
    expect(await findSources({ search: { search: async () => { throw new Error('down'); } } }, queries)).toEqual([]);
    expect(await findSources({}, queries)).toEqual([]);
  });

  it('counts distinct hosts and perspectives; enough is at least 4 hosts across at least 2 perspectives', () => {
    const at = (host: string, perspectives: string[]) => ({ url: `https://${host}/page`, perspectives });
    expect(diversityOf([at('www.a.example.com', ['V']), at('a.example.com', ['C']), at('b.example.com', ['V'])])).toEqual({ hosts: 2, perspectives: 2, perspectiveNames: ['V', 'C'], enough: false });
    expect(diversityOf([at('a.example.com', ['V']), at('b.example.com', ['V']), at('c.example.com', ['V']), at('d.example.com', ['V'])]).enough).toBe(false);
    expect(diversityOf([at('a.example.com', ['V']), at('b.example.com', ['V']), at('c.example.com', ['V']), at('d.example.com', ['C'])]).enough).toBe(true);
    expect(diversityOf([])).toEqual({ hosts: 0, perspectives: 0, perspectiveNames: [], enough: false });
    expect([MIN_HOSTS, MIN_PERSPECTIVES, scopingCap(), scopingCap(2)]).toEqual([4, 2, 80, 30]);
  });
});

describe('runScoping', () => {
  const pageAt = (host: string, title: string) => ({ url: `https://${host}/page`, title, text: page(title) });
  const script = (more: Record<string, unknown> = {}) => ({
    'fixed-perspectives': fixed,
    perspectives: { perspectives: views },
    'source-relevance': (request: { messages: { content: string }[] }) => (request.messages[1].content.includes('Source title: Off subject') ? { about: 'C', market: 'A', span: 'S1' } : { about: 'A', market: 'C', span: 'S2' }),
    'source-role': (request: { messages: { content: string }[] }) => ({ role: request.messages[1].content.includes('Source title: Offer') ? 'B' : 'A' }),
    'scope-notes': { notes: [{ spans: ['S3'], label: 'owner reports' }] },
    ...more,
  });
  const round1 = ['widget what makes one good', 'widget jak poznat kvalitu', 'widget all costs of owning', 'widget celkové náklady', 'widget known faults', 'widget časté závady', 'widget zkušenosti majitelů'];

  it('searches the composed queries of every perspective, keeps a knowledge source of another market, and stops after one round when 4 hosts across 2 perspectives are kept', async () => {
    const searched: string[][] = [];
    const byQuery: Record<string, { url: string; title: string; text: string }[]> = {
      'widget what makes one good': [pageAt('guide.example.com', 'Guide'), pageAt('other.example.com', 'Off subject')],
      'widget all costs of owning': [pageAt('costs.example.org', 'Costs'), pageAt('shop.example.com', 'Offer abroad')],
      'widget known faults': [pageAt('garage.example.cz', 'Garage'), pageAt('guide.example.com', 'Guide')],
      'widget zkušenosti majitelů': [pageAt('owners.example.cz', 'Owners')],
    };
    const search = { search: async (queries: string[]) => { searched.push(queries); return queries.flatMap((query) => byQuery[query] ?? []); } };
    const router = fakeRouter(script());
    const budget = new CallBudget();
    const log: string[] = [];
    const { scoping, pages } = await runScoping({ router, embedder: fakeEmbedder(), search, budget, log: (line: string) => log.push(line) }, { question: 'q', kind: 'widget', regions: ['CZ'], markets: ['Czechia'], languages: ['English', 'Czech'] });
    expect(searched).toEqual([['widget what makes one good', 'widget jak poznat kvalitu'], ['widget all costs of owning', 'widget celkové náklady'], ['widget known faults', 'widget časté závady'], ['widget zkušenosti majitelů']]);
    expect(scoping.queries.map((q: { query: string; round: number }) => [q.query, q.round])).toEqual(round1.map((query) => [query, 1]));
    expect(scoping.perspectives.map((view: { name: string; role?: string }) => [view.name, view.role ?? ''])).toEqual([[VALUE_GOAL, 'value'], [COST_GOAL, 'cost'], ['Workshop', ''], ['Owners', '']]);
    expect(scoping.levels).toEqual(['widget']);
    expect(scoping.screened).toEqual({ purpose: 'q', subject: 'widget' });
    expect(scoping.sources.map((s: { host: string; role: string; market: string; perspectives: string[] }) => [s.host, s.role, s.market, s.perspectives])).toEqual([
      ['guide.example.com', 'knowledge', 'C', [VALUE_GOAL, 'Workshop']],
      ['costs.example.org', 'knowledge', 'C', [COST_GOAL]],
      ['garage.example.cz', 'knowledge', 'C', ['Workshop']],
      ['owners.example.cz', 'knowledge', 'C', ['Owners']],
    ]);
    expect(scoping.sources[0]).toEqual({ url: 'https://guide.example.com/page', title: 'Guide', host: 'guide.example.com', about: 'A', market: 'C', span: 'S2', judgedBy: 'p1', role: 'knowledge', roleVotes: { A: 2 }, perspectives: [VALUE_GOAL, 'Workshop'] });
    expect(scoping.dropped).toEqual([
      { url: 'https://other.example.com/page', reason: 'off-subject: a different subject' },
      { url: 'https://shop.example.com/page', reason: 'off-market: describes another market', role: 'market', roleVotes: { B: 2 } },
    ]);
    expect(scoping.notes).toHaveLength(4);
    expect(scoping.notes[0]).toEqual({ id: 'N1', url: 'https://guide.example.com/page', quote: 'Owners in the country report it after ten years.', label: 'owner reports' });
    expect(scoping.diversity).toEqual({ hosts: 4, perspectives: 4, minHosts: 4, minPerspectives: 2, rounds: 1 });
    expect(scoping.enough).toBe(true);
    expect(scoping.embedModel).toBe('fake-embed');
    expect(pages).toHaveLength(4);
    expect(budget.caps.scoping).toBe(80);
    expect(budget.report().scoping).toEqual({ used: 22, cap: 80, skipped: 0 });
    expect(log).toEqual(['scoping budget: 80 calls (20 for levels and perspectives, 5 for each of 12 source(s): one judgement, up to 3 role votes, one set of notes)']);
  });

  describe('source diversity', () => {
    const english = { value: [{ lang: 'English', phrase: 'v one' }, { lang: 'English', phrase: 'v two' }], cost: [{ lang: 'English', phrase: 'c one' }, { lang: 'English', phrase: 'c two' }] };
    const proposed = [
      { name: 'Workshop', aspects: [{ lang: 'English', phrase: 'known faults' }, { lang: 'English', phrase: 'repair costs' }] },
      { name: 'Owners', aspects: [{ lang: 'English', phrase: 'owner reports' }, { lang: 'English', phrase: 'long term use' }] },
    ];
    const again = [
      { name: 'Owners', aspects: [{ lang: 'English', phrase: 'Owner reports' }, { lang: 'English', phrase: 'forum threads' }] },
      { name: 'Testers', aspects: [{ lang: 'English', phrase: 'test results' }] },
    ];
    const firstRound: Record<string, { url: string; title: string; text: string }[]> = {
      'widget v one': [pageAt('guide.example.com', 'Guide')],
      'widget c one': [pageAt('guide.example.com', 'Guide'), pageAt('costs.example.org', 'Costs')],
    };
    const secondRound: Record<string, { url: string; title: string; text: string }[]> = {
      'widget test results': [pageAt('tests.example.net', 'Tests'), pageAt('guide.example.com', 'Guide')],
      'widget forum threads': [pageAt('forum.example.cz', 'Forum'), { ...pageAt('forum.example.cz', 'Forum two'), url: 'https://forum.example.cz/other' }],
    };
    const thinLine = 'scoping thin: 2 hosts across 2 perspectives (at least 4 hosts across 2 perspectives are needed)';
    const run = async (hits: Record<string, { url: string; title: string; text: string }[]>, more: Record<string, unknown> = {}, budget = new CallBudget()) => {
      const searched: string[][] = [];
      const log: string[] = [];
      const search = { search: async (queries: string[]) => { searched.push(queries); return queries.flatMap((query) => hits[query] ?? []); } };
      const router = fakeRouter(script({ 'fixed-perspectives': english, perspectives: seq({ perspectives: proposed }, { perspectives: again }), ...more }));
      const { scoping } = await runScoping({ router, embedder: fakeEmbedder(), search, budget, log: (line: string) => log.push(line) }, { question: 'q', kind: 'widget', languages: ['English'] });
      return { scoping, searched, router, budget, thin: log.filter((line) => line.startsWith('scoping thin')) };
    };

    it('composes one more round of queries when fewer than 4 hosts are kept, logs "scoping thin: N hosts", and screens no page twice', async () => {
      const { scoping, searched, router, thin } = await run({ ...firstRound, ...secondRound });
      expect(searched).toEqual([['widget v one', 'widget v two'], ['widget c one', 'widget c two'], ['widget known faults', 'widget repair costs'], ['widget owner reports', 'widget long term use'], ['widget test results'], ['widget forum threads']]);
      expect(thin).toEqual([`${thinLine}; one more round of 2 queries, up to 12 sources`]);
      expect(router.userText('perspectives', 1)).toContain('Phrases already searched, give different ones: v one; v two; c one; c two; known faults; repair costs; owner reports; long term use');
      expect(scoping.queries.filter((q: { round: number }) => q.round === 2).map((q: { query: string; perspective: string }) => [q.query, q.perspective])).toEqual([['widget test results', 'Testers'], ['widget forum threads', 'Owners']]);
      expect(scoping.perspectives.map((view: { name: string; aspects: unknown[]; round?: number }) => [view.name, view.aspects.length, view.round ?? 1])).toEqual([[VALUE_GOAL, 2, 1], [COST_GOAL, 2, 1], ['Workshop', 2, 1], ['Owners', 3, 1], ['Testers', 1, 2]]);
      expect(scoping.sources.map((s: { url: string; perspectives: string[] }) => [s.url, s.perspectives])).toEqual([
        ['https://guide.example.com/page', [VALUE_GOAL, COST_GOAL]],
        ['https://costs.example.org/page', [COST_GOAL]],
        ['https://tests.example.net/page', ['Testers']],
        ['https://forum.example.cz/page', ['Owners']],
        ['https://forum.example.cz/other', ['Owners']],
      ]);
      expect(router.count('source-relevance')).toBe(5);
      expect(scoping.diversity).toEqual({ hosts: 4, perspectives: 4, minHosts: 4, minPerspectives: 2, rounds: 2 });
      expect(scoping.enough).toBe(true);
      expect(scoping.notes).toHaveLength(5);
    });

    it('says so when the extra round still leaves fewer than 4 hosts, and when no new query can be composed', async () => {
      const still = await run(firstRound);
      expect(still.thin).toEqual([`${thinLine}; one more round of 2 queries, up to 12 sources`, 'scoping thin: 2 hosts across 2 perspectives after one more round of queries']);
      expect(still.scoping.diversity).toMatchObject({ hosts: 2, perspectives: 2, rounds: 2 });
      expect(still.scoping.enough).toBe(false);
      const none = await run(firstRound, { perspectives: { perspectives: proposed } });
      expect(none.searched).toHaveLength(4);
      expect(none.thin).toEqual([`${thinLine}; no further query can be composed from the perspectives`]);
      expect(none.scoping.diversity.rounds).toBe(1);
    });

    it('runs no extra round when the call budget has no room for one more source', async () => {
      const budget = new CallBudget();
      budget.used.scoping = 76;
      const spent = await run({ ...firstRound, ...secondRound }, {}, budget);
      expect(spent.searched).toHaveLength(4);
      expect(spent.router.count('perspectives')).toBe(1);
      expect(spent.scoping.sources.map((s: { host: string; role: string }) => [s.host, s.role])).toEqual([['guide.example.com', 'undecided']]);
      expect(spent.scoping.dropped).toEqual([{ url: 'https://costs.example.org/page', reason: 'not judged' }]);
      expect(spent.thin).toEqual(['scoping thin: 1 hosts across 2 perspectives (at least 4 hosts across 2 perspectives are needed); no call budget is left for one more round of queries']);
      expect(budget.report().scoping).toMatchObject({ used: 80, cap: 80 });
    });
  });
});
