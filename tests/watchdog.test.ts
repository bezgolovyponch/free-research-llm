import { describe, expect, it } from 'vitest';
import { MAX_REVIVALS, Watchdog, crashedLoop } from '../src/watchdog.mjs';

const t0 = Date.parse('2026-10-24T20:00:00Z');
const hours = (h: number) => new Date(t0 + h * 3600000).toISOString();

describe('crashedLoop', () => {
  it('finds a loop that ended with an error while time was left, never one the user stopped', () => {
    expect(crashedLoop({ active: false, error: 'boom', deadline: hours(2), scope: ['D1'], exclude: [] }, t0)).toEqual({ hoursLeft: 2, scope: ['D1'], exclude: [], error: 'boom' });
    expect(crashedLoop({ active: false, error: 'boom', deadline: hours(2), stopReason: 'stopped by user' }, t0)).toBeNull();
    expect(crashedLoop({ active: true, error: 'boom', deadline: hours(2) }, t0)).toBeNull();
    expect(crashedLoop({ active: false, error: null, deadline: hours(2) }, t0)).toBeNull();
    expect(crashedLoop({ active: false, error: 'boom', deadline: hours(0.01) }, t0)).toBeNull();
    expect(crashedLoop(null, t0)).toBeNull();
  });
});

describe('Watchdog', () => {
  it('restarts a crashed loop with the hours left, at most 3 times in 6 hours, and restarts a dead local model', async () => {
    let now = t0;
    const started: string[] = [];
    const notes: string[] = [];
    let localDown = true;
    const dog = new Watchdog({
      now: () => now,
      listProjects: async () => [
        { id: 'a', improve: { active: false, error: 'every provider failed', deadline: hours(12), scope: [], exclude: ['D2'] } },
        { id: 'b', improve: { active: false, error: 'x', deadline: hours(3), stopReason: 'stopped by user' } },
        { id: 'c', improve: null },
      ],
      isLooping: () => false,
      startLoop: async (id: string, o: { hours: number; exclude: string[] }) => { started.push(`${id} ${o.hours.toFixed(1)} ${o.exclude.join(',')}`); },
      ensureLocal: async ({ mayStart }: { mayStart: () => boolean }) => (localDown ? (mayStart() ? { started: true, pid: 42 } : { started: false, refused: true }) : { started: false }),
      note: (m: string) => notes.push(m),
    });
    for (let i = 0; i < MAX_REVIVALS + 1; i++) {
      await dog.tick();
      now += 60000;
    }
    expect(started).toEqual(['a 12.0 D2', 'a 12.0 D2', 'a 12.0 D2']);
    expect(notes.filter((n) => /not restarted: 3 restarts in 6 h/.test(n))).toHaveLength(2);
    expect(notes.filter((n) => n === 'local model restarted (pid 42)')).toHaveLength(3);
    now += 6 * 3600000;
    localDown = false;
    expect(await dog.tick()).toEqual([expect.stringMatching(/^loop a restarted/)]);
  });

  it('leaves a running loop alone and never runs two checks at once', async () => {
    let release = () => {};
    const dog = new Watchdog({ listProjects: () => new Promise((r) => { release = () => r([{ id: 'a', improve: { active: false, error: 'x', deadline: hours(3) } }]); }), isLooping: () => true, startLoop: async () => { throw new Error('must not start'); }, now: () => t0 });
    const first = dog.tick();
    expect(await dog.tick()).toEqual([]);
    release();
    expect(await first).toEqual([]);
  });
});
