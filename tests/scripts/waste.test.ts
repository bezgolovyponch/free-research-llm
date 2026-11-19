import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aggregate, readCalls, parseDateArg } from '../../scripts/waste.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('waste: started directly or imported', () => {
  it('prints its report only when started directly, never when the quality gate imports it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'waste-entry-'));
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./scripts/waste.mjs')"], { cwd: ROOT, encoding: 'utf8' });
    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe('');
    const direct = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'waste.mjs'), '--json', '--data', dir], { cwd: ROOT, encoding: 'utf8' });
    expect(direct.status).toBe(0);
    expect(JSON.parse(direct.stdout).calls).toBe(0);
  });
});

describe('waste: date parsing', () => {
  it('parses start of day for --since', () => {
    const d = parseDateArg('2026-11-19');
    expect(d.getTime()).toBe(new Date('2026-11-19T00:00:00.000Z').getTime());
  });
  it('parses end of day for --until', () => {
    const d = parseDateArg('2026-11-19', true);
    expect(d.getTime()).toBe(new Date('2026-11-19T23:59:59.999Z').getTime());
  });
  it('throws on invalid date', () => {
    expect(() => parseDateArg('not-a-date')).toThrow('Invalid date');
  });
});

describe('waste: readCalls', () => {
  it('filters by date range and returns parsed calls', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-waste-'));
    const file = path.join(dir, 'model-calls.jsonl');
    const lines = [
      '{"ts":"2026-11-18T23:59:59.000Z","purpose":"research","tier":"fast","provider":"gemini","model":"gemini-3.5-flash-lite","ok":true,"ms":100,"tokens":1000}',
      '{"ts":"2026-11-19T12:00:00.000Z","purpose":"decompose","tier":"deep","provider":"cerebras","model":"gpt-oss-120b","ok":false,"ms":200,"tokens":500,"error":"quota exceeded"}',
      '{"ts":"2026-11-19T13:00:00.000Z","purpose":"research","tier":"fast","provider":"gemini","model":"gemini-3.5-flash-lite","ok":true,"ms":150,"tokens":2000}',
      '{"ts":"2026-11-20T00:00:00.000Z","purpose":"critique","tier":"fast","provider":"sambanova","model":"gpt-oss-120b","ok":true,"ms":300,"tokens":3000}',
    ];
    await fs.writeFile(file, lines.join('\n') + '\n');

    const since = new Date('2026-11-19T00:00:00.000Z');
    const until = new Date('2026-11-19T23:59:59.999Z');
    const calls = readCalls(file, since, until);

    expect(calls).toHaveLength(2);
    expect(calls[0].purpose).toBe('decompose');
    expect(calls[0].ok).toBe(false);
    expect(calls[0].error).toBe('quota exceeded');
    expect(calls[1].purpose).toBe('research');
    expect(calls[1].ok).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns empty array for missing file', async () => {
    const calls = readCalls('/nonexistent/path/model-calls.jsonl', new Date(), new Date());
    expect(calls).toEqual([]);
  });
});

describe('waste: aggregate', () => {
  it('computes per-purpose and per-provider stats with token share and top errors', () => {
    const calls = [
      { ts: '2026-11-19T10:00:00.000Z', purpose: 'research', tier: 'fast', provider: 'gemini', model: 'gemini-3.5-flash-lite', ok: true, ms: 100, tokens: 1000 },
      { ts: '2026-11-19T10:01:00.000Z', purpose: 'research', tier: 'fast', provider: 'gemini', model: 'gemini-3.5-flash-lite', ok: false, ms: 200, tokens: 500, error: 'quota exceeded: per minute limit' },
      { ts: '2026-11-19T10:02:00.000Z', purpose: 'research', tier: 'fast', provider: 'gemini', model: 'gemini-3.5-flash-lite', ok: false, ms: 150, tokens: 300, error: 'quota exceeded: per minute limit' },
      { ts: '2026-11-19T10:03:00.000Z', purpose: 'decompose', tier: 'deep', provider: 'cerebras', model: 'gpt-oss-120b', ok: true, ms: 500, tokens: 2000 },
      { ts: '2026-11-19T10:04:00.000Z', purpose: 'critique', tier: 'fast', provider: 'sambanova', model: 'gpt-oss-120b', ok: false, ms: 100, tokens: 100, error: 'model unavailable' },
    ];

    const { byPurpose, byProvider, totalTokens, totalCalls, totalFailed } = aggregate(calls);

    expect(totalCalls).toBe(5);
    expect(totalFailed).toBe(3);
    expect(totalTokens).toBe(3900);

    expect(byPurpose.research).toMatchObject({
      calls: 3,
      failed: 2,
      failedPct: 66.7,
      tokens: 1800,
      tokenShare: 46.2,
    });
    expect(byPurpose.research.topErrors).toContain('quota exceeded: per minute limit');
    expect(byPurpose.decompose).toMatchObject({ calls: 1, failed: 0, failedPct: 0, tokens: 2000, tokenShare: 51.3 });
    expect(byPurpose.critique).toMatchObject({ calls: 1, failed: 1, failedPct: 100, tokens: 100, tokenShare: 2.6 });

    expect(byProvider.gemini).toMatchObject({ calls: 3, failed: 2, failedPct: 66.7, tokens: 1800, tokenShare: 46.2 });
    expect(byProvider.cerebras).toMatchObject({ calls: 1, failed: 0, failedPct: 0, tokens: 2000, tokenShare: 51.3 });
    expect(byProvider.sambanova).toMatchObject({ calls: 1, failed: 1, failedPct: 100, tokens: 100, tokenShare: 2.6 });
  });

  it('limits top errors to 5 entries', () => {
    const calls = Array.from({ length: 10 }, (_, i) => ({
      ts: '2026-11-19T10:00:00.000Z',
      purpose: 'research',
      tier: 'fast',
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      ok: false,
      ms: 100,
      tokens: 100,
      error: `error ${i}`,
    }));
    const { byProvider } = aggregate(calls);
    expect(byProvider.gemini.topErrors).toHaveLength(5);
  });

  it('handles empty calls', () => {
    const { byPurpose, byProvider, totalTokens, totalCalls, totalFailed } = aggregate([]);
    expect(totalCalls).toBe(0);
    expect(totalFailed).toBe(0);
    expect(totalTokens).toBe(0);
    expect(byPurpose).toEqual({});
    expect(byProvider).toEqual({});
  });
});