import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkWaste } from '../../scripts/quality.mjs';
import { computeWasteStats } from '../../scripts/waste.mjs';

describe('quality: checkWaste uses shared computeWasteStats', () => {
  it('returns same numbers as computeWasteStats for last 24h', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-quality-'));
    const logDir = path.join(dir, 'logs');
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, 'model-calls.jsonl');

    const now = new Date();
    const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    const lines = [
      JSON.stringify({ ts: fortyEightHoursAgo.toISOString(), purpose: 'research', ok: true, tokens: 1000 }),
      JSON.stringify({ ts: twelveHoursAgo.toISOString(), purpose: 'research', ok: true, tokens: 1000 }),
      JSON.stringify({ ts: new Date(twelveHoursAgo.getTime() + 3600000).toISOString(), purpose: 'decompose', ok: false, tokens: 500, error: 'quota' }),
      JSON.stringify({ ts: new Date(now.getTime() - 3600000).toISOString(), purpose: 'critique', ok: true, tokens: 2000 }),
    ];
    await fs.writeFile(logPath, lines.join('\n') + '\n');

    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const shared = computeWasteStats(logPath, since);
    const result = checkWaste(dir);

    expect(result.passed).toBe(true);
    expect(result.detail).toContain(String(shared.total) + ' calls');
    expect(result.detail).toContain(String(shared.failed) + ' failed');
    expect(result.detail).toContain(String(shared.failPct) + '%');

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('skips when log file missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-quality-'));
    const result = checkWaste(dir);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('not found (CI)');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('warns when failPct exceeds 15%', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-quality-'));
    const logDir = path.join(dir, 'logs');
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, 'model-calls.jsonl');

    const now = new Date();
    const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);

    const lines = [
      JSON.stringify({ ts: twelveHoursAgo.toISOString(), purpose: 'research', ok: true, tokens: 1000 }),
      JSON.stringify({ ts: new Date(twelveHoursAgo.getTime() + 3600000).toISOString(), purpose: 'decompose', ok: false, tokens: 500, error: 'quota' }),
      JSON.stringify({ ts: new Date(twelveHoursAgo.getTime() + 7200000).toISOString(), purpose: 'critique', ok: false, tokens: 500, error: 'quota' }),
      JSON.stringify({ ts: new Date(twelveHoursAgo.getTime() + 10800000).toISOString(), purpose: 'sweep', ok: false, tokens: 500, error: 'quota' }),
      JSON.stringify({ ts: new Date(twelveHoursAgo.getTime() + 14400000).toISOString(), purpose: 'verify', ok: false, tokens: 500, error: 'quota' }),
      JSON.stringify({ ts: new Date(now.getTime() - 3600000).toISOString(), purpose: 'notify', ok: false, tokens: 500, error: 'quota' }),
    ];
    await fs.writeFile(logPath, lines.join('\n') + '\n');

    const result = checkWaste(dir);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('WARN: exceeds 15%');

    await fs.rm(dir, { recursive: true, force: true });
  });
});
import { freePort } from '../../scripts/quality.mjs';

describe('freePort', () => {
  it('returns a port the OS just handed out, so concurrent e2e runs never share one', () => {
    const port = freePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
  });
  it('returns null when the probe prints nothing usable', () => {
    expect(freePort(() => ({ stdout: 'not a port' }) as never)).toBeNull();
    expect(freePort(() => ({ stdout: '' }) as never)).toBeNull();
  });
});
