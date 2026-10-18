import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../src/llm/scripted-provider.mjs';
import { ModelRouter } from '../../src/llm/router.mjs';
import { ResearchEngine } from '../../src/research/engine.mjs';
import { SubIssueSuggester, gradeSuggestion } from '../../src/research/suggest.mjs';
import { ProjectStore } from '../../src/store.mjs';

const sources = [{ id: 'S1', title: 'Report', url: 'https://r.example', text: 'Demand for kiosks rose 12% in Brno last year.' }];

describe('gradeSuggestion', () => {
  it('marks a suggestion quoted only when the quote is in a cited source, and drops invented ids', () => {
    expect(gradeSuggestion({ question: 'q', sourceIds: ['S1'], quote: 'kiosks rose 12% in Brno' }, sources).grounded).toBe('quoted');
    expect(gradeSuggestion({ question: 'q', sourceIds: ['S1'], quote: 'made up phrase here' }, sources).grounded).toBe('cited');
    const invented = gradeSuggestion({ question: 'q', sourceIds: ['S7'], quote: 'kiosks rose 12% in Brno' }, sources);
    expect(invented.grounded).toBe('ungrounded');
    expect(invented.sourceIds).toEqual([]);
  });
});

describe('SubIssueSuggester', () => {
  it('searches first, asks the model, grades and stores the suggestions on the node', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-suggest-'));
    const search = { enabled: true, lastErrors: [], search: async () => sources.map(({ id, ...s }) => ({ ...s, kind: 'web' })), describe: () => ({}) };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search, store: new ProjectStore({ dir }) });
    const project = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    await engine.buildTree(project.id);
    const result = await new SubIssueSuggester({ engine }).suggest(project.id, 'D1');
    expect(result.items.map((i: { grounded: string }) => i.grounded)).toEqual(['cited', 'ungrounded']);
    expect(result.sources).toEqual([{ id: 'S1', title: 'Report', url: 'https://r.example' }]);
    const saved = await engine.load(project.id);
    expect(saved.nodes.find((n: { id: string }) => n.id === 'D1').suggestions.items).toHaveLength(2);
    await new SubIssueSuggester({ engine }).suggest(project.id, 'Q');
    expect((await engine.load(project.id)).rootSuggestions.items).toHaveLength(2);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});
