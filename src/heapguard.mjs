export const HEAP_LIMIT_MB = 1024;
export const SAMPLE_EVERY_MS = 10 * 60 * 1000;
export const CHECK_EVERY_MS = 60 * 1000;

export class HeapGuard {
  constructor({ onHigh, limitMb = HEAP_LIMIT_MB, everyMs = CHECK_EVERY_MS, usage = () => process.memoryUsage().heapUsed }) {
    this.onHigh = onHigh;
    this.limitMb = limitMb;
    this.everyMs = everyMs;
    this.usage = usage;
    this.fired = false;
  }

  check() {
    const mb = Math.round(this.usage() / 1048576);
    if (this.fired || mb < this.limitMb) return false;
    this.fired = true;
    this.onHigh(mb);
    return true;
  }

  sample(extra = {}) {
    const m = process.memoryUsage();
    return { heapMB: Math.round(m.heapUsed / 1048576), rssMB: Math.round(m.rss / 1048576), ...extra };
  }

  start({ onSample, extra = () => ({}), sampleEveryMs = SAMPLE_EVERY_MS } = {}) {
    this.timer = setInterval(() => this.check(), this.everyMs);
    this.timer.unref?.();
    if (onSample) {
      this.sampler = setInterval(() => onSample(this.sample(extra())), sampleEveryMs);
      this.sampler.unref?.();
    }
    return this;
  }
}
