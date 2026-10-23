import { describe, expect, it } from 'vitest';
import { mergeTrial, removedBy, trialConflict } from '../../src/research/trialmerge.mjs';

const node = (id: string, parentId: string | null, extra: object = {}) => ({ id, parentId, title: id, question: `${id}?`, searchQueries: [], sourceUrls: [], method: 'search', dependsOn: [], status: 'verified', answer: `${id} answer`, ...extra });
const base = () => ({ question: 'Q?', nodes: [node('D1', 'Q'), node('D1.1', 'D1'), node('D1.2', 'D1'), node('D2', 'Q'), node('D2.1', 'D2', { dependsOn: ['D1.1'] })] });

describe('trialConflict', () => {
  it('lets two trials on different pieces both land, even after the shared parents were re-rolled', () => {
    const snapshot = base();
    const trial = structuredClone(snapshot);
    trial.nodes[2] = { ...trial.nodes[2], question: 'sharper D1.2?', answer: 'new' };
    trial.nodes[0].status = 'pending';
    const current = structuredClone(snapshot);
    current.nodes[4] = { ...current.nodes[4], searchQueries: ['other lane'] };
    current.nodes[0] = { ...current.nodes[0], answer: 'rolled up again', status: 'supported' };
    expect(trialConflict(snapshot, current, trial, ['D1.2'])).toBeNull();
  });

  it('refuses a trial whose piece another change edited, removed, or whose new id is taken', () => {
    const snapshot = base();
    const trial = structuredClone(snapshot);
    trial.nodes[2].question = 'mine';
    const edited = structuredClone(snapshot);
    edited.nodes[2].question = 'theirs';
    expect(trialConflict(snapshot, edited, trial, ['D1.2'])).toBe('D1.2 was changed meanwhile');
    const gone = { ...snapshot, nodes: snapshot.nodes.filter((n) => n.id !== 'D1.2') };
    expect(trialConflict(snapshot, gone, trial, ['D1.2'])).toBe('D1.2 was removed meanwhile');
    const adding = structuredClone(snapshot);
    adding.nodes.push(node('D3', 'Q'));
    const taken = structuredClone(snapshot);
    taken.nodes.push(node('D3', 'Q', { question: 'their D3' }));
    expect(trialConflict(snapshot, taken, adding, ['D3'])).toBe('D3 was added by another change meanwhile');
  });
});

describe('mergeTrial', () => {
  it('applies only the trial pieces onto the latest research and keeps what other lanes did', () => {
    const snapshot = base();
    const trial = structuredClone(snapshot);
    trial.nodes[2] = { ...trial.nodes[2], question: 'sharper', answer: 'mine' };
    const current = structuredClone(snapshot);
    current.nodes[4] = { ...current.nodes[4], answer: 'other lane kept this' };
    const merged = mergeTrial(current, snapshot, trial, ['D1.2']);
    expect(merged.nodes.find((n: { id: string }) => n.id === 'D1.2')).toMatchObject({ question: 'sharper', answer: 'mine' });
    expect(merged.nodes.find((n: { id: string }) => n.id === 'D2.1')?.answer).toBe('other lane kept this');
    expect(current.nodes[2].question).toBe('D1.2?');
  });

  it('removes a dropped driver with its whole branch and cleans dependencies on it', () => {
    const snapshot = base();
    const trial = { ...structuredClone(snapshot), nodes: structuredClone(snapshot).nodes.filter((n: { id: string; parentId: string | null }) => n.id !== 'D1' && n.parentId !== 'D1') };
    expect(removedBy(snapshot, trial)).toEqual(['D1', 'D1.1', 'D1.2']);
    const merged = mergeTrial(structuredClone(snapshot), snapshot, trial, ['D1']);
    expect(merged.nodes.map((n: { id: string }) => n.id)).toEqual(['D2', 'D2.1']);
    expect(merged.nodes[1].dependsOn).toEqual([]);
  });
});
