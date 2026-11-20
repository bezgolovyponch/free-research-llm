import { describe, expect, it } from 'vitest';
import { chosenOptionId } from '../../src/research/verdict.mjs';

describe('chosenOptionId', () => {
  const options = [
    { id: 'O1', option: 'GO' },
    { id: 'O2', option: 'NO-GO' },
    { id: 'O3', option: 'GO-IF' },
  ];

  it('returns O2 when the second option is chosen', () => {
    const result = chosenOptionId(options, 'NO-GO');
    expect(result).toEqual({ id: 'O2', note: null });
  });

  it('matches when chosen text has different leading/trailing spacing', () => {
    const result = chosenOptionId(options, '  NO-GO  ');
    expect(result).toEqual({ id: 'O2', note: null });
    const result2 = chosenOptionId(options, '\tNO-GO\n');
    expect(result2).toEqual({ id: 'O2', note: null });
  });

  it('matches when chosen text has multiple spaces between words', () => {
    const optionsWithSpaces = [
      { id: 'O1', option: 'GO' },
      { id: 'O2', option: 'GO IF' },
      { id: 'O3', option: 'NO-GO' },
    ];
    const result = chosenOptionId(optionsWithSpaces, 'GO  IF');
    expect(result).toEqual({ id: 'O2', note: null });
  });

  it('returns null with note when chosen text has different letter case', () => {
    const result = chosenOptionId(options, 'no-go');
    expect(result).toEqual({ id: null, note: 'not among the options' });
    const result2 = chosenOptionId(options, 'No-Go');
    expect(result2).toEqual({ id: null, note: 'not among the options' });
  });

  it('returns null with note when chosen text names no option', () => {
    const result = chosenOptionId(options, 'something else');
    expect(result).toEqual({ id: null, note: 'not among the options' });
  });

  it('returns null with ambiguous note when two options have the same text', () => {
    const duplicateOptions = [
      { id: 'O1', option: 'GO' },
      { id: 'O2', option: 'GO' },
      { id: 'O3', option: 'NO-GO' },
    ];
    const result = chosenOptionId(duplicateOptions, 'GO');
    expect(result).toEqual({ id: null, note: 'ambiguous' });
  });

  it('returns null with no note when chosen is empty', () => {
    const result = chosenOptionId(options, '');
    expect(result).toEqual({ id: null, note: null });
  });

  it('returns null with no note when chosen is null', () => {
    const result = chosenOptionId(options, null);
    expect(result).toEqual({ id: null, note: null });
  });

  it('returns null with no note when chosen is undefined', () => {
    const result = chosenOptionId(options, undefined);
    expect(result).toEqual({ id: null, note: null });
  });

  it('returns null with note when options list is empty', () => {
    const result = chosenOptionId([], 'GO');
    expect(result).toEqual({ id: null, note: 'not among the options' });
  });
});