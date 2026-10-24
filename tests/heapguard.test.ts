import { describe, expect, it } from 'vitest';
import { HEAP_LIMIT_MB, HeapGuard } from '../src/heapguard.mjs';

describe('HeapGuard', () => {
  it('asks for one graceful restart when memory passes the limit, well before the 2 GB crash', () => {
    let used = 400 * 1048576;
    const calls: number[] = [];
    const guard = new HeapGuard({ onHigh: (mb: number) => calls.push(mb), usage: () => used });
    expect(guard.check()).toBe(false);
    used = 1600 * 1048576;
    expect(guard.check()).toBe(true);
    expect(guard.check()).toBe(false);
    expect(calls).toEqual([1600]);
    expect(HEAP_LIMIT_MB).toBeLessThan(2048);
  });
});
