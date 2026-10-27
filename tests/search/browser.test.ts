import { describe, expect, it } from 'vitest';
import { BrowserReader } from '../../src/search/browser.mjs';

function fakeChromium({ status = 200, html = '<html><body>rendered</body></html>', fail = false, hold = null as null | Promise<void> } = {}) {
  const stats = { launches: 0, open: 0, maxOpen: 0, closedContexts: 0, closed: 0, visited: [] as string[] };
  const browser = {
    newContext: async () => {
      stats.open++;
      stats.maxOpen = Math.max(stats.maxOpen, stats.open);
      return {
        newPage: async () => ({
          goto: async (url: string) => {
            stats.visited.push(url);
            if (hold) await hold;
            if (fail) throw new Error('net::ERR_TIMED_OUT');
            return { status: () => status };
          },
          waitForTimeout: async () => {},
          content: async () => html,
          url: () => stats.visited.at(-1),
        }),
        close: async () => {
          stats.open--;
          stats.closedContexts++;
        },
      };
    },
    close: async () => {
      stats.closed++;
    },
  };
  return { stats, launch: async () => { stats.launches++; return browser; } };
}

describe('BrowserReader: a headless Chromium for pages that refuse plain reads', () => {
  it('renders a page once the browser starts, and reuses one browser', async () => {
    const chromium = fakeChromium();
    const reader = new BrowserReader({ launch: chromium.launch, settleMs: 0 });
    expect(await reader.read('https://portal.example/r?page=2')).toEqual({ status: 200, html: '<html><body>rendered</body></html>', url: 'https://portal.example/r?page=2' });
    await reader.read('https://portal.example/r?page=3');
    expect(chromium.stats.launches).toBe(1);
    expect(chromium.stats.closedContexts).toBe(2);
    await reader.close();
    expect(chromium.stats.closed).toBe(1);
  });

  it('opens at most two pages at once', async () => {
    let open: () => void = () => {};
    const hold = new Promise<void>((r) => { open = r; });
    const chromium = fakeChromium({ hold });
    const reader = new BrowserReader({ launch: chromium.launch, settleMs: 0 });
    const reads = ['a', 'b', 'c', 'd'].map((p) => reader.read(`https://portal.example/${p}`));
    await new Promise((r) => setTimeout(r, 10));
    expect(chromium.stats.visited).toHaveLength(2);
    open();
    await Promise.all(reads);
    expect(chromium.stats.maxOpen).toBe(2);
    expect(chromium.stats.visited).toHaveLength(4);
    await reader.close();
  });

  it('answers null when Chromium is not installed or the page does not load, and never retries a missing browser', async () => {
    let tries = 0;
    const missing = new BrowserReader({ launch: async () => { tries++; throw new Error("Executable doesn't exist"); } });
    expect(await missing.read('https://portal.example/a')).toBeNull();
    expect(await missing.read('https://portal.example/b')).toBeNull();
    expect(tries).toBe(1);
    const failing = new BrowserReader({ launch: fakeChromium({ fail: true }).launch, settleMs: 0 });
    expect(await failing.read('https://portal.example/c')).toBeNull();
    await failing.close();
  });

  it('closes the browser after it has been idle', async () => {
    const chromium = fakeChromium();
    const reader = new BrowserReader({ launch: chromium.launch, settleMs: 0, idleMs: 5 });
    await reader.read('https://portal.example/a');
    await new Promise((r) => setTimeout(r, 30));
    expect(chromium.stats.closed).toBe(1);
    await reader.read('https://portal.example/b');
    expect(chromium.stats.launches).toBe(2);
    await reader.close();
  });
});
