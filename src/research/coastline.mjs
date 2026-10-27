import fs from 'node:fs/promises';

export const COASTLINE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_coastline.geojson';
export const COASTLINE_PRECISION_KM = 2;
const KM_PER_DEGREE = 111.32;

export function coastSegments(geojson) {
  const segments = [];
  for (const feature of geojson?.features ?? []) {
    const geometry = feature?.geometry;
    const lines = geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
    for (const line of lines) for (let i = 1; i < line.length; i++) segments.push([line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]]);
  }
  return segments;
}

const cellKey = (lon, lat) => `${Math.floor(lon)}|${Math.floor(lat)}`;

export function kmToSegment(lat, lon, [lon1, lat1, lon2, lat2]) {
  const kx = KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
  const ax = (lon1 - lon) * kx;
  const ay = (lat1 - lat) * KM_PER_DEGREE;
  const dx = (lon2 - lon1) * kx;
  const dy = (lat2 - lat1) * KM_PER_DEGREE;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export class CoastIndex {
  constructor(segments) {
    this.cells = new Map();
    for (const segment of segments) {
      for (const key of new Set([cellKey(segment[0], segment[1]), cellKey(segment[2], segment[3])])) {
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key).push(segment);
      }
    }
  }

  nearestKm(lat, lon, radiusKm) {
    const spanLat = Math.ceil(radiusKm / KM_PER_DEGREE) + 1;
    const spanLon = Math.ceil(radiusKm / (KM_PER_DEGREE * Math.max(0.1, Math.cos((lat * Math.PI) / 180)))) + 1;
    let best = Infinity;
    for (let i = -spanLon; i <= spanLon; i++) {
      for (let j = -spanLat; j <= spanLat; j++) {
        for (const segment of this.cells.get(cellKey(lon + i, lat + j)) ?? []) best = Math.min(best, kmToSegment(lat, lon, segment));
      }
    }
    return best <= radiusKm ? Math.round(best * 10) / 10 : null;
  }
}

export class CoastFile {
  constructor({ file = '', fetchImpl = fetch } = {}) {
    this.file = file;
    this.fetchImpl = fetchImpl;
    this.loading = null;
  }

  index() {
    this.loading ??= this.load();
    return this.loading;
  }

  async load() {
    let body = null;
    try {
      body = this.file ? await fs.readFile(this.file, 'utf8') : null;
    } catch {
      body = null;
    }
    if (!body) {
      try {
        const res = await this.fetchImpl(COASTLINE_URL, { signal: AbortSignal.timeout(180000) });
        if (!res.ok) return null;
        body = await res.text();
        if (this.file) await fs.writeFile(this.file, body);
      } catch {
        return null;
      }
    }
    return new CoastIndex(coastSegments(JSON.parse(body)));
  }

  async nearestKm(lat, lon, radiusKm) {
    const index = await this.index();
    return index ? index.nearestKm(lat, lon, radiusKm) : undefined;
  }
}
