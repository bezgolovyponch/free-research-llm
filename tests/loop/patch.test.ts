import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PatchError, PatchSet } from '../../src/loop/patch.mjs';

async function sandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-patch-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/a.mjs'), 'const hint = "search official statistics";\nconst other = "search official statistics too";\n');
  await fs.writeFile(path.join(root, 'src/secret.mjs'), 'x');
  return root;
}

describe('PatchSet', () => {
  it('applies unique edits to allowed files and reverts them', async () => {
    const root = await sandbox();
    const patch = new PatchSet({ root, allowlist: ['src/a.mjs'] });
    await patch.apply([{ file: 'src/a.mjs', find: 'const hint = "search official statistics"', replace: 'const hint = "search marketplace listings"' }]);
    expect(await fs.readFile(path.join(root, 'src/a.mjs'), 'utf8')).toMatch(/marketplace listings/);
    await patch.revert();
    expect(await fs.readFile(path.join(root, 'src/a.mjs'), 'utf8')).toMatch(/^const hint = "search official statistics";/);
  });

  it('rejects files outside the allowlist, missing, ambiguous or trivial edits', async () => {
    const root = await sandbox();
    const patch = new PatchSet({ root, allowlist: ['src/a.mjs'] });
    await expect(patch.apply([{ file: 'src/secret.mjs', find: 'xxxxxxxxxx', replace: 'y' }])).rejects.toThrow(/not allowed/);
    await expect(patch.apply([{ file: '../src/a.mjs', find: 'search official', replace: 'y' }])).rejects.toBeInstanceOf(PatchError);
    await expect(patch.apply([{ file: 'src/a.mjs', find: 'not in the file at all', replace: 'y' }])).rejects.toThrow(/not found/);
    await expect(patch.apply([{ file: 'src/a.mjs', find: 'search official statistics', replace: 'y' }])).rejects.toThrow(/not unique/);
    await expect(patch.apply([{ file: 'src/a.mjs', find: 'short', replace: 'y' }])).rejects.toThrow(/too short/);
    await expect(patch.apply([])).rejects.toThrow(/no edits/);
  });
});
