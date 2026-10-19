import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CodeSandbox, restoreBackup } from './sandbox.mjs';

export const CLAUDE_TIMEOUT_MS = 45 * 60 * 1000;
export const MAX_CLAUDE_RUNS = 2;
export const CLAUDE_MAX_TURNS = 80;
export const CLAUDE_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(npm run quality)', 'Bash(npx vitest *)', 'Bash(npx playwright test *)', 'Bash(node --check *)', 'Bash(ls *)'];
export const CLAUDE_DENIED_TOOLS = ['Bash(git push *)', 'Bash(git commit *)', 'Bash(git reset *)', 'Bash(rm *)', 'Bash(curl *)', 'Bash(wget *)', 'WebFetch', 'WebSearch'];
const MAX_OUTPUT = 6000;
const NOTE_EVERY_MS = 5 * 60 * 1000;

const SEARCH_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);

export function claudePath(env = process.env) {
  const parts = [...String(env.PATH ?? '').split(path.delimiter), ...SEARCH_PATH.split(path.delimiter)].filter(Boolean);
  return [...new Set(parts)].join(path.delimiter);
}

export function detectClaude(runSync = spawnSync, env = process.env) {
  try {
    const result = runSync('claude', ['--version'], { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32', env: { ...env, PATH: claudePath(env) } });
    if (result.status !== 0) return { installed: false, version: '' };
    return { installed: true, version: String(result.stdout ?? '').trim().split(/\s+/)[0].slice(0, 20) };
  } catch {
    return { installed: false, version: '' };
  }
}

export function claudePromptFor(ticket, { dir }) {
  const blocked = 'src/coder/, tests/coder/, src/secrets.mjs, src/auth.mjs, src/terminal/, scripts/, .githooks/, package.json, vitest/playwright config, AUDIT-PROTOCOL.md';
  return `Implement the app change ${ticket.id} in this isolated copy of the app: ${dir}

Do not read or edit anything outside ${dir}, and do not run git commit or git push.

CHANGE ${ticket.id}: ${ticket.title}

REQUEST (what the user wants):
${ticket.request}

DESIRED OUTPUT (the result that must exist when this is done):
${ticket.desired}

TESTS AND CHECKS TO ADD:
${(ticket.tests ?? []).join('\n') || 'derive them from the desired output'}

HOW TO WORK
1. Read the files the change touches, then edit them here. The whole app is present, including public/index.html (the UI) and tests/.
2. Every module under src/ has a Vitest test at tests/<same path>.test.ts; add or update tests that fail without your change. UI flows get an e2e case under e2e/.
3. Node ESM, .mjs under src/, no comments of any kind in source. Never write a key, token or password into a file.
4. Do not edit the quality gate, the coder, auth, secrets, the terminal, package.json or the audit protocol (${blocked}).
5. Run \`npm run quality\` here until it prints "quality gate: PASSED". It runs syntax, secrets, comments, test presence, Vitest and Playwright. Existing tests may be added to, never removed or weakened.
6. Keep the surrounding style and make the smallest change that reaches the desired output.
7. When the gate passes, stop and reply with the list of files changed and the gate's PASS lines. If the gate cannot pass, stop and reply with the exact failure.
`;
}

export class ClaudeCodeCoder {
  constructor({ root, workDir, changes, note = () => {}, restart = null, sandboxFactory = null, spawnImpl = null, detect = detectClaude, env = process.env, timeoutMs = CLAUDE_TIMEOUT_MS }) {
    this.root = root;
    this.workDir = workDir;
    this.changes = changes;
    this.note = note;
    this.restart = restart;
    this.sandboxFactory = sandboxFactory ?? ((id) => new CodeSandbox({ root, dir: path.join(workDir, id) }));
    this.spawnImpl = spawnImpl ?? null;
    this.detect = detect;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.queue = Promise.resolve();
    this.active = null;
    this.waiting = new Set();
    this.checkedAt = 0;
    this.availability = { installed: false, version: '' };
  }

  available() {
    const now = Date.now();
    if (now - this.checkedAt < 60000) return this.availability;
    this.availability = this.detect(undefined, this.env);
    this.checkedAt = now;
    return this.availability;
  }

  busy(id) {
    return this.active === id || this.waiting.has(id);
  }

  start(id) {
    if (this.busy(id)) return { started: false, message: `${id} is already being implemented` };
    if (!this.available().installed) return { started: false, message: 'Claude Code is not installed on this computer: install it from https://docs.claude.com/en/docs/claude-code, or use the free-model coder' };
    this.waiting.add(id);
    const job = this.queue.then(() => this.run(id));
    this.queue = job.catch(() => {});
    return { started: true, job, message: `${id} queued for Claude Code (in a sandbox copy; the quality gate decides)` };
  }

  spawnClaude(prompt, cwd) {
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--max-turns', String(CLAUDE_MAX_TURNS), '--allowedTools', CLAUDE_ALLOWED_TOOLS.join(','), '--disallowedTools', CLAUDE_DENIED_TOOLS.join(',')];
    const child = (this.spawnImpl ?? spawn)('claude', args, { cwd, env: { ...this.env, PATH: claudePath(this.env) }, shell: process.platform === 'win32' });
    return new Promise((resolve) => {
      let output = '';
      let timedOut = false;
      const started = Date.now();
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, this.timeoutMs);
      const beat = setInterval(() => this.note(`Claude Code is still working (${Math.round((Date.now() - started) / 60000)} min). The app is unchanged until the gate passes.`), NOTE_EVERY_MS);
      const eat = (d) => {
        output = `${output}${d}`.slice(-MAX_OUTPUT * 3);
      };
      child.stdout?.on('data', eat);
      child.stderr?.on('data', eat);
      child.on('error', (error) => {
        clearTimeout(timer);
        clearInterval(beat);
        resolve({ code: 1, output: `could not start Claude Code: ${error.message}`, timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        clearInterval(beat);
        resolve({ code: timedOut ? 124 : code ?? 1, output, timedOut });
      });
    });
  }

  async gate(sandbox) {
    return sandbox.gate();
  }

  async run(id) {
    this.waiting.delete(id);
    this.active = id;
    const ticket = await this.changes.get(id);
    if (!ticket) {
      this.active = null;
      throw new Error(`change ${id} not found`);
    }
    const sandbox = this.sandboxFactory(id);
    try {
      await this.changes.report(id, { state: 'running', engine: 'claude' });
      this.note(`Change ${id} started with Claude Code in a sandbox copy: ${ticket.title}. It uses your Claude plan; the app changes only if the quality gate passes.`);
      await sandbox.prepare();
      let last = null;
      let feedback = '';
      for (let run = 1; run <= MAX_CLAUDE_RUNS; run++) {
        const prompt = run === 1 ? claudePromptFor(ticket, { dir: sandbox.dir }) : `The quality gate failed in ${sandbox.dir} after the previous run. Fix exactly this failure, keep every other change you made, and run \`npm run quality\` again until it prints "quality gate: PASSED".\n\n${feedback}`;
        const result = await this.spawnClaude(prompt, sandbox.dir);
        const answer = parseClaudeOutput(result.output);
        const touched = await sandbox.changedAll();
        if ((answer.isError || result.code !== 0 || result.timedOut) && !touched.length) {
          const why = result.timedOut ? `Claude Code ran out of time after ${Math.round(this.timeoutMs / 60000)} min` : answer.text || `Claude Code exited with code ${result.code}`;
          await this.logAttempt(id, { run, code: result.code, timedOut: result.timedOut, costUsd: answer.costUsd, turns: answer.turns, outcome: 'no-edits', output: String(why).slice(0, 1500) });
          const failed = await this.changes.report(id, { state: 'failed', passed: false, summary: why, engine: 'claude' });
          this.note(`Change ${id} stopped before any edit: ${String(why).slice(0, 400)}. The app is unchanged.`);
          return failed;
        }
        last = await this.gate(sandbox);
        await this.logAttempt(id, { run, code: result.code, timedOut: result.timedOut, costUsd: answer.costUsd, turns: answer.turns, gate: last.summary, output: String(answer.text ?? '').slice(-1500) });
        if (last.passed) {
          const backup = path.join(this.workDir, `${id}.backup`);
          await fs.rm(backup, { recursive: true, force: true });
          const promoted = await sandbox.promote(backup);
          if (!promoted.length) {
            const unchanged = await this.changes.report(id, { state: 'failed', passed: false, summary: 'Claude Code finished without changing any file; the app is unchanged.', engine: 'claude' });
            this.note(`Change ${id} finished without edits: Claude Code changed no file, so the app is unchanged. Ask again with a more specific request.`);
            return unchanged;
          }
          const cost = answer.costUsd ? ` Claude Code cost about $${answer.costUsd.toFixed(2)} on your Claude plan.` : '';
          const done = await this.changes.report(id, { state: 'done', passed: true, summary: `${last.summary}${cost}`, files: promoted, engine: 'claude' });
          const restarting = Boolean(this.restart?.());
          this.note(`Change ${id} applied with Claude Code: quality gate PASSED. Files: ${promoted.join(', ')}.\n${last.summary}${cost}\nUndo: the Undo button next to ${id} in App changes.${restarting ? ' The app restarts to load it.' : ' Restart the app to load it: node src/frl.mjs restart'}`);
          return done;
        }
        feedback = failureText(last);
        this.note(`Change ${id}, Claude Code run ${run}: gate failed, sending the failure back.\n${last.summary.split('\n').filter((l) => l.startsWith('FAIL')).join('\n')}`);
        if (run === MAX_CLAUDE_RUNS) break;
      }
      const failed = await this.changes.report(id, { state: 'failed', passed: false, summary: last?.summary ?? feedback, engine: 'claude' });
      this.note(`Change ${id} not applied: the quality gate did not pass after ${MAX_CLAUDE_RUNS} Claude Code runs. The app is unchanged. The gate output is in data/changes/${id}.attempts.jsonl. Try again, or ask for a smaller change.`);
      return failed;
    } catch (error) {
      const failed = await this.changes.report(id, { state: 'failed', passed: false, summary: error.message, engine: 'claude' });
      this.note(`Change ${id} stopped: ${error.message.slice(0, 300)}. The app is unchanged.`);
      return failed;
    } finally {
      await sandbox.discard();
      this.active = null;
    }
  }

  async logAttempt(id, entry) {
    const dir = this.changes.dir;
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, `${id}.attempts.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), step: 'claude', ...entry })}\n`);
  }

  async undo(id) {
    const ticket = await this.changes.get(id);
    if (!ticket || ticket.state !== 'done') throw new Error(`only an applied change can be undone (${id} is ${ticket?.state ?? 'unknown'})`);
    const files = await restoreBackup(this.root, path.join(this.workDir, `${id}.backup`));
    const reverted = await this.changes.report(id, { state: 'reverted', passed: false, summary: `undone: ${files.join(', ')}` });
    const restarting = Boolean(this.restart?.());
    this.note(`Change ${id} undone: ${files.join(', ')} restored.${restarting ? ' The app restarts.' : ' Restart the app to load it: node src/frl.mjs restart'}`);
    return reverted;
  }
}

export function parseClaudeOutput(output) {
  const lines = String(output ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const data = JSON.parse(line);
      return { text: String(data.result ?? ''), costUsd: Number(data.total_cost_usd) || 0, turns: Number(data.num_turns) || 0, isError: Boolean(data.is_error) };
    } catch {
      continue;
    }
  }
  return { text: String(output ?? '').trim(), costUsd: 0, turns: 0, isError: false };
}

export function failureText(gate) {
  const failed = String(gate.summary ?? '').split('\n').filter((l) => l.startsWith('FAIL')).join('\n');
  const tail = String(gate.output ?? '').split('\n').filter((l) => /Error|error|expect|Expected|Received|✘|✗|×|FAIL|failed|locator|Timeout|›|at .*:\d+/.test(l)).slice(-60).join('\n');
  return `${failed}\n${tail}`.trim().slice(-5000);
}
