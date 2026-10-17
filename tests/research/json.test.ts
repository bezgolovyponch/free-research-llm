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
