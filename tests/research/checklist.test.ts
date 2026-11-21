import { describe, expect, it, vi } from 'vitest';
import { clusterChecklist, checklistSummary, proposeChecklist, normalizeSample, ChecklistModeler, ChecklistJudge, applyQuoteCheck, checklistFingerprint, kindCluster, askedCounts, filterCountItems, hardenKind, migrateChecks, needsSecondKind, replyList, judgePrompt, measuredValue, JUDGE_VERSION, CHECKLIST_VERSION, LOW_PRICE_REASON, SINGLE_KIND_REASON, matchPrompt } from '../../src/research/checklist.mjs';
import { FAIL, fakeRouter, seq, fakeEmbedder, pickLetter } from '../helpers/fakes';
import { sentenceSpans } from '../../src/research/spans.mjs';
import { hardIdsOf, itemTier, awaitsSecondFamily } from '../../src/research/verdict.mjs';
import { DecisionModeler } from '../../src/research/decision.mjs';
import { retrieveThenVerify } from '../../src/research/semantic.mjs';

const supplierQuestion = 'Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren, Monclair, North face, Barbour with highest price/value ratio, proven good quality, assortiment for the appropriate retail second hand shop business in Czech Republic';
const carQuestion = 'Find accurate and verified car listings on available marketplaces for at least 20 cars as fit and up to 80 as a trade off to purchase within 300km from prague, hatchback, with highest price/value ratio, considering the engines informations, usage trends and empirical data and all important details of the particular car, considering the professional and car enthusiast trustful sources and communities, with all the crucial metrics considered, price up to 65000CZK or equivalent';

describe('normalizeSample', () => {
  it('parses items with clause, question, hard, and numeric', () => {
    const raw = {
      items: [
        { clause: 'wholesale', question: 'Does this sell wholesale?', hard: true, numeric: null },
        { clause: 'brands', question: 'Does this carry Ralph Lauren?', hard: true, numeric: null },
        { clause: 'price', question: 'Is the price per kg stated?', hard: false, numeric: { measure: 'priceEur', op: '<=', value: 50, unit: 'EUR/kg' } },
      ],
    };
    const sample = normalizeSample(raw);
    expect(sample.items).toHaveLength(3);
    expect(sample.items[0]).toMatchObject({ clause: 'wholesale', hard: true, numeric: undefined });
    expect(sample.items[2].numeric).toMatchObject({ measure: 'priceEur', op: '<=', value: 50, unit: 'EUR/kg' });
  });

  it('filters out items without clause or question', () => {
    const raw = { items: [{ clause: '', question: 'x' }, { clause: 'y', question: '' }, { clause: 'ok', question: 'Does this ok?' }] };
    expect(normalizeSample(raw).items).toHaveLength(1);
  });
});

describe('clusterChecklist', () => {
  it('groups items by question meaning across samples and keeps majority groups', () => {
    const samples = [
      { items: [{ clause: 'wholesale', question: 'Does this sell wholesale?', hard: true }, { clause: 'brands', question: 'Does this carry Ralph Lauren?', hard: true }] },
      { items: [{ clause: 'wholesale', question: 'Is this a wholesale supplier?', hard: true }, { clause: 'brands', question: 'Does this carry Moncler?', hard: true }] },
      { items: [{ clause: 'wholesale', question: 'Does this offer wholesale?', hard: true }, { clause: 'brands', question: 'Does this carry The North Face?', hard: true }] },
    ];
    const clusters = clusterChecklist(samples);
    expect(clusters.length).toBe(1);
    const wholesale = clusters.find((c) => c.clause === 'wholesale');
    expect(wholesale).toBeDefined();
    expect(wholesale!.items.length).toBe(1);
    expect(wholesale!.items[0].question).toContain('wholesale');
    expect(clusters.find((c) => c.clause === 'brands')).toBeUndefined();
  });

  it('questions that share only question words are different questions', () => {
    const samples = [0, 1, 2].map(() => ({ items: [
      { clause: 'size', question: 'Does this listing state the engine size?', hard: true },
      { clause: 'distance', question: 'Does this listing state the mileage?', hard: false },
    ] }));
    const questions = clusterChecklist(samples).flatMap((c) => c.items.map((i) => i.question));
    expect(questions.sort()).toEqual(['Does this listing state the engine size?', 'Does this listing state the mileage?']);
  });

  it('keeps only groups with majority across samples', () => {
    const samples = [
      { items: [{ clause: 'wholesale', question: 'Does this sell wholesale?', hard: true }] },
      { items: [{ clause: 'quality', question: 'Is quality proven?', hard: true }] },
      { items: [{ clause: 'assortment', question: 'Is assortment listed?', hard: false }] },
    ];
    const clusters = clusterChecklist(samples);
    expect(clusters.length).toBe(0);
  });

  it('does not invent fallback questions', () => {
    const samples = [
      { items: [{ clause: 'wholesale', question: 'Does this sell wholesale?', hard: true }] },
      { items: [{ clause: 'quality', question: 'Is quality proven?', hard: true }] },
      { items: [{ clause: 'assortment', question: 'Is assortment listed?', hard: false }] },
    ];
    const clusters = clusterChecklist(samples);
    for (const c of clusters) {
      for (const item of c.items) {
        expect(item.question).not.toMatch(/^Does this .+\?$/);
      }
    }
  });

  it('uses most common wording for question', () => {
    const samples = [
      { items: [{ clause: 'wholesale', question: 'Does this sell wholesale?', hard: true }] },
      { items: [{ clause: 'wholesale', question: 'Does this sell wholesale?', hard: true }] },
      { items: [{ clause: 'wholesale', question: 'Is this a wholesale supplier?', hard: true }] },
    ];
    const clusters = clusterChecklist(samples);
    expect(clusters.length).toBe(1);
    expect(clusters[0].items[0].question).toBe('Does this sell wholesale?');
  });

  it('hard is true when majority marked hard', () => {
    const samples = [
      { items: [{ clause: 'wholesale', question: 'Does this sell wholesale?', hard: true }] },
      { items: [{ clause: 'wholesale', question: 'Does this sell wholesale?', hard: true }] },
      { items: [{ clause: 'wholesale', question: 'Does this sell wholesale?', hard: false }] },
    ];
    const clusters = clusterChecklist(samples);
    expect(clusters[0].items[0].hard).toBe(true);
  });

  it('hard is false when minority marked hard', () => {
    const samples = [
      { items: [{ clause: 'wholesale', question: 'Does this sell wholesale?', hard: true }] },
      { items: [{ clause: 'wholesale', question: 'Does this sell wholesale?', hard: false }] },
      { items: [{ clause: 'wholesale', question: 'Does this sell wholesale?', hard: false }] },
    ];
    const clusters = clusterChecklist(samples);
    expect(clusters[0].items[0].hard).toBe(false);
  });

  it('numeric from majority', () => {
    const samples = [
      { items: [{ clause: 'price', question: 'Is price <= 50?', hard: true, numeric: { measure: 'priceEur', op: '<=', value: 50, unit: 'EUR' } }] },
      { items: [{ clause: 'price', question: 'Is price <= 50?', hard: true, numeric: { measure: 'priceEur', op: '<=', value: 50, unit: 'EUR' } }] },
      { items: [{ clause: 'price', question: 'Is price <= 100?', hard: true, numeric: { measure: 'priceEur', op: '<=', value: 100, unit: 'EUR' } }] },
    ];
    const clusters = clusterChecklist(samples);
    expect(clusters.length).toBe(1);
    expect(clusters[0].items[0].numeric).toMatchObject({ measure: 'priceEur', op: '<=', value: 50, unit: 'EUR' });
  });
});

describe('checklistSummary', () => {
  it('computes hardPass, unknown, softYes per item', () => {
    const items = [
      { checks: [{ id: 'a|q', answer: 'yes', hard: true }, { id: 'b|q', answer: 'yes', hard: true }] },
      { checks: [{ id: 'a|q', answer: 'yes', hard: true }, { id: 'b|q', answer: 'unknown', hard: true }] },
      { checks: [{ id: 'a|q', answer: 'no', hard: true }, { id: 'b|q', answer: 'yes', hard: true }] },
      { checks: [{ id: 'a|q', answer: 'yes', hard: false }, { id: 'b|q', answer: 'yes', hard: false }] },
      { checks: [{ id: 'a|q', answer: 'yes', hard: true }, { id: 'b|q', answer: 'yes', hard: false }] },
    ];
    const summary = checklistSummary(items);
    expect(summary[0]).toEqual({ hardPass: true, unknown: 0, softYes: 0 });
    expect(summary[1]).toEqual({ hardPass: false, unknown: 1, softYes: 0 });
    expect(summary[2]).toEqual({ hardPass: false, unknown: 0, softYes: 0 });
    expect(summary[3]).toEqual({ hardPass: false, unknown: 0, softYes: 2 });
    expect(summary[4]).toEqual({ hardPass: true, unknown: 0, softYes: 1 });
  });
});

describe('ChecklistModeler with fake router', () => {
  const supplierProposal = {
    items: [
      { clause: 'wholesale', question: 'Does this sell wholesale or bulk?', hard: true, numeric: null },
      { clause: 'brands', question: 'Does this carry at least one of Ralph Lauren, Moncler, The North Face, Barbour?', hard: true, numeric: null },
      { clause: 'quality', question: 'Does this state a quality grade or guarantee?', hard: true, numeric: null },
      { clause: 'assortment', question: 'Does this list assortment categories?', hard: false, numeric: null },
      { clause: 'delivery', question: 'Does this deliver to Czech Republic or EU?', hard: true, numeric: null },
      { clause: 'price/value', question: 'Is the price per kg or piece published?', hard: false, numeric: { measure: 'priceEur', op: '<=', value: null, unit: 'EUR/kg' } },
    ],
  };

  const carProposal = {
    items: [
      { clause: 'hatchback', question: 'Is this a hatchback?', hard: true, numeric: null },
      { clause: 'price', question: 'Is the price <= 65000 CZK?', hard: true, numeric: { measure: 'priceEur', op: '<=', value: 2700, unit: 'EUR' } },
      { clause: 'distance', question: 'Is this within 300 km of Prague?', hard: true, numeric: null },
      { clause: 'engine', question: 'Is the engine stated?', hard: false, numeric: null },
      { clause: 'recent', question: 'Is the posting date recent?', hard: false, numeric: null },
      { clause: 'price/value', question: 'Is this the highest price/value ratio?', hard: false, numeric: null },
    ],
  };

  it('builds supplier checklist matching expected clauses', async () => {
    let callCount = 0;
    const router = {
      complete: async () => {
        callCount++;
        return { provider: 'test', data: supplierProposal };
      },
    };
    const modeler = new ChecklistModeler({ router, samples: 3 });
    const checklist = await modeler.build(supplierQuestion, 'NL, DE, UK, IT, PL, LT');
    expect(callCount).toBe(3);
    expect(checklist).not.toBeNull();
    const clauses = checklist!.map((c) => c.clause);
    expect(clauses).toContain('wholesale');
    expect(clauses).toContain('brands');
    expect(clauses).toContain('quality');
    expect(clauses).toContain('assortment');
    expect(clauses).toContain('delivery');
    expect(clauses).toContain('price/value');
  });

  it('builds car checklist matching expected clauses', async () => {
    let callCount = 0;
    const router = {
      complete: async () => {
        callCount++;
        return { provider: 'test', data: carProposal };
      },
    };
    const modeler = new ChecklistModeler({ router, samples: 3 });
    const checklist = await modeler.build(carQuestion, 'prefer petrol engines');
    expect(callCount).toBe(3);
    expect(checklist).not.toBeNull();
    const clauses = checklist!.map((c) => c.clause);
    expect(clauses).toContain('hatchback');
    expect(clauses).toContain('price');
    expect(clauses).toContain('distance');
    expect(clauses).toContain('engine');
    expect(clauses).toContain('recent');
    expect(clauses).toContain('price/value');
  });

  it('returns null when fewer than 2 samples succeed', async () => {
    let callCount = 0;
    const router = {
      complete: async () => {
        callCount++;
        if (callCount <= 1) return { provider: 'test', data: supplierProposal };
        return null;
      },
    };
    const modeler = new ChecklistModeler({ router, samples: 3 });
    const checklist = await modeler.build(supplierQuestion, '');
    expect(checklist).toBeNull();
  });
});

describe('applyQuoteCheck', () => {
  const spans = sentenceSpans('We sell wholesale clothing. Minimum order is one bale.');

  it('builds the quote from the sentence ids of a yes', () => {
    const result = applyQuoteCheck([{ id: 'q1', answer: 'yes', spans: ['S2'] }], spans);
    expect(result[0]).toMatchObject({ answer: 'yes', quote: 'Minimum order is one bale.' });
  });

  it('turns a yes or a no into unknown when its ids give no quote', () => {
    const result = applyQuoteCheck([{ id: 'q1', answer: 'yes', spans: ['S9'] }, { id: 'q2', answer: 'no', spans: [] }, { id: 'q3', answer: 'yes', quote: 'We sell wholesale clothing.' }], spans);
    expect(result.map((r: { answer: string; quote: string }) => [r.answer, r.quote])).toEqual([['unknown', ''], ['unknown', ''], ['unknown', '']]);
  });

  it('sets answer to unknown for invalid reply', () => {
    const result = applyQuoteCheck([{ id: 'a|q', answer: 'maybe', spans: ['S1'] }], spans);
    expect(result[0].answer).toBe('unknown');
  });

  it('sets answer to unknown for missing reply', () => {
    const result = applyQuoteCheck([null], spans);
    expect(result[0].answer).toBe('unknown');
  });
});

describe('ChecklistJudge reply binding with short IDs', () => {
  const testChecklist = [
    { clause: 'brand', items: [
      { clause: 'brand', question: 'Does this carry Barbour?', hard: true, numeric: null },
      { clause: 'brand', question: 'Does this carry Ralph Lauren?', hard: false, numeric: null },
    ]},
  ];

  it('binds model replies with q1, q2... to the right questions by index', async () => {
    const router = {
      complete: async () => ({
        provider: 'test',
        data: [
          { id: 'q1', answer: 'yes', spans: ['S1'] },
          { id: 'q2', answer: 'no', spans: ['S1'] },
        ],
      }),
    };
    const judge = new ChecklistJudge({ router });
    const item = { url: 'http://example.com' };
    const pageText = 'We carry Barbour';
    const checks = await judge.judge(item, pageText, testChecklist);
    const ids = checks.map(c => c.id).sort();
    expect(ids).toEqual([
      'brand|Does this carry Barbour?',
      'brand|Does this carry Ralph Lauren?',
    ]);
    expect(checks.find(c => c.id === 'brand|Does this carry Barbour?')?.answer).toBe('yes');
    expect(checks.find(c => c.id === 'brand|Does this carry Ralph Lauren?')?.answer).toBe('no');
  });

  it('ignores reply with unknown q-id', async () => {
    const router = {
      complete: async () => ({
        provider: 'test',
        data: [
          { id: 'q1', answer: 'yes', spans: ['S1'] },
          { id: 'q5', answer: 'yes', spans: ['S1'] },
        ],
      }),
    };
    const judge = new ChecklistJudge({ router });
    const item = { url: 'http://example.com' };
    const pageText = 'We carry Barbour';
    const checks = await judge.judge(item, pageText, testChecklist);
    const ids = checks.map(c => c.id).sort();
    expect(ids).toEqual([
      'brand|Does this carry Barbour?',
      'brand|Does this carry Ralph Lauren?',
    ]);
    expect(checks.find(c => c.id === 'brand|Does this carry Barbour?')?.answer).toBe('yes');
    expect(checks.find(c => c.id === 'brand|Does this carry Ralph Lauren?')?.answer).toBe('unknown');
  });

  it('accepts reply id with surrounding spaces/quotes/case', async () => {
    const router = {
      complete: async () => ({
        provider: 'test',
        data: [
          { id: '  Q1  ', answer: 'yes', spans: ['S1'] },
          { id: '"q2"', answer: 'no', spans: ['S1'] },
        ],
      }),
    };
    const judge = new ChecklistJudge({ router });
    const item = { url: 'http://example.com' };
    const pageText = 'We carry Barbour';
    const checks = await judge.judge(item, pageText, testChecklist);
    expect(checks.find(c => c.id === 'brand|Does this carry Barbour?')?.answer).toBe('yes');
    expect(checks.find(c => c.id === 'brand|Does this carry Ralph Lauren?')?.answer).toBe('no');
  });

  it('reads answers wrapped in an object, and an object with no list as no answers', async () => {
    const wrapped = { complete: async () => ({ provider: 'test', data: { answers: [{ id: 'q1', answer: 'yes', spans: ['S1'] }] } }) };
    const checks = await new ChecklistJudge({ router: wrapped }).judge({ url: 'http://example.com' }, 'We carry Barbour', testChecklist);
    expect(checks.find(c => c.id === 'brand|Does this carry Barbour?')?.answer).toBe('yes');
    const bare = { complete: async () => ({ provider: 'test', data: { note: 'none' } }) };
    const none = await new ChecklistJudge({ router: bare }).judge({ url: 'http://example.com' }, 'We carry Barbour', testChecklist);
    expect(none.map(c => c.answer)).toEqual(['unknown', 'unknown']);
  });

  it('treats asked id with no reply as unknown', async () => {
    const router = {
      complete: async () => ({
        provider: 'test',
        data: [
          { id: 'q1', answer: 'yes', spans: ['S1'] },
        ],
      }),
    };
    const judge = new ChecklistJudge({ router });
    const item = { url: 'http://example.com' };
    const pageText = 'We carry Barbour';
    const checks = await judge.judge(item, pageText, testChecklist);
    const barbourCheck = checks.find(c => c.id === 'brand|Does this carry Barbour?');
    const ralphCheck = checks.find(c => c.id === 'brand|Does this carry Ralph Lauren?');
    expect(barbourCheck?.answer).toBe('yes');
    expect(ralphCheck?.answer).toBe('unknown');
  });

  it('treats answer not in yes|no|unknown as unknown', async () => {
    const router = {
      complete: async () => ({
        provider: 'test',
        data: [
          { id: 'q1', answer: 'maybe', spans: ['S1'] },
          { id: 'q2', answer: 'yes', spans: ['S1'] },
        ],
      }),
    };
    const judge = new ChecklistJudge({ router });
    const item = { url: 'http://example.com' };
    const pageText = 'We carry Barbour and Ralph Lauren';
    const checks = await judge.judge(item, pageText, testChecklist);
    const barbourCheck = checks.find(c => c.id === 'brand|Does this carry Barbour?');
    const ralphCheck = checks.find(c => c.id === 'brand|Does this carry Ralph Lauren?');
    expect(barbourCheck?.answer).toBe('unknown');
    expect(ralphCheck?.answer).toBe('yes');
  });

  it('carries hard and clause through to checks', async () => {
    const router = {
      complete: async () => ({
        provider: 'test',
        data: [
          { id: 'q1', answer: 'yes', spans: ['S1'] },
        ],
      }),
    };
    const judge = new ChecklistJudge({ router });
    const item = { url: 'http://example.com' };
    const pageText = 'We carry Barbour';
    const checks = await judge.judge(item, pageText, testChecklist);
    const barbourCheck = checks.find(c => c.id === 'brand|Does this carry Barbour?');
    expect(barbourCheck?.hard).toBe(true);
    expect(barbourCheck?.clause).toBe('brand');
  });
});

describe('replyList', () => {
  const answer = { id: 'q1', answer: 'yes', spans: ['S1'] };

  it('reads a bare list, an answers envelope and a single answer object', () => {
    expect(replyList([answer])).toEqual([answer]);
    expect(replyList({ answers: [answer] })).toEqual([answer]);
    expect(replyList(answer)).toEqual([answer]);
  });

  it('never takes a nested list such as spans for the answers', () => {
    expect(replyList({ id: 'q1', answer: 'yes', spans: ['S22'] })).toEqual([{ id: 'q1', answer: 'yes', spans: ['S22'] }]);
    expect(replyList({ note: 'none', spans: ['S1'] })).toEqual([]);
    expect(replyList(null)).toEqual([]);
    expect(replyList('yes')).toEqual([]);
  });

  it('accepts a list of answer objects under another key', () => {
    expect(replyList({ results: [answer] })).toEqual([answer]);
  });
});

describe('judge replies in JSON-object mode', () => {
  const fourChecklist = [{ clause: 'c', items: [1, 2, 3, 4].map((n) => ({ clause: 'c', question: `Is property ${n} stated?`, hard: true, numeric: null })) }];
  const askedIds = (content: string) => [...content.matchAll(/^(q\d+):/gm)].map((m) => m[1]);

  function scriptedRouter(replies: unknown[]) {
    const calls: string[][] = [];
    return {
      calls,
      complete: async (req: { messages: { content: string }[] }) => {
        calls.push(askedIds(req.messages[1].content));
        return { provider: 'test', data: replies[Math.min(calls.length - 1, replies.length - 1)] };
      },
    };
  }

  it('a reply that is one answer object binds that answer and asks the other questions once more, only them', async () => {
    const router = scriptedRouter([
      { id: 'q1', answer: 'yes', spans: ['S1'] },
      { answers: [{ id: 'q2', answer: 'no', spans: ['S1'] }, { id: 'q3', answer: 'unknown', spans: [] }, { id: 'q4', answer: 'yes', spans: ['S1'] }] },
    ]);
    const checks = await new ChecklistJudge({ router }).judge({ url: 'http://example.com' }, 'Property one is stated here', fourChecklist);
    expect(router.calls).toEqual([['q1', 'q2', 'q3', 'q4'], ['q2', 'q3', 'q4']]);
    expect(checks.map((c) => c.answer)).toEqual(['yes', 'no', 'unknown', 'yes']);
    expect(checks[0].quote).toBe('Property one is stated here');
  });

  it('the follow-up is asked once: questions it leaves uncovered count as unknown without a third call', async () => {
    const router = scriptedRouter([{ id: 'q1', answer: 'yes', spans: ['S1'] }]);
    const checks = await new ChecklistJudge({ router }).judge({ url: 'http://example.com' }, 'Property one is stated here', fourChecklist);
    expect(router.calls).toEqual([['q1', 'q2', 'q3', 'q4'], ['q2', 'q3', 'q4']]);
    expect(checks.map((c) => c.answer)).toEqual(['yes', 'unknown', 'unknown', 'unknown']);
  });

  it('a reply that covers every question is not followed up', async () => {
    const router = scriptedRouter([{ answers: [1, 2, 3, 4].map((n) => ({ id: `q${n}`, answer: 'unknown', spans: [] })) }]);
    await new ChecklistJudge({ router }).judge({ url: 'http://example.com' }, 'Property one is stated here', fourChecklist);
    expect(router.calls).toEqual([['q1', 'q2', 'q3', 'q4']]);
  });

  it('the prompt asks for an object with an answers list, the shape JSON-object mode allows', () => {
    const sys = judgePrompt({ questions: [{ short: 'q1', question: 'Is it stated?' }], block: '[S1] It is stated' })[0].content;
    expect(sys).toContain('{"answers":[{"id":"q1"');
    expect(sys).not.toContain('only: [');
  });
});

describe('checklistFingerprint and caching', () => {
  const testChecklist = [
    { clause: 'brand', items: [
      { clause: 'brand', question: 'Does this carry Barbour?', hard: true, numeric: null },
      { clause: 'brand', question: 'Does this carry Ralph Lauren?', hard: false, numeric: null },
    ]},
  ];

  it('produces consistent fingerprint for same checklist', () => {
    const fp1 = checklistFingerprint(testChecklist);
    const fp2 = checklistFingerprint(testChecklist);
    expect(fp1).toBe(fp2);
    expect(fp1).toContain('brand|Does this carry Barbour?|1|none');
    expect(fp1).toContain('brand|Does this carry Ralph Lauren?|0|none');
  });

  it('produces different fingerprint when checklist changes', () => {
    const fp1 = checklistFingerprint(testChecklist);
    const modifiedChecklist = [
      { clause: 'brand', items: [
        { clause: 'brand', question: 'Does this carry Barbour?', hard: true, numeric: null },
        { clause: 'brand', question: 'Does this carry Ralph Lauren?', hard: true, numeric: null },
      ]},
    ];
    const fp2 = checklistFingerprint(modifiedChecklist);
    expect(fp1).not.toBe(fp2);
  });
});

describe('ChecklistJudge with fake router', () => {
  const supplierQuestion = 'Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren, Monclair, North face, Barbour with highest price/value ratio, proven good quality, assortiment for the appropriate retail second hand shop business in Czech Republic';
  const supplierChecklist = [
    { clause: 'brands', items: [
      { clause: 'brands', question: 'Does this carry Barbour?', hard: true, numeric: null },
      { clause: 'brands', question: 'Does this carry Ralph Lauren?', hard: true, numeric: null },
    ]},
    { clause: 'price', items: [
      { clause: 'price', question: 'Is the price per kg stated?', hard: false, numeric: { measure: 'priceEur', op: '<=', value: 50, unit: 'EUR/kg' } },
    ]},
  ];

  it('returns unknown for Barbour when page mentions supplier but not Barbour', async () => {
    let callCount = 0;
    const router = {
      complete: async ({ messages }) => {
        callCount++;
        const userMsg = messages.find(m => m.role === 'user')?.content ?? '';
        expect(userMsg).toContain('Barbour');
        expect(userMsg).toContain('Ralph Lauren');
        return {
          provider: 'test',
          data: [
            { id: 'q1', answer: 'no', quote: '' },
            { id: 'q2', answer: 'no', quote: '' },
          ],
        };
      },
    };
    const judge = new ChecklistJudge({ router });
    const item = { url: 'http://example.com', value: 40 };
    const pageText = 'We are a wholesale supplier of clothing';
    const checks = await judge.judge(item, pageText, supplierChecklist);
    const barbourCheck = checks.find(c => c.id.includes('Barbour'));
    expect(barbourCheck).toBeDefined();
    expect(barbourCheck!.answer).not.toBe('yes');
    expect(['no', 'unknown']).toContain(barbourCheck!.answer);
  });

  it('returns unknown for fabricated quote not in page', async () => {
    let callCount = 0;
    const router = {
      complete: async () => {
        callCount++;
        return {
          provider: 'test',
          data: [
            { id: 'q1', answer: 'yes', spans: ['S9'] },
          ],
        };
      },
    };
    const judge = new ChecklistJudge({ router });
    const item = { url: 'http://example.com' };
    const pageText = 'We sell wholesale clothing';
    const checks = await judge.judge(item, pageText, supplierChecklist);
    const barbourCheck = checks.find(c => c.id.includes('Barbour'));
    expect(barbourCheck).toBeDefined();
    expect(barbourCheck!.answer).toBe('unknown');
    expect(barbourCheck!.quote).toBe('');
  });

  it('uses numeric measure for priceEur', async () => {
    const router = { complete: async () => null };
    const judge = new ChecklistJudge({ router });
    const item = { url: 'http://example.com', value: 40 };
    const pageText = 'Price: 40 EUR per kg';
    const checks = await judge.judge(item, pageText, supplierChecklist);
    const priceCheck = checks.find(c => c.id.includes('price'));
    expect(priceCheck).toBeDefined();
    expect(priceCheck!.answer).toBe('yes');
    expect(priceCheck!.quote).toContain('priceEur: 40');
  });

  it('returns no for numeric measure when value exceeds limit', async () => {
    const router = { complete: async () => null };
    const judge = new ChecklistJudge({ router });
    const item = { url: 'http://example.com', value: 100 };
    const pageText = 'Price: 100 EUR per kg';
    const checks = await judge.judge(item, pageText, supplierChecklist);
    const priceCheck = checks.find(c => c.id.includes('price'));
    expect(priceCheck).toBeDefined();
    expect(priceCheck!.answer).toBe('no');
    expect(priceCheck!.quote).toContain('priceEur: 100');
  });
});

describe('item-level checklist with a kind check and code-measured values', () => {
  const checklist = [
    { clause: 'shape', items: [{ clause: 'shape', question: 'Is this thing round?', hard: true, numeric: null }] },
    { clause: 'within 50 km of the town', items: [{ clause: 'within 50 km of the town', question: 'Is this within 50 km of the town?', hard: true, numeric: { measure: 'distanceKm', op: '<=', value: 50, unit: 'km' } }] },
  ];
  const kind = { label: 'widget', terms: ['widget'], not: ['spare part'] };
  const KIND_ID = `kind|${kindCluster(kind).items[0].question}`;

  function recordingRouter(answers: (asked: { id: string; question: string }[]) => unknown[]) {
    const asked: string[][] = [];
    return {
      asked,
      complete: async (req: { messages: { content: string }[] }) => {
        const userContent = req.messages[1].content ?? '';
        const ids: { id: string; question: string }[] = [];
        const lines = userContent.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          const match = line.match(/^(q\d+):\s*(.+)$/);
          if (match) {
            const shortId = match[1];
            const question = match[2];
            ids.push({ id: shortId, question });
          }
        }
        asked.push(ids.map((x) => x.id));
        return { provider: 'test', data: answers(ids) };
      },
    };
  }

  function kindRouter(kindReply: unknown) {
    const kindPrompts: string[] = [];
    const questionCalls: number[] = [];
    return {
      kindPrompts,
      questionCalls,
      complete: async (req: { messages: { content: string }[] }) => {
        const content = req.messages[1].content ?? '';
        if (content.includes('This page offers:')) {
          kindPrompts.push(content);
          return { provider: 'test', data: kindReply };
        }
        const ids = [...content.matchAll(/^(q\d+):/gm)].map((m) => m[1]);
        questionCalls.push(ids.length);
        return { provider: 'test', data: ids.map((id) => ({ id, answer: 'yes', spans: ['S1'] })) };
      },
    };
  }

  it('asks the kind in its own call as a selection among closed options, with a sentence id', async () => {
    const router = kindRouter({ kind: 'A', span: 'S1' });
    const checks = await new ChecklistJudge({ router }).judge({ url: 'http://example.com', distanceKm: 10 }, 'A round widget for sale', checklist, kind);
    expect(kindCluster(kind).items[0].question).toContain('widget');
    expect(kindCluster(kind).items[0].question).toContain('spare part');
    expect(kindCluster(kind).options.map((o: { letter: string }) => o.letter)).toEqual(['A', 'B', 'C', 'D', 'E', 'U']);
    expect(router.kindPrompts).toHaveLength(1);
    expect(router.kindPrompts[0]).toContain('A) one widget, offered as asked');
    expect(router.kindPrompts[0]).toContain('[S1] A round widget for sale');
    expect(checks.find((c) => c.id === KIND_ID)).toMatchObject({ answer: 'yes', quote: 'A round widget for sale', hard: true, clause: 'kind' });
  });

  it('a page selected as a part, a list, a wanted ad or something else fails the kind check', async () => {
    for (const letter of ['B', 'C', 'D', 'E']) {
      const checks = await new ChecklistJudge({ router: kindRouter({ kind: letter, span: 'S1' }) }).judge({ url: 'http://example.com', distanceKm: 10 }, 'A spare part for a widget', checklist, kind);
      expect(checks.find((c) => c.id === KIND_ID)?.answer).toBe('no');
    }
  });

  it('a kind answer without a real sentence id, or the cannot-tell option, is unknown', async () => {
    for (const reply of [{ kind: 'A', span: 'S7' }, { kind: 'A' }, { kind: 'U', span: 'S1' }, { kind: 'Z', span: 'S1' }, [{ id: 'q1', answer: 'yes', spans: ['S1'] }]]) {
      const checks = await new ChecklistJudge({ router: kindRouter(reply) }).judge({ url: 'http://example.com', distanceKm: 10 }, 'A round widget for sale', checklist, kind);
      expect(checks.find((c) => c.id === KIND_ID)).toMatchObject({ answer: 'unknown', quote: '' });
    }
  });

  it('lists the member kinds under option A for an umbrella kind', () => {
    const umbrella = { label: 'contractor', terms: ['contractor'], members: [{ label: 'roofer', terms: ['roofing'] }, { label: 'plumber', terms: ['plumbing'] }] };
    expect(kindCluster(umbrella).options[0].text).toBe('one contractor, offered as asked, of one of these kinds: roofer, plumber');
  });

  it('asks at most 4 questions a call', async () => {
    const many = [{ clause: 'c', items: Array.from({ length: 9 }, (_, i) => ({ clause: 'c', question: `Is property ${i + 1} stated?`, hard: false, numeric: null })) }];
    const router = kindRouter({ kind: 'A', span: 'S1' });
    const checks = await new ChecklistJudge({ router }).judge({ url: 'http://example.com' }, 'A round widget for sale', many);
    expect(router.questionCalls).toEqual([4, 4, 1]);
    expect(checks.filter((c) => c.answer === 'yes')).toHaveLength(9);
  });

  it('shows the sentences an embedder ranks best when the page is longer than the block, in page order', async () => {
    const page = Array.from({ length: 400 }, (_, i) => `Sentence number ${i + 1} talks about the thing.`).join(' ');
    const single = [{ clause: 'c', items: [{ clause: 'c', question: 'Is it stated?', hard: true, numeric: null }] }];
    const seen: string[] = [];
    const router = { complete: async (req: { messages: { content: string }[] }) => { seen.push(req.messages[1].content); return { provider: 'test', data: [{ id: 'q1', answer: 'yes', spans: ['S300'] }] }; } };
    const embedder = { rank: async (_q: string, texts: string[], k: number) => ({ model: 'fake', order: [299, 5, ...texts.map((_, i) => i).filter((i) => i !== 299 && i !== 5)].slice(0, k) }) };
    const checks = await new ChecklistJudge({ router, embedder }).judge({ url: 'http://example.com' }, page, single);
    expect(seen[0].indexOf('[S6]')).toBeLessThan(seen[0].indexOf('[S300]'));
    expect(checks[0]).toMatchObject({ answer: 'yes', quote: 'Sentence number 300 talks about the thing.' });
    const opening = await new ChecklistJudge({ router }).judge({ url: 'http://example.com' }, page, single);
    expect(opening[0].answer).toBe('unknown');
  });

  describe('a low price triggers a second kind judgement, it never decides the kind by itself', () => {
    const judged = [{ id: KIND_ID, answer: 'yes', quote: 'A round widget', hard: true, clause: 'kind' }, { id: 'shape|Is this thing round?', answer: 'yes', quote: 'round', hard: true, clause: 'shape' }];
    const pageText = 'A round widget for sale. Four spare wheels of a widget.';
    const second = (replies: unknown) => {
      const router = fakeRouter({ 'kind-second': replies });
      return { router, options: { cut: 9000, median: 25000, judge: new ChecklistJudge({ router }), pageText, kind } };
    };

    it('asks 3 voters with the price and the median of the comparables, and keeps the yes and its quote on A', async () => {
      const { router, options } = second({ kind: 'A', span: 'S1' });
      const hardened = await hardenKind(judged, { value: 2000, unit: 'CZK' }, options);
      expect(hardened[0]).toMatchObject({ answer: 'yes', quote: 'A round widget', second: { answer: 'yes' } });
      expect(hardened[0].reason).toBeUndefined();
      expect(hardened[1]).toEqual(judged[1]);
      expect(router.calls).toHaveLength(2);
      expect(router.calls[0]).toMatchObject({ tier: 'fast', task: 'kind-second' });
      expect(router.userText('kind-second')).toContain('Price of this item: 2000 CZK\nMedian price of its comparable items: 25000 CZK');
      expect(router.userText('kind-second')).toMatch(/^[A-E]\) a part or an accessory of it and not spare part/m);
      expect(router.userText('kind-second')).toContain('U) cannot tell from these sentences');
      expect(router.calls[1].avoid).toEqual(['p1']);
    });

    it('shows the five kinds under rotated letters, so over three votes each kind sits under three different letters', async () => {
      const { router, options } = second(seq({ kind: 'A', span: 'S1' }, { kind: 'B', span: 'S2' }, { kind: 'U' }));
      await hardenKind(judged, { value: 2000 }, options);
      const orders = router.calls.filter((call) => call.task === 'kind-second').slice(0, 3).map((call) => call.choice!.ids!.join(''));
      expect(orders).toHaveLength(3);
      for (const id of 'ABCDE') expect(new Set(orders.map((order) => order.indexOf(id))).size).toBe(3);
      expect(orders.every((order) => [...order].sort().join('') === 'ABCDE')).toBe(true);
      expect(router.calls[0].choice).toMatchObject({ field: 'kind', options: 5 });
    });

    it('never rejects on a no that only one provider family gave: the kind becomes unknown, to confirm', async () => {
      const router = fakeRouter({ 'kind-second': { kind: 'B', span: 'S2' } }, { providers: ['p1'] });
      const hardened = await hardenKind(judged, { value: 2000 }, { cut: 9000, median: 25000, judge: new ChecklistJudge({ router }), pageText, kind });
      expect(hardened[0]).toMatchObject({ answer: 'unknown', quote: 'A round widget', reason: SINGLE_KIND_REASON, second: { answer: 'unknown', single: true } });
      const sameVendor = fakeRouter({ 'kind-second': { kind: 'B', span: 'S2' } }, { providers: ['p1', 'p2'], models: { p1: 'gpt-oss-120b', p2: 'openai/gpt-oss-20b' } });
      const again = await hardenKind(judged, { value: 2000 }, { cut: 9000, median: 25000, judge: new ChecklistJudge({ router: sameVendor }), pageText, kind });
      expect(again[0]).toMatchObject({ answer: 'unknown', second: { single: true } });
      const two = await hardenKind(judged, { value: 2000 }, second({ kind: 'B', span: 'S2' }).options);
      expect(two[0]).toMatchObject({ answer: 'no', reason: LOW_PRICE_REASON });
    });

    it('answers no on a majority of B to E, with the sentence the voters picked', async () => {
      const { router, options } = second(seq({ kind: 'B', span: 'S2' }, { kind: 'A', span: 'S1' }, { kind: 'C', span: 'S2' }));
      const hardened = await hardenKind(judged, { value: 2000 }, options);
      expect(hardened[0]).toMatchObject({ answer: 'no', quote: 'Four spare wheels of a widget.', reason: LOW_PRICE_REASON });
      expect(router.calls).toHaveLength(3);
    });

    it('is unknown on U, on no majority, on an answer without a real sentence id, and without a judge', async () => {
      for (const replies of [{ kind: 'U', span: 'S1' }, seq({ kind: 'A', span: 'S1' }, { kind: 'B', span: 'S2' }, { kind: 'U' }), { kind: 'B', span: 'S9' }, FAIL]) {
        const hardened = await hardenKind(judged, { value: 2000 }, second(replies).options);
        expect(hardened[0]).toMatchObject({ answer: 'unknown', quote: 'A round widget', reason: LOW_PRICE_REASON });
      }
      expect((await hardenKind(judged, { value: 2000 }, { cut: 9000 }))[0].answer).toBe('unknown');
    });

    it('changes nothing and makes no call with no cut, at or above the cut, without a price, or when the kind is not yes', async () => {
      const { router, options } = second({ kind: 'B', span: 'S2' });
      expect(await hardenKind(judged, { value: 2000 }, { ...options, cut: null })).toBe(judged);
      expect(await hardenKind(judged, { value: 9000 }, options)).toBe(judged);
      expect(await hardenKind(judged, { value: 30000 }, options)).toBe(judged);
      expect(await hardenKind(judged, { value: null }, options)).toBe(judged);
      const no = [{ id: KIND_ID, answer: 'no', quote: 'x', hard: true, clause: 'kind' }];
      expect(await hardenKind(no, { value: 1 }, options)).toBe(no);
      expect(router.calls).toEqual([]);
      expect(needsSecondKind(judged, { value: 2000 }, 9000)).toBe(true);
    });
  });

  it('the fingerprint carries the judge version, so answers of an older judge are not reused', () => {
    expect(JUDGE_VERSION).toBe(6);
    expect(CHECKLIST_VERSION).toBe(6);
    expect(checklistFingerprint(checklist).endsWith(`judge:${JUDGE_VERSION}`)).toBe(true);
  });

  it('migrates stored yes and no answers without a quote to unknown and leaves numeric checks', () => {
    const project = { acceptanceResult: { items: [
      { url: 'a', checks: [{ id: 'x', answer: 'no', quote: '' }, { id: 'y', answer: 'yes', quote: 'distanceKm: 40 km' }, { id: KIND_ID, answer: 'yes', quote: '  ' }, { id: 'z', answer: 'unknown', quote: '' }] },
      { url: 'b' },
    ] } } as { acceptanceResult: { items: { url: string; checks?: { answer: string }[] }[] } };
    expect(migrateChecks(project)).toBe(2);
    expect(project.acceptanceResult.items[0].checks!.map((c) => c.answer)).toEqual(['unknown', 'yes', 'unknown', 'unknown']);
    expect(migrateChecks(project)).toBe(0);
    expect(migrateChecks({})).toBe(0);
  });

  it('a measured distance answers its check by code and is never sent to the page judge', async () => {
    const router = recordingRouter((qs) => qs.map((q) => ({ id: q.id, answer: 'unknown', quote: '' })));
    const judge = new ChecklistJudge({ router });
    const near = await judge.judge({ url: 'http://example.com', distanceKm: 40 }, 'page', checklist, kind);
    const far = await judge.judge({ url: 'http://example.com', distanceKm: 80 }, 'page', checklist, kind);
    const id = 'within 50 km of the town|Is this within 50 km of the town?';
    expect(near.find((c) => c.id === id)).toMatchObject({ answer: 'yes', quote: 'distanceKm: 40 km' });
    expect(far.find((c) => c.id === id)?.answer).toBe('no');
    expect(router.asked.flat()).not.toContain(id);
  });

  it('an item with no measured distance is asked the distance question from its page, with the same id, hard flag and quote check', async () => {
    const seen: string[][] = [];
    const router = {
      complete: async (req: { messages: { content: string }[] }) => {
        const asked = [...req.messages[1].content.matchAll(/^(q\d+):\s*(.+)$/gm)].map((m) => m[2]);
        seen.push(asked);
        return { provider: 'test', data: { answers: asked.map((q, i) => (q.includes('50 km') ? { id: `q${i + 1}`, answer: 'yes', spans: ['S2'] } : { id: `q${i + 1}`, answer: 'unknown', spans: [] })) } };
      },
    };
    const page = 'A round thing for sale. Our yard is in the town, ten minutes from the harbour.';
    const checks = await new ChecklistJudge({ router }).judge({ url: 'http://example.com' }, page, checklist);
    const id = 'within 50 km of the town|Is this within 50 km of the town?';
    expect(seen.flat()).toContain('Is this within 50 km of the town?');
    expect(checks.find((c) => c.id === id)).toMatchObject({ answer: 'yes', quote: 'Our yard is in the town, ten minutes from the harbour.', hard: true, clause: 'within 50 km of the town' });
  });

  it('a measured distance keeps the code comparison and that question is never sent to the page', async () => {
    const router = recordingRouter((qs) => qs.map((q) => ({ id: q.id, answer: 'unknown', spans: [] })));
    const checks = await new ChecklistJudge({ router }).judge({ url: 'http://example.com', distanceKm: 30 }, 'A round thing for sale.', checklist);
    const id = 'within 50 km of the town|Is this within 50 km of the town?';
    expect(checks.find((c) => c.id === id)).toMatchObject({ answer: 'yes', quote: 'distanceKm: 30 km' });
    expect(router.asked).toEqual([['q1']]);
  });

  it('a null or non-numeric value is not a measurement: the question joins the page batch', async () => {
    const router = recordingRouter((qs) => qs.map((q) => ({ id: q.id, answer: 'unknown', spans: [] })));
    await new ChecklistJudge({ router }).judge({ url: 'http://example.com', distanceKm: null }, 'A round thing for sale.', checklist);
    expect(router.asked).toEqual([['q1', 'q2']]);
    const numeric = { measure: 'distanceKm', op: '<=', value: 50, unit: 'km' };
    expect(measuredValue({ distanceKm: 30 }, numeric)).toBe(30);
    expect(measuredValue({ distanceKm: '12' }, numeric)).toBe(12);
    expect(measuredValue({ distanceKm: null }, numeric)).toBeUndefined();
    expect(measuredValue({ distanceKm: 'far' }, numeric)).toBeUndefined();
    expect(measuredValue({}, numeric)).toBeUndefined();
    expect(measuredValue({ distanceKm: 30 }, { ...numeric, value: null })).toBeUndefined();
    expect(measuredValue({ distanceKm: 30 }, null)).toBeUndefined();
  });
});

describe('filterCountItems', () => {
  const acceptance = { expected: 'The list of 20 best offers, 80 trade-offs to review', itemCount: 20, valueRange: [0, 65000] };
  const clusters = [
    { clause: 'shape', items: [{ clause: 'shape', question: 'Is this thing round?', hard: true, numeric: null }] },
    { clause: 'count', items: [{ clause: 'count', question: 'Does this page include at least 20 things?', hard: true, numeric: null }] },
    { clause: 'trade-off', items: [{ clause: 'trade-off', question: 'Are there up to 80 things as trade-offs?', hard: false, numeric: null }] },
    { clause: 'age', items: [{ clause: 'age', question: 'Is this up to 5 years old?', hard: true, numeric: null }] },
    { clause: 'near', items: [{ clause: 'within 20 km', question: 'Is this within 20 km of the town?', hard: true, numeric: { measure: 'distanceKm', op: '<=', value: 20, unit: 'km' } }] },
    { clause: 'price', items: [{ clause: 'price', question: 'Is the price at most 65000?', hard: true, numeric: null }] },
  ];
  const kept = (counts: number[]) => filterCountItems(clusters, counts)!.flatMap((c) => c.items.map((i) => i.question));

  it('reads the asked counts from the acceptance spec, not its value range', () => {
    expect(askedCounts(acceptance).sort((x: number, y: number) => x - y)).toEqual([20, 80]);
  });

  it('drops a qualitative item that restates an asked count and keeps per-item limits', () => {
    expect(kept(askedCounts(acceptance))).toEqual(['Is this thing round?', 'Is this up to 5 years old?', 'Is this within 20 km of the town?', 'Is the price at most 65000?']);
  });

  it('keeps every item when no count was asked', () => {
    expect(kept([])).toHaveLength(clusters.length);
  });

  it('with FRL_ITEM_COUNT_ONLY counts only the asked item count, so a value or a year the asker names per item keeps its check', () => {
    const goKarts = { expected: '4 indoor go-kart tracks in Vienna, each with its own website URL and a 10-minute adult race price in EUR', itemCount: 4, valueRange: null };
    const figure = { expected: 'one figure for 2024 residential heat pump installations in Czechia, with its source and link', itemCount: null, valueRange: null };
    const asked = [
      { clause: 'the price of a 10-minute adult race in eur', items: [{ clause: 'the price of a 10-minute adult race in eur', question: 'Does this go-kart track state the price of a 10-minute adult race in EUR?', hard: true, numeric: null }] },
      { clause: 'in 2024', items: [{ clause: 'in 2024', question: 'Does this figure refer to the year 2024?', hard: true, numeric: null }] },
      { clause: 'count', items: [{ clause: 'count', question: 'Is this one of the 4 tracks asked for?', hard: true, numeric: null }] },
    ];
    const questions = (counts: number[]) => filterCountItems(asked, counts)!.flatMap((c) => c.items.map((i) => i.question));
    expect(askedCounts(goKarts).sort((x: number, y: number) => x - y)).toEqual([4, 10]);
    expect(askedCounts(figure)).toEqual([2024]);
    process.env.FRL_ITEM_COUNT_ONLY = '1';
    try {
      expect(askedCounts(goKarts)).toEqual([4]);
      expect(askedCounts(figure)).toEqual([]);
      expect(askedCounts(acceptance)).toEqual([20]);
      expect(questions(askedCounts(goKarts))).toEqual(['Does this go-kart track state the price of a 10-minute adult race in EUR?', 'Does this figure refer to the year 2024?']);
      expect(questions(askedCounts(figure))).toHaveLength(3);
    } finally {
      delete process.env.FRL_ITEM_COUNT_ONLY;
    }
  });
});

describe('kind options for a research that looks for businesses', () => {
  it('asks whether the page is one business on its own site or profile, and names a directory, an article and a wanted ad as the other answers', () => {
    const cluster = kindCluster({ label: 'wholesale clothing supplier', terms: ['wholesale'], entity: true });
    expect(cluster.items[0].question).toBe('Is this page one wholesale clothing supplier, a single business on its own site or profile (not a directory of several, an article, or a wanted ad)?');
    expect(cluster.options.map((o: { letter: string }) => o.letter)).toEqual(['A', 'B', 'C', 'D', 'E', 'U']);
    expect(cluster.options[0].text).toContain('whatever range of goods it shows');
    expect(cluster.options[1].text).toBe('a directory, list or search page of several businesses');
  });

  it('keeps the listing options for an item sold on listing pages', () => {
    const cluster = kindCluster({ label: 'hatchback', terms: ['hatchback'] });
    expect(cluster.options[2].text).toBe('several items or a list');
    expect(cluster.items[0].question).toBe('Is this page one hatchback offered as asked (not a part, accessory, wanted ad or list)?');
  });
});

describe('numeric checklist items answer from the measured plot row', () => {
  const router = { complete: async () => ({ provider: 'test', data: [] }) };
  const sea = [{ clause: 'sea within e-bike distance (~20 km)', items: [{ question: 'Is the sea within e-bike distance?', hard: true, numeric: { measure: 'distanceKm', op: '<=', value: 20, unit: 'km' } }] }];
  const price = [{ clause: 'purchase price <= 20000 eur', items: [{ question: 'Is the price at most 20000 EUR?', hard: true, numeric: { measure: 'priceEur', op: '<=', value: 20000, unit: 'EUR' } }] }];
  const climate = [{ clause: 'suitable climate for at least 10 months', items: [{ question: 'Is the climate suitable 10 months?', hard: true, numeric: { measure: 'workableMonths', op: '>=', value: 10, unit: 'months' } }] }];
  const row = { title: 'Plot', url: 'http://example.com/plot', price: 120000, currency: 'TRY', value: 2166, unit: 'EUR', site: { coastKm: 3.3, climate: { workable: 12, cci: {} } } };
  const coastCriterion = [{ measure: 'coastKm', op: '<=', value: 20 }];

  it('judges the sea item with the decision criterion measure it states when its own measure reads nothing', async () => {
    const checks = await new ChecklistJudge({ router }).judge(row, '', sea, null, coastCriterion, {});
    expect(checks[0].answer).toBe('yes');
    expect(checks[0].quote).toContain('coastKm: 3.3');
  });

  it('compares the price converted to EUR, not the listing currency amount', async () => {
    const checks = await new ChecklistJudge({ router }).judge(row, '', price, null, [], {});
    expect(checks[0].answer).toBe('yes');
  });

  it('reads the camping months from the plot site climate', async () => {
    const checks = await new ChecklistJudge({ router }).judge(row, '', climate, null, [], {});
    expect(checks[0].answer).toBe('yes');
  });
});

describe('checklist clause matching to criteria and plan checks', () => {
  const kind = { label: 'plot of land', terms: ['plot', 'terreno'], not: ['house', 'villa'] };

  const criterionText = 'strong price increase trend country real house-price trend minus the EU average realTrendVsEu';
  const planCheckLegalText = 'a legal path for a buyer legal';
  const planCheckUnitsText = 'room for 3+ units units';

  function clauseMatchRouter(picks: Record<string, string>) {
    return fakeRouter({
      '': (request) => {
        const content = request.messages[1].content ?? '';
        if (content.includes('This page offers:')) {
          return { kind: 'A', span: 'S1' };
        }
        return { answers: [{ id: 'q1', answer: 'yes', spans: ['S1'] }] };
      },
      'checklist-clause-match': (request) => {
        const query = /^Text: (.+)$/m.exec(request.messages[1].content)?.[1] ?? '';
        const pickedText = picks[query];
        if (!pickedText) return { pick: 'N' };
        return { pick: pickLetter(request as never, (option) => option === pickedText) };
      },
    });
  }

  function pickLegalRouter() {
    return fakeRouter({
      '': (request) => {
        const content = request.messages[1].content ?? '';
        if (content.includes('This page offers:')) {
          return { kind: 'A', span: 'S1' };
        }
        return { answers: [{ id: 'q1', answer: 'yes', spans: ['S1'] }] };
      },
      'checklist-clause-match': (request) => {
        const prompt = request.messages[1].content ?? '';
        const optionLines = [...prompt.matchAll(/^([A-Z])\) (.+)$/gm)];
        const options = optionLines.map(([, letter, text]) => ({ letter, text }));
        const legalOption = options.find((o) => o.text.includes('legal'));
        const pick = legalOption ? legalOption.letter : 'A';
        return { pick };
      },
    });
  }

  function makeTrendChecklist(suffix = '') {
    return [{ clause: `price increase trend is strong${suffix}`, items: [{ clause: `price increase trend is strong${suffix}`, question: 'Does this plot have a strong price increase trend?', hard: true, numeric: null }] }];
  }

  function makeGlampingChecklist(suffix = '') {
    return [{ clause: `suitable for glamping after preparation${suffix}`, items: [{ clause: `suitable for glamping after preparation${suffix}`, question: 'Is this plot suitable for glamping after the necessary preparation work?', hard: true, numeric: null }] }];
  }

  function makeUnmatchedChecklist(suffix = '') {
    return [{ clause: `unknown requirement${suffix}`, items: [{ clause: `unknown requirement${suffix}`, question: 'Does this have an unknown property?', hard: true, numeric: null }] }];
  }

  function makeCacheChecklist(suffix = '') {
    return [{ clause: `cached trend check${suffix}`, items: [{ clause: `cached trend check${suffix}`, question: 'Does this have a cached trend?', hard: true, numeric: null }] }];
  }

  it('matches "price increase trend is strong" to criterion realTrendVsEu (op >, value 0) and answers yes from row with trend +2.8 and ctx euHpi, quote includes realTrendVsEu', async () => {
    const checklist = makeTrendChecklist('-a');
    const router = clauseMatchRouter({
      'price increase trend is strong-a': criterionText,
    });
    const embedder = fakeEmbedder();
    const judge = new ChecklistJudge({ router, embedder });

    const row = {
      url: 'http://example.com/plot',
      title: 'Plot with trend',
      countryCode: 'PT',
      plan: { checks: [] },
    };
    const context = {
      criteria: [{ id: 'realTrendVsEu', measure: 'realTrendVsEu', op: '>', value: 0, clause: 'strong price increase trend' }],
      measures: { trends: { PT: { real: 2.8 } }, euHpi: 0.8 },
      row,
      fingerprint: checklistFingerprint(checklist),
    };

    const checks = await judge.judge(row, 'Some page text about the plot', checklist, kind, context);

    const trendCheck = checks.find((c) => c.id === 'price increase trend is strong-a|Does this plot have a strong price increase trend?');
    expect(trendCheck).toBeDefined();
    expect(trendCheck!.answer).toBe('yes');
    expect(trendCheck!.quote).toContain('realTrendVsEu: 2');
    expect(trendCheck!.derived).toBe(true);
    expect(router.count('checklist-clause-match')).toBeGreaterThanOrEqual(1);
  });

  it('matches "suitable for glamping after preparation" to plan checks legal+units; answers yes when both ok', async () => {
    const checklist = makeGlampingChecklist('-b');
    const router = pickLegalRouter();
    const embedder = fakeEmbedder();
    const judge = new ChecklistJudge({ router, embedder });

    const row = {
      url: 'http://example.com/plot',
      title: 'Plot with legal and units',
      plan: {
        checks: [
          { id: 'legal', label: 'a legal path for a buyer', ok: true, detail: 'Rural camping park allowed' },
          { id: 'units', label: 'room for 3+ units', ok: true, detail: '720 m² → 10 units' },
        ],
      },
    };
    const context = {
      criteria: [],
      row,
      fingerprint: checklistFingerprint(checklist),
    };

    const checks = await judge.judge(row, 'Some page text', checklist, kind, context);

    const glampingCheck = checks.find((c) => c.id === 'suitable for glamping after preparation-b|Is this plot suitable for glamping after the necessary preparation work?');
    expect(glampingCheck).toBeDefined();
    expect(glampingCheck!.answer).toBe('yes');
    expect(glampingCheck!.quote).toContain('legal: yes');
    expect(glampingCheck!.derived).toBe(true);
  });

  it('matches "suitable for glamping after preparation" to plan checks legal+units; answers no when one is false', async () => {
    const checklist = makeGlampingChecklist('-c');
    const router = pickLegalRouter();
    const embedder = fakeEmbedder();
    const judge = new ChecklistJudge({ router, embedder });

    const row = {
      url: 'http://example.com/plot',
      title: 'Plot with legal false',
      plan: {
        checks: [
          { id: 'legal', label: 'a legal path for a buyer', ok: false, detail: 'Not allowed' },
          { id: 'units', label: 'room for 3+ units', ok: true, detail: '720 m² → 10 units' },
        ],
      },
    };
    const context = {
      criteria: [],
      row,
      fingerprint: checklistFingerprint(checklist),
    };

    const checks = await judge.judge(row, 'Some page text', checklist, kind, context);

    const glampingCheck = checks.find((c) => c.id === 'suitable for glamping after preparation-c|Is this plot suitable for glamping after the necessary preparation work?');
    expect(glampingCheck).toBeDefined();
    expect(glampingCheck!.answer).toBe('no');
    expect(glampingCheck!.quote).toContain('legal: no');
    expect(glampingCheck!.derived).toBe(true);
  });

  it('an unmatched clause stays page-judged (router called for the page question)', async () => {
    const checklist = makeUnmatchedChecklist('-d');
    const router = fakeRouter({
      '': (request) => {
        const content = request.messages[1].content ?? '';
        if (content.includes('This page offers:')) {
          return { kind: 'A', span: 'S1' };
        }
        return { answers: [{ id: 'q1', answer: 'yes', spans: ['S1'] }] };
      },
      'checklist-clause-match': (request) => {
        const query = /^Text: (.+)$/m.exec(request.messages[1].content)?.[1] ?? '';
        return { pick: 'N' };
      },
    });
    const embedder = fakeEmbedder();
    const judge = new ChecklistJudge({ router, embedder });

    const row = { url: 'http://example.com/plot', title: 'Plot', plan: { checks: [] } };
    const context = {
      criteria: [{ id: 'dummy', measure: 'priceEur', op: '<=', value: 100, clause: 'dummy' }],
      row,
      fingerprint: checklistFingerprint(checklist),
    };

    const checks = await judge.judge(row, 'Page says it has the unknown property', checklist, kind, context);

    const unmatchedCheck = checks.find((c) => c.id === 'unknown requirement-d|Does this have an unknown property?');
    expect(unmatchedCheck).toBeDefined();
    expect(unmatchedCheck!.answer).toBe('yes');
    expect(unmatchedCheck!.quote).toContain('unknown property');
    expect(unmatchedCheck!.derived).toBeUndefined();
    expect(router.count('checklist-clause-match')).toBeGreaterThanOrEqual(1);
  });

  it('the match is computed once per checklist fingerprint (cached)', async () => {
    const checklist = makeCacheChecklist('-e');
    let matchCalls = 0;
    const router = fakeRouter({
      '': (request) => {
        const content = request.messages[1].content ?? '';
        if (content.includes('This page offers:')) {
          return { kind: 'A', span: 'S1' };
        }
        return { answers: [{ id: 'q1', answer: 'yes', spans: ['S1'] }] };
      },
      'checklist-clause-match': (request) => {
        matchCalls++;
        return { pick: 'A' };
      },
    });
    const embedder = fakeEmbedder();
    const judge = new ChecklistJudge({ router, embedder });

    const row = { url: 'http://example.com/plot', title: 'Plot', countryCode: 'PT', plan: { checks: [] } };
    const context = {
      criteria: [{ id: 'realTrendVsEu', measure: 'realTrendVsEu', op: '>', value: 0, clause: 'cached trend check' }],
      measures: { trends: { PT: { real: 2.8 } }, euHpi: 0.8 },
      row,
      fingerprint: checklistFingerprint(checklist),
    };

    await judge.judge(row, 'Page text 1', checklist, kind, context);
    await judge.judge(row, 'Page text 2', checklist, kind, context);
    await judge.judge(row, 'Page text 3', checklist, kind, context);

    expect(matchCalls).toBe(2);
  });
});

describe('"no" means the page states the contrary (FRL_NO_MEANS_CONTRARY)', () => {
  const q = [{ short: 'q1', question: 'Is the adult monthly membership price in EUR provided for this bouldering gym?' }];
  const original = 'You are a strict judge of one item page. The page is shown as numbered sentences. For each question answer "yes", "no" or "unknown", and give in "spans" the ids of the one or two sentences that show it. Never write the sentence itself. An answer without a sentence id is not counted, so answer "unknown" with empty "spans" when no sentence shows it. Answer with JSON only, one entry per question: {"answers":[{"id":"q1","answer":"yes|no|unknown","spans":["S12"]}]}';
  it('keeps the original judge prompt without the flag and defines "no" as a stated contrary with it', () => {
    const before = process.env.FRL_NO_MEANS_CONTRARY;
    try {
      delete process.env.FRL_NO_MEANS_CONTRARY;
      expect(judgePrompt({ questions: q, block: '[S1] Typ Einmalzahlung Monatlich' })[0].content).toBe(original);
      process.env.FRL_NO_MEANS_CONTRARY = '1';
      const on = judgePrompt({ questions: q, block: '[S1] Typ Einmalzahlung Monatlich' })[0].content;
      expect(on).toContain('"no" only when a sentence shows it is not so');
      expect(on).toContain('a page that does not mention it is "unknown", never "no"');
      expect(on).toContain('An answer without a sentence id is not counted');
    } finally {
      if (before === undefined) delete process.env.FRL_NO_MEANS_CONTRARY;
      else process.env.FRL_NO_MEANS_CONTRARY = before;
    }
  });
});

describe('a check the asker wrote is kept on its quote, not by vote (FRL_QUOTED_CHECKS)', () => {
  const asker = 'Find 5 bouldering gyms in Leipzig, Germany, each with its own website URL and the adult monthly membership price in EUR.\n5 bouldering gyms, each with its own website URL and an adult monthly membership price in EUR\n';
  const sample = (items: Array<Record<string, unknown>>) => ({ items });
  const gym = { clause: 'located in leipzig', question: 'Is this bouldering gym located in Leipzig?', hard: true, quote: 'in Leipzig, Germany' };
  const own = { clause: 'own website url', question: 'Is this page the bouldering gym\'s own website?', hard: false, quote: 'each with its own website URL' };
  const invented = { clause: 'open on sundays', question: 'Is this bouldering gym open on Sundays?', hard: true, quote: 'open on Sundays' };
  const withFlag = (flag: boolean, body: () => void) => {
    const before = process.env.FRL_QUOTED_CHECKS;
    if (flag) process.env.FRL_QUOTED_CHECKS = '1';
    else delete process.env.FRL_QUOTED_CHECKS;
    try {
      body();
    } finally {
      if (before === undefined) delete process.env.FRL_QUOTED_CHECKS;
      else process.env.FRL_QUOTED_CHECKS = before;
    }
  };
  it('keeps a minority item whose quote is in the asker text, as hard, and records its provenance', () => {
    withFlag(true, () => {
      const clusters = clusterChecklist([sample([gym, own]), sample([gym]), sample([gym])], { askerWords: asker });
      expect(clusters.map((c: { clause: string }) => c.clause)).toEqual(['in leipzig, germany', 'each with its own website url']);
      const kept = clusters.find((c: { clause: string }) => c.clause === 'each with its own website url');
      expect(kept).toMatchObject({ source: 'quoted', quote: 'each with its own website URL', share: 0.33 });
      expect(kept.items[0].hard).toBe(true);
    });
  });
  it('does not rescue a minority item whose quote is not in the asker text', () => {
    withFlag(true, () => {
      const clusters = clusterChecklist([sample([gym, invented]), sample([gym]), sample([gym])], { askerWords: asker });
      expect(clusters.map((c: { clause: string }) => c.clause)).toEqual(['in leipzig, germany']);
    });
  });
  it('without the flag keeps only majority items, with the old cluster shape', () => {
    withFlag(false, () => {
      const clusters = clusterChecklist([sample([gym, own]), sample([gym]), sample([gym])], { askerWords: asker });
      expect(clusters).toEqual([{ clause: 'located in leipzig', items: [{ clause: 'located in leipzig', question: 'Is this bouldering gym located in Leipzig?', hard: true, numeric: undefined }] }]);
    });
  });
  it('shows the expected result and asks for quotes only with the flag', async () => {
    const seen: Array<Array<{ role: string; content: string }>> = [];
    const router = { complete: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => { seen.push(messages); return { data: { items: [gym] } }; } };
    const before = process.env.FRL_QUOTED_CHECKS;
    try {
      delete process.env.FRL_QUOTED_CHECKS;
      await proposeChecklist({ router: router as never, question: 'Find 5 bouldering gyms in Leipzig', samples: 1, expected: '5 gyms with their own website' });
      process.env.FRL_QUOTED_CHECKS = '1';
      await proposeChecklist({ router: router as never, question: 'Find 5 bouldering gyms in Leipzig', samples: 1, expected: '5 gyms with their own website' });
    } finally {
      if (before === undefined) delete process.env.FRL_QUOTED_CHECKS;
      else process.env.FRL_QUOTED_CHECKS = before;
    }
    expect(seen[0][1].content).toBe('Question: Find 5 bouldering gyms in Leipzig');
    expect(seen[0][0].content).not.toContain('"quote"');
    expect(seen[1][1].content).toBe('Question: Find 5 bouldering gyms in Leipzig\nExpected result: 5 gyms with their own website');
    expect(seen[1][0].content).toContain('Each item also has "quote"');
  });
});

describe('a request to state a value is an item, not a dropped limit (FRL_QUOTED_CHECKS)', () => {
  it('tells the proposal to keep a requested value as a hard item only with the flag', async () => {
    const seen: Array<Array<{ role: string; content: string }>> = [];
    const router = { complete: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => { seen.push(messages); return { data: { items: [{ clause: 'in brno', question: 'Is this coworking space in Brno?', hard: true }] } }; } };
    const before = process.env.FRL_QUOTED_CHECKS;
    try {
      delete process.env.FRL_QUOTED_CHECKS;
      await proposeChecklist({ router: router as never, question: 'Find 4 coworking spaces in Brno with the price of a one-day pass in CZK', samples: 1 });
      process.env.FRL_QUOTED_CHECKS = '1';
      await proposeChecklist({ router: router as never, question: 'Find 4 coworking spaces in Brno with the price of a one-day pass in CZK', samples: 1 });
    } finally {
      if (before === undefined) delete process.env.FRL_QUOTED_CHECKS;
      else process.env.FRL_QUOTED_CHECKS = before;
    }
    expect(seen[0][0].content).not.toContain('is not a limit and is not dropped');
    expect(seen[1][0].content).toContain('A request that each item states a value (its price, a fee, a size, a duration) is not a limit and is not dropped');
    expect(seen[1][0].content).toContain('Only a bound on that value (at most, under, at least) is left to the acceptance value range.');
  });
});

describe('a hard "no" rejects only when a second vote agrees its sentence shows the item fails (FRL_CONFIRMED_NO)', () => {
  const checklist = [
    { clause: 'adult monthly membership price in eur', items: [{ clause: 'adult monthly membership price in eur', question: 'Does this bouldering gym state its adult monthly membership price in EUR?', hard: true, numeric: null }] },
    { clause: 'in leipzig, germany', items: [{ clause: 'in leipzig, germany', question: 'Does this bouldering gym locate in Leipzig, Germany?', hard: true, numeric: null }] },
  ];
  const page = 'Die Boulderhalle liegt in Dresden. Regulär 99,00 € Ermäßigt 80,00 € für die 10er-Karte.';
  const router = () => fakeRouter({
    '': { answers: [{ id: 'q1', answer: 'no', spans: ['S2'] }, { id: 'q2', answer: 'no', spans: ['S1'] }] },
    'no-check': (request: { messages: Array<{ content: string }> }) => (request.messages[1].content.includes('Dresden') ? { pick: 'fails' } : { pick: 'other' }),
  });
  const judged = async (flag: boolean) => {
    const before = process.env.FRL_CONFIRMED_NO;
    if (flag) process.env.FRL_CONFIRMED_NO = '1';
    else delete process.env.FRL_CONFIRMED_NO;
    try {
      const fake = router();
      const checks = await new ChecklistJudge({ router: fake as never }).judge({ url: 'https://boulder.example' }, page, checklist);
      return { checks, votes: fake.count('no-check') };
    } finally {
      if (before === undefined) delete process.env.FRL_CONFIRMED_NO;
      else process.env.FRL_CONFIRMED_NO = before;
    }
  };

  it('turns a "no" whose sentence shows another value of a different thing into unknown, and keeps a "no" whose sentence shows another place', async () => {
    const { checks, votes } = await judged(true);
    expect(checks).toEqual([
      { id: 'adult monthly membership price in eur|Does this bouldering gym state its adult monthly membership price in EUR?', answer: 'unknown', quote: '', hard: true, clause: 'adult monthly membership price in eur', noUnconfirmed: 'Regulär 99,00 € Ermäßigt 80,00 € für die 10er-Karte.' },
      { id: 'in leipzig, germany|Does this bouldering gym locate in Leipzig, Germany?', answer: 'no', quote: 'Die Boulderhalle liegt in Dresden.', hard: true, clause: 'in leipzig, germany' },
    ]);
    expect(votes).toBe(4);
  });

  it('keeps every "no" as the judge gave it, with no second vote, without the flag', async () => {
    const { checks, votes } = await judged(false);
    expect(checks.map((check: { answer: string }) => check.answer)).toEqual(['no', 'no']);
    expect(checks.some((check: Record<string, unknown>) => 'noUnconfirmed' in check)).toBe(false);
    expect(votes).toBe(0);
  });
});

describe('a checklist survives proposals that fail (FRL_CHECKLIST_REQUIRED)', () => {
  const question = 'Find 5 bouldering gyms in Leipzig, Germany, each with its own website URL and the adult monthly membership price in EUR.';
  const expected = '5 bouldering gyms, each with its own website URL and an adult monthly membership price in EUR';
  const own = { clause: 'own website', question: "Is this page the bouldering gym's own website?", hard: true, numeric: null, quote: 'each with its own website URL' };
  const price = { clause: 'monthly price', question: 'Does this bouldering gym page state its adult monthly membership price in EUR?', hard: true, numeric: null, quote: 'adult monthly membership price in EUR' };
  const invented = { clause: 'open late', question: 'Is this bouldering gym open after 22:00?', hard: true, numeric: null, quote: 'open late' };
  const routerAnswering = (answers: (call: number) => boolean) => {
    let calls = 0;
    return {
      get calls() { return calls; },
      complete: async () => {
        calls++;
        if (!answers(calls)) throw new Error('gemini HTTP 429: daily quota');
        return { provider: 'test', data: { items: [own, price, invented] } };
      },
    };
  };
  const built = async (flag: boolean, router: { complete: () => Promise<unknown> }) => {
    const before = { required: process.env.FRL_CHECKLIST_REQUIRED, quoted: process.env.FRL_QUOTED_CHECKS };
    process.env.FRL_QUOTED_CHECKS = '1';
    if (flag) process.env.FRL_CHECKLIST_REQUIRED = '1';
    else delete process.env.FRL_CHECKLIST_REQUIRED;
    try {
      return await new ChecklistModeler({ router: router as never, samples: 3 }).build(question, '', expected);
    } finally {
      if (before.required === undefined) delete process.env.FRL_CHECKLIST_REQUIRED;
      else process.env.FRL_CHECKLIST_REQUIRED = before.required;
      if (before.quoted === undefined) delete process.env.FRL_QUOTED_CHECKS;
      else process.env.FRL_QUOTED_CHECKS = before.quoted;
    }
  };

  it('asks again for the proposals that failed, and builds the checklist from all that answered', async () => {
    const off = routerAnswering((call) => call > 2);
    expect(await built(false, off)).toBeNull();
    expect(off.calls).toBe(3);
    const on = routerAnswering((call) => call > 2);
    const checklist = await built(true, on);
    expect(on.calls).toBe(5);
    expect(checklist!.map((c: { clause: string }) => c.clause)).toEqual(['each with its own website url', 'adult monthly membership price in eur', 'open late']);
    expect(checklist!.slice(0, 2).map((c: { source: string }) => c.source)).toEqual(['quoted', 'quoted']);
  });

  it('keeps only the asker-quoted items of a lone proposal when every retry fails', async () => {
    const on = routerAnswering((call) => call === 1);
    const checklist = await built(true, on);
    expect(on.calls).toBe(7);
    expect(checklist).toEqual([
      { clause: 'each with its own website url', source: 'quoted', quote: 'each with its own website URL', share: 1, items: [{ clause: 'each with its own website url', question: "Is this page the bouldering gym's own website?", hard: true, numeric: undefined }] },
      { clause: 'adult monthly membership price in eur', source: 'quoted', quote: 'adult monthly membership price in EUR', share: 1, items: [{ clause: 'adult monthly membership price in eur', question: 'Does this bouldering gym page state its adult monthly membership price in EUR?', hard: true, numeric: undefined }] },
    ]);
  });

  it('gives no checklist when no proposal answers at all, after the retries', async () => {
    const none = routerAnswering(() => false);
    expect(await built(true, none)).toBeNull();
    expect(none.calls).toBe(9);
  });
});

describe('two requirements the asker wrote in different words are never merged (FRL_QUOTED_DISTINCT)', () => {
  const asker = 'Find 4 coworking spaces in Brno, Czechia, each with its own website URL and the price of a one-day pass in CZK.\n4 coworking spaces in Brno, each with its own website URL and a one-day pass price in CZK\n';
  const place = { clause: 'in brno', question: 'Is this coworking space in Brno, Czechia?', hard: true, numeric: null, quote: 'in Brno, Czechia' };
  const price = { clause: 'day pass price', question: 'Does this coworking space page state the price of a one-day pass in CZK?', hard: true, numeric: null, quote: 'the price of a one-day pass in CZK' };
  const reworded = { clause: 'located in brno', question: 'Is this coworking space located in Brno, Czechia?', hard: true, numeric: null, quote: 'in Brno' };
  const clauses = (flag: boolean, samples: Array<{ items: object[] }>) => {
    const before = { distinct: process.env.FRL_QUOTED_DISTINCT, quoted: process.env.FRL_QUOTED_CHECKS };
    process.env.FRL_QUOTED_CHECKS = '1';
    if (flag) process.env.FRL_QUOTED_DISTINCT = '1';
    else delete process.env.FRL_QUOTED_DISTINCT;
    try {
      return clusterChecklist(samples as never, { askerWords: asker }).map((c: { clause: string }) => c.clause);
    } finally {
      if (before.distinct === undefined) delete process.env.FRL_QUOTED_DISTINCT;
      else process.env.FRL_QUOTED_DISTINCT = before.distinct;
      if (before.quoted === undefined) delete process.env.FRL_QUOTED_CHECKS;
      else process.env.FRL_QUOTED_CHECKS = before.quoted;
    }
  };
  const samples = () => [{ items: [place, price] }, { items: [place, price] }, { items: [reworded, price] }];

  it('keeps the place and the day-pass price apart though their questions share the kind words, and still merges two wordings of the same ask', () => {
    expect(clauses(false, samples())).toEqual(['in brno, czechia']);
    expect(clauses(true, samples())).toEqual(['in brno, czechia', 'the price of a one-day pass in czk']);
  });
});

describe('the judge sees the page address, and a yes resting on it alone needs a second vote (FRL_PAGE_ADDRESS)', () => {
  const checklist = [{ clause: 'each with its own website url', items: [{ clause: 'each with its own website url', question: 'Does this gym have its own website URL?', hard: true, numeric: null }] }];
  const own = { url: 'https://www.onyx-leipzig.de/preise/', page: 'Preise | Onyx Leipzig. Tageskarten fuer alle Niveaus und Kurse.' };
  const listing = { url: 'https://bestclimbingwalls.com/climbing-walls/no-limit', page: 'No Limit Leipzig | Best Climbing Walls. Find the climbing walls near you.' };
  const judgeAnswers = (request: { messages: Array<{ content: string }> }) => {
    const text = request.messages.map((m) => m.content).join(' ');
    if (text.includes('Page address:') || text.includes('Onyx')) return { answers: [{ id: 'q1', answer: 'yes', spans: ['S1'] }] };
    return { answers: [{ id: 'q1', answer: 'unknown', spans: [] }] };
  };
  const router = (addressCheck: unknown = (request: { messages: Array<{ content: string }> }) => (request.messages[1].content.includes('onyx-leipzig.de') ? { pick: 'shows' } : { pick: 'other' })) => fakeRouter({ '': judgeAnswers, 'address-check': addressCheck as never });
  const judgeText = (fake: { calls: Array<{ messages: Array<{ content: string }> }> }) => fake.calls.map((call) => call.messages.map((m) => m.content).join(' ')).find((text) => text.includes('Item page text:') && text.includes('Questions:')) ?? '';
  const judged = async (flag: boolean, item: { url: string; page: string }, kind: { label: string; terms: string[] } | null = null, addressCheck?: unknown) => {
    const before = process.env.FRL_PAGE_ADDRESS;
    if (flag) process.env.FRL_PAGE_ADDRESS = '1';
    else delete process.env.FRL_PAGE_ADDRESS;
    try {
      const fake = addressCheck === undefined ? router() : router(addressCheck);
      const checks = await new ChecklistJudge({ router: fake as never }).judge({ url: item.url }, item.page, checklist, kind);
      return { checks, fake };
    } finally {
      if (before === undefined) delete process.env.FRL_PAGE_ADDRESS;
      else process.env.FRL_PAGE_ADDRESS = before;
    }
  };

  it('shows the address as the first sentence and keeps a yes on it when the vote agrees the address itself shows it', async () => {
    const { checks, fake } = await judged(true, own);
    expect(judgeText(fake)).toContain(`[S1] Page address: ${own.url}`);
    expect(checks[0]).toMatchObject({ answer: 'yes', quote: `Page address: ${own.url}` });
    expect(fake.count('address-check')).toBeGreaterThanOrEqual(2);
    expect(fake.userText('address-check')).toContain('Opening sentences of the page:\nPreise | Onyx Leipzig.');
  });

  it('falls back to the answer the page gives without its address when the vote finds the address is another site', async () => {
    const { checks, fake } = await judged(true, listing);
    expect(checks[0]).toEqual({ id: 'each with its own website url|Does this gym have its own website URL?', answer: 'unknown', quote: '', hard: true, clause: 'each with its own website url', addressUnconfirmed: listing.url });
    const asked = fake.calls.map((call: { messages: Array<{ content: string }> }) => call.messages.map((m) => m.content).join(' ')).filter((text: string) => text.includes('Item page text:') && text.includes('Questions:'));
    expect(asked).toHaveLength(2);
    expect(asked[1]).not.toContain('Page address:');
  });

  it('never does worse than the page without its address: a vote that no model answers leaves the plain answer', async () => {
    const { checks } = await judged(true, own, null, FAIL);
    expect(checks[0]).toMatchObject({ answer: 'yes', quote: 'Preise | Onyx Leipzig.', addressUnconfirmed: own.url });
  });

  it('keeps the address out of the kind question', async () => {
    const { fake } = await judged(true, own, { label: 'bouldering gym', terms: ['bouldering'] });
    const kindPrompt = fake.calls.map((call: { messages: Array<{ content: string }> }) => call.messages.map((m) => m.content).join('\n')).find((text: string) => text.includes('This page offers:'));
    expect(kindPrompt).toBeTruthy();
    expect(kindPrompt).not.toContain('Page address:');
  });

  it('shows no address and asks no second vote without the flag', async () => {
    const { checks, fake } = await judged(false, listing);
    expect(judgeText(fake)).toContain('Item page text:');
    expect(judgeText(fake)).not.toContain('Page address:');
    expect(fake.count('address-check')).toBe(0);
    expect(checks[0]).not.toHaveProperty('addressUnconfirmed');
  });
});

describe('a linked page is judged about the item it was read for (FRL_DEEPER_ITEM_NAMED)', () => {
  const checklist = [{ clause: 'price of a one-day pass in czk', items: [{ clause: 'price of a one-day pass in czk', question: 'Does this coworking space state the price of a one-day pass in CZK?', hard: true, numeric: null }] }];
  const article = 'Kolik stojí coworking v Česku. WorkLounge Smíchov, day pass od 450 Kč za osobu a den.';
  const of = { title: 'Clubco — coworking | Cowork.cz', url: 'https://cowork.cz/prostor/clubco' };
  const judgedText = async (flag: boolean, item: Record<string, unknown>) => {
    const before = process.env.FRL_DEEPER_ITEM_NAMED;
    if (flag) process.env.FRL_DEEPER_ITEM_NAMED = '1';
    else delete process.env.FRL_DEEPER_ITEM_NAMED;
    try {
      const fake = fakeRouter({ '': { answers: [{ id: 'q1', answer: 'unknown', spans: [] }] } });
      await new ChecklistJudge({ router: fake as never }).judge(item as never, article, checklist);
      return fake.calls.map((call: { messages: Array<{ content: string }> }) => call.messages.map((m) => m.content).join(' ')).find((text: string) => text.includes('Item page text:')) ?? '';
    } finally {
      if (before === undefined) delete process.env.FRL_DEEPER_ITEM_NAMED;
      else process.env.FRL_DEEPER_ITEM_NAMED = before;
    }
  };

  it('names the item and asks for answers about that item only', async () => {
    const text = await judgedText(true, { url: 'https://cowork.cz/clanky/kolik-stoji-coworking', of });
    expect(text).toContain('The item: Clubco — coworking | Cowork.cz — https://cowork.cz/prostor/clubco');
    expect(text).toContain('a sentence about another item, place or offer answers nothing, so the answer is "unknown"');
  });

  it('names nothing for an item page itself or without the flag', async () => {
    expect(await judgedText(true, { url: 'https://cowork.cz/prostor/clubco' })).not.toContain('The item:');
    const off = await judgedText(false, { url: 'https://cowork.cz/clanky/kolik-stoji-coworking', of });
    expect(off).toContain('Item page text:');
    expect(off).not.toContain('The item:');
    expect(off).not.toContain('answers nothing');
  });
});
