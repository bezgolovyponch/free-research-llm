import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { isAllowedCommand } from '../../scripts/claims.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('claims.mjs', () => {
  it('verifies a passing claim', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-claims-'));
    try {
      const claimsFile = path.join(tmpDir, 'claims.md');
      await fs.writeFile(claimsFile, 'claim: git works | cmd: git rev-parse --is-inside-work-tree | expect: true\n');

      const result = spawnSync('node', ['scripts/claims.mjs', claimsFile], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('VERIFIED');
      expect(result.stdout).toContain('git works');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails a claim with wrong expectation', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-claims-'));
    try {
      const claimsFile = path.join(tmpDir, 'claims.md');
      await fs.writeFile(claimsFile, 'claim: git output mismatch | cmd: git rev-parse --is-inside-work-tree | expect: this string does not exist\n');

      const result = spawnSync('node', ['scripts/claims.mjs', claimsFile], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAILED');
      expect(result.stdout).toContain('git output mismatch');
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
      await fs.writeFile(claimsFile, 'claim: git version works | cmd: git --version | expect: git version\n');

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

  it('allows npx vitest run commands without running a nested suite', () => {
    expect(isAllowedCommand('npx vitest run tests/scripts/waste.test.ts')).toBe(true);
    expect(isAllowedCommand('npx vitest watch')).toBe(false);
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