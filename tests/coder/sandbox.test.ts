import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodeSandbox, PromoteError, diffStats, failedGates, failureDetail, gateSummary, restoreBackup } from '../../src/coder/sandbox.mjs';

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

  it('sees edits an agent made directly in the copy, ignores run artifacts, and promotes only files that differ', async () => {
    const root = await repo();
    const dir = path.join(root, '..', `${path.basename(root)}-agent-work`);
    const sandbox = new CodeSandbox({ root, dir, listFiles: () => ['src/a.mjs', 'tests/a.test.ts'], gate: async () => ({ passed: true, output: 'quality gate: PASSED' }) });
    await sandbox.prepare();
    await fs.writeFile(path.join(dir, 'src/a.mjs'), 'export const a = 3;\n');
    await fs.writeFile(path.join(dir, 'src/new.mjs'), 'export const n = 1;\n');
    await fs.mkdir(path.join(dir, 'test-results'), { recursive: true });
    await fs.writeFile(path.join(dir, 'test-results', 'trace.json'), '{}');
    expect(await sandbox.changedAll()).toEqual(['src/a.mjs', 'src/new.mjs']);
    const backup = path.join(root, '..', `${path.basename(root)}-agent-backup`);
    await sandbox.promote(backup);
    expect(await fs.readFile(path.join(root, 'src/a.mjs'), 'utf8')).toBe('export const a = 3;\n');
    expect(await fs.readFile(path.join(root, 'src/new.mjs'), 'utf8')).toBe('export const n = 1;\n');
    expect(await fs.access(path.join(root, 'test-results')).then(() => true, () => false)).toBe(false);
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

  it('summarises what a promoted change did to each file: lines added and removed, and new files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-diff-root-'));
    const backup = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-diff-bak-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(backup, 'src'), { recursive: true });
    await fs.writeFile(path.join(backup, 'src/a.mjs'), 'one\ntwo\nthree\n');
    await fs.writeFile(path.join(root, 'src/a.mjs'), 'one\nTWO\nthree\nfour\n');
    await fs.writeFile(path.join(root, 'src/b.mjs'), 'x\ny\n');
    expect(diffStats({ root, backupDir: backup, files: ['src/a.mjs', 'src/b.mjs'] })).toEqual([
      { file: 'src/a.mjs', added: 2, removed: 1, created: false },
      { file: 'src/b.mjs', added: 2, removed: 0, created: true },
    ]);
    await Promise.all([root, backup].map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('promotes only what the agent changed, never reverts files the app changed meanwhile, and refuses protected files', async () => {
    const root = await repo();
    await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(root, 'scripts/quality.mjs'), 'gate\n');
    await fs.writeFile(path.join(root, 'src/b.mjs'), 'export const b = 1;\n');
    const dir = path.join(root, '..', `${path.basename(root)}-work`);
    const sandbox = new CodeSandbox({ root, dir, listFiles: () => ['src/a.mjs', 'src/b.mjs', 'tests/a.test.ts', 'scripts/quality.mjs'], gate: async () => ({ passed: true, output: '' }) });
    await sandbox.prepare();
    await fs.writeFile(path.join(dir, 'src/a.mjs'), 'export const a = 2;\n');
    await fs.writeFile(path.join(root, 'src/b.mjs'), 'export const b = 99;\n');
    expect(await sandbox.changedAll()).toEqual(['src/a.mjs']);
    await sandbox.promote(path.join(dir, '..', `${path.basename(root)}-bak1`));
    expect(await fs.readFile(path.join(root, 'src/b.mjs'), 'utf8')).toBe('export const b = 99;\n');
    expect(await fs.readFile(path.join(root, 'src/a.mjs'), 'utf8')).toBe('export const a = 2;\n');

    const second = new CodeSandbox({ root, dir: `${dir}2`, listFiles: () => ['src/a.mjs', 'scripts/quality.mjs'], gate: async () => ({ passed: true, output: '' }) });
    await second.prepare();
    await fs.writeFile(path.join(`${dir}2`, 'scripts/quality.mjs'), 'weakened\n');
    await expect(second.promote(path.join(root, '..', 'bak2'))).rejects.toThrow(/protected files \(scripts\/quality\.mjs\)/);
    expect(await fs.readFile(path.join(root, 'scripts/quality.mjs'), 'utf8')).toBe('gate\n');

    const third = new CodeSandbox({ root, dir: `${dir}3`, listFiles: () => ['src/a.mjs'], gate: async () => ({ passed: true, output: '' }) });
    await third.prepare();
    await fs.writeFile(path.join(`${dir}3`, 'src/a.mjs'), 'export const a = 3;\n');
    await fs.writeFile(path.join(root, 'src/a.mjs'), 'export const a = 7;\n');
    const conflict = third.promote(path.join(root, '..', 'bak3'));
    await expect(conflict).rejects.toBeInstanceOf(PromoteError);
    await expect(third.promote(path.join(root, '..', 'bak3'))).rejects.toThrow(/changed in the app while the change was being made \(src\/a\.mjs\)/);
    expect(await fs.readFile(path.join(root, 'src/a.mjs'), 'utf8')).toBe('export const a = 7;\n');
    await Promise.all([sandbox, second, third].map((x) => x.discard()));
    await fs.rm(root, { recursive: true, force: true });
  });
});
