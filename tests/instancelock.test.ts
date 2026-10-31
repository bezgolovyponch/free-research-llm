import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InstanceLock } from '../src/instancelock.mjs';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-lock-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('InstanceLock', () => {
  it('refuses a second server on the same data folder while the first one is alive', async () => {
    const file = path.join(dir, 'server.lock');
    const alive = new Set([100]);
    const first = new InstanceLock({ file, pid: 100, isAlive: (pid: number) => alive.has(pid) });
    const second = new InstanceLock({ file, pid: 200, isAlive: (pid: number) => alive.has(pid) });
    expect(await first.acquire({ host: '0.0.0.0' })).toEqual({ acquired: true });
    const refused = await second.acquire();
    expect(refused.acquired).toBe(false);
    expect(refused.holder).toMatchObject({ pid: 100, host: '0.0.0.0' });
  });

  it('takes over a lock left by a server that is no longer running', async () => {
    const file = path.join(dir, 'server.lock');
    await new InstanceLock({ file, pid: 100, isAlive: () => false }).acquire();
    const next = new InstanceLock({ file, pid: 200, isAlive: () => false });
    expect(await next.acquire()).toEqual({ acquired: true });
    expect(JSON.parse(await fs.readFile(file, 'utf8')).pid).toBe(200);
  });

  it('releases only its own lock', async () => {
    const file = path.join(dir, 'server.lock');
    const first = new InstanceLock({ file, pid: 100, isAlive: () => true });
    await first.acquire();
    await new InstanceLock({ file, pid: 200, isAlive: () => true }).release();
    expect(JSON.parse(await fs.readFile(file, 'utf8')).pid).toBe(100);
    await first.release();
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('treats a missing or broken lock file as free', async () => {
    const file = path.join(dir, 'server.lock');
    await fs.writeFile(file, 'not json');
    expect(await new InstanceLock({ file, pid: 1 }).acquire()).toEqual({ acquired: true });
  });
});
