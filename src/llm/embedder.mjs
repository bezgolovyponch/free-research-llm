import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { splitKeys } from './provider.mjs';

export const EMBED_BATCH = 50;
export const EMBED_TEXT_CHARS = 2000;
export const EMBED_CACHE_SIZE = 20000;
export const EMBED_TEXTS_PER_RUN = 2000;

export const KEY_REFUSALS = [401, 403, 429];
export const EMBED_ROUTES = [
  {
    id: 'cloudflare',
    model: '@cf/baai/bge-m3',
    keys: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    request: (env, texts) => ({
      url: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/baai/bge-m3`,
      init: { method: 'POST', headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: texts }) },
    }),
    vectors: (body) => body?.result?.data,
  },
  {
    id: 'gemini',
    model: 'gemini-embedding-001',
    keys: ['GEMINI_API_KEY'],
    request: (env, texts) => ({
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
      init: { method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ requests: texts.map((text) => ({ model: 'models/gemini-embedding-001', content: { parts: [{ text }] }, taskType: 'SEMANTIC_SIMILARITY' })) }) },
    }),
    vectors: (body) => body?.embeddings?.map((item) => item?.values),
  },
];

function cosine(a, b) {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < Math.min(a?.length ?? 0, b?.length ?? 0); i++) {
    dot += a[i] * b[i];
    left += a[i] * a[i];
    right += b[i] * b[i];
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

function nearest(query, vectors) {
  return vectors
    .map((vector, index) => ({ index, score: cosine(query, vector) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((hit) => hit.index);
}

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, EMBED_TEXT_CHARS);
const keyOf = (text) => createHash('sha256').update(text).digest('hex');
const slugOf = (model) => String(model).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
const encode = (vector) => Buffer.from(new Float32Array(vector).buffer).toString('base64');

function decode(text) {
  const bytes = Buffer.from(String(text ?? ''), 'base64');
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4)));
}

export class Embedder {
  constructor({ env = process.env, fetchImpl = fetch, routes = EMBED_ROUTES, dir = null, maxTexts = EMBED_TEXTS_PER_RUN } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.routes = routes;
    this.dir = dir;
    this.maxTexts = maxTexts;
    this.embedded = 0;
    this.caches = new Map();
    this.failures = [];
    this.reported = 0;
    this.lastModel = null;
  }

  get ready() {
    return this.routes.some((route) => route.keys.every((key) => this.env[key]));
  }

  newRun() {
    this.embedded = 0;
  }

  fileOf(model) {
    return path.join(this.dir, `${slugOf(model)}.json`);
  }

  async cacheOf(model) {
    if (this.caches.has(model)) return this.caches.get(model);
    const cache = new Map();
    if (this.dir) {
      const stored = await fs.readFile(this.fileOf(model), 'utf8').then(JSON.parse).catch(() => null);
      if (stored?.model === model) for (const [key, value] of Object.entries(stored.vectors ?? {})) cache.set(key, decode(value));
    }
    this.caches.set(model, cache);
    return cache;
  }

  async persist(model, cache) {
    while (cache.size > EMBED_CACHE_SIZE) cache.delete(cache.keys().next().value);
    if (!this.dir) return;
    await fs.mkdir(this.dir, { recursive: true });
    const vectors = Object.fromEntries([...cache].map(([key, vector]) => [key, encode(vector)]));
    await fs.writeFile(this.fileOf(model), JSON.stringify({ model, vectors }));
  }

  async answerFrom(route, batch) {
    const variants = Math.max(1, ...route.keys.map((key) => splitKeys(this.env[key]).length));
    let status = 0;
    for (let index = 0; index < variants; index++) {
      const env = { ...this.env, ...Object.fromEntries(route.keys.map((key) => { const values = splitKeys(this.env[key]); return [key, values[index % values.length] ?? '']; })) };
      const { url, init } = route.request(env, batch);
      const response = await this.fetchImpl(url, init);
      if (response.ok) return response;
      status = response.status;
      if (!KEY_REFUSALS.includes(status)) break;
    }
    throw new Error(`${route.id} embeddings answered ${status}`);
  }

  async fetchVectors(route, texts) {
    const out = [];
    for (let at = 0; at < texts.length; at += EMBED_BATCH) {
      const batch = texts.slice(at, at + EMBED_BATCH);
      const response = await this.answerFrom(route, batch);
      const vectors = route.vectors(await response.json());
      if (!Array.isArray(vectors) || vectors.length !== batch.length || vectors.some((v) => !Array.isArray(v) || !v.length)) throw new Error(`${route.id} embeddings returned no vectors`);
      out.push(...vectors);
    }
    return out;
  }

  async embedAll(texts) {
    const list = (texts ?? []).map(clean);
    const usable = this.routes.filter((route) => route.keys.every((key) => this.env[key]));
    if (!usable.length && !this.failures.some((failure) => failure.route === 'none')) this.failures.push({ route: 'none', error: 'no embedding route has keys' });
    for (const route of usable) {
      const cache = await this.cacheOf(route.model);
      const missing = [...new Set(list.filter((text) => !cache.has(keyOf(text))))];
      if (this.embedded + missing.length > this.maxTexts) {
        this.failures.push({ route: route.id, error: `the run's allowance of ${this.maxTexts} embedded texts is used up` });
        return null;
      }
      try {
        if (missing.length) {
          const vectors = await this.fetchVectors(route, missing);
          missing.forEach((text, i) => cache.set(keyOf(text), vectors[i]));
          this.embedded += missing.length;
          await this.persist(route.model, cache);
        }
        this.lastModel = route.model;
        return { model: route.model, vectors: list.map((text) => cache.get(keyOf(text))) };
      } catch (error) {
        this.failures.push({ route: route.id, error: String(error?.message ?? error).slice(0, 160) });
      }
    }
    return null;
  }

  async rank(query, candidates, k = (candidates ?? []).length) {
    const list = candidates ?? [];
    if (!list.length) return null;
    const embedded = await this.embedAll([query, ...list]);
    if (!embedded) return null;
    const [first, ...rest] = embedded.vectors;
    return { model: embedded.model, order: nearest(first, rest).slice(0, k) };
  }

  async medoid(texts) {
    const list = texts ?? [];
    if (!list.length) return null;
    if (list.length === 1) return 0;
    const embedded = await this.embedAll(list);
    if (!embedded) return null;
    const places = list.map(() => 0);
    embedded.vectors.forEach((vector, from) => {
      const others = embedded.vectors.map((other, index) => ({ other, index })).filter((entry) => entry.index !== from);
      nearest(vector, others.map((entry) => entry.other)).forEach((at, place) => {
        places[others[at].index] += place;
      });
    });
    return places.indexOf(Math.min(...places));
  }

  failureNote() {
    const fresh = this.failures.slice(this.reported);
    this.reported = this.failures.length;
    return fresh.length ? `embeddings unavailable (${[...new Set(fresh.map((f) => `${f.route}: ${f.error}`))].join('; ')}); every candidate is judged instead` : '';
  }
}
