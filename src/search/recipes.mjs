import fs from 'node:fs/promises';
import path from 'node:path';

export const RECHECK_MS = 7 * 24 * 3600 * 1000;
export const MAX_MISSES = 3;
const MAX_SITES = 300;
const MAX_SEARCH_PAGES = 4;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export class SiteRecipes {
  constructor({ file = '', now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.sites = {};
    this.loaded = !file;
    this.writing = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') this.sites = parsed;
    } catch {
      this.sites = {};
    }
    this.loaded = true;
    return this;
  }

  get(url) {
    return this.sites[hostOf(url)] ?? null;
  }

  learn(url, { template, methods, count, country = '', sample = [] }) {
    const host = hostOf(url);
    if (!host || !count) return null;
    const known = this.sites[host];
    const relearned = Boolean(known && known.template && template && known.template !== template);
    const pages = [url, ...(known?.searchPages ?? []).filter((p) => p !== url)].slice(0, MAX_SEARCH_PAGES);
    this.sites[host] = {
      template: template || known?.template || '',
      methods,
      count,
      country: country || known?.country || '',
      sample: sample.length ? sample.slice(0, 5).map((t) => String(t).slice(0, 80)) : known?.sample ?? [],
      searchPages: pages,
      learnedAt: relearned || !known ? new Date(this.now()).toISOString() : known.learnedAt,
      verifiedAt: relearned ? null : known?.verifiedAt ?? null,
      misses: 0,
    };
    this.persist();
    return this.sites[host];
  }

  miss(url) {
    const host = hostOf(url);
    const known = this.sites[host];
    if (!known) return null;
    known.misses = (known.misses ?? 0) + 1;
    if (known.misses >= MAX_MISSES) delete this.sites[host];
    this.persist();
    return this.sites[host] ?? null;
  }

  needsCheck(url) {
    const known = this.get(url);
    if (!known) return false;
    return !known.verifiedAt || this.now() - Date.parse(known.verifiedAt) > RECHECK_MS;
  }

  verify(url, { count, template }) {
    const known = this.get(url);
    if (!known) return false;
    const ok = count > 0 && (!known.template || !template || template === known.template);
    if (ok) known.verifiedAt = new Date(this.now()).toISOString();
    else known.misses = (known.misses ?? 0) + 1;
    this.persist();
    return ok;
  }

  verifiedSearchPages() {
    return Object.entries(this.sites).filter(([, r]) => r.verifiedAt).flatMap(([host, r]) => (r.searchPages ?? []).map((url) => ({ host, url, count: r.count, country: r.country ?? '', sample: r.sample ?? [] })));
  }

  describe() {
    return Object.entries(this.sites).map(([host, r]) => ({ host, template: r.template, methods: r.methods, count: r.count, country: r.country ?? '', verified: Boolean(r.verifiedAt), misses: r.misses ?? 0 }));
  }

  persist() {
    const hosts = Object.keys(this.sites);
    if (hosts.length > MAX_SITES) for (const host of hosts.slice(0, hosts.length - MAX_SITES)) delete this.sites[host];
    if (!this.file) return this.writing;
    const body = JSON.stringify(this.sites, null, 1);
    this.writing = this.writing.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(`${this.file}.tmp`, body);
        await fs.rename(`${this.file}.tmp`, this.file);
      } catch {
        return undefined;
      }
    });
    return this.writing;
  }
}
