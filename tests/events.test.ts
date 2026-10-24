import { describe, expect, it } from 'vitest';
import { EventStream } from '../src/events.mjs';

function fakeRes({ accept = () => true }: { accept?: (n: number) => boolean } = {}) {
  const handlers: Record<string, () => void> = {};
  return {
    writes: [] as string[],
    writableLength: 0,
    destroyed: false,
    on(name: string, fn: () => void) { handlers[name] = fn; },
    emit(name: string) { handlers[name]?.(); },
    write(chunk: string) { this.writes.push(chunk); return accept(this.writes.length); },
    destroy() { this.destroyed = true; },
  };
}

function manualClock() {
  const tasks: Array<() => void> = [];
  return { schedule: (fn: () => void) => { tasks.push(fn); return tasks.length; }, cancel: () => {}, run: () => { while (tasks.length) tasks.shift()!(); } };
}

describe('EventStream', () => {
  it('batches many updates into one send and renders only what is sent', () => {
    const res = fakeRes();
    const clock = manualClock();
    let renders = 0;
    const stream = new EventStream({ res, render: (p: { n: number }) => { renders += 1; return p; }, schedule: clock.schedule, cancel: clock.cancel });
    for (let n = 0; n < 50; n++) stream.push({ type: n === 10 ? 'phase' : 'node' }, { n });
    clock.run();
    expect(res.writes).toHaveLength(1);
    expect(renders).toBe(1);
    expect(JSON.parse(res.writes[0].slice(6))).toEqual({ event: { type: 'phase' }, project: { n: 49 } });
  });

  it('stops writing while the page is not reading, sends the latest once it drains, and closes a stuck or bloated connection', () => {
    let now = 0;
    const clock = manualClock();
    const slow = fakeRes({ accept: () => false });
    const stream = new EventStream({ res: slow, render: (p: object) => p, now: () => now, schedule: clock.schedule, cancel: clock.cancel, stuckMs: 1000 });
    stream.push({ type: 'node' }, { n: 1 });
    clock.run();
    expect(stream.blockedSince).toBe(0);
    for (let n = 2; n < 20; n++) stream.push({ type: 'node' }, { n });
    clock.run();
    stream.ping();
    expect(slow.writes).toHaveLength(1);
    slow.emit('drain');
    clock.run();
    expect(slow.writes).toHaveLength(2);
    expect(JSON.parse(slow.writes[1].slice(6)).project).toEqual({ n: 19 });
    now = 5000;
    stream.ping();
    expect(slow.destroyed).toBe(true);
    stream.push({ type: 'node' }, { n: 99 });
    clock.run();
    expect(slow.writes).toHaveLength(2);
    const bloated = fakeRes();
    bloated.writableLength = 9 * 1024 * 1024;
    const big = new EventStream({ res: bloated, render: (p: object) => p, schedule: clock.schedule, cancel: clock.cancel });
    big.push({ type: 'node' }, {});
    clock.run();
    expect(bloated.destroyed).toBe(true);
    expect(bloated.writes).toHaveLength(0);
  });
});
