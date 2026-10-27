import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArmBook, SEED_PRIOR, armKey } from '../../src/research/arms.mjs';
import { HALF_LIFE_MS } from '../../src/llm/outcomes.mjs';
import { buildBrief } from '../../src/research/brief.mjs';
import { CandidateSweeper } from '../../src/research/sweep.mjs';

function seeded(seed = 3) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

describe('portal arms: Thompson sampling over measured yield (arXiv 1111.1797)', () => {
  it('treats page 2 of a portal as the same arm, and other paths or filters as other arms', () => {
    expect(armKey('https://www.imo.example/pt/terreno/?page=3#x')).toBe('imo.example/pt/terreno');
    expect(armKey('https://imo.example/pt/terreno?priceMax=20000&pagina=2')).toBe('imo.example/pt/terreno?priceMax=20000');
    expect(armKey('https://imo.example/pt/moradia')).not.toBe(armKey('https://imo.example/pt/terreno'));
  });

  it('starts a hand-picked seed only as a prior that measured reads override, and forgets old reads', () => {
    let now = 0;
    const book = new ArmBook({ now: () => now });
    expect(book.posterior('https://seed.example/a', { seed: true }).mean).toBeCloseTo(SEED_PRIOR.a / (SEED_PRIOR.a + SEED_PRIOR.b), 5);
    book.record('https://seed.example/a', { useful: 0, empty: 6 });
    book.record('https://found.example/b', { useful: 5, empty: 1, listings: 40 });
    expect(book.posterior('https://seed.example/a', { seed: true }).mean).toBeLessThan(0.25);
    expect(book.posterior('https://found.example/b').mean).toBeGreaterThan(0.7);
    now = HALF_LIFE_MS;
    expect(book.posterior('https://found.example/b').observed).toBeCloseTo(3, 5);
  });

  it('reads portals that gave new listings first most of the time, yet still explores the others', () => {
    const book = new ArmBook();
    book.record('https://good.example/x', { useful: 8, empty: 1 });
    book.record('https://bad.example/x', { useful: 1, empty: 8 });
    const rng = seeded(5);
    const firsts = Array.from({ length: 200 }, () => book.order([{ url: 'https://bad.example/x' }, { url: 'https://good.example/x' }], rng)[0].url);
    const good = firsts.filter((u) => u === 'https://good.example/x').length;
    expect(good).toBeGreaterThan(170);
    expect(good).toBeLessThan(200);
  });

  it('keeps arms across restarts in its file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-arms-'));
    const file = path.join(dir, 'arms.json');
    const book = new ArmBook({ file });
    book.record('https://good.example/x', { useful: 2, empty: 0, listings: 7 });
    await book.writing;
    expect((await new ArmBook({ file }).load()).posterior('https://good.example/x').listings).toBeCloseTo(7, 5);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('sweep with arms', () => {
  const kind = { label: 'plot of land', terms: ['terreno'] };
  const brief = buildBrief({ question: 'Plots, 20000EUR max', acceptance: { expected: '2 plots in Portugal', itemCount: 2, valueRange: [0, 20000], unit: 'EUR' }, template: { itemKind: kind } });
  const ad = (host: string, n: number, value: number) => ({ title: `Terreno ${n}`, url: `https://${host}/pt/anuncio/terreno-${n}-ID1x${n}yz`, value, unit: 'EUR' });

  it('reads the better-yielding portal first and records each portal by the new listings within the limits it gave', async () => {
    const pages: Record<string, { listings: unknown[]; next: string; links: unknown[] }> = {
      'https://dry.example/pt/r': { listings: [ad('dry.example', 1, 90000)], next: '', links: [] },
      'https://rich.example/pt/r': { listings: [ad('rich.example', 2, 9000), ad('rich.example', 3, 12000)], next: '', links: [] },
    };
    const read: string[] = [];
    const search = { readPage: async (url: string) => { read.push(url); return { status: 200, text: 'terrenos', locale: 'pt', ...(pages[url] ?? { listings: [], next: '', links: [] }) }; } };
    const arms = new ArmBook();
    arms.record('https://rich.example/pt/r', { useful: 9, empty: 0 });
    arms.record('https://dry.example/pt/r', { useful: 0, empty: 9 });
    const seeds = () => [{ url: 'https://dry.example/pt/r', country: 'PT', sample: ['terreno'], count: 1, seed: true }, { url: 'https://rich.example/pt/r', country: 'PT', sample: ['terreno'], count: 1, seed: true }];
    const result = await new CandidateSweeper({ search, seeds, arms, rng: seeded(9) }).sweep({ nodes: [] }, brief);
    expect(read[0]).toBe('https://rich.example/pt/r');
    expect(result!.arms.map((a: { url: string; useful: number; empty: number; listings: number }) => [a.url, a.useful, a.empty, a.listings])).toEqual([['https://rich.example/pt/r', 1, 0, 2], ['https://dry.example/pt/r', 0, 1, 0]]);
    expect(arms.posterior('https://dry.example/pt/r').observed).toBeCloseTo(10, 5);
  });
});
