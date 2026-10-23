import { describe, expect, it } from 'vitest';
import { DEFAULT_LANES, MAX_LANES, Mutex, lanesFrom, runInLanes } from '../../src/research/lanes.mjs';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function graph(prereq: Record<string, string[]>) {
  const finished = new Set<string>();
  return {
    finished,
    options: (lanes: () => number, log: string[], live: { now: number; max: number }, stop = () => false, fail = '') => ({
      order: Object.keys(prereq),
      isFinished: (id: string) => finished.has(id),
      prerequisites: (id: string) => prereq[id] ?? [],
      known: (id: string) => id in prereq,
      lanes,
      shouldStop: stop,
      work: async (id: string) => {
        live.now += 1;
        live.max = Math.max(live.max, live.now);
        log.push(`start ${id}`);
        await tick(15);
        live.now -= 1;
        if (id === fail) throw new Error('no model provider');
        finished.add(id);
        log.push(`end ${id}`);
      },
    }),
  };
}

describe('runInLanes', () => {
  it('runs independent pieces side by side and waits for prerequisites', async () => {
    const g = graph({ a: [], b: [], c: [], d: ['a', 'b'], Q: ['c', 'd'] });
    const log: string[] = [];
    const live = { now: 0, max: 0 };
    await runInLanes(g.options(() => 2, log, live));
    expect(live.max).toBe(2);
    expect(log.indexOf('start d')).toBeGreaterThan(Math.max(log.indexOf('end a'), log.indexOf('end b')));
    expect(log.indexOf('start Q')).toBeGreaterThan(Math.max(log.indexOf('end c'), log.indexOf('end d')));
    expect(g.finished.size).toBe(5);
  });

  it('uses one lane when asked, takes extra lanes mid-run, and stops starting work when told', async () => {
    const one = graph({ a: [], b: [], c: [] });
    const live1 = { now: 0, max: 0 };
    await runInLanes(one.options(() => 1, [], live1));
    expect(live1.max).toBe(1);
    let lanes = 1;
    const grow = graph({ a: [], b: [], c: [], d: [] });
    const live2 = { now: 0, max: 0 };
    setTimeout(() => { lanes = 3; }, 5);
    await runInLanes(grow.options(() => lanes, [], live2));
    expect(live2.max).toBeGreaterThanOrEqual(2);
    const stopping = graph({ a: [], b: [], c: [] });
    const result = await runInLanes(stopping.options(() => 1, [], { now: 0, max: 0 }, () => stopping.finished.size >= 1));
    expect(result.remaining).toEqual(['b', 'c']);
  });

  it('finishes running work, then raises the first fatal error', async () => {
    const g = graph({ a: [], b: [], c: [] });
    await expect(runInLanes(g.options(() => 2, [], { now: 0, max: 0 }, () => false, 'a'))).rejects.toThrow('no model provider');
    expect(g.finished.has('b')).toBe(true);
    expect(g.finished.has('c')).toBe(false);
  });

  it('breaks a dependency cycle instead of hanging', async () => {
    const g = graph({ a: ['b'], b: ['a'] });
    await runInLanes(g.options(() => 2, [], { now: 0, max: 0 }));
    expect(g.finished.size).toBe(2);
  });
});

describe('Mutex', () => {
  it('runs tasks one at a time in arrival order and survives a failing task', async () => {
    const lock = new Mutex();
    const seen: string[] = [];
    const slow = lock.run(async () => { seen.push('a1'); await tick(10); seen.push('a2'); });
    const failing = lock.run(async () => { seen.push('b'); throw new Error('x'); });
    const last = lock.run(async () => { seen.push('c'); return 7; });
    await slow;
    await expect(failing).rejects.toThrow('x');
    expect(await last).toBe(7);
    expect(seen).toEqual(['a1', 'a2', 'b', 'c']);
  });
});

describe('lanesFrom', () => {
  it('defaults to 2 lanes and caps at 4', () => {
    expect(lanesFrom({})).toBe(DEFAULT_LANES);
    expect(lanesFrom({ FRL_LANES: '1' })).toBe(1);
    expect(lanesFrom({ FRL_LANES: '9' })).toBe(MAX_LANES);
    expect(lanesFrom({ FRL_LANES: 'x' })).toBe(DEFAULT_LANES);
  });
});
