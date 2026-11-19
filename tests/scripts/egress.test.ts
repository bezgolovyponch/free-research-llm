import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function repoFiles() {
  const listed = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  return listed.status === 0 ? listed.stdout.split('\n').filter(Boolean).filter((f) => fsSync.existsSync(path.join(ROOT, f))) : [];
}

describe('quality: egress gate', () => {
  it('passes for currently allowed egress files', async () => {
    const { egress } = await import('../../scripts/quality.mjs');
    const files = repoFiles();
    const result = egress(files);
    expect(result.passed).toBe(true);
  });

  it('fails when a new file makes outbound calls without being in egress-allowed.json', async () => {
    const { egress } = await import('../../scripts/quality.mjs');
    const testFile = path.join(ROOT, 'src', 'research', 'new-fetch.mjs');
    await fs.writeFile(testFile, 'export async function foo() { return fetch("https://example.com"); }');
    try {
      const files = ['src/research/new-fetch.mjs'];
      const result = egress(files);
      expect(result.passed).toBe(false);
      expect(result.detail).toContain('src/research/new-fetch.mjs: makes outbound network calls but not in egress-allowed.json');
    } finally {
      await fs.rm(testFile, { force: true });
    }
  });

  it('fails when egress-allowed.json lists a file that does not exist', async () => {
    const { egress } = await import('../../scripts/quality.mjs');
    const allowedPath = path.join(ROOT, 'tests', 'fixtures', 'security', 'egress-allowed.json');
    const original = await fs.readFile(allowedPath, 'utf8');
    const allowed = JSON.parse(original);
    allowed['src/research/nonexistent.mjs'] = 'test reason';
    await fs.writeFile(allowedPath, JSON.stringify(allowed, null, 2));
    try {
      const files = repoFiles();
      const result = egress(files);
      expect(result.passed).toBe(false);
      expect(result.detail).toContain('egress-allowed.json: src/research/nonexistent.mjs listed but not found in source modules');
    } finally {
      await fs.writeFile(allowedPath, original);
    }
  });

  it('fails for fetchImpl default = fetch not in egress-allowed.json', async () => {
    const { egress } = await import('../../scripts/quality.mjs');
    const testFile = path.join(ROOT, 'src', 'research', 'fetchimpl-default.mjs');
    await fs.writeFile(testFile, 'export class X { constructor({ fetchImpl = fetch } = {}) { this.fetchImpl = fetchImpl; } }');
    try {
      const files = ['src/research/fetchimpl-default.mjs'];
      const result = egress(files);
      expect(result.passed).toBe(false);
      expect(result.detail).toContain('src/research/fetchimpl-default.mjs: makes outbound network calls but not in egress-allowed.json');
    } finally {
      await fs.rm(testFile, { force: true });
    }
  });

  it('fails for import of node:https not in egress-allowed.json', async () => {
    const { egress } = await import('../../scripts/quality.mjs');
    const testFile = path.join(ROOT, 'src', 'research', 'import-https.mjs');
    await fs.writeFile(testFile, "import https from 'node:https'; export async function foo() { return new Promise((resolve) => https.get('https://example.com', resolve)); }");
    try {
      const files = ['src/research/import-https.mjs'];
      const result = egress(files);
      expect(result.passed).toBe(false);
      expect(result.detail).toContain('src/research/import-https.mjs: makes outbound network calls but not in egress-allowed.json');
    } finally {
      await fs.rm(testFile, { force: true });
    }
  });

  it('fails for passed-in globalThis.fetch not in egress-allowed.json', async () => {
    const { egress } = await import('../../scripts/quality.mjs');
    const testFile = path.join(ROOT, 'src', 'research', 'globalthis-fetch.mjs');
    await fs.writeFile(testFile, 'export async function foo() { return globalThis.fetch("https://example.com"); }');
    try {
      const files = ['src/research/globalthis-fetch.mjs'];
      const result = egress(files);
      expect(result.passed).toBe(false);
      expect(result.detail).toContain('src/research/globalthis-fetch.mjs: makes outbound network calls but not in egress-allowed.json');
    } finally {
      await fs.rm(testFile, { force: true });
    }
  });
});
