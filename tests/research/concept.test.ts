import { describe, expect, it } from 'vitest';
import { CONCEPT_MARKER, CONCEPT_PAGES, CONCEPT_QUERIES, CONCEPT_SAMPLES, MIN_PAGES, applyConceptCard, conceptCardPrompt, conceptPages, conceptQueries, conceptQueryPrompt, mergeConceptCards, mentionsPhrase, APPRAISAL, CRITERION, CONTEXT, ELIGIBILITY, FRAME_SAMPLES, FRAME_TASK, LIMIT, POPULATION, RANK, ROLE_TASK, ASKED_LIMIT, agreeFrames, askerQuestions, askedWithUnit, conceptChecklist, definedByHint, conceptDescribed, conceptExamples, conceptKindLabel, conceptOf, conceptText, frameConcept, framePrompt, criterionQuestion, frameSample, spanIn } from '../../src/research/concept.mjs';
import { fakeRouter, seq } from '../helpers/fakes';

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

describe('concept framing', () => {
  const question = 'Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren, Monclair, North face, Barbour with highest price/value ratio , proven good quality, assortiment for the appropriate retail second hand shop business in Czech Republic';
  const expected = '20 direct links to the providers with proof';
  const said = { question, expected };
  const full = {
    population: { quote: 'wholesale branded second hand clothing providers', label: 'wholesale provider' },
    concept: [
      { quote: 'branded second hand clothing', text: 'sells branded second hand clothing', examples: [] },
      { quote: 'similar to Ralph Lauren, Monclair, North face, Barbour', text: 'brands of the class the examples stand for', examples: ['Ralph Lauren', 'Monclair', 'North face', 'Barbour', 'Gucci'] },
      { quote: 'proven good quality', text: 'quality is proven', examples: [] },
    ],
    limits: [{ quote: '20 direct links' }],
    ranks: [{ quote: 'highest price/value ratio', text: 'best price for value' }],
    context: [{ quote: 'retail second hand shop business in Czech Republic', text: 'for a Czech retail shop' }],
    method: [],
  };

  it('keeps an element only with words copied from the request, and an example only when the quote holds it', () => {
    const sample = frameSample(full, said);
    expect(sample.value.map((e: { role: string }) => e.role)).toEqual([POPULATION, CRITERION, CRITERION, CRITERION, LIMIT, RANK, CONTEXT]);
    expect(sample.value[2].examples).toEqual(['Ralph Lauren', 'Monclair', 'North face', 'Barbour']);
    expect(sample.value[4].source).toBe('expected');
    expect(frameSample({ concept: [{ quote: 'ships within 24 hours', text: 'fast delivery' }] }, said).error).toContain('copied letter for letter');
    expect(spanIn('a  B c', 'b C')).toEqual({ at: 2, end: 5 });
    expect(spanIn('abc', '')).toBeNull();
  });

  it('frames the population in the asker\'s words, the class with its examples, and what ranks apart from what is required', () => {
    const concept = agreeFrames([frameSample(full, said).value, frameSample(full, said).value], said);
    expect(conceptKindLabel(concept)).toBe('wholesale branded second hand clothing providers');
    expect(conceptDescribed(concept)).toBe('Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren');
    expect(conceptDescribed({ population: { quote: 'red things' } })).toBe('red things');
    expect(conceptDescribed(null)).toBe('');
    expect(concept.criteria.map((c: { id: string; quote: string }) => `${c.id} ${c.quote}`)).toEqual(['E1 branded second hand clothing', 'E2 similar to Ralph Lauren, Monclair, North face, Barbour', 'E3 proven good quality']);
    expect(conceptExamples(concept)).toEqual(['Ralph Lauren', 'Monclair', 'North face', 'Barbour']);
    expect(concept.ranks.map((r: { quote: string }) => r.quote)).toEqual(['highest price/value ratio']);
    expect(concept.context).toHaveLength(1);
    expect(concept.criteria.some((c: { unframed?: boolean }) => c.unframed)).toBe(false);
    expect(conceptText(concept)).toContain('[E2] must: brands of the class the examples stand for (the asker\'s examples of the class: Ralph Lauren, Monclair, North face, Barbour; a similar member counts)');
  });

  it('never lets one sample turn a requirement into a rank, a context or a method', () => {
    const demoting = { ...full, concept: full.concept.slice(0, 2), method: [{ quote: 'proven good quality', text: 'how to research' }] };
    const one = agreeFrames([frameSample(demoting, said).value], said);
    expect(one.criteria.map((c: { quote: string }) => c.quote)).toContain('proven good quality');
    expect(one.method).toEqual([]);
    const two = agreeFrames([frameSample(demoting, said).value, frameSample(demoting, said).value, frameSample(full, said).value], said);
    expect(two.method.map((m: { quote: string }) => m.quote)).toEqual(['proven good quality']);
    const tied = agreeFrames([frameSample(demoting, said).value, frameSample(demoting, said).value, frameSample(full, said).value, frameSample(full, said).value], said);
    expect(tied.criteria.map((c: { quote: string }) => c.quote)).toContain('proven good quality');
  });

  it('makes a piece of the request no sample framed a requirement of its own', () => {
    const thin = { population: full.population, concept: full.concept.slice(0, 2), ranks: full.ranks };
    const concept = agreeFrames([frameSample(thin, said).value, frameSample(thin, said).value], said);
    const unframed = concept.criteria.filter((c: { unframed?: boolean }) => c.unframed).map((c: { quote: string }) => c.quote);
    expect(unframed).toEqual(['proven good quality', 'assortiment for the appropriate retail second hand shop business in Czech Republic', '20 direct links to the providers with proof']);
  });

  it('asks one sample per provider family, asks a reply that quotes nothing again with the reason, returns nothing when none quotes the request, and is read back from the decision model', async () => {
    const router = fakeRouter({ [FRAME_TASK]: seq(full, { concept: [{ quote: 'not in the request', text: 'x' }] }, { concept: [] }, full) });
    const concept = await frameConcept({ router }, said);
    expect(router.count(FRAME_TASK)).toBe(FRAME_SAMPLES + 2);
    expect(router.outcomes.map((outcome: { provider: string; passed: boolean }) => [outcome.provider, outcome.passed])).toEqual([['p1', true], ['p2', false], ['p2', false], ['p3', true], ['p1', true]]);
    expect(router.calls.filter((call: { task?: string }) => call.task === FRAME_TASK)[2].messages.at(-1)?.content).toMatch(/^Your last answer was not accepted: no "quote" was copied letter for letter/);
    expect(router.userText(FRAME_TASK)).toContain(`Request: ${question.replace(/\s+/g, ' ')}`);
    expect(router.userText(FRAME_TASK)).toContain(`Expected result: ${expected}`);
    expect(concept.samples).toBe(2);
    expect(await frameConcept({ router: fakeRouter({}) }, said)).toBeNull();
    const model = { question, expected, requirements: concept.criteria, framing: { population: concept.population, ranks: concept.ranks } };
    expect(conceptOf(model)).toMatchObject({ question, expected, criteria: concept.criteria, population: concept.population, ranks: concept.ranks });
    expect(conceptKindLabel(conceptOf(model))).toBe('wholesale branded second hand clothing providers');
    expect(conceptOf({ question, criteria: [] })).toBeNull();
    expect(conceptOf(null)).toBeNull();
    expect(conceptText(null)).toBe('');
    expect(conceptKindLabel(null)).toBe('');
    expect(framePrompt({ question: 'q' })[1].content).toBe('Request: q');
  });
});

describe('eligibility criteria fed into the decision model checklist', () => {
  const concept = {
    question: 'Find sellers of coats like Alpha Coats, Betula, proven quality, within 300 km',
    expected: '20 links',
    criteria: [
      { id: 'E1', text: 'sells coats of makers like the named ones', quote: 'coats like Alpha Coats, Betula', examples: ['Alpha Coats', 'Betula'] },
      { id: 'E2', text: 'quality is proven', quote: 'proven quality', examples: [] },
    ],
  };
  const modelWritten = [
    { clause: 'graded a', items: [{ clause: 'graded a', question: 'Is it graded A?', hard: true, numeric: null }] },
    { clause: 'distance', items: [{ clause: 'distance', question: 'Is it within 300 km?', hard: true, numeric: { measure: 'distanceKm', op: '<=', value: 300, unit: 'km' } }] },
    { clause: 'sea', items: [{ clause: 'sea', question: 'Is the sea within 20 km?', hard: true, numeric: { measure: 'coastKm', op: '<=', value: 20, unit: 'km' } }] },
    { clause: 'value', items: [{ clause: 'value', question: 'Is it the cheapest?', hard: false, numeric: null }] },
  ];

  it('makes every requirement of the asker a hard check, with the examples as anchors of its class', () => {
    const checklist = conceptChecklist(concept, modelWritten);
    expect(checklist.slice(0, 2).map((c: { role: string; criterion: string; quote: string; items: Array<{ hard: boolean }> }) => [c.role, c.criterion, c.quote, c.items[0].hard])).toEqual([[ELIGIBILITY, 'E1', 'coats like Alpha Coats, Betula', true], [ELIGIBILITY, 'E2', 'proven quality', true]]);
    expect(checklist[0].items[0].question).toBe('Does this result meet the asker\'s requirement "sells coats of makers like the named ones"? The asker named Alpha Coats, Betula as examples; another member of the same class counts as well.');
    expect(criterionQuestion(concept.criteria[1])).toBe('Does this result meet the asker\'s requirement "quality is proven"?');
  });

  it('keeps the questions a model wrote as appraisal that never vetoes, except a limit whose number the asker wrote', () => {
    const appraisal = conceptChecklist(concept, modelWritten).slice(2);
    expect(appraisal.map((c: { role: string; clause: string; items: Array<{ hard: boolean }> }) => [c.role, c.clause, c.items[0].hard])).toEqual([[APPRAISAL, 'graded a', false], [APPRAISAL, 'distance', true], [APPRAISAL, 'sea', false], [APPRAISAL, 'value', false]]);
  });

  it('keeps a limit a hint gives when the hint defines a word of the request, labelled with its source, and only then', () => {
    const criteria = [
      { measure: 'coastKm', op: '<=', value: 20, source: 'guidance', quote: 'about 20 km', clause: 'within 300 km' },
      { measure: 'areaM2', op: '>=', value: 500, source: 'guidance', quote: 'at least 500 m2', clause: 'a large garden' },
    ];
    const extra = [...modelWritten, { clause: 'area', items: [{ clause: 'area', question: 'Is it at least 500 m2?', hard: true, numeric: { measure: 'areaM2', op: '>=', value: 500, unit: 'm2' } }] }];
    const appraisal = conceptChecklist(concept, extra, { criteria }).slice(2);
    expect(appraisal.map((c: { clause: string; items: Array<{ hard: boolean; limitSource?: string }> }) => [c.clause, c.items[0].hard, c.items[0].limitSource])).toEqual([
      ['graded a', false, undefined],
      ['distance', true, ASKED_LIMIT],
      ['sea', true, 'your hint "about 20 km", which defines "within 300 km" of your request'],
      ['value', false, undefined],
      ['area', false, undefined],
    ]);
    expect(definedByHint({ measure: 'coastKm', op: '<=', value: 20 }, [{ ...criteria[0], source: 'question' }], concept.question)).toBe('');
    expect(definedByHint({ measure: 'coastKm', op: '<=', value: 21 }, criteria, concept.question)).toBe('');
    expect(definedByHint(null, null, '')).toBe('');
  });

  it('counts a number as the limit of the asker only with the unit written beside it', () => {
    const text = 'within 300km from prague, price up to 65 000 CZK, 20000EUR max, 10 month a year, 20 links';
    expect([[300, 'km'], [65000, 'CZK'], [20000, 'EUR'], [10, 'months'], [20, 'km'], [300, 'points'], [300, ''], [7, 'km']].map(([value, unit]) => askedWithUnit(text, value, unit))).toEqual([true, true, true, true, false, false, false, false]);
  });

  it('leaves the checklist as it is when no concept was framed, and holds without a model checklist', () => {
    expect(conceptChecklist(null, modelWritten)).toBe(modelWritten);
    expect(conceptChecklist({ criteria: [] }, modelWritten)).toBe(modelWritten);
    expect(conceptChecklist(null)).toBeNull();
    expect(conceptChecklist(concept, null)).toHaveLength(2);
  });
});

describe('framings of different provider families', () => {
  const question = 'Find 40 activity providers in Durres (Albania) and within about 60 km that a stag party of 8 to 15 men from the UK or Germany could book directly: boat trips, jet ski, karting and group transfers.';
  const said = { question, expected: '' };
  const first = 'Find 40 activity providers in Durres (Albania) and within about 60 km that a stag party of 8 to 15 men from the UK or Germany could book directly';
  const list = { quote: 'boat trips, jet ski, karting and group transfers', text: 'offers one of the listed activities', examples: ['boat trips', 'jet ski', 'karting', 'group transfers'] };
  const frames = [
    { population: { quote: 'activity providers', label: 'activity provider' }, concept: [{ quote: 'in Durres (Albania) and within about 60 km', text: 'located in Durres or within 60 km' }, { quote: 'a stag party of 8 to 15 men from the UK or Germany', text: 'suits a stag party' }, { quote: 'could book directly', text: 'bookable directly' }, list], limits: [{ quote: '40 activity providers' }, { quote: 'within about 60 km' }], context: [{ quote: first, text: 'who the list is for' }] },
    { population: { quote: first, label: 'activity provider' }, concept: [{ quote: 'jet ski', text: 'offers jet ski' }, { quote: 'karting', text: 'offers karting' }], limits: [{ quote: '40 activity providers' }] },
    { population: { quote: 'activity providers', label: 'activity provider' }, concept: [{ quote: 'that a stag party of 8 to 15 men from the UK or Germany could book directly', text: 'bookable directly by a stag party' }, list], limits: [{ quote: '40 activity providers' }, { quote: 'within about 60 km' }], context: [{ quote: 'in Durres (Albania)', text: 'where' }] },
  ];

  it('never lets a span that encloses parts of another role glue them together: each condition of the first sentence stays a condition, and a listed class keeps its members', () => {
    const concept = agreeFrames(frames.map((data) => frameSample(data, said).value), said);
    expect(concept.criteria.map((c: { quote: string; uncertain?: boolean }) => [c.quote, Boolean(c.uncertain)])).toEqual([
      ['in Durres (Albania) and within about 60 km', false],
      ['that a stag party of 8 to 15 men from the UK or Germany could book directly', true],
      ['boat trips, jet ski, karting and group transfers', false],
    ]);
    expect(concept.criteria[2].examples).toEqual(['boat trips', 'jet ski', 'karting', 'group transfers']);
    expect(concept.limits.map((c: { quote: string }) => c.quote)).toEqual(['40 activity providers', 'within about 60 km']);
  });
});

describe('a part of the request that no single result page can show is never a page check', () => {
  const question = 'Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren, Monclair, North face, Barbour with highest price/value ratio, proven good quality, assortiment for the appropriate retail second hand shop business in Czech Republic';
  const expected = '20 direct links to the providers with proof';
  const said = { question, expected };
  const population = { quote: 'wholesale branded second hand clothing providers', label: 'clothing wholesaler' };
  const brands = { quote: 'similar to Ralph Lauren, Monclair, North face, Barbour', text: 'brands of the class the examples stand for', ask: 'Does this provider sell brands like Ralph Lauren, Monclair, North face or Barbour?', examples: ['Ralph Lauren', 'Barbour'] };
  const thin = { population, concept: [brands], ranks: [{ quote: 'highest price/value ratio', text: 'best price for value' }] };
  const roleOf: Record<string, string> = { 'highest price/value ratio': RANK, 'proven good quality': CRITERION, 'assortiment for the appropriate retail second hand shop business in Czech Republic': CONTEXT, '20 direct links to the providers with proof': LIMIT };
  const voter = (request: { messages: Array<{ content: string }> }) => ({ role: roleOf[Object.keys(roleOf).find((quote) => request.messages[1].content.includes(`Part: "${quote}"`))!] });

  it('keeps the question a framer wrote about one result, unless it carries a number the asker did not write, and asks it with the examples', () => {
    const sample = frameSample({ population, concept: [brands, { quote: 'proven good quality', text: 'quality is proven', ask: 'Is the quality rated above 4.5?' }] }, said).value;
    expect(sample[1].ask).toBe('Does this provider sell brands like Ralph Lauren, Monclair, North face or Barbour?');
    expect(sample[2]).not.toHaveProperty('ask');
    expect(criterionQuestion({ ...sample[1], examples: ['Ralph Lauren', 'Barbour'] })).toBe('Does this provider sell brands like Ralph Lauren, Monclair, North face or Barbour? The asker named Ralph Lauren, Barbour as examples; another member of the same class counts as well.');
  });

  it('asks two provider families what an unframed part is: a condition of one result stays a requirement, a context, a rank or a count of the list leaves the page checks', async () => {
    const router = fakeRouter({ [FRAME_TASK]: thin, [ROLE_TASK]: voter });
    const concept = await frameConcept({ router }, said);
    expect(concept.criteria.map((c: { id: string; quote: string; unframed?: boolean }) => [c.id, c.quote, Boolean(c.unframed)])).toEqual([['E1', 'similar to Ralph Lauren, Monclair, North face, Barbour', false], ['E2', 'proven good quality', false]]);
    expect(concept.context.map((c: { quote: string }) => c.quote)).toEqual(['assortiment for the appropriate retail second hand shop business in Czech Republic']);
    expect(concept.limits.map((c: { id: string; quote: string }) => `${c.id} ${c.quote}`)).toEqual(['L1 20 direct links to the providers with proof']);
    expect(concept.open).toEqual([]);
    expect(router.userText(ROLE_TASK)).toContain('Part: "proven good quality"');
    expect(conceptChecklist(concept, null).map((c: { clause: string }) => c.clause)).toEqual(['brands of the class the examples stand for', 'proven good quality']);
  });

  it('makes an unframed part, and a rank one provider family alone framed and placed, a question for the asker, never a page check, and keeps an uncertain requirement a requirement', async () => {
    const alone = fakeRouter({ [FRAME_TASK]: thin, [ROLE_TASK]: voter }, { providers: ['p1'] });
    const concept = await frameConcept({ router: alone }, said);
    expect(concept.samples).toBe(1);
    expect(concept.criteria.map((c: { quote: string }) => c.quote)).toEqual(['similar to Ralph Lauren, Monclair, North face, Barbour']);
    expect(concept.open.map((c: { id: string; quote: string }) => `${c.id} ${c.quote}`)).toEqual(['Q1 highest price/value ratio', 'Q2 proven good quality', 'Q3 assortiment for the appropriate retail second hand shop business in Czech Republic', 'Q4 20 direct links to the providers with proof']);
    expect(conceptText(concept)).toContain('[Q2] to confirm with you: Is "proven good quality" a condition each result must meet? If it is, say in Hints how a result shows it.');
    expect(conceptChecklist(concept, null).map((c: { clause: string }) => c.clause)).toEqual(['brands of the class the examples stand for']);
    expect(askerQuestions({ framing: { open: concept.open } })).toHaveLength(4);
    expect(askerQuestions(null)).toEqual([]);
    const demoting = { ...thin, concept: [brands, { quote: 'proven good quality', text: 'quality is proven' }], method: [{ quote: 'proven good quality', text: 'how to research' }] };
    const split = fakeRouter({ [FRAME_TASK]: seq(demoting, thin, thin), [ROLE_TASK]: { role: 'method' } }, { providers: ['p1'] });
    const kept = await frameConcept({ router: split }, said);
    expect(kept.criteria.map((c: { quote: string; uncertain?: boolean }) => [c.quote, Boolean(c.uncertain)])).toContainEqual(['proven good quality', true]);
    const voted = fakeRouter({ [FRAME_TASK]: seq(demoting, thin, thin), [ROLE_TASK]: (request: { messages: Array<{ content: string }> }) => (request.messages[1].content.includes('Part: "proven good quality"') ? { role: 'method' } : voter(request)) });
    const moved = await frameConcept({ router: voted }, said);
    expect(moved.method.map((c: { quote: string }) => c.quote)).toEqual(['proven good quality']);
    expect(moved.criteria.map((c: { quote: string }) => c.quote)).not.toContain('proven good quality');
  });
});
