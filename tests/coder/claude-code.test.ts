import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChangeBook } from '../../src/changes.mjs';
import { ClaudeCodeCoder, claudePromptFor, detectClaude, parseClaudeOutput } from '../../src/coder/claude-code.mjs';

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };

function fakeChild(output: string, code = 0): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => {
    if (output) child.stdout.emit('data', output);
    child.emit('close', code);
  });
  return child;
}

function fakeSandbox({ gates = [true], changed = ['src/a.mjs'], dir = '/tmp/sandbox/C1' } = {}) {
  return {
    dir,
    prepared: false,
    promoted: false,
    discarded: false,
    async prepare() {
      this.prepared = true;
      return ['src/a.mjs', 'public/index.html'];
    },
    async changedAll() {
      return changed;
    },
    async gate() {
      const passed = gates.shift() ?? false;
      return { passed, output: passed ? 'PASS  tests ok' : 'FAIL  tests 1 failed\nAssertionError: expected 2 to be 3', summary: passed ? 'PASS  tests ok' : 'FAIL  tests 1 failed' };
    },
    async promote() {
      this.promoted = true;
      return changed;
    },
    async discard() {
      this.discarded = true;
    },
  };
}

async function setup({ gates = [true], output = JSON.stringify({ result: 'done', total_cost_usd: 0.12, is_error: false }), changed = ['src/a.mjs'], detect = { installed: true, version: '2.1.0' } } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-claude-'));
  const changes = new ChangeBook({ dir: path.join(dir, 'changes') });
  const ticket = await changes.create({ title: 'Green button', request: 'Make the Run button green in the header', desired: 'The Run button is green', engine: 'claude' });
  const notes: string[] = [];
  const runs: Array<{ command: string; args: string[]; options: { cwd: string } }> = [];
  const sandbox = fakeSandbox({ gates, changed });
  const coder = new ClaudeCodeCoder({
    root: dir,
    workDir: path.join(dir, 'work'),
    changes,
    note: (m: string) => notes.push(m),
    restart: () => true,
    sandboxFactory: () => sandbox,
    detect: () => detect,
    spawnImpl: ((command: string, args: string[], options: { cwd: string }) => {
      runs.push({ command, args, options });
      return fakeChild(output);
    }) as never,
  });
  return { dir, changes, ticket, coder, sandbox, notes, runs };
}

describe('ClaudeCodeCoder', () => {
  it('runs Claude Code in the sandbox copy, applies only after the gate passes and reports the cost', async () => {
    const t = await setup();
    expect(t.coder.available()).toEqual({ installed: true, version: '2.1.0' });
    const result = await t.coder.start(t.ticket.id).job;
    expect(result).toMatchObject({ id: 'C1', state: 'done', engine: 'claude', result: { passed: true, summary: expect.stringContaining('$0.12') } });
    expect(t.sandbox.prepared).toBe(true);
    expect(t.sandbox.promoted).toBe(true);
    expect(t.sandbox.discarded).toBe(true);
    expect(t.notes.at(-1)).toContain('applied with Claude Code');
    expect(t.notes.at(-1)).toContain('$0.12');
    const [call] = t.runs;
    expect(call.command).toBe('claude');
    expect(call.options.cwd).toBe('/tmp/sandbox/C1');
    expect(call.args).toContain('--permission-mode');
    expect(call.args.join(' ')).not.toContain('dangerously');
    expect(call.args).toContain('acceptEdits');
    const allowed = call.args[call.args.indexOf('--allowedTools') + 1].split(',');
    expect(allowed).not.toContain('Bash');
    expect(allowed.filter((t: string) => t.startsWith('Bash'))).toEqual(['Bash(npm run quality)', 'Bash(npx vitest *)', 'Bash(npx playwright test *)', 'Bash(node --check *)', 'Bash(ls *)']);
    expect(call.args[call.args.indexOf('--disallowedTools') + 1]).toContain('Bash(git push *)');
    expect(call.args.join(' ')).toContain('/tmp/sandbox/C1');
    await fs.rm(t.dir, { recursive: true, force: true });
  });

  it('feeds a failed gate back once, then stops and leaves the app unchanged', async () => {
    const t = await setup({ gates: [false, false] });
    const result = await t.coder.start(t.ticket.id).job;
    expect(result).toMatchObject({ state: 'failed', result: { passed: false } });
    expect(t.sandbox.promoted).toBe(false);
    expect(t.runs).toHaveLength(2);
    expect(t.runs[1].args.join(' ')).toContain('The quality gate failed');
    expect(t.notes.join('\n')).toContain('gate failed');
    await fs.rm(t.dir, { recursive: true, force: true });
  });

  it('stops before the gate when Claude Code cannot run at all, and says why', async () => {
    const t = await setup({ output: JSON.stringify({ result: "You've hit your session limit · resets 9:40pm", is_error: true, total_cost_usd: 0 }), changed: [] });
    const result = await t.coder.start(t.ticket.id).job;
    expect(result).toMatchObject({ state: 'failed' });
    expect(t.notes.at(-1)).toContain('session limit');
    expect(t.sandbox.promoted).toBe(false);
    await fs.rm(t.dir, { recursive: true, force: true });
  });

  it('refuses to start when Claude Code is not installed', async () => {
    const t = await setup({ detect: { installed: false, version: '' } });
    const started = t.coder.start(t.ticket.id);
    expect(started.started).toBe(false);
    expect(started.message).toContain('not installed');
    await fs.rm(t.dir, { recursive: true, force: true });
  });

  it('gives the model the ticket, the sandbox rule and the protected paths, and parses the JSON result', () => {
    const prompt = claudePromptFor({ id: 'C4', title: 'T', request: 'R', desired: 'D', tests: ['tests/a.test.ts'], area: 'UI' }, { dir: '/tmp/work/C4' });
    expect(prompt).toContain('C4');
    expect(prompt).toContain('/tmp/work/C4');
    expect(prompt).toContain('npm run quality');
    expect(prompt).toContain('src/coder/');
    expect(prompt).toContain('do not run git commit or git push');
    expect(parseClaudeOutput(`${JSON.stringify({ result: 'ok', total_cost_usd: 0.5, is_error: false, num_turns: 4 })}`)).toEqual({ text: 'ok', costUsd: 0.5, turns: 4, isError: false });
    expect(parseClaudeOutput('plain text')).toEqual({ text: 'plain text', costUsd: 0, turns: 0, isError: false });
    expect(detectClaude((() => ({ status: 1, stdout: '' })) as never)).toEqual({ installed: false, version: '' });
  });
});
