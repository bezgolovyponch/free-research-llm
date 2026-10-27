import fs from 'node:fs/promises';
import { HALF_LIFE_MS, betaSample, decayed } from '../llm/outcomes.mjs';

export const ARM_PRIOR = { a: 1, b: 1 };
export const SEED_PRIOR = { a: 2, b: 1 };
const MAX_ARMS = 2000;
const PAGE_PARAMS = /^(?:page|pagina|sayfa|p|pg|offset|start)$/i;

export function armKey(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (PAGE_PARAMS.test(key)) u.searchParams.delete(key);
    u.hash = '';
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return String(url ?? '');
  }
}

export class ArmBook {
  constructor({ file = '', now = () => Date.now(), halfLifeMs = HALF_LIFE_MS } = {}) {
    this.file = file;
    this.now = now;
    this.halfLifeMs = halfLifeMs;
    this.arms = {};
    this.loaded = !file;
    this.writing = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.arms = parsed?.arms ?? {};
    } catch {
      this.arms = {};
    }
    this.loaded = true;
    return this;
  }

  current(key) {
    const arm = this.arms[key];
    if (!arm) return { pass: 0, fail: 0, listings: 0 };
    const age = this.now() - arm.at;
    return { pass: decayed(arm.pass, age, this.halfLifeMs), fail: decayed(arm.fail, age, this.halfLifeMs), listings: decayed(arm.listings ?? 0, age, this.halfLifeMs) };
  }

  posterior(url, { seed = false } = {}) {
    const prior = seed ? SEED_PRIOR : ARM_PRIOR;
    const { pass, fail, listings } = this.current(armKey(url));
    const a = prior.a + pass;
    const b = prior.b + fail;
    return { a, b, mean: a / (a + b), observed: pass + fail, listings };
  }

  sample(url, { seed = false, rng = Math.random } = {}) {
    const { a, b } = this.posterior(url, { seed });
    return betaSample(a, b, rng);
  }

  record(url, { useful = 0, empty = 0, listings = 0 } = {}) {
    if (!url || useful + empty <= 0) return;
    const key = armKey(url);
    const now = this.current(key);
    this.arms[key] = { pass: now.pass + useful, fail: now.fail + empty, listings: now.listings + listings, at: this.now() };
    const keys = Object.keys(this.arms);
    if (keys.length > MAX_ARMS) for (const k of keys.sort((x, y) => this.arms[x].at - this.arms[y].at).slice(0, keys.length - MAX_ARMS)) delete this.arms[k];
    this.save();
  }

  save() {
    if (this.file) this.writing = this.writing.then(() => fs.writeFile(this.file, JSON.stringify({ arms: this.arms }))).catch(() => {});
  }

  order(starts, rng = Math.random) {
    return starts.map((s) => ({ ...s, draw: this.sample(s.url, { seed: Boolean(s.seed), rng }) })).sort((x, y) => y.draw - x.draw);
  }
}
