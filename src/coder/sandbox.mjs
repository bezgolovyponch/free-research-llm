import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyEdit, countTests } from './edits.mjs';

const GATE_TIMEOUT_MS = 20 * 60 * 1000;

function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

async function readOrNull(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

export function gateSummary(output) {
  return String(output ?? '').split('\n').filter((l) => /^(PASS|FAIL) /.test(l)).join('\n');
}

function npmGate(cwd) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const child = spawn(win ? 'npm.cmd' : 'npm', ['run', '--silent', 'quality'], { cwd, shell: win, env: { ...process.env, FRL_KEYCHAIN: '0' } });
    let output = '';
    const timer = setTimeout(() => child.kill(), GATE_TIMEOUT_MS);
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ passed: code === 0 && /quality gate: PASSED/.test(output), output });
    });
  });
}

const DETAIL_COMMANDS = { e2e: ['npx', ['playwright', 'test', '--reporter=line']], tests: ['npx', ['vitest', 'run']] };
const DETAIL_CHARS = 5000;

export function failedGates(output) {
  return [...String(output ?? '').matchAll(/^FAIL\s+(\w+)/gm)].map((m) => m[1]);
}

export function failureDetail(text) {
  const lines = String(text ?? '').split('\n');
  const keep = lines.filter((l) => /✘|×|FAIL|Error|expect|Expected|Received|toHave|toContain|toBe|locator|Timeout|at .*\.(spec|test)\.ts:\d+|›/.test(l));
  return keep.join('\n').slice(-DETAIL_CHARS);
}

function explainFailures(cwd, gates) {
  const parts = [];
  for (const gate of gates) {
    const command = DETAIL_COMMANDS[gate];
    if (!command) continue;
    const win = process.platform === 'win32';
    const r = spawnSync(win ? `${command[0]}.cmd` : command[0], command[1], { cwd, encoding: 'utf8', shell: win, timeout: GATE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    parts.push(`--- ${gate} failure detail ---\n${failureDetail(`${r.stdout ?? ''}${r.stderr ?? ''}`)}`);
  }
  return parts.join('\n');
}

export class CodeSandbox {
  constructor({ root, dir, gate = npmGate, listFiles = null, explain = explainFailures }) {
    this.root = root;
    this.dir = dir;
    this.gateRunner = gate;
    this.explain = explain;
    this.listFiles = listFiles ?? (() => {
      const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
    });
    this.touched = new Set();
  }

  async prepare() {
    await fs.rm(this.dir, { recursive: true, force: true });
    await fs.mkdir(this.dir, { recursive: true });
    this.files = [];
    for (const rel of this.listFiles()) {
      const from = path.join(this.root, rel);
      if (!(await exists(from))) continue;
      await fs.mkdir(path.dirname(path.join(this.dir, rel)), { recursive: true });
      await fs.copyFile(from, path.join(this.dir, rel));
      this.files.push(rel);
    }
    const modules = path.join(this.root, 'node_modules');
    if (await exists(modules)) await fs.symlink(modules, path.join(this.dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    spawnSync('git', ['init', '-q'], { cwd: this.dir });
    await fs.copyFile(path.join(this.root, '.gitignore'), path.join(this.dir, '.gitignore')).catch(() => {});
    this.testCount = await this.countAllTests();
    return this.files;
  }

  read(rel) {
    return readOrNull(path.join(this.dir, rel));
  }

  async apply(edits) {
    const staged = new Map();
    for (const edit of edits) {
      const current = staged.has(edit.file) ? staged.get(edit.file) : await this.read(edit.file);
      staged.set(edit.file, applyEdit(current, edit));
    }
    for (const [rel, body] of staged) {
      await fs.mkdir(path.dirname(path.join(this.dir, rel)), { recursive: true });
      await fs.writeFile(path.join(this.dir, rel), body);
      this.touched.add(rel);
      if (!this.files.includes(rel)) this.files.push(rel);
    }
    return [...staged.keys()];
  }

  async countAllTests() {
    let n = 0;
    for (const rel of this.files) if (/^(tests|e2e)\/.*\.(test|spec)\.ts$/.test(rel)) n += countTests(await this.read(rel));
    return n;
  }

  async gate() {
    spawnSync('git', ['add', '-A'], { cwd: this.dir });
    const tests = await this.countAllTests();
    if (tests < this.testCount) return { passed: false, output: `FAIL  testCount    the change removes tests (${this.testCount} before, ${tests} after); tests may be added, never removed`, summary: `FAIL  testCount    ${this.testCount} → ${tests}` };
    const result = await this.gateRunner(this.dir);
    const detail = result.passed ? '' : await this.explain(this.dir, failedGates(result.output));
    return { ...result, output: detail ? `${result.output}\n${detail}` : result.output, summary: gateSummary(result.output) };
  }

  async changed() {
    const out = [];
    for (const rel of this.touched) if ((await this.read(rel)) !== (await readOrNull(path.join(this.root, rel)))) out.push(rel);
    return out.sort();
  }

  async walk(base = this.dir, prefix = '') {
    const out = [];
    let entries = [];
    try {
      entries = await fs.readdir(base, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (['node_modules', '.git', 'data', 'test-results', 'playwright-report', '.cache', 'coverage'].includes(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...(await this.walk(path.join(base, entry.name), rel)));
      else if (entry.isFile()) out.push(rel);
    }
    return out;
  }

  async changedAll() {
    const out = [];
    for (const rel of await this.walk()) if ((await this.read(rel)) !== (await readOrNull(path.join(this.root, rel)))) out.push(rel);
    return out.sort();
  }

  async promote(backupDir) {
    const files = await this.changedAll();
    const manifest = [];
    for (const rel of files) {
      const original = await readOrNull(path.join(this.root, rel));
      if (original != null) {
        await fs.mkdir(path.dirname(path.join(backupDir, rel)), { recursive: true });
        await fs.writeFile(path.join(backupDir, rel), original);
      }
      manifest.push({ file: rel, existed: original != null });
    }
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
    for (const rel of files) {
      await fs.mkdir(path.dirname(path.join(this.root, rel)), { recursive: true });
      await fs.copyFile(path.join(this.dir, rel), path.join(this.root, rel));
    }
    return files;
  }

  async discard() {
    await fs.rm(this.dir, { recursive: true, force: true });
  }
}

export async function restoreBackup(root, backupDir) {
  const manifest = JSON.parse(await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  for (const { file, existed } of manifest) {
    if (existed) await fs.copyFile(path.join(backupDir, file), path.join(root, file));
    else await fs.rm(path.join(root, file), { force: true });
  }
  return manifest.map((m) => m.file);
}
