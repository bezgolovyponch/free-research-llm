import { describe, expect, it } from 'vitest';
import { decomposePrompt, queryPlanPrompt, researchPrompt, synthesizePrompt, variantPrompt } from '../../src/research/prompts.mjs';

const project = { question: 'Find glamping plots under 20000 EUR', acceptance: { expected: '50 plots' }, acceptanceResult: null, nodes: [{ id: 'D4', parentId: 'Q', status: 'weak', question: 'zoning?' }] };
const text = (stall: object | null) => variantPrompt({ project, node: { id: 'Q' }, score: { score: 0.28, acceptance: 0.1 }, trials: [], stall } as never)[1].content;

describe('variantPrompt', () => {
  it('asks for removals only when a piece duplicates another, not first', () => {
    expect(text(null)).not.toMatch(/First remove/);
    expect(text(null)).toMatch(/Remove \("remove"\) a top-level piece only if it duplicates another/);
    expect(text(null)).not.toMatch(/STALLED|REFUSED/);
  });

  it('steers a stalled loop toward new evidence for the lowest check below 100% and lists refused removals', () => {
    const prompt = text({ stalled: true, trialsSinceKept: 200, hoursSinceKept: 11.2, weakest: { label: 'At least 50 valid items', value: 0.1 }, failingPieces: [], refusedRemovals: ['D4', 'D5'] });
    expect(prompt).toMatch(/THE LOOP IS STALLED: 200 trials in 11.2 h kept nothing\. The lowest expected-result check below 100% is "At least 50 valid items" at 10%\./);
    expect(prompt).toMatch(/NEW evidence for what can still gain/);
    expect(prompt).toMatch(/REMOVALS ALREADY TESTED AND REFUSED \(never propose them again\): D4, D5/);
  });

  it('names the failing pieces when every check is at 100%', () => {
    const prompt = text({ stalled: true, trialsSinceKept: 200, hoursSinceKept: 11.2, weakest: null, failingPieces: ['D2', 'D3'], refusedRemovals: [] });
    expect(prompt).toMatch(/Every expected-result check is at 100%, but these pieces do not pass: D2, D3\./);
    expect(prompt).not.toMatch(/weakest expected-result check/i);
  });
});

describe('variantPrompt purpose, regions and query memory', () => {
  const plots = {
    question: 'Find appropriate plots to buy for glamping business, 20000EUR max, 10 month a year, mild climate, nearby sea accessible by ebike',
    acceptance: { expected: '50 Plots In EU, Vietnam and Turkey strongly feasible for Glamping business 10 minth, 1 year' },
    acceptanceResult: null,
    brief: {
      kind: { label: 'plot of land', terms: ['terreno', 'plot of land'] },
      itemCount: 50,
      valueRange: [0, 20000],
      unit: 'EUR',
      regions: ['PT', 'ES', 'TR', 'VN'],
      groups: ['EU'],
      narrowed: ['EU narrowed to Portugal, Spain, the members you named'],
      coastal: true,
      excludes: ['offered for rent', 'offered as a swap', 'wanted ads', 'news, blog or guide pages', 'search or category pages'],
    },
    nodes: [{ id: 'D8.3', parentId: 'Q', status: 'weak', question: 'Turkey/Vietnam coastal glamping parcels under 20000 EUR?', searchQueries: [], sourceUrls: [] }],
  };
  const promptOf = (trials: object[]) => variantPrompt({ project: plots as never, node: plots.nodes[0] as never, score: { score: 0.807, acceptance: 0.807 } as never, trials: trials as never, stall: null })[1].content;

  it('tells the proposer the research purpose, the allowed regions, the price cap, the kind and the countries\' languages, and that out-of-region names are trimmed', () => {
    const prompt = promptOf([]);
    expect(prompt).toContain('RESEARCH PURPOSE (gather data only for this; every proposal must serve it):');
    expect(prompt).toContain('Deliver: 50 single plot of land listing pages for sale');
    expect(prompt).toContain('Hard limit: price 0–20000 EUR');
    expect(prompt).toContain('Where: EU (27 countries), Turkey, Vietnam (near the sea) · EU narrowed to Portugal, Spain, the members you named');
    expect(prompt).toContain('ALLOWED REGIONS: Portugal (PT), Spain (ES), Turkey (TR), Vietnam (VN)');
    expect(prompt).toContain('never name a region outside them; code trims out-of-region names from the proposal before the trial');
    expect(prompt).toContain('LANGUAGES of the asked countries (use them in searchQueries): English, Portuguese, Spanish, Turkish, Vietnamese');
  });

  it('lists the queries already used on the piece and requires different sources or queries, never the same ones', () => {
    const prompt = promptOf([
      { change: 'Add native Turkish queries', outcome: 'no-gain', score: 0.807, queries: ['arsa satılık Muğla', 'tarla satılık denize yakın'] },
      { change: 'Add Vietnamese portal queries', outcome: 'reverted-whole', score: 0.807, queries: ['đất nền Bình Thuận dưới 500 triệu'] },
    ]);
    expect(prompt).toContain('QUERIES ALREADY USED ON THIS PIECE (never propose them again; code refuses the repeat without testing): arsa satılık Muğla | tarla satılık denize yakın | đất nền Bình Thuận dưới 500 triệu');
    expect(prompt).toContain('different from the ones already used: new portals or native-language queries for the allowed countries, never the same queries again');
  });
});

describe('list-first decomposition', () => {
  const template = { label: 't', drivers: 'd', metrics: 'm', sources: 's', decisionRule: 'r' };

  it('keeps pieces away from finding, pricing, filtering, locating, ranking or verifying listings when code does that work', () => {
    const prompt = decomposePrompt({ question: 'Find 20 hatchbacks within 300 km of Prague under 65000 CZK', template, constraints: {}, expected: 'at least 20 cars', listsItems: true })[1].content;
    expect(prompt).toContain('Do not create pieces that search for, price, filter');
    expect(prompt).toContain('Create pieces only for knowledge a listing cannot show');
  });

  it('adds no such rule when the research does not ask for items', () => {
    const prompt = decomposePrompt({ question: 'Should I import e-bikes from Germany to Czechia?', template, constraints: {}, expected: '' })[1].content;
    expect(prompt).not.toContain('Do not create pieces that search for, price, filter');
  });

  it('sends pieces only to knowledge needs when the brief lists needs', () => {
    const prompt = decomposePrompt({ question: 'Find 20 hatchbacks within 300 km of Prague', template, constraints: {}, expected: 'at least 20 cars', brief: 'Why: A buyer wants a used hatchback so that they buy the best value car\nValue: a shortlist of 20 hatchbacks\nNeeds: reliability (knowledge: adac.de); price (computed: listings table)' })[1].content;
    expect(prompt).toContain('Create pieces only for needs of kind knowledge; listings and computed needs are done by code.');
    expect(decomposePrompt({ question: 'Find 20 hatchbacks', template, constraints: {}, expected: '' })[1].content).not.toContain('Create pieces only for needs of kind knowledge');
  });
});

describe('queryPlanPrompt', () => {
  const prompt = queryPlanPrompt({
    question: 'Find 20 hatchbacks within 300 km of Prague under 65000 CZK',
    pieces: [{ id: 'D1.1', question: 'Which engines are reliable in this price segment?' }],
    groups: ['skoda fabia', 'kia rio'],
    languages: ['Czech', 'English'],
  })[1].content;

  it('names the groups actually found and the asked countries\' languages', () => {
    expect(prompt).toContain('skoda fabia');
    expect(prompt).toContain('kia rio');
    expect(prompt).toContain('Czech');
    expect(prompt).toContain('English');
  });

  it('asks for queries per piece aimed at expert sources and owner communities in every non-English language', () => {
    expect(prompt).toContain('D1.1');
    expect(prompt).toContain('Which engines are reliable in this price segment?');
    expect(prompt).toMatch(/expert or statistical sources/);
    expect(prompt).toMatch(/defect statistics/);
    expect(prompt).toMatch(/owner-community query for each listed non-English language \(Czech\)/);
    expect(prompt).toMatch(/forum, club, owners' experiences or reviews/);
    expect(prompt).toMatch(/Never write generic how-to queries/);
    expect(prompt).toContain('{"queries":{"<pieceId>":["query","query"]}}');
  });

  it('keeps English out of the owner-community language list', () => {
    const one = queryPlanPrompt({ question: 'q', pieces: [{ id: 'D1', question: 'p' }], groups: ['a'], languages: ['English'] })[1].content;
    expect(one).toContain('one owner-community query for each listed non-English language (none)');
  });
});

describe('concept brief in prompts', () => {
  const template = { label: 't', drivers: 'd', metrics: 'm', sources: 's', decisionRule: 'r' };
  it('puts the code-built brief into decomposition and research, and the screened table into the memo', () => {
    expect(decomposePrompt({ question: 'Find plots', template, constraints: {}, expected: '50 plots', brief: 'Hard limit: price 0–20000 EUR' })[1].content).toContain('CONCEPT BRIEF (built by code from the user\'s words; every piece must serve it, never research general background that does not change which items qualify):\nHard limit: price 0–20000 EUR');
    expect(decomposePrompt({ question: 'Find plots', template, constraints: {}, expected: '' })[1].content).not.toContain('CONCEPT BRIEF');
    expect(decomposePrompt({ question: 'Find plots', template, constraints: {}, expected: '', brief: 'Hard limit: price 0–20000 EUR' })[1].content).not.toContain('Build the tree from the decision model');
    expect(decomposePrompt({ question: 'Find plots', template, constraints: {}, expected: '', brief: 'Decision model (code checks every listing against it): sea within 20 km' })[1].content).toContain('Build the tree from the decision model: one driver finds candidate listings in the named countries only');
    const node = { id: 'D1.1', question: 'Plots in Portugal?', metric: 'price', unit: 'EUR', method: 'lookup' };
    expect(researchPrompt({ question: 'q', node, sources: [], upstream: [], previousFailures: [], brief: 'Where: Portugal' } as never)[1].content).toContain('Concept brief (hard limits; ignore source content outside it):\nWhere: Portugal');
    expect(synthesizePrompt({ question: 'q', decision: 'd', template, constraints: {}, nodes: [], shortlist: 'found 9, kept 3' } as never)[1].content).toContain('CANDIDATE TABLE (screened by code against the hard limits; cite counts from it, never invent items):\nfound 9, kept 3');
  });
});
