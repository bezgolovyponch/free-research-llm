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

import { buildRoles, rolesSummary } from '../../src/research/requestmodel.mjs';

describe('buildRoles places', () => {
  it('uses "sources must be in it" when brief.located is true', () => {
    const brief = { regions: ['DE', 'PL'], located: true };
    const roles = buildRoles({ question: 'Find suppliers in Germany and Poland', expected: '', constraints: {}, brief, domain: null });
    expect(roles).toHaveLength(2);
    expect(roles[0]).toMatchObject({ name: 'Germany', type: 'place', role: 'sources must be in it', from: 'brief' });
    expect(roles[1]).toMatchObject({ name: 'Poland', type: 'place', role: 'sources must be in it', from: 'brief' });
  });

  it('uses "where the result is used" when brief.located is false', () => {
    const brief = { regions: ['CZ'], located: false };
    const roles = buildRoles({ question: 'Find suppliers for Czech market', expected: '', constraints: {}, brief, domain: null });
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ name: 'Czechia', type: 'place', role: 'where the result is used', from: 'brief' });
  });

  it('returns empty array when brief has no regions', () => {
    const brief = { regions: [], located: true };
    const roles = buildRoles({ question: 'Find suppliers', expected: '', constraints: {}, brief, domain: null });
    expect(roles).toEqual([]);
  });
});

describe('buildRoles actors', () => {
  it('creates entry per string statement in domain.actors', () => {
    const domain = { actors: ['Wholesalers', 'Retailers'] };
    const roles = buildRoles({ question: 'Find suppliers', expected: '', constraints: {}, brief: { regions: [], located: true }, domain });
    expect(roles).toHaveLength(2);
    expect(roles[0]).toMatchObject({ name: 'Wholesalers', type: 'actor', from: 'domain' });
    expect(roles[1]).toMatchObject({ name: 'Retailers', type: 'actor', from: 'domain' });
  });

  it('creates entry per object statement with text and keeps actorSource', () => {
    const domain = { actors: [{ text: 'Logistics providers', source: 'https://example.com/logistics' }, { text: 'Customs brokers', source: 'https://example.com/customs' }] };
    const roles = buildRoles({ question: 'Find suppliers', expected: '', constraints: {}, brief: { regions: [], located: true }, domain });
    expect(roles).toHaveLength(2);
    expect(roles[0]).toMatchObject({ name: 'Logistics providers', type: 'actor', from: 'domain', actorSource: 'https://example.com/logistics' });
    expect(roles[1]).toMatchObject({ name: 'Customs brokers', type: 'actor', from: 'domain', actorSource: 'https://example.com/customs' });
  });

  it('skips empty actor names', () => {
    const domain = { actors: ['Valid actor', '', { text: '  ', source: 'x' }, { text: 'Another valid', source: 'y' }] };
    const roles = buildRoles({ question: 'Find suppliers', expected: '', constraints: {}, brief: { regions: [], located: true }, domain });
    expect(roles).toHaveLength(2);
    expect(roles.map((r) => r.name)).toEqual(['Valid actor', 'Another valid']);
  });
});

describe('buildRoles grounding', () => {
  it('marks place as quoted when region name appears in asker text', () => {
    const brief = { regions: ['DE'], located: true };
    const roles = buildRoles({ question: 'Find suppliers in Germany', expected: '', constraints: {}, brief, domain: null });
    expect(roles[0].source).toBe('quoted');
    expect(roles[0].quote).toBe('Germany');
  });

  it('marks place as derived when region name not in asker text', () => {
    const brief = { regions: ['DE'], located: true };
    const roles = buildRoles({ question: 'Find suppliers in Europe', expected: '', constraints: {}, brief, domain: null });
    expect(roles[0].source).toBe('derived');
    expect(roles[0].quote).toBe('');
  });

  it('marks actor as quoted when actor name appears in asker text', () => {
    const domain = { actors: ['Wholesalers'] };
    const roles = buildRoles({ question: 'Find wholesalers in Germany', expected: '', constraints: {}, brief: { regions: [], located: true }, domain });
    expect(roles[0].source).toBe('quoted');
    expect(roles[0].quote).toBe('Wholesalers');
  });

  it('marks actor as derived when actor name not in asker text', () => {
    const domain = { actors: ['Wholesalers'] };
    const roles = buildRoles({ question: 'Find suppliers in Germany', expected: '', constraints: {}, brief: { regions: [], located: true }, domain });
    expect(roles[0].source).toBe('derived');
    expect(roles[0].quote).toBe('');
  });
});

describe('buildRoles empty inputs', () => {
  it('returns empty array when brief and domain are null', () => {
    const roles = buildRoles({ question: 'Find suppliers', expected: '', constraints: {}, brief: null, domain: null });
    expect(roles).toEqual([]);
  });

  it('returns empty array when brief has no regions and domain has no actors', () => {
    const brief = { regions: [], located: true };
    const domain = { actors: [] };
    const roles = buildRoles({ question: 'Find suppliers', expected: '', constraints: {}, brief, domain });
    expect(roles).toEqual([]);
  });
});

describe('rolesSummary', () => {
  it('counts actors, places, and quoted', () => {
    const roles = [
      { name: 'Germany', type: 'place', role: 'x', source: 'quoted', quote: 'Germany', from: 'brief' },
      { name: 'Poland', type: 'place', role: 'x', source: 'derived', quote: '', from: 'brief' },
      { name: 'Wholesalers', type: 'actor', role: '', source: 'quoted', quote: 'Wholesalers', from: 'domain' },
    ];
    expect(rolesSummary(roles)).toBe('roles: 1 actor(s), 2 place(s) — 2 quoted');
  });

  it('handles empty array', () => {
    expect(rolesSummary([])).toBe('roles: 0 actor(s), 0 place(s) — 0 quoted');
  });
});

import { knowledgePieces } from '../../src/research/requestmodel.mjs';

describe('knowledgePieces', () => {
  it('builds one piece per missing aspect with the next free driver ids, naming the kind and places', () => {
    const pieces = knowledgePieces({ nodes: [{ id: 'D1' }, { id: 'D2' }, { id: 'D2.1' }], missing: ['object', 'terms'], label: 'bouldering gym', places: ['Germany'], languages: ['English', 'German'], queries: ['boulderhalle leipzig'], serves: ['E1', 'Q1'] });
    expect(pieces.map((p) => p.id)).toEqual(['D3', 'D4']);
    expect(pieces[0].question).toContain('bouldering gym in Germany');
    expect(pieces[1].question).toContain('English and German');
    expect(pieces[0].serves).toEqual(['E1', 'Q1']);
    expect(pieces[0].searchQueries).toContain('boulderhalle leipzig');
    expect(pieces.map((p) => p.knowledge)).toEqual(['object', 'terms']);
  });
  it('returns nothing without a kind label or without missing aspects, and ignores unknown aspects', () => {
    expect(knowledgePieces({ missing: ['object'], label: '' })).toEqual([]);
    expect(knowledgePieces({ missing: [], label: 'x' })).toEqual([]);
    expect(knowledgePieces({ missing: ['nonsense'], label: 'x' })).toEqual([]);
  });
});
