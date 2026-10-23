import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLocalModel, forgetServe, rememberServe } from '../../src/local/autostart.mjs';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }))); });

async function root() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-autostart-'));
  dirs.push(dir);
  return dir;
}

describe('ensureLocalModel', () => {
  it('restarts the saved local model when it is not answering, and leaves a running one alone', async () => {
    const dir = await root();
    const server = path.join(dir, 'llama-server');
    await fs.writeFile(server, '');
    expect(await ensureLocalModel({ root: dir })).toMatchObject({ started: false, reason: 'no local model was set up' });
    await rememberServe(dir, { server, args: ['-hf', 'm', '--port', '8090'], port: 8090 });
    const spawned: Array<[string, string[]]> = [];
    const spawnImpl = ((cmd: string, args: string[]) => { spawned.push([cmd, args]); return { pid: 42, unref() {} }; }) as never;
    const down = (async () => { throw new Error('refused'); }) as never;
    expect(await ensureLocalModel({ root: dir, fetchImpl: down, spawnImpl })).toEqual({ started: true, pid: 42, port: 8090 });
    expect(spawned).toEqual([[server, ['-hf', 'm', '--port', '8090']]]);
    const up = (async () => new Response('{"status":"ok"}')) as never;
    expect(await ensureLocalModel({ root: dir, fetchImpl: up, spawnImpl })).toMatchObject({ started: false, reason: 'already running' });
    await forgetServe(dir);
    expect(await ensureLocalModel({ root: dir, fetchImpl: down, spawnImpl })).toMatchObject({ started: false });
    expect(spawned).toHaveLength(1);
  });

  it('says so when the saved llama-server binary is gone', async () => {
    const dir = await root();
    await rememberServe(dir, { server: path.join(dir, 'missing'), args: [], port: 8090 });
    expect(await ensureLocalModel({ root: dir, fetchImpl: (async () => { throw new Error('x'); }) as never })).toMatchObject({ started: false, reason: expect.stringMatching(/not found/) });
  });
});
