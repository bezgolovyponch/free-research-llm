import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectStore } from '../src/store.mjs';

describe('ProjectStore', () => {
  it('saves atomically, lists newest first, removes, and rejects path tricks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-store-'));
    const store = new ProjectStore({ dir });
    const a = store.newId('Cars in Germany?');
    expect(a).toMatch(/^cars-in-germany-[0-9a-f]{6}$/);
    await store.save({ id: a, question: 'A', phase: 'done' });
    await new Promise((r) => setTimeout(r, 5));
    await store.save({ id: 'second-project', question: 'B', phase: 'created' });
    expect((await new ProjectStore({ dir }).list()).map((p) => p.question)).toEqual(['B', 'A']);
    await store.remove(a);
    expect(await store.get(a)).toBeNull();
    await expect(store.get('../etc/passwd')).rejects.toThrow(/invalid project id/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('ProjectStore.list', () => {
  it('ignores JSON files in the folder that are not projects', async () => {
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { ProjectStore } = await import('../src/store.mjs');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frl-store-list-'));
    await fsp.writeFile(path.join(dir, 'app-chat.json'), JSON.stringify([{ role: 'user', content: 'hi' }]));
    const store = new ProjectStore({ dir });
    await store.save({ id: 'real-question-abc123', question: 'real question?', nodes: [] });
    expect((await store.list()).map((p: { id: string }) => p.id)).toEqual(['real-question-abc123']);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

