import { describe, expect, it, vi } from 'vitest';
import { clusterChecklist, checklistSummary, proposeChecklist, normalizeSample, ChecklistModeler, ChecklistJudge, applyQuoteCheck, checklistFingerprint, kindCluster, askedCounts, filterCountItems, hardenKind, migrateChecks, needsSecondKind, JUDGE_VERSION, CHECKLIST_VERSION, LOW_PRICE_REASON } from '../../src/research/checklist.mjs';
import { FAIL, fakeRouter, seq } from '../helpers/fakes';
import { sentenceSpans } from '../../src/research/spans.mjs';

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
      expect(router.userText('kind-second')).toContain('B) a part or an accessory of it and not spare part');
      expect(router.calls[1].avoid).toEqual(['p1']);
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
    expect(JUDGE_VERSION).toBe(4);
    expect(CHECKLIST_VERSION).toBe(4);
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

  it('an item with no measured distance leaves the distance check unknown', async () => {
    const router = recordingRouter(() => []);
    const checks = await new ChecklistJudge({ router }).judge({ url: 'http://example.com' }, 'page', checklist);
    expect(checks.find((c) => c.clause === 'within 50 km of the town')?.answer).toBe('unknown');
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
