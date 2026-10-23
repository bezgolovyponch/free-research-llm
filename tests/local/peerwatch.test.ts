import { describe, expect, it } from 'vitest';
import { PeerWatcher } from '../../src/local/peerwatch.mjs';

describe('PeerWatcher', () => {
  it('checks a device that opened the research link, connects its model once, and forgets devices that went away', async () => {
    let now = 0;
    let serving = false;
    const probed: string[] = [];
    const connected: string[] = [];
    const watcher = new PeerWatcher({
      now: () => now,
      checkEveryMs: 1000,
      forgetAfterMs: 5000,
      probe: async (host: string) => { probed.push(host); return [{ id: 'llamacpp-lan', url: `http://${host}:8090/v1`, ok: serving }, { id: 'ollama', url: `http://${host}:11434/v1`, ok: false }]; },
      onFound: async (e: { id: string; url: string }) => { connected.push(`${e.id} ${e.url}`); },
    });
    expect(watcher.note('::ffff:127.0.0.1')).toBe(false);
    expect(watcher.note('::ffff:192.168.5.26')).toBe(true);
    expect(watcher.note('192.168.5.26')).toBe(false);
    expect(await watcher.check()).toEqual([]);
    expect(await watcher.check()).toEqual([]);
    expect(probed).toEqual(['192.168.5.26']);
    serving = true;
    now = 1500;
    watcher.note('192.168.5.26');
    expect((await watcher.check()).map((e) => e.id)).toEqual(['llamacpp-lan']);
    now = 3000;
    expect(await watcher.check()).toEqual([]);
    expect(connected).toEqual(['llamacpp-lan http://192.168.5.26:8090/v1']);
    now = 9000;
    expect(watcher.due()).toEqual([]);
    expect(watcher.peers.size).toBe(0);
  });
});
