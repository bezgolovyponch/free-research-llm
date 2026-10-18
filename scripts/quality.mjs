#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNTESTED_ENTRYPOINTS = new Set(['src/frl.mjs', 'src/cli.mjs', 'src/loop/cli.mjs', 'src/llm/presets.mjs', 'src/research/prompts.mjs', 'src/llm/scripted-provider.mjs']);
const SECRET_PATTERNS = [
  ['google-api-key', /AIza[0-9A-Za-z_-]{35}/],
  ['google-auth-key', /\bAQ\.[0-9A-Za-z_-]{40,}/],
  ['groq-key', /gsk_[0-9A-Za-z]{40,}/],
  ['openrouter-key', /sk-or-v1-[0-9a-f]{40,}/],
  ['cerebras-key', /csk-[0-9a-z]{40,}/],
  ['nvidia-key', /nvapi-[0-9A-Za-z_-]{40,}/],
  ['tavily-key', /tvly-[0-9A-Za-z-]{20,}/],
  ['jina-key', /jina_[0-9a-f]{30,}/],
  ['firecrawl-key', /fc-[0-9a-f]{32}/],
  ['generic-sk-key', /\bsk-[0-9A-Za-z]{32,}\b/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

function run(command, args) {
  return spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function repoFiles() {
  const listed = run('git', ['ls-files', '-co', '--exclude-standard']);
  return listed.status === 0 ? listed.stdout.split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f))) : [];
}

function sourceModules(files) {
  return files.filter((f) => /^(src|scripts)\/.*\.mjs$/.test(f));
}

const gates = {
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
      .filter((f) => f.startsWith('src/') && !UNTESTED_ENTRYPOINTS.has(f))
      .filter((f) => !fs.existsSync(path.join(ROOT, `tests/${f.slice(4, -4)}.test.ts`)));
    return { passed: missing.length === 0, detail: missing.length ? `no test file for: ${missing.join(', ')}` : 'every logic module has a matching test file' };
  },

  e2e() {
    if (!fs.existsSync(path.join(ROOT, 'node_modules/@playwright/test'))) return { passed: true, detail: 'skipped: Playwright not installed (npm install, npx playwright install chromium webkit)' };
    const result = run('npx', ['playwright', 'test', '--reporter=line']);
    const summary = `${result.stdout}${result.stderr}`.match(/(\d+ passed[^\n]*|\d+ failed[^\n]*)/g);
    return { passed: result.status === 0, detail: summary ? summary.join(', ') : `${result.stdout}${result.stderr}`.slice(-300) };
  },

  tests() {
    const result = run('npx', ['vitest', 'run']);
    const summary = `${result.stdout}${result.stderr}`.match(/Tests\s+([^\n]+)/);
    return { passed: result.status === 0, detail: summary ? summary[1].trim() : result.stderr.slice(-300) };
  },
};

const files = repoFiles();
const results = Object.entries(gates).map(([name, gate]) => ({ gate: name, ...gate(files) }));
const verdict = { at: new Date().toISOString(), passed: results.every((r) => r.passed), results };
fs.mkdirSync(path.join(ROOT, 'data/logs'), { recursive: true });
fs.appendFileSync(path.join(ROOT, 'data/logs/quality.jsonl'), `${JSON.stringify(verdict)}\n`);
for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.gate.padEnd(13)} ${r.detail}`);
console.log(verdict.passed ? '\nquality gate: PASSED' : '\nquality gate: FAILED');
process.exitCode = verdict.passed ? 0 : 1;
