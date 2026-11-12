import fs from 'node:fs/promises';

export const HALF_LIFE_MS = 3 * 24 * 3600 * 1000;
export const PRIOR_WEIGHT = 4;
const MAX_KEYS = 500;

export function decayed(count, ageMs, halfLifeMs = HALF_LIFE_MS) {
  return count * 0.5 ** (Math.max(0, ageMs) / halfLifeMs);
}

function gammaSample(shape, rng) {
  if (shape < 1) return gammaSample(shape + 1, rng) * rng() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      const u1 = rng();
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v ** 3;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u || 1e-12) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function betaSample(a, b, rng = Math.random) {
  const x = gammaSample(a, rng);
  const y = gammaSample(b, rng);
  return x / (x + y);
}

export function priorOf(capability) {
  const p = Math.min(0.95, Math.max(0.05, (Number(capability) || 3) / 5));
  return { a: p * PRIOR_WEIGHT, b: (1 - p) * PRIOR_WEIGHT };
}

export class OutcomeBook {
  constructor({ file = '', now = () => Date.now(), halfLifeMs = HALF_LIFE_MS } = {}) {
    this.file = file;
    this.now = now;
    this.halfLifeMs = halfLifeMs;
    this.counts = {};
    this.loaded = !file;
    this.writing = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') this.counts = parsed.counts ?? {};
    } catch {
      this.counts = {};
    }
    this.loaded = true;
    return this;
  }

  key(provider, purposeClass, model = null) {
    return model ? `${provider}|${model}|${purposeClass}` : `${provider}|${purposeClass}`;
  }

  current(key) {
    const c = this.counts[key];
    if (!c) return { pass: 0, fail: 0 };
    const age = this.now() - c.at;
    return { pass: decayed(c.pass, age, this.halfLifeMs), fail: decayed(c.fail, age, this.halfLifeMs) };
  }

  record({ provider, purposeClass, passed, model = null }) {
    if (!provider || !purposeClass) return;
    const key = this.key(provider, purposeClass, model);
    const { pass, fail } = this.current(key);
    this.counts[key] = { pass: pass + (passed ? 1 : 0), fail: fail + (passed ? 0 : 1), at: this.now() };
    const keys = Object.keys(this.counts);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_KEYS))) delete this.counts[k];
    if (this.file) this.writing = this.writing.then(() => fs.writeFile(this.file, JSON.stringify({ counts: this.counts }))).catch(() => {});
  }

  posterior(provider, purposeClass, capability, model = null) {
    const prior = priorOf(capability);
    const { pass, fail } = this.current(this.key(provider, purposeClass, model));
    const a = prior.a + pass;
    const b = prior.b + fail;
    return { a, b, mean: a / (a + b), observed: pass + fail, pass, fail };
  }

  sample(provider, purposeClass, capability, rng = Math.random, model = null) {
    const { a, b } = this.posterior(provider, purposeClass, capability, model);
    return betaSample(a, b, rng);
  }
}
