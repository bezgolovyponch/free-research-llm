import { describe, expect, it, vi } from 'vitest';
import { preconditions, effect, traceOk } from '../../src/research/nodevalidity.mjs';
import { NON_ANSWER } from '../../src/research/verify.mjs';

function makeNode(overrides = {}) {
  return {
    id: 'D1',
    parentId: 'Q',
    title: 'Test node',
    question: 'Find the price',
    method: 'lookup',
    searchQueries: ['price test'],
    sourceUrls: [],
    dependsOn: [],
    metric: 'price',
    unit: 'EUR',
    status: 'verified',
    finding: null,
    sources: [],
    ...overrides,
  };
}

function makeProject(nodes = []) {
  return { nodes };
}

describe('preconditions', () => {
  it('passes for a well-formed lookup node with searchQueries', () => {
    const node = makeNode({ method: 'lookup', searchQueries: ['test query'] });
    const failed = preconditions(node, makeProject([node]));
    expect(failed).toEqual([]);
  });

  it('passes for a calculation node with dependsOn', () => {
    const dep = makeNode({ id: 'D2', method: 'lookup', searchQueries: ['dep'] });
    const node = makeNode({ id: 'D3', method: 'calculation', dependsOn: ['D2'] });
    const failed = preconditions(node, makeProject([dep, node]));
    expect(failed).toEqual([]);
  });

  it('fails on unknown method', () => {
    const node = makeNode({ method: 'unknown-method' });
    const failed = preconditions(node, makeProject([node]));
    expect(failed).toContainEqual({ check: 'role', reason: 'unknown method "unknown-method"' });
  });

  it('fails when no searchQueries, sourceUrls, or dependsOn', () => {
    const node = makeNode({ searchQueries: [], sourceUrls: [], dependsOn: [] });
    const failed = preconditions(node, makeProject([node]));
    expect(failed).toContainEqual({ check: 'inputs', reason: 'no searchQueries, no sourceUrls, no dependsOn inputs' });
  });

  it('fails when dependsOn references missing node', () => {
    const node = makeNode({ dependsOn: ['D99'] });
    const failed = preconditions(node, makeProject([node]));
    expect(failed).toContainEqual({ check: 'dependsOn', reason: 'dependsOn references missing node(s)' });
  });
});

describe('effect', () => {
  it('returns broken when no finding', () => {
    const node = makeNode({ finding: null });
    const result = effect(node);
    expect(result).toEqual({ broken: true, reason: 'no finding produced' });
  });

  it('returns broken for empty answer', () => {
    const node = makeNode({ finding: { answer: '', claims: [], gaps: [] } });
    const result = effect(node);
    expect(result.broken).toBe(true);
    expect(result.reason).toContain('no-data');
  });

  it('returns broken for NON_ANSWER pattern', () => {
    const answer = 'It is not possible to determine the price from the provided evidence';
    const node = makeNode({ finding: { answer, claims: [] } });
    const result = effect(node);
    expect(result.broken).toBe(true);
    expect(result.reason).toContain('no-data');
  });

  it('returns broken for isEvidenceGap pattern', () => {
    const answer = 'The evidence does not contain verifiable data on the price';
    const node = makeNode({ finding: { answer, claims: [] } });
    const result = effect(node);
    expect(result.broken).toBe(true);
    expect(result.reason).toContain('no-data');
  });

  it('returns broken for claims without sources or assumptions', () => {
    const node = makeNode({ finding: { answer: 'Price is 100', claims: [{ text: 'Price is 100', sourceIds: [], assumption: false }] } });
    const result = effect(node);
    expect(result.broken).toBe(true);
    expect(result.reason).toContain('no-data');
  });

  it('passes for claim with source', () => {
    const node = makeNode({
      finding: { answer: 'Price is 100', claims: [{ text: 'Price is 100', sourceIds: ['S1'], assumption: false }] },
      sources: [{ id: 'S1', url: 'https://example.com' }],
    });
    const result = effect(node);
    expect(result).toEqual({ broken: false, reason: null });
  });

  it('passes for claim with assumption', () => {
    const node = makeNode({ finding: { answer: 'Price is 100', claims: [{ text: 'Price is 100', sourceIds: [], assumption: true }] } });
    const result = effect(node);
    expect(result).toEqual({ broken: false, reason: null });
  });

  it('returns broken for lookup method with no source url', () => {
    const node = makeNode({ method: 'lookup', finding: { answer: 'Price is 100', claims: [{ text: 'Price is 100', sourceIds: ['S1'], assumption: false }] }, sources: [{ id: 'S1', url: '' }] });
    const result = effect(node);
    expect(result.broken).toBe(true);
    expect(result.reason).toContain('no retrieved source with url');
  });

  it('passes for calculation method without source url', () => {
    const node = makeNode({ method: 'calculation', finding: { answer: 'Total is 200', claims: [], calculation: { formula: 'a+b', inputs: { a: 100, b: 100 }, result: 200 } } });
    const result = effect(node);
    expect(result).toEqual({ broken: false, reason: null });
  });

  it('passes when number in answer with metric on node', () => {
    const node = makeNode({ metric: 'price', finding: { answer: 'Price is 100', claims: [{ text: 'Price is 100', sourceIds: ['S1'], assumption: false }] }, sources: [{ id: 'S1', url: 'https://example.com' }] });
    const result = effect(node);
    expect(result).toEqual({ broken: false, reason: null });
  });

  it('passes when number in answer without metric (metric check removed)', () => {
    const node = makeNode({ metric: '', finding: { answer: 'Price is 100', claims: [{ text: 'Price is 100', sourceIds: ['S1'], assumption: false }] }, sources: [{ id: 'S1', url: 'https://example.com' }] });
    const result = effect(node);
    expect(result).toEqual({ broken: false, reason: null });
  });
});

describe('traceOk', () => {
  const mockEmbedder = {
    embedAll: vi.fn().mockResolvedValue({
      vectors: [
        [1, 0, 0],
        [0.9, 0.1, 0],
        [0.8, 0.2, 0],
      ],
    }),
  };

  it('returns ok when before is null', async () => {
    const node = makeNode();
    const result = await traceOk(node, null, makeProject([node]), mockEmbedder);
    expect(result).toEqual({ ok: true, reason: null });
  });

  it('returns ok when question unchanged', async () => {
    const node = makeNode();
    const before = { question: 'Find the price' };
    const result = await traceOk(node, before, makeProject([node]), mockEmbedder);
    expect(result).toEqual({ ok: true, reason: null });
  });

  it('returns ok when similarity thresholds met', async () => {
    const node = makeNode({ question: 'Find the cost' });
    const before = { question: 'Find the price' };
    const parent = makeNode({ id: 'Q', title: 'Root', question: 'What is the total cost?' });
    const project = makeProject([parent, node]);
    const result = await traceOk(node, before, project, mockEmbedder);
    expect(result.ok).toBe(true);
  });

  it('fails when question drift (similarity to old < 60%)', async () => {
    const driftEmbedder = {
      embedAll: vi.fn().mockResolvedValue({
        vectors: [
          [1, 0, 0],
          [0.3, 0.7, 0],
          [0.8, 0.2, 0],
        ],
      }),
    };
    const node = makeNode({ question: 'What is the weather?' });
    const before = { question: 'Find the price' };
    const parent = makeNode({ id: 'Q', title: 'Root', question: 'What is the total cost?' });
    const project = makeProject([parent, node]);
    const result = await traceOk(node, before, project, driftEmbedder);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('question drift');
  });

  it('fails when question no longer serves parent (similarity < 40%)', async () => {
    const driftEmbedder = {
      embedAll: vi.fn().mockResolvedValue({
        vectors: [
          [1, 0, 0],
          [0.9, 0.1, 0],
          [0.2, 0.8, 0],
        ],
      }),
    };
    const node = makeNode({ question: 'Find the price' });
    const before = { question: 'Find the cost' };
    const parent = makeNode({ id: 'Q', title: 'Root', question: 'What is the weather forecast?' });
    const project = makeProject([parent, node]);
    const result = await traceOk(node, before, project, driftEmbedder);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no longer serves parent');
  });

  it('returns ok when embedder is null', async () => {
    const node = makeNode({ question: 'Find the price' });
    const before = { question: 'Find the cost' };
    const result = await traceOk(node, before, makeProject([node]), null);
    expect(result).toEqual({ ok: true, reason: null });
  });
});