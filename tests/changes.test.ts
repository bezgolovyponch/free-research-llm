import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChangeBook, claudePrompt, normalizeTicket, ticketMarkdown } from '../src/changes.mjs';

describe('app change tickets', () => {
  it('turns an App chat request into a numbered ticket file for Claude Code and tracks its gate result', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-changes-'));
    const book = new ChangeBook({ dir });
    await expect(book.create({ request: 'short', desired: 'x' })).rejects.toThrow(/request/);
    const [a, b] = await Promise.all([
      book.create({ title: 'CSV export', request: 'Add a CSV export of delivered items to the Results tab', desired: 'A Download CSV button that saves every delivered item', tests: ['tests/report.test.ts: CSV columns'] }),
      book.create({ request: 'Show the loop score as a chart in Gates & logs', desired: 'A line of score per trial' }),
    ]);
    expect([a.id, b.id]).toEqual(['C1', 'C2']);
    const md = await fs.readFile(path.join(dir, 'C1.md'), 'utf8');
    expect(md).toContain('# C1 · CSV export');
    expect(md).toContain('- tests/report.test.ts: CSV columns');
    expect(md).toContain('AUDIT-PROTOCOL.md Part 1');
    expect(md).toContain('node src/frl.mjs change C1 --claude');
    expect(await book.report('C1', { state: 'done', passed: true, summary: 'quality gate: PASSED' })).toMatchObject({ state: 'done', result: { passed: true } });
    expect(await book.report('C2', { state: 'reverted', summary: 'undone: src/a.mjs', files: ['src/a.mjs'] })).toMatchObject({ state: 'reverted', files: ['src/a.mjs'], result: { summary: 'undone: src/a.mjs' } });
    await book.report('C2', { state: 'queued' });
    await expect(book.report('C1', { state: 'weird' })).rejects.toThrow(/state/);
    await expect(book.report('../x', { state: 'done' })).rejects.toThrow(/unknown/);
    expect((await book.all()).map((t: { id: string; state: string }) => `${t.id}:${t.state}`)).toEqual(['C1:done', 'C2:queued']);
    expect(claudePrompt('C2')).toBe('Implement the app change in data/changes/C2.md. Follow AUDIT-PROTOCOL.md and CONCEPT.md.');
    expect(normalizeTicket({ request: 'Add a dark mode toggle to the header', desired: 'toggle' })).toMatchObject({ title: 'Add a dark mode toggle to the header', tests: [] });
    expect(ticketMarkdown({ id: 'C9', title: 't', request: 'r', desired: 'd', tests: [], area: '', createdAt: '2026-10-19T10:00:00Z' })).toContain('Derive them from the desired output');
    await fs.rm(dir, { recursive: true, force: true });
  });
});
