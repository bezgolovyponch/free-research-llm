import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('claims.mjs', () => {
  it('verifies a passing claim', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-claims-'));
    try {
      const claimsFile = path.join(tmpDir, 'claims.md');
      await fs.writeFile(claimsFile, 'claim: git status works | cmd: git status | expect: On branch\n');

      const result = spawnSync('node', ['scripts/claims.mjs', claimsFile], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('VERIFIED');
      expect(result.stdout).toContain('git status works');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails a claim with wrong expectation', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-claims-'));
    try {
      const claimsFile = path.join(tmpDir, 'claims.md');
      await fs.writeFile(claimsFile, 'claim: git status fails | cmd: git status | expect: this string does not exist\n');

      const result = spawnSync('node', ['scripts/claims.mjs', claimsFile], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAILED');
      expect(result.stdout).toContain('git status fails');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects disallowed commands', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-claims-'));
    try {
      const claimsFile = path.join(tmpDir, 'claims.md');
      await fs.writeFile(claimsFile, 'claim: disallowed command | cmd: rm -rf / | expect: something\n');

      const result = spawnSync('node', ['scripts/claims.mjs', claimsFile], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAILED');
      expect(result.stdout).toContain('Command not in allowed list');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('allows git commands', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-claims-'));
    try {
      const claimsFile = path.join(tmpDir, 'claims.md');
      await fs.writeFile(claimsFile, 'claim: git log works | cmd: git log --oneline -1 | expect: fix\n');

      const result = spawnSync('node', ['scripts/claims.mjs', claimsFile], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('VERIFIED');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('allows grep commands', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-claims-'));
    try {
      const claimsFile = path.join(tmpDir, 'claims.md');
      await fs.writeFile(claimsFile, 'claim: grep finds test | cmd: grep -r testIntegrity tests/scripts/ | expect: testIntegrity\n');

      const result = spawnSync('node', ['scripts/claims.mjs', claimsFile], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('VERIFIED');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('allows npx vitest run commands', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-claims-'));
    try {
      const claimsFile = path.join(tmpDir, 'claims.md');
      await fs.writeFile(claimsFile, 'claim: vitest runs testIntegrity | cmd: npx vitest run tests/scripts/testintegrity.test.ts | expect: Test Files  1 passed\n');

      const result = spawnSync('node', ['scripts/claims.mjs', claimsFile], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('VERIFIED');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('allows node scripts/ commands', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-claims-'));
    try {
      const claimsFile = path.join(tmpDir, 'claims.md');
      await fs.writeFile(claimsFile, 'claim: node scripts runs | cmd: node scripts/waste.mjs | expect: No calls found\n');

      const result = spawnSync('node', ['scripts/claims.mjs', claimsFile], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('VERIFIED');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});