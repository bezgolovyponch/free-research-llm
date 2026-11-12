import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { playbookText } from '../../src/research/playbook.mjs';
import { helpsOnly } from '../../src/research/improve.mjs';
import { LESSONS_KEPT, LessonBook, PRINCIPLE_MIN_TESTS, kindOf, lessonsFromTrials, principlesFrom } from '../../src/research/lessons.mjs';

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

describe('lessons: principles stay inside one item kind and only when they help', () => {
  const SUPPLIER_CHANGE = 'Replace the search-engine lookups with brand-filtered category pages on https://www.zagumi.com/nl/used-clothing/ and https://accio.com/supplier/germany-wholesaler-used-clothes';
  const PLOT_CHANGE = 'Read the listing page itself, e.g. https://www.imovirtual.com/pt/anuncio/terreno-rustico-em-paiao-figueira-da-foz-ID1j2CX, not the search snippet';
  const HELPS_CHANGE = 'Open every candidate page https://www.pisos.com/comprar/terreno-saron-48422526045_518908/ in full before scoring it';

  it('stores the research item kind on every lesson', () => {
    const lessons = lessonsFromTrials([trial('r1', PLOT_CHANGE, 'kept')], { researchId: 'r1', kind: 'plot of land' });
    expect(lessons[0]).toMatchObject({ researchId: 'r1', kind: 'plot of land' });
    expect(lessonsFromTrials([trial('r1', PLOT_CHANGE, 'kept')], { researchId: 'r1' })[0].kind).toBe('');
    expect(kindOf({ brief: { kind: { label: 'plot of land' } } })).toBe('plot of land');
    expect(kindOf({ decisionModel: { kind: { label: 'wholesale second-hand clothing supplier' } } })).toBe('wholesale second-hand clothing supplier');
    expect(kindOf({})).toBe('');
  });

  it('does not share a supplier-kind lesson with a plot-kind research, and never shares kindless lessons', async () => {
    const book = new LessonBook();
    const supplier = ['s1', 's2', 's3'].flatMap((id) => lessonsFromTrials([trial(id, SUPPLIER_CHANGE, 'kept')], { researchId: id, kind: 'wholesale second-hand clothing supplier' }));
    const plot = ['p1', 'p2', 'p3'].flatMap((id) => lessonsFromTrials([trial(id, PLOT_CHANGE, 'kept')], { researchId: id, kind: 'plot of land' }));
    const kindless = lessonsFromTrials([trial('k1', 'add a second independent source', 'kept')], { researchId: 'k1' });
    await book.add([...supplier, ...plot, ...kindless]);
    const forPlot = await book.forType('sub-question|lookup|fact', { excludeResearch: 'b7772e', kind: 'plot of land' });
    expect(forPlot.map((l) => l.researchId).sort()).toEqual(['p1', 'p2', 'p3']);
    const forSupplier = await book.forType('sub-question|lookup|fact', { excludeResearch: 'b7772e', kind: 'wholesale second-hand clothing supplier' });
    expect(forSupplier.length).toBe(3);
    expect((await book.forType('sub-question|lookup|fact', { excludeResearch: 'b7772e' })).length).toBe(0);
  });

  it('passes only same-kind helps principles to the playbook, never mixed ones', async () => {
    const book = new LessonBook();
    const mixed = ['m1', 'm2', 'm3'].flatMap((id, i) => lessonsFromTrials([trial(id, PLOT_CHANGE, i === 0 ? 'kept' : 'reverted-whole')], { researchId: id, kind: 'plot of land' }));
    const helps = ['h1', 'h2', 'h3'].flatMap((id) => lessonsFromTrials([trial(id, HELPS_CHANGE, 'kept')], { researchId: id, kind: 'plot of land' }));
    const supplier = ['s1', 's2', 's3'].flatMap((id) => lessonsFromTrials([trial(id, SUPPLIER_CHANGE, 'kept')], { researchId: id, kind: 'wholesale second-hand clothing supplier' }));
    await book.add([...mixed, ...helps, ...supplier]);
    const others = await book.forType('sub-question|lookup|fact', { excludeResearch: 'b7772e', kind: 'plot of land' });
    const principles = helpsOnly(principlesFrom(others, 'sub-question|lookup|fact'));
    expect(principles.map((p) => p.verdict)).toEqual(['helps']);
    const node = { id: 'D1.1', parentId: 'D1', question: 'q', method: 'lookup', status: 'weak' };
    const project = { id: 'b7772e', nodes: [{ id: 'Q' }, { id: 'D1', parentId: 'Q' }, node], improve: { trials: [] } };
    const playbook = playbookText(project, node, { principles });
    expect(playbook.text).toContain(HELPS_CHANGE + ': helps');
    expect(playbook.text).not.toContain('mixed');
    expect(playbook.text).not.toContain(SUPPLIER_CHANGE);
  });
});
