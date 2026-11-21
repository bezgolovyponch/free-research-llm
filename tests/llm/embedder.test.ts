import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as module from '../../src/llm/embedder.mjs';
import { EMBED_BATCH, Embedder } from '../../src/llm/embedder.mjs';

const AXES: Record<string, number[]> = { red: [1, 0, 0], crimson: [0.9, 0.1, 0], green: [0, 1, 0], lime: [0.1, 0.9, 0], blue: [0, 0, 1] };
const vectorOf = (text: string, flip = false) => {
  const base = AXES[text] ?? [0.3, 0.3, 0.3];
  return flip ? [...base].reverse() : base;
};

function route(id: string, { fail = () => false, flip = false, log = [] as string[][] } = {}) {
  return {
    id,
    model: `${id}-model`,
    keys: [`${id.toUpperCase()}_KEY`],
    request: (_env: unknown, texts: string[]) => ({ url: `https://embed.test/${id}`, init: { body: JSON.stringify(texts) } }),
    vectors: (body: { vectors: number[][] }) => body.vectors,
    log,
    fail,
    flip,
  };
}

function fetchFor(routes: ReturnType<typeof route>[]) {
  return async (url: string, init: { body: string }) => {
    const hit = routes.find((entry) => url.endsWith(`/${entry.id}`))!;
    const texts = JSON.parse(init.body) as string[];
    hit.log.push(texts);
    if (hit.fail(hit.log.length)) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ vectors: texts.map((text) => vectorOf(text, hit.flip)) }) };
  };
}

const env = { ONE_KEY: 'k', TWO_KEY: 'k' };

describe('embedder: ranks only, one model per comparison', () => {
  it('exposes no score: rank gives indexes, medoid an index, and the module exports no cosine or nearest', async () => {
    const one = route('one');
    const embedder = new Embedder({ env, routes: [one], fetchImpl: fetchFor([one]) as never });
    const ranked = await embedder.rank('red', ['blue', 'crimson', 'green'], 2);
    expect(ranked).toEqual({ model: 'one-model', order: [1, 0] });
    expect(JSON.stringify(ranked)).not.toMatch(/score|0\.\d/);
    expect(await embedder.medoid(['red', 'crimson', 'green'])).toBe(1);
    expect(await embedder.medoid(['red'])).toBe(0);
    expect(Object.keys(module).filter((name) => /cosine|nearest|score/i.test(name))).toEqual([]);
  });

  it('embeds the query and the candidates in one call, in batches of 50', async () => {
    const one = route('one');
    const embedder = new Embedder({ env, routes: [one], fetchImpl: fetchFor([one]) as never });
    await embedder.rank('red', ['green', 'blue']);
    expect(one.log).toEqual([['red', 'green', 'blue']]);
    const many = Array.from({ length: 120 }, (_, i) => `text ${i}`);
    await embedder.rank('q', many);
    expect(one.log.slice(1).map((batch) => batch.length)).toEqual([EMBED_BATCH, EMBED_BATCH, 21]);
  });

  it('embeds the whole set again on the next route when a route fails part-way', async () => {
    const one = route('one', { fail: (call) => call === 2 });
    const two = route('two');
    const embedder = new Embedder({ env, routes: [one, two], fetchImpl: fetchFor([one, two]) as never });
    const many = Array.from({ length: 60 }, (_, i) => `text ${i}`);
    const ranked = await embedder.rank('q', many, 3);
    expect(ranked!.model).toBe('two-model');
    expect(one.log.map((batch) => batch.length)).toEqual([50, 11]);
    expect(two.log.flat()).toHaveLength(61);
    expect(embedder.failures).toEqual([{ route: 'one', error: 'one embeddings answered 503' }]);
    expect(embedder.failureNote()).toContain('one embeddings answered 503');
    expect(embedder.failureNote()).toBe('');
  });

  it('keeps a cache per model: the second model never reads the first model vectors', async () => {
    const one = route('one', { fail: (call) => call > 1 });
    const two = route('two', { flip: true });
    const embedder = new Embedder({ env, routes: [one, two], fetchImpl: fetchFor([one, two]) as never });
    expect((await embedder.rank('red', ['blue', 'crimson']))!.order[0]).toBe(1);
    expect(await embedder.rank('red', ['blue', 'crimson'])).toEqual({ model: 'one-model', order: [1, 0] });
    expect(one.log).toHaveLength(1);
    const next = await embedder.rank('red', ['blue', 'crimson', 'green']);
    expect(next!.model).toBe('two-model');
    expect(two.log).toEqual([['red', 'blue', 'crimson', 'green']]);
  });

  it('returns null with no keys, and when every route fails; no lexical fallback', async () => {
    const one = route('one', { fail: () => true });
    expect(await new Embedder({ env: {}, routes: [one], fetchImpl: fetchFor([one]) as never }).rank('red', ['red'])).toBeNull();
    expect(new Embedder({ env: {}, routes: [one] }).ready).toBe(false);
    const failing = new Embedder({ env, routes: [one], fetchImpl: fetchFor([one]) as never });
    expect(await failing.rank('red', ['red', 'blue'])).toBeNull();
    expect(await failing.medoid(['red', 'blue'])).toBeNull();
    expect(await failing.rank('red', [])).toBeNull();
  });

  it('stops at the allowance of texts for one run', async () => {
    const one = route('one');
    const embedder = new Embedder({ env, routes: [one], fetchImpl: fetchFor([one]) as never, maxTexts: 3 });
    expect(await embedder.rank('red', ['green', 'blue'])).not.toBeNull();
    expect(await embedder.rank('red', ['lime'])).toBeNull();
    expect(embedder.failures[0].error).toContain('allowance of 3');
  });

  it('gives each new run its own allowance, so a long-lived app does not stop embedding after a few researches', async () => {
    const one = route('one');
    const embedder = new Embedder({ env, routes: [one], fetchImpl: fetchFor([one]) as never, maxTexts: 3 });
    expect(await embedder.rank('red', ['green', 'blue'])).not.toBeNull();
    expect(await embedder.rank('red', ['lime'])).toBeNull();
    embedder.newRun();
    expect(await embedder.rank('red', ['lime'])).not.toBeNull();
    expect(embedder.embedded).toBe(1);
  });

  it('round-trips the disk cache per model', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-embed-'));
    const one = route('one');
    const first = new Embedder({ env, routes: [one], fetchImpl: fetchFor([one]) as never, dir });
    await first.rank('red', ['crimson', 'blue']);
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'one-model.json'), 'utf8'));
    expect(stored.model).toBe('one-model');
    expect(Object.keys(stored.vectors)).toHaveLength(3);
    expect(Object.keys(stored.vectors).every((key) => /^[0-9a-f]{64}$/.test(key))).toBe(true);
    const again = route('one');
    const second = new Embedder({ env, routes: [again], fetchImpl: fetchFor([again]) as never, dir });
    expect(await second.rank('red', ['crimson', 'blue'])).toEqual({ model: 'one-model', order: [0, 1] });
    expect(again.log).toEqual([]);
  });
});

describe('embedder: key lists', () => {
  const keyed = (refused: number) => {
    const sent: string[] = [];
    const entry = { id: 'one', model: 'one-model', keys: ['ONE_KEY'], request: (env: Record<string, string>, texts: string[]) => ({ url: 'https://embed.test/one', init: { key: env.ONE_KEY, body: JSON.stringify(texts) } }), vectors: (body: { vectors: number[][] }) => body.vectors };
    const fetchImpl = async (_url: string, init: { key: string; body: string }) => {
      sent.push(init.key);
      if (init.key === 'first') return { ok: false, status: refused, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ vectors: (JSON.parse(init.body) as string[]).map((text) => vectorOf(text)) }) };
    };
    return { sent, embedder: new Embedder({ env: { ONE_KEY: 'first, second' }, fetchImpl: fetchImpl as never, routes: [entry] as never }) };
  };

  it('sends one key of a comma-separated list at a time and moves to the next when a key is refused', async () => {
    const { sent, embedder } = keyed(401);
    expect(await embedder.embedAll(['red'])).toMatchObject({ model: 'one-model' });
    expect(sent).toEqual(['first', 'second']);
  });

  it('does not try another key when the service itself fails', async () => {
    const { sent, embedder } = keyed(503);
    expect(await embedder.embedAll(['red'])).toBeNull();
    expect(sent).toEqual(['first']);
    expect(embedder.failures).toEqual([{ route: 'one', error: 'one embeddings answered 503' }]);
  });
});
