import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectJournal, diffProject, emptyShadow, journalEntry, listingUrlsOf, lostPieces, replayJournal, researched, rowFactsKey, shadowOf, undoEntry } from '../src/journal.mjs';
import { KEPT_ROWS, driverNode, pendingNode, plotResearch, researchedNode, sweepPage } from './helpers/research-shapes';

describe('researched', () => {
  it('counts a piece as researched when it holds a finding, sources, listings or the user\'s files', () => {
    expect(researched(researchedNode())).toBe(true);
    expect(researched(pendingNode())).toBe(false);
    expect(researched({ ...pendingNode(), sources: [{ id: 'S1', url: 'https://www.imovirtual.com/pt/anuncio/terreno-bombarral-ID1jc4M' }] })).toBe(true);
    expect(researched({ ...pendingNode(), listings: [{ url: 'https://www.imovirtual.com/pt/anuncio/terreno-bombarral-ID1jc4M' }] })).toBe(true);
    expect(researched({ ...pendingNode(), attachments: [{ id: 'U1', name: 'plots.csv' }] })).toBe(true);
    expect(researched({ ...pendingNode(), status: 'covered', coveredBy: 'candidate-table' })).toBe(false);
  });
});

describe('diffProject', () => {
  it('reports removed and replaced pieces with their full previous content and added ones by id', () => {
    const before = plotResearch();
    const shadow = shadowOf(before);
    const after = structuredClone(before);
    after.nodes = after.nodes.filter((n) => n.id !== 'D1.1');
    after.nodes[0].finding = null;
    after.nodes.push(pendingNode('D3'));
    const diff = diffProject(shadow, after);
    expect(diff.nodes).toMatchObject({ before: 3, after: 3, added: ['D3'] });
    expect(diff.nodes.removed).toHaveLength(1);
    expect(diff.nodes.removed[0]).toMatchObject({ index: 1, id: 'D1.1' });
    expect(diff.nodes.removed[0].node.finding.answer).toBe(researchedNode().finding.answer);
    expect(diff.nodes.replaced.map((r) => r.id)).toEqual(['D1']);
    expect(diff.nodes.replaced[0].node.finding.answer).toBe(driverNode().finding.answer);
    expect(lostPieces(diff)).toEqual(['D1.1']);
    expect(diff.sweepChanged).toBe(false);
  });

  it('does not count a pending piece as lost, and an unchanged save as any change', () => {
    const before = plotResearch();
    const shadow = shadowOf(before);
    const same = diffProject(shadow, structuredClone(before));
    expect(same.nodes).toMatchObject({ removed: [], replaced: [], added: [] });
    expect(same.rows).toMatchObject({ removed: [], moved: [], replaced: [], added: [] });
    const after = structuredClone(before);
    after.nodes = after.nodes.filter((n) => n.id !== 'D2');
    const diff = diffProject(shadow, after);
    expect(diff.nodes.removed.map((r) => r.id)).toEqual(['D2']);
    expect(lostPieces(diff)).toEqual([]);
  });

  it('tells a kept row that left the research from one that only left the table or changed its facts', () => {
    const before = plotResearch();
    const shadow = shadowOf(before);
    const after = structuredClone(before);
    const [gone, moved, repriced] = KEPT_ROWS.map((r) => r.url);
    after.candidates.kept = after.candidates.kept.filter((r) => r.url !== gone && r.url !== moved);
    after.candidates.toCheck = [{ ...KEPT_ROWS[1], toCheck: 'price far below what most listings of this kind cost' }];
    after.sweep.pages = [sweepPage(KEPT_ROWS.slice(1))];
    after.candidates.kept[0] = { ...after.candidates.kept[0], price: 5200, value: 5200, site: { coastKm: 7.2 } };
    const diff = diffProject(shadow, after);
    expect(diff.rows).toMatchObject({ before: 3, after: 1 });
    expect(diff.rows.removed).toHaveLength(1);
    expect(diff.rows.removed[0]).toMatchObject({ index: 0, url: gone });
    expect(diff.rows.removed[0].row).toEqual(KEPT_ROWS[0]);
    expect(diff.rows.moved).toEqual([{ index: 1, url: moved }]);
    expect(diff.rows.replaced).toHaveLength(1);
    expect(diff.rows.replaced[0]).toMatchObject({ index: 2, url: repriced, row: { price: 4900 } });
    expect(diff.sweepChanged).toBe(true);
  });

  it('ignores measurement changes on a row whose listing facts stayed the same', () => {
    const before = plotResearch();
    const after = structuredClone(before);
    after.candidates.kept[0].site = { coastKm: 18.9 };
    after.candidates.kept[0].verified = { verdict: 'confirmed', failed: [], at: '2026-11-12T15:00:00.000Z' };
    after.candidates.kept[0].plan = { tier: 'trade-off' };
    const diff = diffProject(shadowOf(before), after);
    expect(diff.rows.replaced).toEqual([]);
    expect(rowFactsKey(before.candidates.kept[0])).toBe(rowFactsKey(after.candidates.kept[0]));
    expect(rowFactsKey(before.candidates.kept[0])).not.toBe(rowFactsKey({ ...before.candidates.kept[0], price: 1 }));
  });

  it('collects the listing urls from every holder a row can live in', () => {
    const project = plotResearch();
    project.nodes[1].listings = [{ url: 'https://www.imovirtual.com/pt/anuncio/terreno-bombarral-ID1jc4M' }];
    project.nodes[1].finding.rejected = [{ url: 'https://www.olx.pt/d/anuncio/cede-se-jazigo-4-6-lugares-IDJEXGe.html' }];
    const urls = listingUrlsOf(project);
    for (const row of KEPT_ROWS) expect(urls.has(row.url)).toBe(true);
    expect(urls.has('https://www.imovirtual.com/pt/anuncio/terreno-bombarral-ID1jc4M')).toBe(true);
    expect(urls.has('https://www.olx.pt/d/anuncio/cede-se-jazigo-4-6-lugares-IDJEXGe.html')).toBe(true);
    expect(emptyShadow()).toMatchObject({ nodeCount: 0, rowCount: 0 });
  });
});

describe('undo and replay', () => {
  it('journal replay restores a removed node\'s findings and a removed row, and drops what was added after the cut', async () => {
    const original = plotResearch();
    let shadow = shadowOf(original);
    const entries = [];
    const record = (project, reason, ts) => {
      const diff = diffProject(shadow, project);
      entries.push(journalEntry({ id: project.id, reason, userAction: null, diff, ts }));
      shadow = diff.next;
    };
    const step1 = structuredClone(original);
    step1.nodes = step1.nodes.filter((n) => n.id !== 'D1.1');
    step1.candidates.kept = step1.candidates.kept.slice(1);
    step1.sweep.pages = [sweepPage(KEPT_ROWS.slice(1))];
    record(step1, 'delete: D1.1 removed by the user', '2026-11-12T10:00:00.000Z');
    const step2 = structuredClone(step1);
    step2.nodes.push(pendingNode('D3'));
    step2.nodes[0].finding = { ...step2.nodes[0].finding, answer: 'rewritten later' };
    record(step2, 'D3: added by the user', '2026-11-12T11:00:00.000Z');
    const rebuilt = structuredClone(step2);
    const totals = replayJournal(rebuilt, entries, { before: '2026-11-12T10:00:00.000Z' });
    expect(totals).toMatchObject({ entries: 2, nodes: { restored: 1, reverted: 1, dropped: 1 }, rows: { restored: 1 } });
    expect(rebuilt.nodes.map((n) => n.id)).toEqual(['D1', 'D1.1', 'D2']);
    expect(rebuilt.nodes[1].finding.answer).toBe(researchedNode().finding.answer);
    expect(rebuilt.nodes[0].finding.answer).toBe(driverNode().finding.answer);
    expect(rebuilt.candidates.kept.map((r) => r.url)).toEqual(KEPT_ROWS.map((r) => r.url));
    const later = structuredClone(step2);
    expect(replayJournal(later, entries, { before: '2026-11-12T10:30:00.000Z' })).toMatchObject({ entries: 1, nodes: { restored: 0, reverted: 1, dropped: 1 } });
    expect(later.nodes.map((n) => n.id)).toEqual(['D1', 'D2']);
  });

  it('undoEntry puts a restored piece back where it was and never duplicates one that is present', () => {
    const project = plotResearch();
    const entry = journalEntry({ id: project.id, reason: 'x', userAction: 'delete', diff: diffProject(shadowOf(project), { ...project, nodes: project.nodes.filter((n) => n.id !== 'D1') }) });
    const counts = undoEntry(project, entry);
    expect(counts.nodes).toEqual({ restored: 0, reverted: 0, dropped: 0 });
    expect(project.nodes.map((n) => n.id)).toEqual(['D1', 'D1.1', 'D2']);
    const without = { ...project, nodes: project.nodes.filter((n) => n.id !== 'D1') };
    expect(undoEntry(without, entry).nodes.restored).toBe(1);
    expect(without.nodes.map((n) => n.id)).toEqual(['D1', 'D1.1', 'D2']);
  });
});

describe('ProjectJournal', () => {
  it('appends one line per entry, reads them back in order, skips a torn line and summarises removals', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-journal-'));
    const journal = new ProjectJournal({ dir });
    const project = plotResearch();
    const diff = diffProject(shadowOf(project), { ...project, nodes: project.nodes.filter((n) => n.id !== 'D1.1') });
    await journal.append(project.id, journalEntry({ id: project.id, reason: 'research created', userAction: null, diff: diffProject(emptyShadow(), project), ts: '2026-11-12T09:00:00.000Z' }));
    await journal.append(project.id, journalEntry({ id: project.id, reason: 'delete: D1.1 removed by the user', userAction: 'delete', diff, ts: '2026-11-12T10:00:00.000Z' }));
    await fs.appendFile(journal.file(project.id), '{"ts":"2026-11-12T10:30:00.0');
    const entries = await journal.read(project.id);
    expect(entries.map((e) => e.ts)).toEqual(['2026-11-12T09:00:00.000Z', '2026-11-12T10:00:00.000Z']);
    expect(entries[0].nodes.added).toEqual(['D1', 'D1.1', 'D2']);
    expect(entries[1].nodes.removed[0].node.sources).toEqual(researchedNode().sources);
    expect(await journal.summary(project.id)).toMatchObject({ entries: 2, first: '2026-11-12T09:00:00.000Z', last: '2026-11-12T10:00:00.000Z', removals: [{ ts: '2026-11-12T10:00:00.000Z', userAction: 'delete', nodes: ['D1.1'], rows: 0 }] });
    expect(await journal.read('never-saved-research')).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
