import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatLesson, loadLessons, matchLessons, matchesGlob, normalizePath } from '../../scripts/recall.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lessons = loadLessons();

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [path.join(ROOT, 'scripts/recall.mjs'), ...args], { cwd: ROOT, encoding: 'utf8' });
}

describe('process lessons store', () => {
  it('holds one entry per failure class F1 to F22', () => {
    expect(lessons.map((lesson: { id: string }) => lesson.id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22']);
    for (const lesson of lessons) {
      expect(typeof lesson.title).toBe('string');
      expect(lesson.title.length).toBeGreaterThan(0);
      expect(Array.isArray(lesson.touches)).toBe(true);
      expect(lesson.touches.length).toBeGreaterThan(0);
      expect(typeof lesson.signal).toBe('string');
      expect(lesson.signal.length).toBeGreaterThan(0);
      expect(typeof lesson.cause).toBe('string');
      expect(lesson.cause.length).toBeGreaterThan(0);
      expect(typeof lesson.prevention).toBe('string');
      expect(lesson.prevention.length).toBeGreaterThan(0);
    }
  });
});

describe('glob matching', () => {
  it('matches a path against a directory glob', () => {
    expect(matchesGlob('src/research/brief.mjs', 'src/research/**')).toBe(true);
    expect(matchesGlob('src/research/deep/nested/file.mjs', 'src/research/**')).toBe(true);
    expect(matchesGlob('src/llm/router.mjs', 'src/research/**')).toBe(false);
  });

  it('matches an exact file glob', () => {
    expect(matchesGlob('scripts/quality.mjs', 'scripts/quality.mjs')).toBe(true);
    expect(matchesGlob('scripts/quality-lock.mjs', 'scripts/quality.mjs')).toBe(false);
  });

  it('normalizes absolute and relative paths to repo relative form', () => {
    expect(normalizePath('./src/llm/router.mjs')).toBe('src/llm/router.mjs');
    expect(normalizePath('/private/tmp/frl/src/llm/router.mjs', '/private/tmp/frl')).toBe('src/llm/router.mjs');
    expect(normalizePath('  ')).toBe('');
  });
});

describe('lesson lookup', () => {
  it('returns every lesson whose touches glob covers the path', () => {
    const ids = matchLessons(lessons, ['src/research/acceptance.mjs']).map((lesson: { id: string }) => lesson.id);
    expect(ids).toContain('F1');
    expect(ids).toContain('F2');
    expect(ids).toContain('F3');
    expect(ids).not.toContain('F7');
  });

  it('returns the gate lesson for a gate file', () => {
    const ids = matchLessons(lessons, ['scripts/quality.mjs']).map((lesson: { id: string }) => lesson.id);
    expect(ids).toContain('F5');
  });

  it('returns nothing for a path no lesson touches', () => {
    expect(matchLessons(lessons, ['README.md'])).toEqual([]);
  });

  it('ignores a repeated path', () => {
    const matched = matchLessons(lessons, ['scripts/launch-worker.mjs', 'scripts/launch-worker.mjs']);
    expect(matched.map((lesson: { id: string }) => lesson.id)).toEqual(['F3', 'F7']);
  });

  it('formats one line per lesson with signal and prevention', () => {
    const line = formatLesson(lessons.find((lesson: { id: string }) => lesson.id === 'F5'));
    expect(line).toMatch(/^F5 \| .+ \| signal: .+ \| prevention: .+$/);
    expect(line.split(' | ')).toHaveLength(4);
  });
});

describe('recall command', () => {
  it('prints one line per matching lesson for a path', () => {
    const out = runCli(['scripts/quality.mjs']);
    const lines = out.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^F\d+ \| .+ \| signal: .+ \| prevention: .+$/);
    expect(lines.some((line) => line.startsWith('F5 | '))).toBe(true);
  });

  it('prints nothing when no lesson matches', () => {
    expect(runCli(['README.md'])).toBe('');
  });

  it('prints the lessons of the changed files for --changed', () => {
    const out = runCli(['--changed']);
    for (const line of out.split('\n').filter(Boolean)) expect(line).toMatch(/^F\d+ \| .+ \| signal: .+ \| prevention: .+$/);
  });
});
