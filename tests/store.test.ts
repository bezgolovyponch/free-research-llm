import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectStore, RemovalRefusedError, StoreBusyError, storePaths } from '../src/store.mjs';
import { KEPT_ROWS, PROJECT_ID, driverNode, pendingNode, plotResearch, researchedNode, sweepPage } from './helpers/research-shapes';

describe('ProjectStore', () => {
  it('saves atomically, lists newest first, removes, and rejects path tricks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-store-'));
    const store = new ProjectStore({ dir });
    const a = store.newId('Cars in Germany?');
    expect(a).toMatch(/^cars-in-germany-[0-9a-f]{6}$/);
    await store.save({ id: a, question: 'A', phase: 'done' });
    await new Promise((r) => setTimeout(r, 5));
    await store.save({ id: 'second-project', question: 'B', phase: 'created' });
    expect((await new ProjectStore({ dir }).list()).map((p) => p.question)).toEqual(['B', 'A']);
    await store.remove(a);
    expect(await store.get(a)).toBeNull();
    await expect(store.get('../etc/passwd')).rejects.toThrow(/invalid project id/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('ProjectStore.list', () => {
  it('ignores JSON files in the folder that are not projects', async () => {
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { ProjectStore } = await import('../src/store.mjs');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frl-store-list-'));
    await fsp.writeFile(path.join(dir, 'app-chat.json'), JSON.stringify([{ role: 'user', content: 'hi' }]));
    const store = new ProjectStore({ dir });
    await store.save({ id: 'real-question-abc123', question: 'real question?', nodes: [] });
    expect((await store.list()).map((p: { id: string }) => p.id)).toEqual(['real-question-abc123']);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});


describe('ProjectStore memory bound', () => {
  it('keeps only the most recently used researches in memory, never drops a busy one, and lists without loading everything', async () => {
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { ProjectStore } = await import('../src/store.mjs');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frl-store-lru-'));
    const busy = new Set(['busy-research-000001']);
    const store = new ProjectStore({ dir, maxCached: 2, isBusy: (id: string) => busy.has(id) });
    for (const id of ['busy-research-000001', 'second-research-02', 'third-research-003', 'fourth-research-04']) await store.save({ id, question: `${id}?`, nodes: [] });
    expect([...store.cache.keys()].sort()).toEqual(['busy-research-000001', 'fourth-research-04']);
    const third = await store.get('third-research-003');
    expect(third.question).toBe('third-research-003?');
    expect(store.cache.has('fourth-research-04')).toBe(false);
    expect(store.cache.has('busy-research-000001')).toBe(true);
    expect((await store.list()).map((p: { id: string }) => p.id).sort()).toEqual(['busy-research-000001', 'fourth-research-04', 'second-research-02', 'third-research-003']);
    expect(store.cache.size).toBe(2);
    expect(await store.get('second-research-02')).toMatchObject({ question: 'second-research-02?' });
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('ProjectStore.list summaries', () => {
  it('parses a research file again only when it changed on disk', async () => {
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { ProjectStore } = await import('../src/store.mjs');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'frl-store-sum-'));
    const writer = new ProjectStore({ dir });
    await writer.save({ id: 'first-research-01', question: 'first?', nodes: [] });
    const reader = new ProjectStore({ dir, maxCached: 0 });
    const reads: string[] = [];
    const original = reader.readFile.bind(reader);
    reader.readFile = async (id: string) => { reads.push(id); return original(id); };
    expect((await reader.list())[0].question).toBe('first?');
    await reader.list();
    expect(reads).toEqual(['first-research-01']);
    await new Promise((r) => setTimeout(r, 20));
    await writer.save({ id: 'first-research-01', question: 'changed?', nodes: [] });
    expect((await reader.list())[0].question).toBe('changed?');
    expect(reads).toEqual(['first-research-01', 'first-research-01']);
    await fsp.rm(path.join(dir, 'first-research-01.json'));
    expect(await reader.list()).toEqual([]);
    expect(reader.summaries.size).toBe(0);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('ProjectStore journal, snapshots and refusals', () => {
  async function fresh(options: Record<string, unknown> = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-store-journal-'));
    const events: Array<{ id: string; event: { type: string; message: string } }> = [];
    const store = new ProjectStore({ dir, onEvent: (id: string, event: { type: string; message: string }) => events.push({ id, event }), ...options });
    return { dir, store, events };
  }

  it('a removing save writes one snapshot and journals the removed content', async () => {
    const { dir, store } = await fresh();
    const project = plotResearch();
    await store.save(project, { reason: 'research created' });
    const storedBefore = await fs.readFile(store.file(project.id), 'utf8');
    project.nodes = project.nodes.filter((n) => n.id !== 'D1.1');
    project.candidates.kept = project.candidates.kept.slice(1);
    project.sweep.pages = [sweepPage(KEPT_ROWS.slice(1))];
    await store.save(project, { reason: 'delete: D1.1 removed by the user with 0 sub-node(s)', userAction: 'delete' });
    const snapshots = await store.snapshots(project.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].file).toMatch(new RegExp(`^${project.id}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.json$`));
    expect(await fs.readFile(snapshots[0].path, 'utf8')).toBe(storedBefore);
    const entries = await store.journal.read(project.id);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ reason: 'research created', userAction: null, nodes: { before: 0, after: 3, added: ['D1', 'D1.1', 'D2'] }, rows: { before: 0, after: 3 }, snapshot: null });
    expect(entries[1]).toMatchObject({ reason: 'delete: D1.1 removed by the user with 0 sub-node(s)', userAction: 'delete', snapshot: snapshots[0].file, nodes: { before: 3, after: 2 }, rows: { before: 3, after: 2 } });
    expect(entries[1].nodes.removed).toEqual([{ index: 1, id: 'D1.1', node: researchedNode() }]);
    expect(entries[1].rows.removed).toEqual([{ index: 0, url: KEPT_ROWS[0].url, row: KEPT_ROWS[0] }]);
    expect(JSON.parse(await fs.readFile(store.file(project.id), 'utf8')).nodes.map((n: { id: string }) => n.id)).toEqual(['D1', 'D2']);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('an automatic removal of a researched piece is refused, logged as an error, and leaves the stored copy and the cache untouched', async () => {
    const { dir, store, events } = await fresh();
    const project = plotResearch();
    await store.save(project);
    const storedBefore = await fs.readFile(store.file(project.id), 'utf8');
    project.nodes = project.nodes.filter((n) => n.id !== 'D1.1');
    await expect(store.save(project, { reason: 'start-of-run repairs' })).rejects.toBeInstanceOf(RemovalRefusedError);
    await expect(store.save(project)).rejects.toThrow(/would remove 1 researched piece\(s\) \(D1\.1\)/);
    expect(await fs.readFile(store.file(project.id), 'utf8')).toBe(storedBefore);
    expect(events.map((e) => e.event.type)).toEqual(['error', 'error']);
    expect(events[0].event.message).toMatch(/start-of-run repairs/);
    expect(events[0].id).toBe(project.id);
    expect(store.cache.has(project.id)).toBe(false);
    expect((await store.get(project.id)).nodes.map((n: { id: string }) => n.id)).toEqual(['D1', 'D1.1', 'D2']);
    expect(await store.journal.read(project.id)).toHaveLength(1);
    expect(await store.snapshots(project.id)).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a user-reason removal passes, while an unknown user action is a programming error', async () => {
    const { dir, store, events } = await fresh();
    const project = plotResearch();
    await store.save(project);
    const pending = project.nodes.filter((n) => n.id !== 'D1' && n.id !== 'D1.1');
    for (const action of ['delete', 're-decompose', 'restore', 'loop'] as const) {
      const copy = { ...structuredClone(project), nodes: structuredClone(pending) };
      await expect(store.save(copy, { reason: `${action} by the user`, userAction: action })).resolves.toBe(copy);
      await store.save(structuredClone(project), { reason: 'restore', userAction: 'restore' });
    }
    await expect(store.save(structuredClone(project), { userAction: 'repair' as never })).rejects.toThrow(/unknown user action "repair"/);
    const removable = { ...structuredClone(project), nodes: project.nodes.filter((n) => n.id !== 'D2') };
    await expect(store.save(removable, { reason: 'repair dropped a pending piece' })).resolves.toBe(removable);
    expect(events).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('the 6th snapshot drops the oldest', async () => {
    const { dir, store } = await fresh();
    const project = plotResearch({ nodes: [driverNode(), ...Array.from({ length: 7 }, (_, i) => pendingNode(`D${i + 2}`))] });
    await store.save(project);
    const written: string[] = [];
    for (let round = 0; round < 6; round++) {
      await new Promise((r) => setTimeout(r, 3));
      project.nodes = project.nodes.slice(0, -1);
      await store.save(project, { reason: `delete ${round}`, userAction: 'delete' });
      written.push((await store.snapshots(project.id))[0].file);
    }
    const left = await store.snapshots(project.id);
    expect(left).toHaveLength(5);
    expect(left.map((s) => s.file)).toEqual([...written].reverse().slice(0, 5));
    expect(await fs.readdir(store.snapshotDir)).not.toContain(written[0]);
    expect(JSON.parse(await fs.readFile(left[4].path, 'utf8')).nodes).toHaveLength(7);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a kept row that a new sweep no longer lists is journaled in full but takes no snapshot, and a row moved to another table takes neither', async () => {
    const { dir, store } = await fresh();
    const project = plotResearch();
    await store.save(project);
    project.candidates.kept = project.candidates.kept.slice(0, 2);
    project.candidates.toCheck = [KEPT_ROWS[2]];
    await store.save(project, { reason: 'table rebuilt' });
    expect(await store.snapshots(project.id)).toEqual([]);
    project.candidates.kept = project.candidates.kept.slice(1);
    project.sweep = { ...project.sweep, at: '2026-11-12T16:00:00.000Z', pages: [sweepPage(KEPT_ROWS.slice(1))] };
    await store.save(project, { reason: 'listings collected by code before the pieces' });
    expect(await store.snapshots(project.id)).toEqual([]);
    const entries = await store.journal.read(project.id);
    expect(entries[1].rows).toMatchObject({ removed: [], moved: [{ index: 2, url: KEPT_ROWS[2].url }] });
    expect(entries[2].rows.removed).toEqual([{ index: 0, url: KEPT_ROWS[0].url, row: KEPT_ROWS[0] }]);
    project.candidates.kept = [];
    await store.save(project, { reason: 'table rebuilt without a sweep: the rows stay on the sweep page' });
    expect(await store.snapshots(project.id)).toEqual([]);
    const held = plotResearch({ pages: [sweepPage([])] });
    held.id = 'rows-held-by-the-table-only';
    await store.save(held);
    held.candidates.kept = [];
    await store.save(held, { reason: 'table rebuilt without a sweep: the rows have no other holder' });
    expect(await store.snapshots(held.id)).toHaveLength(1);
    expect((await store.journal.read(held.id))[1].rows.removed.map((r: { url: string }) => r.url)).toEqual(KEPT_ROWS.map((r) => r.url));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('restore brings back the node and row counts from a snapshot and refuses while the research is running', async () => {
    const busy = new Set<string>();
    const { dir, store, events } = await fresh({ isBusy: (id: string) => busy.has(id) });
    const project = plotResearch();
    await store.save(project);
    project.nodes = project.nodes.filter((n) => n.id === 'D2');
    project.candidates.kept = [];
    project.sweep.pages = [];
    await store.save(project, { reason: 'delete: D1 removed by the user with 1 sub-node(s)', userAction: 'delete' });
    const [snapshot] = await store.snapshots(project.id);
    busy.add(project.id);
    await expect(store.restore(project.id, { snapshot: snapshot.file })).rejects.toBeInstanceOf(StoreBusyError);
    busy.delete(project.id);
    await expect(store.restore(project.id, {})).rejects.toThrow(/name a snapshot file or pass --before/);
    const result = await store.restore(project.id, { snapshot: snapshot.file });
    expect(result).toMatchObject({ ok: true, from: 'snapshot', nodes: { before: 1, after: 3 }, rows: { before: 0, after: 3 } });
    const restored = await store.get(project.id);
    expect(restored.nodes.map((n: { id: string }) => n.id)).toEqual(['D1', 'D1.1', 'D2']);
    expect(restored.candidates.kept).toEqual(KEPT_ROWS);
    expect(JSON.parse(await fs.readFile(store.file(project.id), 'utf8')).nodes).toHaveLength(3);
    const entries = await store.journal.read(project.id);
    expect(entries.at(-1)).toMatchObject({ userAction: 'restore', reason: `restore: snapshot ${snapshot.file}`, nodes: { before: 1, after: 3, added: ['D1', 'D1.1'] } });
    expect(events.at(-1)).toMatchObject({ id: project.id, event: { type: 'restore', message: `restored from snapshot ${snapshot.file}; pieces 1 → 3, kept rows 0 → 3` } });
    expect((await store.restorable(project.id)).snapshots[0]).toMatchObject({ file: snapshot.file, nodes: 3, rows: 3, phase: 'done' });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('journal replay restores a removed node findings when no snapshot is named', async () => {
    const { dir, store } = await fresh();
    const project = plotResearch();
    await store.save(project);
    await new Promise((r) => setTimeout(r, 3));
    project.nodes = project.nodes.filter((n) => n.id !== 'D1.1');
    await store.save(project, { reason: 'delete: D1.1 removed by the user', userAction: 'delete' });
    const removal = (await store.journal.read(project.id))[1];
    await fs.rm(store.snapshotDir, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 3));
    project.nodes[0].finding = { ...project.nodes[0].finding, answer: 'a later roll-up' };
    await store.save(project, { reason: 'D1: weak' });
    await expect(store.restore(project.id, { before: 'yesterday' })).rejects.toThrow(/ISO time/);
    await expect(store.restore(project.id, { before: '2030-01-01T00:00:00.000Z' })).rejects.toThrow(/no entry at or after/);
    const result = await store.restore(project.id, { before: removal.ts });
    expect(result).toMatchObject({ ok: true, from: 'journal', nodes: { before: 2, after: 3 } });
    expect(result.message).toMatch(/2 save\(s\) undone, pieces restored 1, reverted 1/);
    const restored = await store.get(project.id);
    expect(restored.nodes.find((n: { id: string }) => n.id === 'D1.1').finding).toEqual(researchedNode().finding);
    expect(restored.nodes[0].finding.answer).toBe(driverNode().finding.answer);
    expect((await store.journal.read(project.id)).at(-1)).toMatchObject({ userAction: 'restore', nodes: { added: ['D1.1'] } });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('builds its view of the stored copy from disk once when a research was saved by an earlier process', async () => {
    const { dir, store } = await fresh();
    await store.save(plotResearch());
    const later = new ProjectStore({ dir });
    const reads: string[] = [];
    const original = later.readFile.bind(later);
    later.readFile = async (id: string) => { reads.push(id); return original(id); };
    const project = await later.get(PROJECT_ID);
    project.nodes = project.nodes.filter((n: { id: string }) => n.id !== 'D1.1');
    await expect(later.save(project)).rejects.toBeInstanceOf(RemovalRefusedError);
    expect(reads).toEqual([PROJECT_ID]);
    const direct = new ProjectStore({ dir });
    const copy = { ...plotResearch(), nodes: [driverNode()] };
    await expect(direct.save(copy, { reason: 'repair' })).rejects.toThrow(/D1\.1/);
    expect(storePaths({ root: '/app' })).toEqual({ base: path.join('/app', 'data'), projects: path.join('/app', 'data', 'projects'), journal: path.join('/app', 'data', 'journal'), snapshots: path.join('/app', 'data', 'projects', 'snapshots'), logs: path.join('/app', 'data', 'logs') });
    expect(storePaths({ root: '/app', dataDir: '/tmp/d' })).toMatchObject({ projects: '/tmp/d', journal: path.join('/tmp/d', 'journal'), snapshots: path.join('/tmp/d', 'snapshots') });
    await fs.rm(dir, { recursive: true, force: true });
  });
});

