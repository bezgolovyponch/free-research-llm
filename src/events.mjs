export const PUSH_EVERY_MS = 500;
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
export const STUCK_MS = 60 * 1000;

export class EventStream {
  constructor({ res, render, now = () => Date.now(), everyMs = PUSH_EVERY_MS, maxBuffered = MAX_BUFFERED_BYTES, stuckMs = STUCK_MS, schedule = (fn, ms) => setTimeout(fn, ms), cancel = (t) => clearTimeout(t) }) {
    this.res = res;
    this.render = render;
    this.now = now;
    this.everyMs = everyMs;
    this.maxBuffered = maxBuffered;
    this.stuckMs = stuckMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.latest = null;
    this.phase = null;
    this.timer = null;
    this.blockedSince = null;
    this.closed = false;
    this.sent = 0;
    res.on?.('drain', () => {
      this.blockedSince = null;
      if (this.latest && !this.timer) this.timer = this.schedule(() => this.flush(), 0);
    });
  }

  push(event, project) {
    if (this.closed) return;
    this.latest = project;
    if (event?.type === 'phase' || !this.phase) this.phase = event;
    if (this.blockedSince === null && !this.timer) this.timer = this.schedule(() => this.flush(), this.sent ? this.everyMs : 0);
  }

  flush() {
    this.timer = null;
    if (this.closed || !this.latest) return;
    if (this.stale()) return this.close();
    if (this.blockedSince !== null) return;
    const payload = `data: ${JSON.stringify({ event: this.phase, project: this.render(this.latest) })}\n\n`;
    this.latest = null;
    this.phase = null;
    this.sent += 1;
    if (!this.res.write(payload)) this.blockedSince = this.now();
  }

  ping() {
    if (this.closed) return;
    if (this.stale()) return this.close();
    if (this.blockedSince === null) this.res.write(': ping\n\n');
  }

  stale() {
    return (this.res.writableLength ?? 0) > this.maxBuffered || (this.blockedSince !== null && this.now() - this.blockedSince > this.stuckMs);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
    this.latest = null;
    this.res.destroy?.();
  }
}
