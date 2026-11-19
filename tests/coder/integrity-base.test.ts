import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffAgainstBaseDir, checkTestIntegrity } from '../../scripts/quality.mjs';

describe('FRL_INTEGRITY_BASE: diffAgainstBaseDir', () => {
  it('generates diff for changed test expect line', async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-base-'));
    const tmpCurrent = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-current-'));

    try {
      const testDir = path.join(tmpBase, 'tests', 'research');
      await fs.mkdir(testDir, { recursive: true });
      const testFile = path.join(testDir, 'example.test.ts');
      await fs.writeFile(testFile, "import { describe, expect, it } from 'vitest';\n\ndescribe('example', () => {\n  it('passes', () => { expect(1 + 1).toBe(2); });\n});\n");

      const currentTestDir = path.join(tmpCurrent, 'tests', 'research');
      await fs.mkdir(currentTestDir, { recursive: true });
      const currentTestFile = path.join(currentTestDir, 'example.test.ts');
      await fs.writeFile(currentTestFile, "import { describe, expect, it } from 'vitest';\n\ndescribe('example', () => {\n  it('passes', () => { expect(1 + 1).toBe(3); });\n});\n");

      const scriptsBase = path.join(tmpBase, 'scripts');
      await fs.mkdir(scriptsBase, { recursive: true });
      await fs.writeFile(path.join(scriptsBase, 'quality.mjs'), "console.log('base');\n");
      const scriptsCurrent = path.join(tmpCurrent, 'scripts');
      await fs.mkdir(scriptsCurrent, { recursive: true });
      await fs.writeFile(path.join(scriptsCurrent, 'quality.mjs'), "console.log('current');\n");

      const diff = diffAgainstBaseDir(tmpBase, tmpCurrent);
      expect(diff).toContain('tests/research/example.test.ts');
      expect(diff).toContain('expect(1 + 1).toBe(3)');
      expect(diff).toContain("-  it('passes', () => { expect(1 + 1).toBe(2); });");
      expect(diff).toContain("+  it('passes', () => { expect(1 + 1).toBe(3); });");

      const result = checkTestIntegrity(diff, []);
      expect(result.passed).toBe(false);
      expect(result.detail).toContain('Changed line in tests/research/example.test.ts');
      expect(result.detail).toContain('expect(1 + 1).toBe(3)');
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true });
      await fs.rm(tmpCurrent, { recursive: true, force: true });
    }
  });

  it('passes when test-change commit message allows the change', async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-base-'));
    const tmpCurrent = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-current-'));

    try {
      const testDir = path.join(tmpBase, 'tests', 'research');
      await fs.mkdir(testDir, { recursive: true });
      const testFile = path.join(testDir, 'example.test.ts');
      await fs.writeFile(testFile, "import { describe, expect, it } from 'vitest';\n\ndescribe('example', () => {\n  it('passes', () => { expect(1 + 1).toBe(2); });\n});\n");

      const currentTestDir = path.join(tmpCurrent, 'tests', 'research');
      await fs.mkdir(currentTestDir, { recursive: true });
      const currentTestFile = path.join(currentTestDir, 'example.test.ts');
      await fs.writeFile(currentTestFile, "import { describe, expect, it } from 'vitest';\n\ndescribe('example', () => {\n  it('passes', () => { expect(1 + 1).toBe(3); });\n});\n");

      const diff = diffAgainstBaseDir(tmpBase, tmpCurrent);
      const commitMessages = ['test-change: tests/research/example.test.ts — updated expectation'];
      const result = checkTestIntegrity(diff, commitMessages);
      expect(result.passed).toBe(true);
      expect(result.detail).toContain('allowed by test-change');
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true });
      await fs.rm(tmpCurrent, { recursive: true, force: true });
    }
  });
});