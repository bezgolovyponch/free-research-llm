import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { playbookText } from '../../src/research/playbook.mjs';
import { LESSONS_KEPT, LessonBook, PRINCIPLE_MIN_TESTS, lessonsFromTrials, principlesFrom } from '../../src/research/lessons.mjs';

const trial = (researchId: string, change: string, outcome: string, score = 0.5, before = 0.4, extra = {}) => ({ at: `2026-10-${10 + researchId.length}T10:00:00Z`, nodeId: 'D1.1', change, outcome, score, before, type: 'sub-question|lookup|fact', ...extra });

describe('lessons: cross-research memory of gate-decided changes', () => {
  it('turns trials into lessons and ignores untested or change-less trials', () => {
    const lessons = lessonsFromTrials([trial('r1', 'add a second independent source', 'kept'), trial('r1', '', 'kept'), trial('r1', 'x', 'pending')], { researchId: 'r1' });
    expect(lessons.length).toBe(1);
    expect(lessons[0]).toMatchObject({ researchId: 'r1', outcome: 'kept', type: 'sub-question|lookup|fact' });
    expect(lessons[0].gain).toBeCloseTo(0.1, 3);
  });

  it('derives a principle only after enough tests, and says whether it helps', () => {
    const many = (outcome: string, id: string) => lessonsFromTrials([trial(id, 'add a second independent source', outcome)], { researchId: id });
    const helpful = [...many('kept', 'alpha'), ...many('kept', 'beta'), ...many('reverted-whole', 'gamma')];
    const [p] = principlesFrom(helpful, 'sub-question|lookup|fact');
    expect(p.verdict).toBe('helps');
    expect(p.tests).toBe(3);
    expect(p.researches).toBe(3);
    expect(p.statement).toContain('kept 2 of 3 tests across 3 researches');
    expect(principlesFrom(helpful.slice(0, PRINCIPLE_MIN_TESTS - 1), 'sub-question|lookup|fact')).toEqual([]);
  });

  it('marks a change that never helped, and keeps types apart', () => {
    const bad = ['alpha', 'beta', 'gamma'].flatMap((id) => lessonsFromTrials([trial(id, 'repeat the same search', 'reverted-piece')], { researchId: id }));
    const other = lessonsFromTrials([trial('delta', 'repeat the same search', 'kept', 0.5, 0.1, { type: 'driver|calculation|fact' })], { researchId: 'delta' });
    expect(principlesFrom([...bad, ...other], 'sub-question|lookup|fact')[0].verdict).toBe('does not help');
    expect(principlesFrom([...bad, ...other], 'driver|calculation|fact')).toEqual([]);
  });

  it('stores lessons once per trial, survives a restart, and caps the store', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-lessons-'));
    const file = path.join(dir, 'lessons.json');
    const book = new LessonBook({ file });
    const entries = lessonsFromTrials([trial('r1', 'add a second independent source', 'kept')], { researchId: 'r1' });
    expect(await book.add(entries)).toBe(1);
    expect(await book.add(entries)).toBe(0);
    await book.writing;
    const reopened = new LessonBook({ file });
    expect((await reopened.forType('sub-question|lookup|fact')).length).toBe(1);
    expect((await reopened.forType('sub-question|lookup|fact', { excludeResearch: 'r1' })).length).toBe(0);
    const many = Array.from({ length: LESSONS_KEPT + 5 }, (_, i) => ({ researchId: 'bulk', nodeId: 'D1', type: 'x', change: `c${i}`, outcome: 'kept', gain: 0, at: `t${i}` }));
    await reopened.add(many);
    expect(reopened.lessons.length).toBe(LESSONS_KEPT);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('shows shared principles to the proposer without replacing the local playbook', () => {
    const node = { id: 'D1.1', parentId: 'D1', question: 'q', method: 'lookup', status: 'weak' };
    const project = { nodes: [{ id: 'Q' }, { id: 'D1', parentId: 'Q' }, node], improve: { trials: [] } };
    const principles = principlesFrom(['a', 'b', 'c'].flatMap((id) => lessonsFromTrials([trial(id, 'add a second independent source', 'kept')], { researchId: id })), 'sub-question|lookup|fact');
    const plain = playbookText(project, node);
    const shared = playbookText(project, node, { principles });
    expect(plain.principles).toBe(0);
    expect(shared.principles).toBe(1);
    expect(shared.text).toContain('PRINCIPLES LEARNED IN OTHER RESEARCHES');
    expect(shared.text).toContain('add a second independent source: helps');
  });
});
