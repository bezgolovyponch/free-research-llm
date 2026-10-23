export const DEFAULT_LANES = 2;
export const MAX_LANES = 4;

export function lanesFrom(env = {}) {
  const raw = Number(env.FRL_LANES);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(MAX_LANES, Math.floor(raw)) : DEFAULT_LANES;
}

export class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  async run(task) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

export async function runInLanes({ order, isFinished, prerequisites, known, lanes, work, shouldStop }) {
  const queue = order.filter((id) => !isFinished(id));
  const running = new Map();
  let fatal = null;
  const ready = (id) => prerequisites(id).every((p) => !known(p) || isFinished(p));
  while (queue.length || running.size) {
    while (!fatal && !shouldStop() && queue.length && running.size < Math.max(1, lanes())) {
      let index = queue.findIndex(ready);
      if (index < 0 && !running.size) index = 0;
      if (index < 0) break;
      const [id] = queue.splice(index, 1);
      const task = (async () => {
        try {
          await work(id);
        } catch (error) {
          fatal ??= error;
        } finally {
          running.delete(id);
        }
      })();
      running.set(id, task);
    }
    if (!running.size) break;
    await Promise.race(running.values());
  }
  if (fatal) throw fatal;
  return { remaining: queue };
}
