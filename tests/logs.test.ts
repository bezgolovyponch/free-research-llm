import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventLog } from '../src/logs.mjs';

describe('EventLog', () => {
  it('appends JSONL records in order and reads back the newest ones', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-logs-'));
    const log = new EventLog({ dir });
    for (let i = 0; i < 5; i++) void log.append('project-a/b', { type: 'x', i });
    await log.queue;
    const rows = await log.read('project-a/b', 3);
    expect(rows.map((r) => r.i)).toEqual([2, 3, 4]);
    expect(rows[0].ts).toMatch(/^\d{4}-/);
    expect(await fs.readdir(dir)).toEqual(['project-a_b.jsonl']);
    expect(await log.read('missing')).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
