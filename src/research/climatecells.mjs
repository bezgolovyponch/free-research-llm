import fs from 'node:fs/promises';
import { CCI_DAILY_VARS } from './cci.mjs';

export const CLIMATE_URL = 'https://archive-api.open-meteo.com/v1/archive';
export const CLIMATE_YEAR = 2025;
export const CLIMATE_CELL_DEG = 0.25;
export const CLIMATE_PACE_MS = 20000;
export const QUOTA_PAUSE_MS = 60 * 60 * 1000;

const centre = (x) => Math.round((Math.floor(x / CLIMATE_CELL_DEG) * CLIMATE_CELL_DEG + CLIMATE_CELL_DEG / 2) * 1000) / 1000;

export function climateCell(lat, lon) {
  return { lat: centre(lat), lon: centre(lon), key: `${centre(lat)},${centre(lon)}` };
}

export function climateUrl(cell) {
  return `${CLIMATE_URL}?latitude=${cell.lat}&longitude=${cell.lon}&start_date=${CLIMATE_YEAR}-01-01&end_date=${CLIMATE_YEAR}-12-31&daily=${CCI_DAILY_VARS}&timezone=GMT`;
}

export class ClimateCells {
  constructor({ file = '', fetchJson, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), paceMs = CLIMATE_PACE_MS }) {
    this.file = file;
    this.fetchJson = fetchJson;
    this.now = now;
    this.sleep = sleep;
    this.paceMs = paceMs;
    this.cells = null;
    this.nextAt = 0;
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.cells) return this.cells;
    try {
      this.cells = this.file ? JSON.parse(await fs.readFile(this.file, 'utf8')).cells ?? {} : {};
    } catch {
      this.cells = {};
    }
    return this.cells;
  }

  async has(lat, lon) {
    return Boolean((await this.load())[climateCell(lat, lon).key]);
  }

  async save() {
    if (!this.file) return;
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify({ year: CLIMATE_YEAR, cellDeg: CLIMATE_CELL_DEG, cells: this.cells }));
    await fs.rename(`${this.file}.tmp`, this.file);
  }

  daily(lat, lon) {
    const next = this.queue.then(() => this.fetchCell(lat, lon), () => this.fetchCell(lat, lon));
    this.queue = next;
    return next;
  }

  async fetchCell(lat, lon) {
    const cells = await this.load();
    const cell = climateCell(lat, lon);
    if (cells[cell.key]) return cells[cell.key].daily;
    const wait = this.nextAt - this.now();
    if (wait > 0) await this.sleep(wait);
    this.nextAt = this.now() + this.paceMs;
    try {
      const weather = await this.fetchJson(climateUrl(cell));
      if (!weather?.daily?.time?.length) return null;
      cells[cell.key] = { at: this.now(), daily: weather.daily };
      await this.save();
      return weather.daily;
    } catch (error) {
      if (/\b429\b/.test(String(error.message))) this.nextAt = this.now() + QUOTA_PAUSE_MS;
      return null;
    }
  }
}
