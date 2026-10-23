const CHECK_EVERY_MS = 60 * 1000;
const FORGET_AFTER_MS = 30 * 60 * 1000;

export class PeerWatcher {
  constructor({ probe, onFound, now = () => Date.now(), checkEveryMs = CHECK_EVERY_MS, forgetAfterMs = FORGET_AFTER_MS }) {
    this.probe = probe;
    this.onFound = onFound;
    this.now = now;
    this.checkEveryMs = checkEveryMs;
    this.forgetAfterMs = forgetAfterMs;
    this.peers = new Map();
    this.connected = new Map();
    this.checking = false;
  }

  note(address) {
    const host = String(address ?? '').replace(/^::ffff:/, '');
    if (!host || host === '127.0.0.1' || host === '::1') return false;
    const known = this.peers.get(host);
    this.peers.set(host, { seenAt: this.now(), checkedAt: known?.checkedAt ?? -Infinity });
    return !known;
  }

  due() {
    const time = this.now();
    for (const [host, peer] of this.peers) if (time - peer.seenAt > this.forgetAfterMs) this.peers.delete(host);
    return [...this.peers].filter(([, peer]) => time - peer.checkedAt >= this.checkEveryMs).map(([host]) => host);
  }

  async check() {
    if (this.checking) return [];
    this.checking = true;
    const found = [];
    try {
      for (const host of this.due()) {
        this.peers.get(host).checkedAt = this.now();
        for (const endpoint of await this.probe(host)) {
          if (!endpoint.ok || this.connected.get(endpoint.id) === endpoint.url) continue;
          this.connected.set(endpoint.id, endpoint.url);
          found.push(endpoint);
          await this.onFound(endpoint);
        }
      }
    } finally {
      this.checking = false;
    }
    return found;
  }
}
