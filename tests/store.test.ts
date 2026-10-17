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
