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


describe('ProjectStore memory bound', () => {
  it('keeps only the most recently used researches in memory, never drops a busy one, and lists without loading everything', async () => {
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { ProjectStore } = await import('../src/store.mjs');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frl-store-lru-'));
    const busy = new Set(['busy-research-000001']);
    const store = new ProjectStore({ dir, maxCached: 2, isBusy: (id: string) => busy.has(id) });
    for (const id of ['busy-research-000001', 'second-research-02', 'third-research-003', 'fourth-research-04']) await store.save({ id, question: `${id}?`, nodes: [] });
    expect([...store.cache.keys()].sort()).toEqual(['busy-research-000001', 'fourth-research-04']);
    const third = await store.get('third-research-003');
    expect(third.question).toBe('third-research-003?');
    expect(store.cache.has('fourth-research-04')).toBe(false);
    expect(store.cache.has('busy-research-000001')).toBe(true);
    expect((await store.list()).map((p: { id: string }) => p.id).sort()).toEqual(['busy-research-000001', 'fourth-research-04', 'second-research-02', 'third-research-003']);
    expect(store.cache.size).toBe(2);
    expect(await store.get('second-research-02')).toMatchObject({ question: 'second-research-02?' });
    await fsp.rm(dir, { recursive: true, force: true });
  });
});
