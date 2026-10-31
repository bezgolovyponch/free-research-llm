import { describe, expect, it } from 'vitest';
import { ROOT_EVERY, nextTarget } from '../../../src/research/improve.mjs';

const order = ['D2', 'D1.1', 'D1.2', 'D1.3', 'Q'];

describe('nextTarget: pieces first, the whole question due every few piece trials', () => {
  it('picks pieces in their weakness order before the question', () => {
    expect(nextTarget(order, { piecesThisPass: 0 })).toBe('D2');
    expect(nextTarget(order, { piecesThisPass: ROOT_EVERY - 1 })).toBe('D2');
  });

  it('makes the question due after ROOT_EVERY piece trials, even if pieces remain (a cut-off pass still reaches it)', () => {
    expect(nextTarget(order, { piecesThisPass: ROOT_EVERY })).toBe('Q');
  });

  it('does not pick the question twice in one pass', () => {
    expect(nextTarget(order, { tried: new Set(['Q']), piecesThisPass: 10 })).toBe('D2');
  });

  it('falls back to the question once every piece is tried, resting or claimed', () => {
    expect(nextTarget(['Q'], { tried: new Set(['D2']), piecesThisPass: 1 })).toBe('Q');
    expect(nextTarget(['Q'], { tried: new Set(['Q']), piecesThisPass: 1 })).toBeUndefined();
    expect(nextTarget(['D2', 'Q'], { tried: new Set(['D2']), resting: new Set(['Q']), piecesThisPass: 1 })).toBeUndefined();
  });

  it('skips resting pieces and still reaches the question when they are the only pieces left', () => {
    expect(nextTarget(['D2', 'D1.1', 'Q'], { resting: new Set(['D2']), piecesThisPass: 0 })).toBe('D1.1');
    expect(nextTarget(['D2', 'Q'], { resting: new Set(['D2']), piecesThisPass: 0 })).toBe('Q');
  });

  it('keeps the old behaviour when the question is out of scope', () => {
    expect(nextTarget(['D2', 'D1.1'], { piecesThisPass: 9 })).toBe('D2');
    expect(nextTarget(['D2', 'D1.1'], { tried: new Set(['D2', 'D1.1']) })).toBeUndefined();
  });
});
