import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Coastline, NATURAL_EARTH_COAST, gridOf, pointToSegmentKm, segmentsOf } from '../../verifier/coast.mjs';

const coast = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-9.1, 39.0], [-9.1, 40.0]] } }, { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[10, 50], [11, 50]]] } }] };

describe('independent coastline (Natural Earth 1:10m)', () => {
  it('splits lines into segments and indexes them by 1° cell', () => {
    const segments = segmentsOf(coast);
    expect(segments).toEqual([[-9.1, 39, -9.1, 40], [10, 50, 11, 50]]);
    expect([...gridOf(segments).keys()].sort()).toEqual(['-10,39', '-10,40', '10,50', '11,50']);
  });

  it('measures the distance from a point to the nearest coast segment', () => {
    expect(pointToSegmentKm(39.5, -9.0, [-9.1, 39, -9.1, 40])).toBeCloseTo(8.6, 1);
    const line = Coastline.fromGeojson(coast);
    expect(line.nearestKm(39.5, -9.0, 25)).toBeCloseTo(8.6, 1);
    expect(line.nearestKm(39.5, -8.0, 25)).toBeNull();
  });

  it('downloads the coastline once and reads it from its cache afterwards', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-coast-'));
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls++;
      expect(url).toBe(NATURAL_EARTH_COAST);
      return new Response(JSON.stringify(coast), { status: 200 });
    }) as never;
    expect((await Coastline.load({ cacheDir: dir, fetchImpl })).nearestKm(39.5, -9.0, 25)).toBeCloseTo(8.6, 1);
    await Coastline.load({ cacheDir: dir, fetchImpl });
    expect(calls).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
