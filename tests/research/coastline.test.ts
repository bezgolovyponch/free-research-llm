import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COASTLINE_URL, CoastFile, CoastIndex, coastSegments, kmToSegment } from '../../src/research/coastline.mjs';

const coast = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-8.9, 40.0], [-8.9, 40.4]] } }, { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[-9.5, 38.7], [-9.4, 38.7]]] } }] };

describe('coastline from the Natural Earth 1:10m file, measured by the app itself', () => {
  it('splits lines into segments and measures the distance to the nearest one', () => {
    expect(coastSegments(coast)).toHaveLength(2);
    expect(kmToSegment(40.2, -8.9, [-8.9, 40.0, -8.9, 40.4])).toBeCloseTo(0, 5);
    const index = new CoastIndex(coastSegments(coast));
    expect(index.nearestKm(40.18764, -8.68305, 25)).toBeCloseTo(18.4, 0);
    expect(index.nearestKm(40.2, -8.0, 25)).toBeNull();
  });

  it('reads the file once it is on disk, downloads it when it is missing, and answers undefined when neither works', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-coast-'));
    const file = path.join(dir, 'coastline-ne10m.geojson');
    const urls: string[] = [];
    const fetchImpl = async (url: string) => { urls.push(url); return new Response(JSON.stringify(coast)); };
    expect(await new CoastFile({ file, fetchImpl: fetchImpl as never }).nearestKm(40.2, -8.85, 25)).toBeCloseTo(4.3, 0);
    expect(urls).toEqual([COASTLINE_URL]);
    expect(await new CoastFile({ file, fetchImpl: fetchImpl as never }).nearestKm(40.2, -8.85, 25)).toBeCloseTo(4.3, 0);
    expect(urls).toHaveLength(1);
    const offline = new CoastFile({ file: path.join(dir, 'missing.geojson'), fetchImpl: (async () => new Response('busy', { status: 503 })) as never });
    expect(await offline.nearestKm(40.2, -8.85, 25)).toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
