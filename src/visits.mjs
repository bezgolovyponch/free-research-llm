const QUIET_MS = 10 * 60 * 1000;
const REFUSAL_QUIET_MS = 30 * 1000;

function clientAddress(req) {
  return String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '') || 'unknown';
}

export class RemoteVisits {
  constructor({ note, now = () => Date.now(), quietMs = QUIET_MS }) {
    this.note = note;
    this.now = now;
    this.quietMs = quietMs;
    this.seen = new Map();
  }

  record(req, pathname, access) {
    const address = clientAddress(req);
    const outcome = access.allowed ? (access.share ? `research link (${access.share})` : 'full access') : `refused: ${access.reason}`;
    const key = access.allowed ? `${address}|${outcome}` : `${address}|${outcome}|${pathname}`;
    const quiet = access.allowed ? this.quietMs : Math.min(this.quietMs, REFUSAL_QUIET_MS);
    if (this.seen.has(key) && this.now() - this.seen.get(key) < quiet) return false;
    this.seen.set(key, this.now());
    for (const [k, at] of this.seen) if (this.now() - at >= this.quietMs) this.seen.delete(k);
    this.note(`other device ${address} opened ${pathname} · ${outcome}`);
    return true;
  }
}

export const REACHABLE_PAGE = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reachable</title><body style="font:16px system-ui;padding:24px;max-width:560px"><h2>Free Research LLM is reachable</h2><p>This device can reach the app. Now open the research link you were given, exactly as it is (it starts with <code>http://</code>).</p></body>';
