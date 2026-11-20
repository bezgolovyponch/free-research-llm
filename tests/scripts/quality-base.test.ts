import { describe, expect, it } from 'vitest';
import { pickBase } from '../../scripts/quality.mjs';

describe('quality: the base a gate compares against', () => {
  it('uses the merge-base with origin/main when the branch has commits', () => {
    expect(pickBase({ head: 'h', originBase: 'b', localBase: 'old', parent: '', ci: false })).toBe('b');
  });

  it('never falls back to a stale local main when HEAD is still the origin/main merge-base', () => {
    expect(pickBase({ head: 'h', originBase: 'h', localBase: 'old', parent: '', ci: false })).toBe('');
  });

  it('uses the local main only when origin/main does not resolve', () => {
    expect(pickBase({ head: 'h', originBase: '', localBase: 'm', parent: '', ci: false })).toBe('m');
  });

  it('compares with the parent commit in CI when HEAD is the base', () => {
    expect(pickBase({ head: 'h', originBase: 'h', localBase: 'old', parent: 'p', ci: true })).toBe('p');
  });

  it('returns no base when no ref resolves outside CI', () => {
    expect(pickBase({ head: 'h', originBase: '', localBase: '', parent: '', ci: false })).toBe('');
  });
});
