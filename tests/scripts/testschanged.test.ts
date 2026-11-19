import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { checkTestsChanged } from '../../scripts/quality.mjs';
import fs from 'node:fs';
import path from 'node:path';

describe('testsChanged gate', () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  const ROOT = process.cwd();

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    process.chdir(originalCwd);
  });

  it('passes when changed source file has corresponding test change', () => {
    const changed = ['src/research/engine.mjs', 'tests/research/engine.test.ts'];
    const result = checkTestsChanged(changed, [], ROOT);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('every changed source file has a corresponding test change');
  });

  it('fails when changed source file has no test change', () => {
    const changed = ['src/research/engine.mjs'];
    const result = checkTestsChanged(changed, [], ROOT);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('changed source file without test change: src/research/engine.mjs → tests/research/engine.test.ts');
  });

  it('passes when source file is in UNTESTED_ENTRYPOINTS', () => {
    const changed = ['src/frl.mjs'];
    const result = checkTestsChanged(changed, [], ROOT);
    expect(result.passed).toBe(true);
  });

  it('passes when no-test declaration in commit message matches source file', () => {
    const changed = ['src/research/engine.mjs'];
    const commitMessages = ['no-test: src/research/engine.mjs — pure refactor, no behavior change'];
    const result = checkTestsChanged(changed, commitMessages, ROOT);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('every changed source file has a corresponding test change');
  });

  it('fails when no-test declaration does not match the changed source file', () => {
    const changed = ['src/research/engine.mjs'];
    const commitMessages = ['no-test: src/research/other.mjs — unrelated'];
    const result = checkTestsChanged(changed, commitMessages, ROOT);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('src/research/engine.mjs → tests/research/engine.test.ts');
  });

  it('passes for verifier source file with test change', () => {
    const changed = ['verifier/check.mjs', 'tests/verifier/check.test.ts'];
    const result = checkTestsChanged(changed, [], ROOT);
    expect(result.passed).toBe(true);
  });

  it('fails for verifier source file without test change when test file exists', () => {
    const testFile = path.join(ROOT, 'tests/verifier/check.test.ts');
    const existed = fs.existsSync(testFile);
    if (!existed) fs.writeFileSync(testFile, '');
    try {
      const changed = ['verifier/check.mjs'];
      const result = checkTestsChanged(changed, [], ROOT);
      expect(result.passed).toBe(false);
      expect(result.detail).toContain('verifier/check.mjs → tests/verifier/check.test.ts');
    } finally {
      if (!existed) fs.unlinkSync(testFile);
    }
  });

  it('passes when test file does not exist yet', () => {
    const changed = ['src/research/nonexistent.mjs'];
    const result = checkTestsChanged(changed, [], ROOT);
    expect(result.passed).toBe(true);
  });

  it('handles multiple changed source files', () => {
    const changed = [
      'src/research/engine.mjs',
      'tests/research/engine.test.ts',
      'src/research/chat.mjs'
    ];
    const result = checkTestsChanged(changed, [], ROOT);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('src/research/chat.mjs → tests/research/chat.test.ts');
    expect(result.detail).not.toContain('src/research/engine.mjs');
  });

  it('passes when no-test uses em dash', () => {
    const changed = ['src/research/engine.mjs'];
    const commitMessages = ['no-test: src/research/engine.mjs — pure refactor'];
    const result = checkTestsChanged(changed, commitMessages, ROOT);
    expect(result.passed).toBe(true);
  });

  it('passes when no-test uses hyphen', () => {
    const changed = ['src/research/engine.mjs'];
    const commitMessages = ['no-test: src/research/engine.mjs - pure refactor'];
    const result = checkTestsChanged(changed, commitMessages, ROOT);
    expect(result.passed).toBe(true);
  });
});
