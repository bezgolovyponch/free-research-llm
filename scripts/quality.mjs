#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { SECRET_PATTERNS } from '../src/secrets.mjs';
import { acquireQualityLock, releaseQualityLock, LOCK_WAIT_MS } from './quality-lock.mjs';
import { binEntry, startedDirectly } from './tool-entry.mjs';
import { computeWasteStats } from './waste.mjs';
import { recordSnapshot, checkSnapshot } from './zero-loss.mjs';

import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNTESTED_ENTRYPOINTS = new Set(['src/frl.mjs', 'src/cli.mjs', 'src/llm/presets.mjs', 'src/research/prompts.mjs', 'src/llm/scripted-provider.mjs']);

const EGRESS_PATTERNS = [
  /\bfetch\s*\(/,
  /\bfetchImpl\s*=\s*fetch\b/,
  /\bglobalThis\.fetch\b/,
  /\bhttp\.request\s*\(/,
  /\bhttps\.request\s*\(/,
  /\bnet\.connect\s*\(/,
  /\bnew\s+WebSocket\s*\(/,
  /\bchild_process\b.*\b(spawn|exec|execFile|spawnSync)\b.*\b(curl|wget)\b/,
  /import\s+.*\s+from\s+['"]node:http['"]/,
  /import\s+.*\s+from\s+['"]node:https['"]/,
  /import\s+.*\s+from\s+['"]node:net['"]/,
  /import\s+.*\s+from\s+['"]node:tls['"]/,
  /import\s+.*\s+from\s+['"]node:dgram['"]/,
  /import\s+.*\s+from\s+['"]http2['"]/,
  /import\s+.*\s+from\s+['"]undici['"]/,
  /import\s+.*\s+from\s+['"]ws['"]/,
];

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

export function checkWaste(dataDir) {
  const logPath = path.join(dataDir, 'logs', 'model-calls.jsonl');
  if (!fs.existsSync(logPath)) {
    return { passed: true, detail: 'model-calls.jsonl not found (CI), waste check skipped' };
  }
  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const { total, failed, failPct } = computeWasteStats(logPath, since);
  if (total === 0) return { passed: true, detail: 'no model calls in last 24h' };
  const warn = failPct > 15;
  return {
    passed: true,
    detail: `last 24h: ${total} calls, ${failed} failed (${failPct}%)${warn ? ' ⚠ WARN: exceeds 15%' : ' OK'}`,
  };
}

const FLAKE_ROUNDS = 3;

function failingLines(output, pattern) {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  return [...new Set(plain.split('\n').filter((l) => pattern.test(l)).map((l) => l.trim().slice(0, 220)))].slice(0, 8);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ...result, stdout: result.stdout ?? '', stderr: `${result.stderr ?? ''}${result.error ? `${command} did not start: ${result.error.message}` : ''}` };
}

function runTool(pkg, name, args) {
  return run(process.execPath, [binEntry(pkg, name, ROOT), ...args]);
}

function repoFiles() {
  const listed = run('git', ['ls-files', '-co', '--exclude-standard']);
  return listed.status === 0 ? listed.stdout.split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f))) : [];
}

function sourceModules(files) {
  return files.filter((f) => /^(src|scripts|verifier)\/.*\.mjs$/.test(f));
}

function mergeBase() {
  const head = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  for (const ref of ['origin/main', 'main']) {
    const base = run('git', ['merge-base', 'HEAD', ref]).stdout.trim();
    if (base && base !== head) return base;
  }
  return process.env.CI ? run('git', ['rev-parse', 'HEAD~1']).stdout.trim() : '';
}

function checkTestIntegrity(diff, commitMessages) {
  function isProtected(path) {
    if (path === 'scripts/quality.mjs' || path === 'scripts/zero-loss.mjs') return true;
    if (path.startsWith('scripts/reference')) return true;
    if (path.startsWith('tests/')) {
      if (path.endsWith('.test.ts')) return true;
      if (path.startsWith('tests/fixtures/reference/')) return true;
      if (path.startsWith('tests/fixtures/methods/')) return true;
    }
    return false;
  }

  function testChangeAllows(path, messages) {
    for (const msg of messages) {
      const match = msg.match(/^test-change:\s*(\S+)\s+[—-]\s+(.+)$/);
      if (match) {
        const allowedPath = match[1].trim();
        if (allowedPath === path) return true;
        if (allowedPath.endsWith('/') && path.startsWith(allowedPath)) return true;
      }
    }
    return false;
  }

  const lines = diff.split('\n');
  let currentFile = null;
  const violations = [];
  const allowedViolations = [];
  let pendingRemovals = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    if (fileMatch) {
      currentFile = fileMatch[2];
      pendingRemovals = [];
      continue;
    }
    if (!currentFile || !isProtected(currentFile)) continue;

    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@')) continue;

    if (line.startsWith('-')) {
      const content = line.slice(1);
      pendingRemovals.push(content);
    } else if (line.startsWith('+')) {
      const addedContent = line.slice(1);
      if (pendingRemovals.length > 0) {
        const removedContent = pendingRemovals.shift();
        if (!testChangeAllows(currentFile, commitMessages)) {
          violations.push(`Changed line in ${currentFile}: ${addedContent}`);
        } else {
          allowedViolations.push(`Changed line in ${currentFile} (allowed by test-change): ${addedContent}`);
        }
      } else {
      }
    } else {
      for (const removed of pendingRemovals) {
        if (!testChangeAllows(currentFile, commitMessages)) {
          violations.push(`Removed line in ${currentFile}: ${removed}`);
        } else {
          allowedViolations.push(`Removed line in ${currentFile} (allowed by test-change): ${removed}`);
        }
      }
      pendingRemovals = [];
    }
  }

  for (const removed of pendingRemovals) {
    if (!testChangeAllows(currentFile, commitMessages)) {
      violations.push(`Removed line in ${currentFile}: ${removed}`);
    } else {
      allowedViolations.push(`Removed line in ${currentFile} (allowed by test-change): ${removed}`);
    }
  }

  if (violations.length > 0) {
    return { passed: false, detail: violations.join('\n') };
  }
  if (allowedViolations.length > 0) {
    return { passed: true, detail: allowedViolations.join('\n') };
  }
  return { passed: true, detail: 'no removed or changed lines in protected paths' };
}

function protectedPaths() {
  return [
    'tests/**/*.test.ts',
    'tests/fixtures/reference/**',
    'tests/fixtures/methods/**',
    'scripts/quality.mjs',
    'scripts/zero-loss.mjs',
    'scripts/reference*.mjs',
  ];
}

function diffAgainstBaseDir(baseDir, currentDir = ROOT) {
  const protectedPathsList = protectedPaths();
  let diff = '';
  for (const pattern of protectedPathsList) {
    const glob = pattern.replace(/\*\*/g, '*');
    const files = run('find', [currentDir, '-path', `*/${glob}`, '-type', 'f']).stdout.trim().split('\n').filter(Boolean);
    for (const file of files) {
      const relPath = path.relative(currentDir, file);
      const baseFile = path.join(baseDir, relPath);
      if (!fs.existsSync(baseFile)) continue;
      const currentContent = fs.readFileSync(file, 'utf8');
      const baseContent = fs.readFileSync(baseFile, 'utf8');
      if (currentContent === baseContent) continue;
      const currentLines = currentContent.split('\n');
      const baseLines = baseContent.split('\n');
      const maxLen = Math.max(currentLines.length, baseLines.length);
      let fileDiff = '';
      for (let i = 0; i < maxLen; i++) {
        const baseLine = baseLines[i] ?? '';
        const currentLine = currentLines[i] ?? '';
        if (baseLine !== currentLine) {
          if (baseLine && !currentLine) {
            fileDiff += `-${baseLine}\n`;
          } else if (!baseLine && currentLine) {
            fileDiff += `+${currentLine}\n`;
          } else {
            fileDiff += `-${baseLine}\n+${currentLine}\n`;
          }
        }
      }
      if (fileDiff) {
        diff += `diff --git a/${relPath} b/${relPath}\n--- a/${relPath}\n+++ b/${relPath}\n${fileDiff}`;
      }
    }
  }
  return diff;
}

export function integrityResult({ messageFile } = {}) {
  const base = mergeBase();
  const logged = run('git', ['log', '--pretty=%B', base ? `${base}..HEAD` : '-1']).stdout.trim();
  const pending = messageFile && fs.existsSync(messageFile) ? fs.readFileSync(messageFile, 'utf8') : '';
  const commitMessages = `${logged}\n${pending}`.split('\n').filter(Boolean);
  const integrityBase = process.env.FRL_INTEGRITY_BASE;
  let diff = '';
  if (integrityBase) {
    diff = diffAgainstBaseDir(integrityBase);
  } else if (base) {
    diff = run('git', ['diff', base, '--', ...protectedPaths()]).stdout;
  } else if (messageFile && run('git', ['rev-parse', '--verify', 'HEAD']).stdout.trim()) {
    diff = run('git', ['diff', '--cached', 'HEAD', '--', ...protectedPaths()]).stdout;
  } else if (process.env.CI) {
    diff = run('git', ['diff', 'HEAD~1', '--', ...protectedPaths()]).stdout;
  } else {
    return { passed: true, detail: 'skipped: no git history for testIntegrity gate' };
  }
  return checkTestIntegrity(diff, commitMessages);
}

const gates = {
  testIntegrity() {
    if (process.env.FRL_INTEGRITY_DEFER === '1') return { passed: true, detail: 'checked by the commit-msg hook, which sees the message being written' };
    return integrityResult({ messageFile: process.env.FRL_COMMIT_MSG_FILE });
  },

  methods(files) {
    const methodsPath = path.join(ROOT, 'src', 'research', 'methods.json');
    if (!fs.existsSync(methodsPath)) {
      return { passed: false, detail: 'src/research/methods.json not found' };
    }
    const methods = JSON.parse(fs.readFileSync(methodsPath, 'utf8'));
    const verified = methods.filter((m) => m.status === 'verified');
    const failures = [];
    for (const method of verified) {
      const fixturePath = path.join(ROOT, 'tests', 'fixtures', 'methods', `${method.id}.txt`);
      if (!fs.existsSync(fixturePath)) {
        failures.push(`${method.id}: fixture not found at ${fixturePath}`);
        continue;
      }
      const fixture = fs.readFileSync(fixturePath, 'utf8');
      const normQuote = normalizeWhitespace(method.quote);
      const normFixture = normalizeWhitespace(fixture);
      if (!normFixture.includes(normQuote)) {
        failures.push(`${method.id}: quote not found in fixture (whitespace-normalised)`);
      }
      if (method.sha256) {
        const hash = crypto.createHash('sha256').update(fixture).digest('hex');
        if (hash !== method.sha256) {
          failures.push(`${method.id}: fixture sha256 mismatch (expected ${method.sha256}, got ${hash})`);
        }
      } else {
        failures.push(`${method.id}: missing sha256 in methods.json`);
      }
    }
    return {
      passed: failures.length === 0,
      detail: failures.length ? failures.join('; ') : `${verified.length} verified method quote(s) and sha256(s) verified`
    };
  },

  syntax(files) {
    const failures = sourceModules(files).filter((f) => run(process.execPath, ['--check', f]).status !== 0);
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    try {
      new Function(html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>')));
    } catch (error) {
      failures.push(`public/index.html: ${error.message}`);
    }
    return { passed: failures.length === 0, detail: failures.length ? failures.join('; ') : `${sourceModules(files).length} modules and the UI script parse` };
  },

  workflows(files) {
    const workflows = files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
    const failures = [];
    for (const file of workflows) {
      try {
        const doc = parseYaml(fs.readFileSync(path.join(ROOT, file), 'utf8'));
        const jobs = Object.entries(doc?.jobs ?? {});
        if (!jobs.length) failures.push(`${file}: no jobs`);
        const locked = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).packages?.['node_modules/playwright']?.version;
        for (const [name, job] of jobs) {
          const tag = String(job?.container?.image ?? '').match(/^mcr\.microsoft\.com\/playwright:v([\d.]+)-/)?.[1];
          if (tag && tag !== locked) failures.push(`${file}: job ${name} runs Playwright image v${tag} but package-lock.json has ${locked}`);
        }
        for (const [name, job] of jobs) if (!Number.isFinite(job?.['timeout-minutes'])) failures.push(`${file}: job ${name} has no timeout-minutes, so a hung step waits six hours`);
        for (const [name, job] of jobs) for (const [i, step] of (job?.steps ?? []).entries()) if (!step?.uses && !step?.run) failures.push(`${file}: job ${name} step ${i + 1} has neither uses nor run`);
      } catch (error) {
        failures.push(`${file}: ${String(error.message).split('\n')[0]}`);
      }
    }
    return { passed: failures.length === 0, detail: failures.length ? failures.join('; ') : `${workflows.length} CI workflow file(s) parse, no duplicate keys, every job has a timeout, the Playwright image matches the lockfile` };
  },

  independence(files) {
    const offenders = sourceModules(files).filter((f) => f.startsWith('verifier/')).filter((f) => /(?:from\s+|import\()\s*['"](?:\.\.\/)+src\//.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    return { passed: offenders.length === 0, detail: offenders.length ? `the external verifier imports app code: ${offenders.join(', ')}` : 'the external verifier shares no code with the app' };
  },

  secrets(files) {
    const hits = [];
    for (const file of files) {
      if (/node_modules|\.png$|\.jpg$|package-lock\.json$/.test(file)) continue;
      const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const [name, pattern] of SECRET_PATTERNS) if (pattern.test(body)) hits.push(`${file}: ${name}`);
    }
    const gitleaks = run('gitleaks', ['detect', '--no-banner', '--redact', '--source', ROOT]);
    const leaksRan = !gitleaks.error;
    if (leaksRan && gitleaks.status !== 0) hits.push('gitleaks reported findings (run: gitleaks detect --redact)');
    return { passed: hits.length === 0, detail: hits.length ? hits.join('; ') : `${files.length} files scanned${leaksRan ? ' + gitleaks' : ' (gitleaks not installed: built-in patterns only)'}` };
  },

  dependencies(files, root = ROOT) {
    const allowedPath = path.join(root, 'tests', 'fixtures', 'security', 'allowed-dependencies.json');
    if (!fs.existsSync(allowedPath)) return { passed: false, detail: 'missing tests/fixtures/security/allowed-dependencies.json' };
    const allowed = JSON.parse(fs.readFileSync(allowedPath, 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const failures = [];

    for (const [section, deps] of Object.entries({ dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, optionalDependencies: pkg.optionalDependencies })) {
      const allowedDeps = allowed[section] || {};
      for (const [name, version] of Object.entries(deps || {})) {
        if (!allowedDeps[name] || allowedDeps[name] !== version) {
          failures.push(`${section}: ${name}@${version} not in allowed list`);
        }
      }
      for (const name of Object.keys(allowedDeps)) {
        if (!deps?.[name]) {
          failures.push(`${section}: ${name} missing from package.json but in allowed list`);
        }
      }
    }

    const allowedScripts = allowed.allowScripts || {};
    const allowedScriptNames = new Set(Object.keys(allowedScripts).filter((k) => allowedScripts[k]).map((k) => k.split('@')[0]));
    for (const [pkgPath, info] of Object.entries(lock.packages || {})) {
      if (info.hasInstallScript && pkgPath !== '' && !pkgPath.endsWith('/free-research-llm')) {
        const name = pkgPath.replace('node_modules/', '');
        if (!allowedScriptNames.has(name)) {
          failures.push(`install script: ${name} has install script but not in allowScripts`);
        }
      }
    }

    for (const [name, allowed] of Object.entries(allowedScripts)) {
      if (!allowed) continue;
      const pkgName = name.split('@')[0];
      const pkgInfo = lock.packages[`node_modules/${pkgName}`];
      if (!pkgInfo || !pkgInfo.hasInstallScript) {
        failures.push(`allowScripts: ${name} listed but has no install script in lockfile`);
      }
    }

    return { passed: failures.length === 0, detail: failures.length ? failures.join('; ') : 'package.json and lockfile match allowed-dependencies.json; no unauthorized install scripts' };
  },

  egress(files, root = ROOT) {
    const allowedPath = path.join(root, 'tests', 'fixtures', 'security', 'egress-allowed.json');
    if (!fs.existsSync(allowedPath)) return { passed: false, detail: 'missing tests/fixtures/security/egress-allowed.json' };
    const allowed = JSON.parse(fs.readFileSync(allowedPath, 'utf8'));
    const sourceFiles = sourceModules(files);
    const failures = [];

    for (const file of sourceFiles) {
      const filePath = path.join(root, file);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      let hasEgress = false;
      for (const pattern of EGRESS_PATTERNS) {
        if (pattern.test(content)) {
          hasEgress = true;
          break;
        }
      }
      if (hasEgress && !allowed[file]) {
        failures.push(`${file}: makes outbound network calls but not in egress-allowed.json`);
      }
    }

    for (const file of Object.keys(allowed)) {
      if (!sourceFiles.includes(file)) {
        failures.push(`egress-allowed.json: ${file} listed but not found in source modules`);
      }
    }

    return { passed: failures.length === 0, detail: failures.length ? failures.join('; ') : `${Object.keys(allowed).length} egress-allowed file(s) verified` };
  },

  noComments(files) {
    const offenders = [];
    for (const file of sourceModules(files)) {
      fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((line, i) => {
        const t = line.trim();
        if ((t.startsWith('//') || t.startsWith('/*')) && !/eslint-|@ts-/.test(t)) offenders.push(`${file}:${i + 1}`);
      });
    }
    return { passed: offenders.length === 0, detail: offenders.length ? `comment lines: ${offenders.slice(0, 10).join(', ')}` : 'no comments in source' };
  },

  testsPresent(files) {
    const missing = sourceModules(files)
      .filter((f) => (f.startsWith('src/') || f.startsWith('verifier/')) && !UNTESTED_ENTRYPOINTS.has(f))
      .filter((f) => !fs.existsSync(path.join(ROOT, f.startsWith('src/') ? `tests/${f.slice(4, -4)}.test.ts` : `tests/${f.slice(0, -4)}.test.ts`)));
    return { passed: missing.length === 0, detail: missing.length ? `no test file for: ${missing.join(', ')}` : 'every logic module has a matching test file' };
  },

  e2e() {
    if (!fs.existsSync(path.join(ROOT, 'node_modules/@playwright/test'))) {
      const ci = Boolean(process.env.CI);
      return { passed: !ci, detail: ci ? 'Playwright is not installed and CI is set: the gate cannot run e2e, so it fails instead of skipping' : 'skipped: Playwright not installed (npm install, npx playwright install chromium webkit)' };
    }
    const lock = acquireQualityLock();
    if (!lock.acquired) {
      return { passed: false, detail: `another quality gate holds ${lock.file} (pid ${lock.holder}); waited ${Math.round(LOCK_WAIT_MS / 60000)} min for it` };
    }
    try {
      const result = runTool('@playwright/test', 'playwright', ['test', '--reporter=line']);
      const summary = `${result.stdout}${result.stderr}`.match(/(\d+ passed[^\n]*|\d+ failed[^\n]*)/g);
      const failing = result.status === 0 ? [] : failingLines(`${result.stdout}${result.stderr}`, /^\s*(?:✘|\d+\)\s|Error:|Test timeout)/);
      return { passed: result.status === 0, detail: `${summary ? summary.join(', ') : `${result.stdout}${result.stderr}`.slice(-300)}${failing.length ? `\n      ${failing.join('\n      ')}` : ''}` };
    } finally {
      releaseQualityLock({ file: lock.file });
    }
  },

  flakes() {
    const base = mergeBase();
    const changed = [...new Set([
      ...run('git', ['diff', '--cached', '--name-only', '--diff-filter=AM']).stdout.split('\n'),
      ...run('git', ['diff', '--name-only', '--diff-filter=AM']).stdout.split('\n'),
      ...(base ? run('git', ['diff', '--name-only', '--diff-filter=AM', base]).stdout.split('\n') : []),
    ])].filter((f) => /^tests\/.+\.test\.ts$/.test(f) && fs.existsSync(path.join(ROOT, f)));
    if (!changed.length) return { passed: true, detail: 'no new or changed test files' };
    for (let round = 1; round <= FLAKE_ROUNDS; round++) {
      const result = runTool('vitest', 'vitest', ['run', ...changed]);
      if (result.status !== 0) return { passed: false, detail: `round ${round} of ${FLAKE_ROUNDS} failed for ${changed.join(', ')}\n      ${failingLines(`${result.stdout}${result.stderr}`, /^\s*(?:×|FAIL\s|AssertionError|Error:)/).join('\n      ')}` };
    }
    return { passed: true, detail: `${changed.length} new or changed test file(s) passed ${FLAKE_ROUNDS} times in a row` };
  },
  tests() {
    const result = runTool('vitest', 'vitest', ['run']);
    const output = `${result.stdout}${result.stderr}`;
    const summary = output.match(/Tests\s+([^\n]+)/);
    const failing = result.status === 0 ? [] : failingLines(output, /^\s*(?:×|FAIL\s|AssertionError|Error:)/);
    return { passed: result.status === 0, detail: `${summary ? summary[1].trim() : result.stderr.slice(-300)}${failing.length ? `\n      ${failing.join('\n      ')}` : ''}` };
  },

  waste() {
    const dataDir = process.env.FRL_DATA_DIR || path.join(ROOT, 'data');
    return checkWaste(dataDir);
  },

  async zeroLoss() {
    const snapshotDir = process.env.FRL_REFERENCE_SNAPSHOT || path.join(ROOT, '..', 'lead', 'snapshot-2026-11-19');
    const baselineFile = path.join(ROOT, 'tests', 'fixtures', 'reference', 'baseline.json');
    if (!fs.existsSync(snapshotDir) || !fs.existsSync(baselineFile)) {
      return { passed: true, detail: 'skipped: baseline or snapshot not found' };
    }
    const tapeDir = process.env.FRL_TAPE_DIR || path.join(snapshotDir, 'tape');
    const hasTape = fs.existsSync(tapeDir);
    const failed = await checkSnapshot(snapshotDir, baselineFile, hasTape);
    const detail = failed ? 'zero-loss check failed' : 'zero-loss check passed';
    return { passed: !failed, detail: hasTape ? detail + ' (with judge)' : detail };
  },
};

export function dependencies(files, root = ROOT) {
  return gates.dependencies(files, root);
}

export function egress(files, root = ROOT) {
  return gates.egress(files, root);
}

export { checkTestIntegrity, diffAgainstBaseDir };

async function runQualityGate() {
  const files = repoFiles();
  const results = [];
  for (const [name, gate] of Object.entries(gates)) {
    const result = gate(files);
    results.push({ gate: name, ...(result instanceof Promise ? await result : result) });
  }
  const verdict = { at: new Date().toISOString(), passed: results.every((r) => r.passed), results };
  fs.mkdirSync(path.join(ROOT, 'data/logs'), { recursive: true });
  fs.appendFileSync(path.join(ROOT, 'data/logs/quality.jsonl'), `${JSON.stringify(verdict)}\n`);
  for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.gate.padEnd(13)} ${r.detail}`);
  console.log(verdict.passed ? '\nquality gate: PASSED' : '\nquality gate: FAILED');
  process.exitCode = verdict.passed ? 0 : 1;
}

if (startedDirectly(import.meta.url)) {
  runQualityGate();
}
