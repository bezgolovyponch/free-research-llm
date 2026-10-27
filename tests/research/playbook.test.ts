import { describe, expect, it } from 'vitest';
import { HARMFUL_LIMIT, demonstrations, frontier, gateTrace, ledger, pieceType, playbookText, refusedByLedger, similarChange, typeStats } from '../../src/research/playbook.mjs';

const node = (id: string, parentId: string, more = {}) => ({ id, parentId, title: id, question: `find land listings ${id}`, method: 'lookup', status: 'weak', searchQueries: [], sourceUrls: [], ...more });
const nodes = [node('D1', 'Q'), node('D1.1', 'D1'), node('D1.2', 'D1', { status: 'verified', searchQueries: ['terreno rustico venda'], sourceUrls: ['https://imo.example/r', 'https://gov.example/never-read'], sources: [{ url: 'https://imo.example/r', text: 'terrenos' }, { url: 'https://gov.example/never-read', text: '' }] }), node('D2', 'Q', { question: 'tax rate', method: 'calculation' }), node('D1.3', 'D1')];
const trial = (nodeId: string, before: number, score: number, outcome = 'kept', more = {}) => ({ at: '2026-10-26T10:00:00Z', nodeId, before, score, outcome, change: `change on ${nodeId} ${score}`, ...more });

describe('playbook: GEPA-style reflection, Pareto frontier of kept changes, demonstrations (arXiv 2507.19457, 2310.03714)', () => {
  it('types a piece by its level, method and whether it asks for listings', () => {
    expect(pieceType(nodes[1])).toBe('sub-question|lookup|list');
    expect(pieceType(nodes[3])).toBe('driver|calculation|fact');
    expect(pieceType({ id: 'Q' })).toBe('root');
  });

  it('keeps, for each piece, only its best kept change: the frontier of changes that won somewhere', () => {
    const trials = [trial('D1.1', 0.3, 0.31), trial('D1.1', 0.31, 0.35), trial('D1.3', 0.35, 0.36), trial('D1.3', 0.36, 0.2, 'reverted-whole'), trial('D2', 0.4, 0.5)];
    const front = frontier(trials, nodes, 'sub-question|lookup|list');
    expect(front.map((f: { nodeId: string; gain: number }) => [f.nodeId, f.gain])).toEqual([['D1.1', 0.04], ['D1.3', 0.01]]);
    expect(frontier(trials, nodes).map((f: { nodeId: string }) => f.nodeId)).toEqual(['D2', 'D1.1', 'D1.3']);
  });

  it('turns the failed gates, reviewer objections and reported gaps into the trace the proposer must diagnose', () => {
    const traced = gateTrace({ verification: { failures: ['no quote'], checks: [{ id: 'attribution', label: 'Each claim is backed by a quote', passed: false, detail: '2 of 3' }, { id: 'answer', label: 'Answers', passed: true }] }, critique: { issues: ['ignores Turkey'] }, finding: { gaps: ['no prices for Vietnam'] } });
    expect(traced).toEqual(['no quote', 'Each claim is backed by a quote: 2 of 3', 'reviewer: ignores Turkey', 'gap: no prices for Vietnam']);
  });

  it('shows the proposer the frontier of other pieces of the same type and verified pieces of that type with only the pages they actually read, never its own past wins', () => {
    const project = { nodes, improve: { trials: [trial('D1.1', 0.3, 0.35, 'kept', { diagnosis: 'no local-language query' }), trial('D1.3', 0.35, 0.36)] } };
    const book = playbookText(project, nodes[1]);
    expect(book).toMatchObject({ lessons: 1, demos: 1 });
    expect(book.text).toContain('- D1.3 +0.01: change on D1.3 0.36');
    expect(book.text).not.toContain('D1.1 +');
    expect(book.text).toContain('- D1.2: find land listings D1.2 · queries: terreno rustico venda · pages: https://imo.example/r');
    expect(book.text).not.toContain('never-read');
    expect(demonstrations(project, nodes[3])).toEqual([]);
  });

  it('measures, per piece type, how often a tested change is kept with and without that guidance (MAS-PromptBench: measure, do not assume)', () => {
    const trials = [trial('D1.1', 0.3, 0.35, 'kept', { guided: true }), trial('D1.3', 0.35, 0.3, 'reverted-whole', { guided: true }), trial('D1.3', 0.35, 0.35, 'no-gain'), trial('D1.1', 0.35, 0.35, 'repeat')];
    expect(typeStats(trials, nodes)).toEqual({ 'sub-question|lookup|list': { tested: 3, kept: 1, guided: { tested: 2, kept: 1 }, unguided: { tested: 1, kept: 0 } } });
  });

  it('keeps an ACE-style ledger of similar changes with helpful and harmful counts per piece type (arXiv 2510.04618)', () => {
    const portal = (nodeId: string, outcome: string, place: string) => trial(nodeId, 0.4, 0.4, outcome, { change: `Add local-language portal queries and direct listing URLs for rustic land in ${place}` });
    const trials = [portal('D1.1', 'reverted-whole', 'Portugal'), portal('D1.3', 'no-gain', 'Spain'), portal('D1.1', 'reverted-noise', 'Greece'), portal('D1.3', 'repeat', 'Turkey'), trial('D1.3', 0.4, 0.45, 'kept', { change: 'Read the cadastre export for Mira instead of portals' })];
    const book = ledger(trials, nodes, 'sub-question|lookup|list');
    expect(book.map((b: { helpful: number; harmful: number; pieces: string[] }) => [b.helpful, b.harmful, b.pieces])).toEqual([[0, 3, ['D1.1', 'D1.3']], [1, 0, ['D1.3']]]);
    expect(HARMFUL_LIMIT).toBe(3);
    expect(refusedByLedger(trials, nodes, 'sub-question|lookup|list', 'Add local-language portal queries and direct listing URLs for rustic land in Vietnam')).toMatchObject({ harmful: 3 });
    expect(refusedByLedger(trials, nodes, 'sub-question|lookup|list', 'Read the land registry open data for Algarve')).toBeNull();
    expect(refusedByLedger(trials.slice(0, 2), nodes, 'sub-question|lookup|list', 'Add local-language portal queries and direct listing URLs for rustic land in Vietnam')).toBeNull();
    expect(similarChange('Add node D7 to search coastal plots', 'Add node D6 to search coastal plots')).toBe(1);
    const shown = playbookText({ nodes, improve: { trials } }, nodes[4]);
    expect(shown.failing).toBe(1);
    expect(shown.text).toContain('- tested 3 times on 2 piece(s), 0 kept: Add local-language portal queries');
  });
});
