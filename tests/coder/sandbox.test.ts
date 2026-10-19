import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodeSandbox, failedGates, failureDetail, gateSummary, restoreBackup } from '../../src/coder/sandbox.mjs';

async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-sbx-root-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/a.mjs'), 'export const a = 1;\n');
  await fs.writeFile(path.join(root, 'tests/a.test.ts'), "it('a', () => {});\nit('b', () => {});\n");
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
  return root;
}

describe('CodeSandbox', () => {
  it('edits a copy, runs the gate there, and touches the real app only on promote, with a backup that undoes it', async () => {
    const root = await repo();
    const dir = path.join(root, '..', `${path.basename(root)}-work`);
    const gates: string[] = [];
    const sandbox = new CodeSandbox({ root, dir, listFiles: () => ['src/a.mjs', 'tests/a.test.ts', '.gitignore', 'gone.md'], gate: async (cwd: string) => { gates.push(cwd); return { passed: true, output: 'PASS  tests 3 passed\n\nquality gate: PASSED' }; } });
    expect(await sandbox.prepare()).toEqual(['src/a.mjs', 'tests/a.test.ts', '.gitignore']);
    expect(sandbox.testCount).toBe(2);
    await sandbox.apply([{ file: 'src/a.mjs', search: '1', replace: '2' }, { file: 'src/b.mjs', content: 'export const b = 1;\n' }, { file: 'tests/a.test.ts', search: "it('b'", replace: "it('c', () => {});\nit('b'" }]);
    expect(await fs.readFile(path.join(root, 'src/a.mjs'), 'utf8')).toBe('export const a = 1;\n');
    expect(await sandbox.gate()).toMatchObject({ passed: true, summary: 'PASS  tests 3 passed' });
    expect(gates).toEqual([dir]);
    expect(await sandbox.changed()).toEqual(['src/a.mjs', 'src/b.mjs', 'tests/a.test.ts']);
    const backup = path.join(dir, '..', `${path.basename(root)}-backup`);
    await sandbox.promote(backup);
    expect(await fs.readFile(path.join(root, 'src/a.mjs'), 'utf8')).toBe('export const a = 2;\n');
    expect(await restoreBackup(root, backup)).toEqual(['src/a.mjs', 'src/b.mjs', 'tests/a.test.ts']);
    expect(await fs.readFile(path.join(root, 'src/a.mjs'), 'utf8')).toBe('export const a = 1;\n');
    await expect(fs.access(path.join(root, 'src/b.mjs'))).rejects.toThrow();
    await sandbox.discard();
    await Promise.all([root, backup].map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('fails without running the gate when a change removes tests', async () => {
    const root = await repo();
    const dir = path.join(root, '..', `${path.basename(root)}-work`);
    let ran = false;
    const sandbox = new CodeSandbox({ root, dir, listFiles: () => ['src/a.mjs', 'tests/a.test.ts'], gate: async () => { ran = true; return { passed: true, output: '' }; } });
    await sandbox.prepare();
    await sandbox.apply([{ file: 'tests/a.test.ts', content: "it('a', () => {});\n" }]);
    expect(await sandbox.gate()).toMatchObject({ passed: false, summary: expect.stringContaining('2 → 1') });
    expect(ran).toBe(false);
    await sandbox.discard();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('adds the failing tests and their assertions to a failed gate, so the model sees what broke', async () => {
    const root = await repo();
    const dir = path.join(root, '..', `${path.basename(root)}-work`);
    const asked: string[][] = [];
    const sandbox = new CodeSandbox({ root, dir, listFiles: () => ['src/a.mjs'], gate: async () => ({ passed: false, output: 'PASS  syntax ok\nFAIL  e2e           1 failed, 11 passed\nquality gate: FAILED' }), explain: async (_cwd: string, gates: string[]) => { asked.push(gates); return '--- e2e failure detail ---\nError: expect(locator).toContainText(expected)'; } });
    await sandbox.prepare();
    const result = await sandbox.gate();
    expect(asked).toEqual([['e2e']]);
    expect(result.summary).toBe('PASS  syntax ok\nFAIL  e2e           1 failed, 11 passed');
    expect(result.output).toContain('toContainText');
    await sandbox.discard();
    await fs.rm(root, { recursive: true, force: true });
    expect(failedGates('FAIL  e2e x\nPASS  a\nFAIL  tests y')).toEqual(['e2e', 'tests']);
    expect(failureDetail('ok\n  1) [Pixel 7] › e2e/features.spec.ts:40:3 › heading\n    Error: expect(locator).toContainText(expected)\n    Expected: "9 kept"\nnoise')).toBe('  1) [Pixel 7] › e2e/features.spec.ts:40:3 › heading\n    Error: expect(locator).toContainText(expected)\n    Expected: "9 kept"');
  });

  it('keeps only the PASS/FAIL lines of the gate output', () => {
    expect(gateSummary('noise\nPASS  syntax ok\nFAIL  tests 1 failed\nquality gate: FAILED')).toBe('PASS  syntax ok\nFAIL  tests 1 failed');
  });
});
