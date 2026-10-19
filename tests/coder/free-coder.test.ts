import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChangeBook } from '../../src/changes.mjs';
import { FreeCoder, MAX_ATTEMPTS, MAX_GATE_RUNS, editPrompt, failureFeedback, planPrompt } from '../../src/coder/free-coder.mjs';

type Edit = { file: string; search?: string; replace?: string; content?: string };

function fakeSandbox(gates: boolean[]) {
  const files = new Map<string, string>([['src/a.mjs', 'export const a = 1;\n'], ['tests/a.test.ts', "it('a', () => {});\n"]]);
  return {
    touched: new Set<string>(),
    applied: [] as Edit[][],
    promoted: false,
    discarded: false,
    async prepare() { return [...files.keys()]; },
    async read(f: string) { return files.get(f) ?? null; },
    async apply(edits: Edit[]) {
      for (const e of edits) {
        const cur = files.get(e.file);
        if (e.content == null && (cur == null || !cur.includes(e.search!))) {
          const { EditError } = await import('../../src/coder/edits.mjs');
          throw new EditError(`${e.file}: the search text was not found exactly`);
        }
        files.set(e.file, e.content ?? cur!.replace(e.search!, e.replace!));
        this.touched.add(e.file);
      }
      this.applied.push(edits);
    },
    async gate() { const passed = gates.shift() ?? false; return { passed, output: passed ? 'PASS  tests ok' : 'FAIL  tests 1 failed\nAssertionError: expected 2 to be 3', summary: passed ? 'PASS  tests ok' : 'FAIL  tests 1 failed' }; },
    async promote() { this.promoted = true; return [...this.touched]; },
    async discard() { this.discarded = true; },
  };
}

async function setup(replies: unknown[], gates: boolean[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-coder-'));
  const changes = new ChangeBook({ dir: path.join(dir, 'changes') });
  const ticket = await changes.create({ title: 'Bump a', request: 'Make the constant a equal 2', desired: 'a is 2 and a test says so', area: 'src/a.mjs' });
  const queue = [...replies];
  const prompts: string[] = [];
  const notes: string[] = [];
  const router = { complete: async ({ messages, purpose }: { messages: Array<{ content: string }>; purpose: string }) => { prompts.push(`${purpose}:${messages[1].content}`); return { data: queue.shift() }; } };
  const sandbox = fakeSandbox(gates);
  let restarts = 0;
  const coder = new FreeCoder({ router, root: dir, workDir: path.join(dir, 'work'), changes, note: (m: string) => notes.push(m), restart: () => { restarts++; return true; }, sandboxFactory: () => sandbox });
  return { dir, changes, ticket, coder, sandbox, prompts, notes, restarts: () => restarts };
}

describe('FreeCoder', () => {
  it('plans, edits, re-tries with the gate failure, and applies the change only when the gate passes', async () => {
    const t = await setup([
      { files: ['src/a.mjs', 'scripts/quality.mjs', 'tests/a.test.ts'], plan: 'edit a, add a test' },
      { edits: [{ file: 'src/a.mjs', search: 'a = 7', replace: 'a = 2' }] },
      { edits: [{ file: 'src/a.mjs', search: 'a = 1', replace: 'a = 2' }] },
      { edits: [{ file: 'tests/a.test.ts', search: "it('a'", replace: "it('is 2', () => {});\nit('a'" }] },
    ], [false, true]);
    const result = await t.coder.start(t.ticket.id).job;
    expect(result).toMatchObject({ id: 'C1', state: 'done', result: { passed: true, summary: 'PASS  tests ok' }, files: ['src/a.mjs', 'tests/a.test.ts'] });
    expect(t.prompts[0]).toMatch(/^code-plan:CHANGE C1/);
    expect(t.prompts[1]).toContain('=== src/a.mjs ===');
    expect(t.prompts[1]).not.toContain('=== scripts/quality.mjs ===');
    expect(t.prompts[2]).toContain('the search text was not found exactly');
    expect(t.prompts[3]).toContain('AssertionError: expected 2 to be 3');
    expect(t.sandbox.promoted).toBe(true);
    expect(t.sandbox.discarded).toBe(true);
    expect(t.restarts()).toBe(1);
    expect(t.notes.at(-1)).toContain('Change C1 applied after attempt 3: quality gate PASSED');
    await fs.rm(t.dir, { recursive: true, force: true });
  });

  it('leaves the app unchanged when no attempt passes the gate, within a budget of gate runs, and logs every attempt', async () => {
    const t = await setup([{ files: ['src/a.mjs'] }, ...Array.from({ length: MAX_ATTEMPTS }, (_, i) => ({ edits: [{ file: 'src/a.mjs', content: `export const a = ${i + 3};\n` }] }))], []);
    expect(await t.coder.start(t.ticket.id).job).toMatchObject({ state: 'failed', result: { passed: false } });
    expect(t.sandbox.applied).toHaveLength(MAX_GATE_RUNS);
    const log = (await fs.readFile(path.join(t.dir, 'changes', 'C1.attempts.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(log.map((e) => e.outcome ?? e.step)).toEqual(['plan', ...Array(MAX_GATE_RUNS).fill('gate-failed')]);
    expect(t.notes.filter((n) => n.includes('gate failed, retrying'))).toHaveLength(MAX_GATE_RUNS);
    expect(t.sandbox.promoted).toBe(false);
    expect(t.restarts()).toBe(0);
    expect(t.notes.at(-1)).toContain('The app is unchanged');
    await fs.rm(t.dir, { recursive: true, force: true });
  });

  it('refuses a whole-file rewrite of a large file and asks for search/replace instead', async () => {
    const t = await setup([{ files: ['src/big.mjs'] }, { edits: [{ file: 'src/big.mjs', content: 'x' }] }, { edits: [{ file: 'src/big.mjs', search: 'needle', replace: 'pin' }] }], [true]);
    const read = t.sandbox.read.bind(t.sandbox);
    t.sandbox.prepare = async () => ['src/a.mjs', 'src/big.mjs'];
    t.sandbox.read = async (f: string) => (f === 'src/big.mjs' ? `${'a'.repeat(30000)}needle${'b'.repeat(30000)}` : read(f));
    t.sandbox.apply = async (edits: Edit[]) => { t.sandbox.applied.push(edits); edits.forEach((e) => t.sandbox.touched.add(e.file)); };
    expect(await t.coder.start('C1').job).toMatchObject({ state: 'done' });
    expect(t.sandbox.applied).toEqual([[{ file: 'src/big.mjs', search: 'needle', replace: 'pin' }]]);
    expect(t.prompts[1]).toContain('EXCERPTS of a 60006-character file');
    expect(t.prompts[2]).toContain('Do not rewrite large files with "content": src/big.mjs');
    await fs.rm(t.dir, { recursive: true, force: true });
  });

  it('reports a model outage as a failed change, runs one job at a time and refuses to undo what was not applied', async () => {
    const t = await setup([], []);
    (t.coder as unknown as { router: unknown }).router = { complete: async () => { throw new Error('every provider failed for code-plan'); } };
    const first = t.coder.start('C1');
    expect(t.coder.start('C1')).toMatchObject({ started: false });
    expect(await first.job).toMatchObject({ state: 'failed', result: { summary: 'every provider failed for code-plan' } });
    expect(t.notes.at(-1)).toContain('the free model quotas are used up for now');
    await expect(t.coder.undo('C1')).rejects.toThrow(/only an applied change/);
    await fs.rm(t.dir, { recursive: true, force: true });
  });

  it('shows the model the ticket, the rules and the gate failure', () => {
    const ticket = { id: 'C2', title: 't', request: 'r', desired: 'd', tests: ['x'] };
    const plan = planPrompt(ticket, ['src/a.mjs'], ['public/index.html'])[1].content;
    expect(plan).toContain('REPOSITORY FILES:\nsrc/a.mjs');
    expect(plan).toContain("FILES THAT CONTAIN THE TICKET'S WORDS (found by code): public/index.html");
    const prompt = editPrompt(ticket, { plan: 'p', sources: [{ file: 'src/n.mjs', text: '(file does not exist yet)' }], feedback: 'FAIL  tests', attempt: 2 })[1].content;
    expect(prompt).toContain('(file does not exist yet)');
    expect(prompt).toContain('THE PREVIOUS ATTEMPT FAILED');
    expect(failureFeedback({ summary: 'PASS  syntax\nFAIL  tests 1 failed', output: 'ok\nTypeError: x is not a function\n    at src/a.mjs:3:1' })).toBe('FAIL  tests 1 failed\nTypeError: x is not a function\n    at src/a.mjs:3:1');
  });
});
