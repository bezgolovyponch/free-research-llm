export const BROWSER_PAGES_AT_ONCE = 2;
export const BROWSER_TIMEOUT_MS = 25000;
export const BROWSER_IDLE_MS = 2 * 60 * 1000;
export const BROWSER_SETTLE_MS = 1500;

async function settled(step) {
  try {
    await step();
    return true;
  } catch {
    return false;
  }
}

async function launchChromium() {
  const { chromium } = await import('@playwright/test');
  return chromium.launch({ headless: true });
}

export class BrowserReader {
  constructor({ launch = launchChromium, pagesAtOnce = BROWSER_PAGES_AT_ONCE, timeoutMs = BROWSER_TIMEOUT_MS, idleMs = BROWSER_IDLE_MS, settleMs = BROWSER_SETTLE_MS } = {}) {
    this.launch = launch;
    this.pagesAtOnce = pagesAtOnce;
    this.timeoutMs = timeoutMs;
    this.idleMs = idleMs;
    this.settleMs = settleMs;
    this.browser = null;
    this.starting = null;
    this.unavailable = false;
    this.open = 0;
    this.waiting = [];
    this.idleTimer = null;
    this.reads = 0;
  }

  async ready() {
    if (this.unavailable) return null;
    if (this.browser) return this.browser;
    this.starting ??= (async () => {
      try {
        this.browser = await this.launch();
        return this.browser;
      } catch {
        this.unavailable = true;
        return null;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  async slot() {
    if (this.open < this.pagesAtOnce) {
      this.open++;
      return;
    }
    await new Promise((resolve) => this.waiting.push(resolve));
  }

  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.open--;
  }

  async read(url) {
    const browser = await this.ready();
    if (!browser) return null;
    clearTimeout(this.idleTimer);
    await this.slot();
    let context = null;
    try {
      context = await browser.newContext();
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      await page.waitForTimeout(this.settleMs);
      this.reads++;
      return { status: response?.status() ?? 0, html: await page.content(), url: page.url() };
    } catch {
      return null;
    } finally {
      if (context) await settled(() => context.close());
      this.release();
      this.scheduleClose();
    }
  }

  scheduleClose() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), this.idleMs);
    this.idleTimer.unref?.();
  }

  async close() {
    clearTimeout(this.idleTimer);
    const browser = this.browser;
    this.browser = null;
    if (browser) await settled(() => browser.close());
  }
}
