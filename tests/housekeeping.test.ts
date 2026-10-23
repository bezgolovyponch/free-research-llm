import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SWEEP_DEFAULTS, TempSweeper, describeSweep, sweepHoursFrom } from '../src/housekeeping.mjs';
import { EventLog } from '../src/logs.mjs';

const DAY_MS = 24 * 3600 * 1000;
const dirs: string[] = [];

async function dataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-sweep-'));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, 'work'), { recursive: true });
  await fs.mkdir(path.join(dir, 'logs'), { recursive: true });
  await fs.mkdir(path.join(dir, 'llama'), { recursive: true });
  return dir;
}

async function aged(file: string, ageMs: number, now: number) {
  const when = new Date(now - ageMs);
  await fs.utimes(file, when, when);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('TempSweeper', () => {
  it('removes old coder work, old .tmp files and old logs of deleted research, keeping everything recent or live', async () => {
    const dir = await dataDir();
    const now = Date.now();
    const logs = new EventLog({ dir: path.join(dir, 'logs') });
    await fs.mkdir(path.join(dir, 'work', 'C1'));
    await fs.writeFile(path.join(dir, 'work', 'C2.backup'), 'x');
    await aged(path.join(dir, 'work', 'C1'), 8 * DAY_MS, now);
    await fs.writeFile(path.join(dir, 'old.tmp'), 'x');
    await fs.writeFile(path.join(dir, 'fresh.tmp'), 'x');
    await fs.writeFile(path.join(dir, 'llama', 'model.tmp'), 'x');
    await aged(path.join(dir, 'old.tmp'), 2 * DAY_MS, now);
    await aged(path.join(dir, 'llama', 'model.tmp'), 2 * DAY_MS, now);
    for (const id of ['gone-old', 'gone-new', 'live']) await fs.writeFile(path.join(dir, 'logs', `project-${id}.jsonl`), '{}\n');
    await aged(path.join(dir, 'logs', 'project-gone-old.jsonl'), 8 * DAY_MS, now);
    await aged(path.join(dir, 'logs', 'project-live.jsonl'), 30 * DAY_MS, now);
    const sweeper = new TempSweeper({ dataDir: dir, logs, projectExists: async (id: string) => id === 'live', now: () => now });

    const report = await sweeper.sweep();

    expect(report.work).toEqual(['C1']);
    expect(report.tmp).toEqual(['old.tmp']);
    expect(report.orphanLogs).toEqual(['project-gone-old.jsonl']);
    expect((await fs.readdir(path.join(dir, 'work'))).sort()).toEqual(['C2.backup']);
    expect((await fs.readdir(path.join(dir, 'logs'))).sort()).toEqual(['project-gone-new.jsonl', 'project-live.jsonl']);
    expect(await fs.readdir(path.join(dir, 'llama'))).toEqual(['model.tmp']);
  });

  it('trims oversized logs to their newest lines', async () => {
    const dir = await dataDir();
    const logs = new EventLog({ dir: path.join(dir, 'logs') });
    for (let i = 0; i < 50; i++) void logs.append('model-calls', { i });
    await fs.writeFile(path.join(dir, 'logs', 'server.out'), Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'));
    const sweeper = new TempSweeper({ dataDir: dir, logs, projectExists: async () => true, limits: { ...SWEEP_DEFAULTS, logMaxBytes: 100, logKeepLines: 5, serverOutMaxBytes: 100, serverOutKeepLines: 3 } });

    const report = await sweeper.sweep();

    expect(report.trimmedLogs).toEqual(['model-calls.jsonl', 'server.out']);
    expect((await logs.read('model-calls')).map((r: { i: number }) => r.i)).toEqual([45, 46, 47, 48, 49]);
    expect(await fs.readFile(path.join(dir, 'logs', 'server.out'), 'utf8')).toBe('line 47\nline 48\nline 49');
    await logs.append('model-calls', { i: 50 });
    expect((await logs.read('model-calls')).at(-1)).toMatchObject({ i: 50 });
  });

  it('runs on schedule immediately and stops cleanly', async () => {
    const dir = await dataDir();
    const sweeper = new TempSweeper({ dataDir: dir, logs: new EventLog({ dir: path.join(dir, 'logs') }), projectExists: async () => true });
    const reports: unknown[] = [];
    await new Promise<void>((resolve) => sweeper.schedule(6, (r) => { reports.push(r); resolve(); }));
    expect(sweeper.timer).not.toBeNull();
    sweeper.stop();
    expect(sweeper.timer).toBeNull();
    sweeper.schedule(0, () => reports.push('never'));
    expect(sweeper.timer).toBeNull();
    expect(reports).toHaveLength(1);
  });
});

describe('sweepHoursFrom', () => {
  it('defaults to every 6 hours, honours a number and turns off with 0 or junk', () => {
    expect(sweepHoursFrom({})).toBe(6);
    expect(sweepHoursFrom({ FRL_SWEEP_HOURS: '1.5' })).toBe(1.5);
    expect(sweepHoursFrom({ FRL_SWEEP_HOURS: '0' })).toBe(0);
    expect(sweepHoursFrom({ FRL_SWEEP_HOURS: 'often' })).toBe(0);
  });
});

describe('describeSweep', () => {
  it('names what was cleared and stays silent when nothing was', () => {
    expect(describeSweep({ work: [], tmp: [], orphanLogs: [], trimmedLogs: [] })).toBe('');
    expect(describeSweep({ work: ['C1'], tmp: [], orphanLogs: ['a', 'b'], trimmedLogs: ['server.out'] })).toBe('temp sweep: 1 old coder work folders · 2 logs of deleted research · trimmed server.out');
  });
});
