import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SelfImprover } from '../../src/loop/improver.mjs';

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-loop-'));
  await fs.mkdir(path.join(root, 'src/research'), { recursive: true });
  await fs.mkdir(path.join(root, 'data/projects'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/research/prompts.mjs'), 'export const P = "Answer only from EVIDENCE and established answers.";\n');
  await fs.writeFile(path.join(root, 'src/research/templates.mjs'), 'export const T = "typical sources: listings";\n');
  return root;
}

function harness(root: string, { grades, testsOk = true, edit }: { grades: string[][]; testsOk?: boolean; edit: object }) {
  const calls: string[] = [];
  let run = 0;
  const exec = async (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args[0]}`);
    if (cmd === 'node') {
      const id = `proj-${run}`;
      const statuses = grades[run++];
      await fs.writeFile(path.join(root, 'data/projects', `${id}.json`), JSON.stringify({ id, nodes: statuses.map((status, i) => ({ id: `D${i}`, status })), report: { verdict: 'GO-IF x' } }));
      return { stdout: `project: ${id}\n` };
    }
    if (cmd === 'npx' && !testsOk) throw new Error('tests failed');
    return { stdout: '' };
  };
  const router = { complete: async () => ({ data: { rationale: 'better hint', edits: [edit] } }) };
  const lines: string[] = [];
  const improver = new SelfImprover({ root, router, exec, targets: [{ id: 't1', question: 'q', template: 'car-arbitrage' }], log: (l: string) => lines.push(l), sleep: async () => {} });
  return { improver, calls, lines };
}

const goodEdit = { file: 'src/research/templates.mjs', find: 'typical sources: listings', replace: 'typical sources: marketplace listings and statistics' };

describe('SelfImprover', () => {
  it('records a baseline, then keeps and commits an edit that scores at least as well', async () => {
    const root = await workspace();
    const { improver, calls, lines } = harness(root, { grades: [['weak', 'weak'], ['verified', 'weak']], edit: goodEdit });
    await improver.runForever({ maxIterations: 2, pauseMs: 0 });
    expect(lines[0]).toMatch(/baseline t1 score=/);
    expect(lines[1]).toMatch(/kept t1 score=/);
    expect(await fs.readFile(path.join(root, 'src/research/templates.mjs'), 'utf8')).toMatch(/marketplace listings and statistics/);
    expect(calls).toEqual(['node src/cli.mjs', 'npx vitest', 'node src/cli.mjs', 'git add', 'git commit']);
  });

  it('reverts an edit that makes the research worse', async () => {
    const root = await workspace();
    const { improver, lines } = harness(root, { grades: [['verified', 'supported'], ['weak', 'weak']], edit: goodEdit });
    await improver.runForever({ maxIterations: 2, pauseMs: 0 });
    expect(lines[1]).toMatch(/reverted-worse/);
    expect(await fs.readFile(path.join(root, 'src/research/templates.mjs'), 'utf8')).toBe('export const T = "typical sources: listings";\n');
  });

  it('reverts when tests fail and rejects edits it cannot apply', async () => {
    const root = await workspace();
    const failing = harness(root, { grades: [['weak']], testsOk: false, edit: goodEdit });
    await failing.improver.runForever({ maxIterations: 2, pauseMs: 0 });
    expect(failing.lines[1]).toMatch(/tests-failed-reverted/);
    const root2 = await workspace();
    const bogus = harness(root2, { grades: [['weak']], edit: { file: 'src/app.mjs', find: 'anything long enough', replace: 'x' } });
    await bogus.improver.runForever({ maxIterations: 2, pauseMs: 0 });
    expect(bogus.lines[1]).toMatch(/proposal-rejected .*not allowed/);
  });
});
