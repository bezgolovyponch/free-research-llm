import { describe, expect, it } from 'vitest';
import { sentencesOf } from '../../src/research/clauses.mjs';
import { clausesOf } from '../../src/research/strategy.mjs';

describe('sentencesOf', () => {
  it('numbers the sentence each piece starts in, by form only: a full stop, question or exclamation mark before more text, or a line break', () => {
    expect(sentencesOf(clausesOf('similar to A, B, C with the best ratio, proven quality'))).toEqual([0, 0, 0, 0]);
    expect(sentencesOf(clausesOf('Find trails near the city, for children. Report the parking, the length'))).toEqual([0, 0, 1]);
    expect(sentencesOf(['one', 'two? three', 'four\nfive', 'six'])).toEqual([0, 0, 1, 2]);
    expect(sentencesOf(['price up to 65.000 CZK', 'engine 1.2 MPI', 'the end.'])).toEqual([0, 0, 0]);
    expect(sentencesOf([])).toEqual([]);
  });
});
