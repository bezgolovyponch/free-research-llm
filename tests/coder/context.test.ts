import { describe, expect, it } from 'vitest';
import { FULL_FILE_CHARS, excerpt, fileView, rankFiles, ticketTerms } from '../../src/coder/context.mjs';

describe('coder context', () => {
  it('takes quoted phrases and meaningful words from a ticket', () => {
    const terms = ticketTerms({ title: 'Show kept trials', request: 'The heading "Loop trials (N)" should show kept trials', desired: 'heading text', tests: [] });
    expect(terms[0]).toBe('Loop trials');
    expect(terms).toEqual(expect.arrayContaining(['kept', 'trials', 'heading']));
    expect(terms).not.toContain('should');
  });

  it('shows small files whole and large files as excerpts around the ticket terms, with line numbers', () => {
    expect(fileView('a.mjs', 'small', ['x'])).toEqual({ file: 'a.mjs', text: 'small', partial: false });
    expect(fileView('n.mjs', null, [])).toMatchObject({ text: '(file does not exist yet)' });
    const body = `${'filler line\n'.repeat(3000)}<h2>Loop trials ('+tr.length+')</h2>\n${'more\n'.repeat(3000)}`;
    expect(body.length).toBeGreaterThan(FULL_FILE_CHARS);
    const view = fileView('public/index.html', body, ['Loop trials']);
    expect(view.partial).toBe(true);
    expect(view.text).toContain("<h2>Loop trials ('+tr.length+')</h2>");
    expect(view.text).toMatch(/--- excerpt from line 29\d\d ---/);
    expect(view.text.length).toBeLessThan(4000);
    expect(excerpt('abc'.repeat(5000), ['zzz']).length).toBe(3000);
  });

  it('finds the files that contain the ticket words, so the model edits the right file', () => {
    const entries = [{ file: 'src/app.mjs', body: 'trials kept' }, { file: 'public/index.html', body: "<h2>Loop trials ('+n+')</h2> kept" }, { file: 'src/x.mjs', body: 'nothing' }];
    expect(rankFiles(entries, ['Loop trials', 'kept', 'heading'])).toEqual(['public/index.html']);
  });
});
