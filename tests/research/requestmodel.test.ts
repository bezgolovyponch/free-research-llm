import { describe, expect, it } from 'vitest';
import { buildRequestModel, requestModelSummary, servesless } from '../../src/research/requestmodel.mjs';

describe('buildRequestModel grounding', () => {
  it('labels a requirement quoted when its clause is in the asker text, with fold tolerance', () => {
    const model = buildRequestModel({
      question: 'Find suppliers with a price   per KG and a phone number',
      expected: '',
      constraints: {},
      decisionModel: { purpose: 'compare offers', requirements: [{ measure: 'R1', clause: 'price per kg' }, { measure: 'R2', clause: 'verified grade A quality' }] },
    });
    const r1 = model.requirements.find((r) => r.id === 'R1');
    const r2 = model.requirements.find((r) => r.id === 'R2');
    expect(r1?.source).toBe('quoted');
    expect(r1?.quote).toBe('price per kg');
    expect(r2?.source).toBe('derived');
    expect(r2?.quote).toBe('');
  });

  it('labels the purpose quoted only when the asker said it', () => {
    const quoted = buildRequestModel({ question: 'I want to compare offers before buying', decisionModel: { purpose: 'compare offers', requirements: [{ measure: 'R1', clause: 'x' }] } });
    expect(quoted.purpose.source).toBe('quoted');
    const derived = buildRequestModel({ question: 'Find suppliers', decisionModel: { purpose: 'maximize margin', requirements: [{ measure: 'R1', clause: 'x' }] } });
    expect(derived.purpose.source).toBe('derived');
  });

  it('counts constraint values as asker text', () => {
    const model = buildRequestModel({
      question: 'Find plots',
      constraints: { where: 'within 40 km of the city' },
      decisionModel: { requirements: [{ measure: 'R1', clause: 'within 40 km of the city' }] },
    });
    expect(model.requirements[0].source).toBe('quoted');
  });

  it('uses the model-supplied quote when the clause itself is paraphrased', () => {
    const model = buildRequestModel({
      question: 'The venue must take groups of 8 to 15 men',
      decisionModel: { requirements: [{ measure: 'R1', clause: 'group capacity in the asked range', quote: 'groups of 8 to 15 men' }] },
    });
    expect(model.requirements[0].source).toBe('quoted');
    expect(model.requirements[0].quote).toBe('groups of 8 to 15 men');
  });

  it('falls back to E1 and Q1 when the model has no requirements', () => {
    const model = buildRequestModel({ question: 'How big is the market?', expected: 'two estimates with sources', decisionModel: null });
    expect(model.requirements.map((r) => r.id)).toEqual(['E1', 'Q1']);
    expect(model.requirements.every((r) => r.source === 'quoted')).toBe(true);
  });

  it('returns an empty-but-shaped model on empty input', () => {
    const model = buildRequestModel({});
    expect(model.purpose).toEqual({ text: '', source: 'derived', quote: '' });
    expect(model.requirements).toEqual([]);
  });
});

describe('servesless', () => {
  const requirements = [{ id: 'R1' }, { id: 'R2' }];
  it('names pieces with no valid serves entry', () => {
    const nodes = [
      { id: 'D1', serves: ['R1'] },
      { id: 'D2', serves: [] },
      { id: 'D3' },
      { id: 'D4', serves: ['NOPE'] },
    ];
    expect(servesless(nodes, requirements)).toEqual(['D2', 'D3', 'D4']);
  });
  it('is empty when every piece serves a known requirement', () => {
    expect(servesless([{ id: 'D1', serves: ['R2'] }], requirements)).toEqual([]);
  });
});

describe('requestModelSummary', () => {
  it('counts quoted and derived and names the purpose source', () => {
    const summary = requestModelSummary({
      purpose: { text: 'p', source: 'derived', quote: '' },
      requirements: [
        { id: 'R1', clause: 'a', source: 'quoted', quote: 'a' },
        { id: 'R2', clause: 'b', source: 'derived', quote: '' },
      ],
    });
    expect(summary).toBe('request model: 2 requirement(s) — 1 quoted, 1 derived; purpose derived');
  });
});

import { captureAlternatives } from '../../src/research/requestmodel.mjs';

describe('captureAlternatives', () => {
  const model = () => ({
    purpose: { text: '', source: 'derived', quote: '' },
    requirements: [{ id: 'R1', clause: 'a', source: 'quoted', quote: 'a' }],
  });
  const node = { id: 'D1', serves: ['R1'] };
  const source = () => ({
    url: 'https://hub.example/offers',
    text: 'Catalog: Quad safari tour for groups. Paintball arena sessions. Contact us.',
    listings: [
      { title: 'Quad safari tour', url: 'https://hub.example/quad' },
      { title: 'Paintball arena sessions', url: 'https://hub.example/pb' },
      { title: 'Ghost offer not on the page', url: 'https://hub.example/ghost' },
    ],
  });

  it('records page-verified listing titles for the served requirement and skips unverified ones', () => {
    const m = model();
    const added = captureAlternatives(m, node, [source()]);
    expect(added).toBe(2);
    expect(m.alternatives.map((a) => a.means)).toEqual(['Quad safari tour', 'Paintball arena sessions']);
    expect(m.alternatives.every((a) => a.requirementId === 'R1')).toBe(true);
    expect(m.alternatives[0].url).toBe('https://hub.example/quad');
  });

  it('dedupes across calls and returns 0 for a node serving nothing', () => {
    const m = model();
    expect(captureAlternatives(m, node, [source()])).toBe(2);
    expect(captureAlternatives(m, node, [source()])).toBe(0);
    expect(captureAlternatives(m, { id: 'D2', serves: [] }, [source()])).toBe(0);
    expect(captureAlternatives(m, { id: 'D3' }, [source()])).toBe(0);
    expect(m.alternatives).toHaveLength(2);
  });

  it('returns 0 on an empty model or unknown serves ids', () => {
    expect(captureAlternatives({ purpose: { text: '', source: 'derived', quote: '' }, requirements: [] }, node, [source()])).toBe(0);
    const m = model();
    expect(captureAlternatives(m, { id: 'D4', serves: ['NOPE'] }, [source()])).toBe(0);
  });
});
