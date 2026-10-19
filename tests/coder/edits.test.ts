import { describe, expect, it } from 'vitest';
import { EditError, applyEdit, countTests, editablePath, normalizeEdits } from '../../src/coder/edits.mjs';

describe('free-coder edit policy', () => {
  it('lets the coder edit app code, tests, UI and top-level docs, never the gate, the coder, auth, secrets or the terminal', () => {
    expect(['src/research/score.mjs', 'tests/research/score.test.ts', 'e2e/a.spec.ts', 'public/index.html', 'GUIDE.md'].map(editablePath)).toEqual(['src/research/score.mjs', 'tests/research/score.test.ts', 'e2e/a.spec.ts', 'public/index.html', 'GUIDE.md']);
    expect(['scripts/quality.mjs', 'src/coder/free-coder.mjs', 'tests/coder/edits.test.ts', 'src/auth.mjs', 'src/secrets.mjs', 'src/terminal/hub.mjs', 'package.json', 'AUDIT-PROTOCOL.md', '.githooks/pre-commit', 'data/changes/index.json', '../etc/passwd', '/etc/hosts', 'src/../scripts/quality.mjs', 'docs/x.md'].map(editablePath).filter(Boolean)).toEqual([]);
    expect(editablePath('src\\research\\a.mjs')).toBe('src/research/a.mjs');
  });

  it('keeps well-formed edits and lists the refused ones', () => {
    expect(normalizeEdits({ edits: [{ file: 'src/a.mjs', search: 'x', replace: 'y' }, { file: 'tests/a.test.ts', content: 'c' }, { file: 'scripts/quality.mjs', content: '' }, { file: 'src/b.mjs', search: '', replace: 'y' }] })).toEqual({
      edits: [{ file: 'src/a.mjs', search: 'x', replace: 'y' }, { file: 'tests/a.test.ts', content: 'c' }],
      refused: ['scripts/quality.mjs', 'src/b.mjs'],
    });
    expect(normalizeEdits('nonsense')).toEqual({ edits: [], refused: [] });
  });

  it('applies an exact, unique search/replace and explains every miss', () => {
    expect(applyEdit('a\nb\nc', { file: 'f', search: 'b', replace: 'B' })).toBe('a\nB\nc');
    expect(applyEdit(null, { file: 'f', content: 'new' })).toBe('new');
    expect(() => applyEdit('a', { file: 'f', search: 'z', replace: '' })).toThrow(EditError);
    expect(() => applyEdit('b b', { file: 'f', search: 'b', replace: '' })).toThrow(/more than once/);
    expect(() => applyEdit(null, { file: 'f', search: 'b', replace: '' })).toThrow(/does not exist/);
  });

  it('counts test cases so a change cannot pass by deleting tests', () => {
    expect(countTests("it('a', () => {});\n  it(\"b\", async () => {});\ntest(`c`, () => {});\nexpect(x).it('no');")).toBe(3);
  });
});
