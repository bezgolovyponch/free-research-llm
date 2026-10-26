import { describe, expect, it } from 'vitest';
import { roundRobin, SEED_PORTALS, seedPortals } from '../../src/research/portals.mjs';

const kind = { label: 'plot of land', terms: ['terreno'] };

describe('seed portals', () => {
  it('offers only verified coastal land portals of the countries the brief names, within the price limit', () => {
    const seeds = seedPortals({ kind, regions: ['ES', 'TR'], coastal: true, valueRange: [0, 20000] });
    expect(new Set(seeds.map((s) => s.country))).toEqual(new Set(['ES', 'TR']));
    expect(seeds.every((s) => s.seed && /^https:\/\//.test(s.url))).toBe(true);
    expect(seeds.some((s) => s.url === 'https://www.pisos.com/venta/terrenos-galicia/hasta-20000/')).toBe(true);
    expect(seedPortals({ kind, regions: ['ES'], coastal: true, valueRange: [0, 50000] }).filter((s) => s.country === 'ES')).toEqual([]);
    expect(seedPortals({ kind: { label: 'used car' }, regions: ['ES'] })).toEqual([]);
    expect(seedPortals(null)).toEqual([]);
    expect(SEED_PORTALS.filter((s) => s.country === 'PT')).toHaveLength(10);
  });

  it('interleaves pages by country so no named country waits behind another', () => {
    const pages = [{ c: 'PT', n: 1 }, { c: 'PT', n: 2 }, { c: 'PT', n: 3 }, { c: 'ES', n: 1 }, { c: 'TR', n: 1 }, { c: 'TR', n: 2 }];
    expect(roundRobin(pages, (p) => p.c).map((p) => `${p.c}${p.n}`)).toEqual(['PT1', 'ES1', 'TR1', 'PT2', 'TR2', 'PT3']);
  });
});
