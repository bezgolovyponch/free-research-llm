import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIMATE_PACE_MS, ClimateCells, QUOTA_PAUSE_MS, climateCell, climateUrl } from '../../src/research/climatecells.mjs';

const daily = { time: ['2025-01-01'], temperature_2m_mean: [14] };

describe('ClimateCells: one recent year of daily weather per 0.25 degree cell, fetched once', () => {
  it('snaps nearby plots to one cell centre and asks for 2025 only', () => {
    expect(climateCell(40.18764, -8.68305)).toEqual({ lat: 40.125, lon: -8.625, key: '40.125,-8.625' });
    expect(climateCell(40.2, -8.6).key).toBe('40.125,-8.625');
    expect(climateCell(40.5, -8.6).key).toBe('40.625,-8.625');
    expect(climateUrl(climateCell(40.18764, -8.68305))).toContain('latitude=40.125&longitude=-8.625&start_date=2025-01-01&end_date=2025-12-31');
  });

  it('fetches each cell once, keeps it on disk for the next run, and paces new cells', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-cells-'));
    const file = path.join(dir, 'climate-cells.json');
    const urls: string[] = [];
    const sleeps: number[] = [];
    let clock = 0;
    const fetchJson = async (url: string) => { urls.push(url); return { daily }; };
    const cells = new ClimateCells({ file, fetchJson, now: () => clock, sleep: async (ms: number) => { sleeps.push(ms); clock += ms; } });
    expect(await cells.daily(40.18764, -8.68305)).toEqual(daily);
    expect(await cells.daily(40.2, -8.6)).toEqual(daily);
    expect(urls).toHaveLength(1);
    await cells.daily(40.6, -8.6);
    expect(urls).toHaveLength(2);
    expect(sleeps).toEqual([CLIMATE_PACE_MS]);
    const again = new ClimateCells({ file, fetchJson, now: () => clock, sleep: async () => {} });
    expect(await again.has(40.19, -8.65)).toBe(true);
    expect(await again.daily(40.19, -8.65)).toEqual(daily);
    expect(urls).toHaveLength(2);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('pauses an hour after a rate-limit answer instead of failing every plot', async () => {
    const sleeps: number[] = [];
    let clock = 0;
    let calls = 0;
    const fetchJson = async () => { calls++; if (calls === 1) throw new Error('HTTP 429 from archive-api.open-meteo.com'); return { daily }; };
    const cells = new ClimateCells({ fetchJson, now: () => clock, sleep: async (ms: number) => { sleeps.push(ms); clock += ms; } });
    expect(await cells.daily(40.1, -8.6)).toBeNull();
    expect(await cells.daily(40.1, -8.6)).toEqual(daily);
    expect(sleeps).toEqual([QUOTA_PAUSE_MS]);
  });
});
