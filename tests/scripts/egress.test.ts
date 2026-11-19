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

async function setupEgressTest() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'egress-test-'));
  const fixturesDir = path.join(tmp, 'tests', 'fixtures', 'security');
  await fs.mkdir(fixturesDir, { recursive: true });
  const srcDir = path.join(tmp, 'src', 'research');
  await fs.mkdir(srcDir, { recursive: true });
  const scriptsDir = path.join(tmp, 'scripts');
  await fs.mkdir(scriptsDir, { recursive: true });
  const verifierDir = path.join(tmp, 'verifier');
  await fs.mkdir(verifierDir, { recursive: true });
  const localDir = path.join(tmp, 'src', 'local');
  await fs.mkdir(localDir, { recursive: true });
  const llmDir = path.join(tmp, 'src', 'llm');
  await fs.mkdir(llmDir, { recursive: true });
  const searchDir = path.join(tmp, 'src', 'search');
  await fs.mkdir(searchDir, { recursive: true });
  const terminalDir = path.join(tmp, 'src', 'terminal');
  await fs.mkdir(terminalDir, { recursive: true });
  const constructDir = path.join(tmp, 'scripts', 'construct');
  await fs.mkdir(constructDir, { recursive: true });

  const allowedPath = path.join(ROOT, 'tests', 'fixtures', 'security', 'egress-allowed.json');
  const allowed = JSON.parse(await fs.readFile(allowedPath, 'utf8'));
  await fs.writeFile(path.join(fixturesDir, 'egress-allowed.json'), JSON.stringify(allowed, null, 2));

  for (const file of Object.keys(allowed)) {
    const filePath = path.join(tmp, file);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '// stub');
  }

  return tmp;
}

describe('quality: egress gate', () => {
  it('passes for currently allowed egress files', async () => {
    const { egress } = await import('../../scripts/quality.mjs');
    const tmp = await setupEgressTest();
    const files = Object.keys(JSON.parse(await fs.readFile(path.join(tmp, 'tests', 'fixtures', 'security', 'egress-allowed.json'), 'utf8')));
    const result = egress(files, tmp);
    expect(result.passed).toBe(true);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('fails when a new file makes outbound calls without being in egress-allowed.json', async () => {
    const { egress } = await import('../../scripts/quality.mjs');
    const tmp = await setupEgressTest();
    const testFile = path.join(tmp, 'src', 'research', 'new-fetch.mjs');
    await fs.writeFile(testFile, 'export async function foo() { return fetch("https://example.com"); }');
    const files = ['src/research/new-fetch.mjs'];
    const result = egress(files, tmp);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('src/research/new-fetch.mjs: makes outbound network calls but not in egress-allowed.json');
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('fails when egress-allowed.json lists a file that does not exist', async () => {
    const { egress } = await import('../../scripts/quality.mjs');
    const tmp = await setupEgressTest();
    const allowedPath = path.join(tmp, 'tests', 'fixtures', 'security', 'egress-allowed.json');
    const allowed = JSON.parse(await fs.readFile(allowedPath, 'utf8'));
    allowed['src/research/nonexistent.mjs'] = 'test reason';
    await fs.writeFile(allowedPath, JSON.stringify(allowed, null, 2));
    const files = Object.keys(allowed).filter(f => fsSync.existsSync(path.join(tmp, f)));
    const result = egress(files, tmp);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('egress-allowed.json: src/research/nonexistent.mjs listed but not found in source modules');
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('fails for fetchImpl default = fetch not in egress-allowed.json', async () => {
    const { egress } = await import('../../scripts/quality.mjs');
    const tmp = await setupEgressTest();
    const testFile = path.join(tmp, 'src', 'research', 'fetchimpl-default.mjs');
    await fs.writeFile(testFile, 'export class X { constructor({ fetchImpl = fetch } = {}) { this.fetchImpl = fetchImpl; } }');
    const files = ['src/research/fetchimpl-default.mjs'];
    const result = egress(files, tmp);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('src/research/fetchimpl-default.mjs: makes outbound network calls but not in egress-allowed.json');
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('fails for import of node:https not in egress-allowed.json', async () => {
    const { egress } = await import('../../scripts/quality.mjs');
    const tmp = await setupEgressTest();
    const testFile = path.join(tmp, 'src', 'research', 'import-https.mjs');
    await fs.writeFile(testFile, "import https from 'node:https'; export async function foo() { return new Promise((resolve) => https.get('https://example.com', resolve)); }");
    const files = ['src/research/import-https.mjs'];
    const result = egress(files, tmp);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('src/research/import-https.mjs: makes outbound network calls but not in egress-allowed.json');
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('fails for passed-in globalThis.fetch not in egress-allowed.json', async () => {
    const { egress } = await import('../../scripts/quality.mjs');
    const tmp = await setupEgressTest();
    const testFile = path.join(tmp, 'src', 'research', 'globalthis-fetch.mjs');
    await fs.writeFile(testFile, 'export async function foo() { return globalThis.fetch("https://example.com"); }');
    const files = ['src/research/globalthis-fetch.mjs'];
    const result = egress(files, tmp);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('src/research/globalthis-fetch.mjs: makes outbound network calls but not in egress-allowed.json');
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
