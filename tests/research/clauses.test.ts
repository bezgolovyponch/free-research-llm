import { describe, expect, it } from 'vitest';
import { clausesOf } from '../../src/research/clauses.mjs';

describe('clausesOf', () => {
  it('splits a question into pieces at punctuation only', () => {
    expect(clausesOf('plots but also cheap, so no air condition; near the sea')).toEqual(['plots but also cheap', 'so no air condition', 'near the sea']);
    expect(clausesOf('cars near the city, hatchback, , cheap;')).toEqual(['cars near the city', 'hatchback', 'cheap']);
  });
});
