import { describe, expect, it } from 'vitest';
import { JsonExtractError, extractJson } from '../../src/research/json.mjs';

describe('extractJson', () => {
  it('parses plain, fenced and prose-wrapped JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Sure! {"a":{"b":"}"}} hope that helps')).toEqual({ a: { b: '}' } });
  });

  it('tolerates trailing commas', () => {
    expect(extractJson('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
  });

  it('throws a typed error when there is no object', () => {
    expect(() => extractJson('no json here')).toThrow(JsonExtractError);
  });
});

describe('truncated replies', () => {
  it('keeps every complete element of a reply cut off mid-way', () => {
    const cut = '{"decision":"Buy?","nodes":[{"id":"D1","title":"A"},{"id":"D2","title":"B"},{"id":"D3","tit';
    expect(extractJson(cut)).toEqual({ decision: 'Buy?', nodes: [{ id: 'D1', title: 'A' }, { id: 'D2', title: 'B' }], _truncated: true });
  });

  it('closes a reply cut inside a nested string', () => {
    const cut = '{"answer":"ok","claims":[{"text":"x 5","sourceIds":["S1"]},{"text":"half';
    expect(extractJson(cut).claims).toEqual([{ text: 'x 5', sourceIds: ['S1'] }]);
  });

  it('still fails when nothing complete survived', () => {
    expect(() => extractJson('{"deci')).toThrow(JsonExtractError);
  });
});
