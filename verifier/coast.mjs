import fs from 'node:fs/promises';
import path from 'node:path';

export const NATURAL_EARTH_COAST = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_coastline.geojson';
export const COAST_MARGIN_KM = 2;
const KM_PER_DEG = 111.32;

export function segmentsOf(geojson) {
  const out = [];
  for (const f of geojson?.features ?? []) {
    const g = f?.geometry;
    const lines = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) for (let i = 1; i < line.length; i++) out.push([line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]]);
  }
  return out;
}

const cellOf = (lon, lat) => `${Math.floor(lon)},${Math.floor(lat)}`;

export function gridOf(segments) {
  const grid = new Map();
  for (const s of segments) {
    const keys = new Set([cellOf(s[0], s[1]), cellOf(s[2], s[3])]);
    for (const k of keys) {
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(s);
    }
  }
  return grid;
}

export function pointToSegmentKm(lat, lon, s) {
  const kx = KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const ax = (s[0] - lon) * kx;
  const ay = (s[1] - lat) * KM_PER_DEG;
  const bx = (s[2] - lon) * kx;
  const by = (s[3] - lat) * KM_PER_DEG;
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export class Coastline {
  constructor({ grid }) {
    this.grid = grid;
  }

  static fromGeojson(geojson) {
    return new Coastline({ grid: gridOf(segmentsOf(geojson)) });
  }

  static async load({ cacheDir, fetchImpl = fetch }) {
    const file = path.join(cacheDir, 'ne_10m_coastline.geojson');
    let body;
    try {
      body = await fs.readFile(file, 'utf8');
    } catch {
      const res = await fetchImpl(NATURAL_EARTH_COAST, { signal: AbortSignal.timeout(180000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from Natural Earth`);
      body = await res.text();
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(file, body);
    }
    return Coastline.fromGeojson(JSON.parse(body));
  }

  nearestKm(lat, lon, radiusKm) {
    const reachLat = Math.ceil(radiusKm / KM_PER_DEG) + 1;
    const reachLon = Math.ceil(radiusKm / (KM_PER_DEG * Math.max(0.1, Math.cos((lat * Math.PI) / 180)))) + 1;
    let best = Infinity;
    for (let dx = -reachLon; dx <= reachLon; dx++) {
      for (let dy = -reachLat; dy <= reachLat; dy++) {
        for (const s of this.grid.get(`${Math.floor(lon) + dx},${Math.floor(lat) + dy}`) ?? []) best = Math.min(best, pointToSegmentKm(lat, lon, s));
      }
    }
    return best <= radiusKm ? Math.round(best * 10) / 10 : null;
  }
}
