export const HEAP_LIMIT_MB = 1500;
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

  start() {
    this.timer = setInterval(() => this.check(), this.everyMs);
    this.timer.unref?.();
    return this;
  }
}
