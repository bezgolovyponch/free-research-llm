import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelRouter } from '../src/llm/router.mjs';
import { ScriptedProvider } from '../src/llm/scripted-provider.mjs';
import { ResearchEngine } from '../src/research/engine.mjs';
import { toMarkdown } from '../src/report.mjs';
import { ProjectStore } from '../src/store.mjs';

describe('toMarkdown', () => {
  it('renders verdict, numbers, tree, checks and source links', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-report-'));
    const search = { enabled: true, lastErrors: [], search: async () => [{ kind: 'web', title: 'Src', url: 'https://x.example/', domain: 'x.example', text: 't' }] };
    const engine = new ResearchEngine({ router: new ModelRouter({ providers: [new ScriptedProvider()] }), search, store: new ProjectStore({ dir }), demo: true });
    const project = await engine.createProject({ question: 'Flat-rate tax or s.r.o. for a Czech freelancer?' });
    const md = toMarkdown(await engine.run(project.id));
    expect(md).toMatch(/^# Flat-rate tax/);
    expect(md).toMatch(/DEMO MODE/);
    expect(md).toMatch(/## Verdict/);
    expect(md).toMatch(/\| Net margin per unit \| 300 EUR \| D2\.2 \|/);
    expect(md).toMatch(/### D1 · Demand/);
    expect(md).toMatch(/\[S1\] \[Src\]\(https:\/\/x\.example\/\)/);
    expect(md).toMatch(/✔ Calculation recomputes/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('results export', () => {
  const p = {
    id: 'p1',
    question: 'Golf DE vs CZ?',
    acceptance: { expected: '10 listings' },
    report: { verdict: 'PROVISIONAL (low confidence; 1 piece to fix, research or clarify) — GO-IF transport < 400 EUR', confidence: 'low', summary: 's', keyNumbers: [], scenarios: [], sensitivity: [], risks: [], openQuestions: [], nextSteps: [], evidenceQuality: { verified: 1, total: 2, weak: ['D2'] }, bestEstimate: { value: '18', unit: '% margin', low: '9', high: '24', basis: 'D1, D2' } },
    acceptanceResult: { score: 0.5, checks: [], items: [{ title: 'Golf, "2012"', value: 2400, currency: 'EUR', url: 'https://m.de/1', nodeId: 'D1' }] },
    nodes: [
      { id: 'D1', parentId: 'Q', title: 'Prices', question: 'q', status: 'verified', finding: { answer: '=SUM(A1)', claims: [], gaps: [] }, sources: [{ id: 'S1', title: 't', url: 'https://m.de/1' }] },
      { id: 'D2', parentId: 'Q', title: 'Transport', question: 'q', status: 'weak', impact: 5, uncertainty: 5, finding: { answer: 'about 400', claims: [], gaps: ['carrier quotes'] }, verification: { checks: [] } },
    ],
  };

  it('exports pieces with their action, delivered items and everything as JSON; the markdown carries the estimate and the plan', async () => {
    const { csvField, itemsCsv, piecesCsv, resultsJson } = await import('../src/report.mjs');
    const pieces = piecesCsv(p).split('\r\n');
    expect(pieces[0]).toBe('piece,title,role,grade,answer,action,why,next step,priority,moves the verdict,sources,first source');
    expect(pieces[1]).toBe("D1,Prices,driver,verified,'=SUM(A1),Done,,,,,1,https://m.de/1");
    expect(pieces[2]).toContain('D2,Transport,driver,weak,about 400,Research further');
    expect(pieces[2]).toContain('Search for: carrier quotes');
    expect(itemsCsv(p).split('\r\n')[1]).toBe('"Golf, ""2012""",2400,EUR,https://m.de/1,D1,,');
    expect(csvField('-cmd')).toBe("'-cmd");
    const json = resultsJson(p);
    expect(json).toMatchObject({ bestEstimate: { value: '18' }, confidence: { provisional: true, byChecks: 'low' }, actions: [{ nodeId: 'D2', action: 'research' }], items: [{ url: 'https://m.de/1' }] });
    expect(json.pieces[0].sources).toEqual([{ id: 'S1', title: 't', url: 'https://m.de/1' }]);
    const md = toMarkdown(p as never);
    expect(md).toContain('**Best estimate:** 18 % margin (range 9–24) · rests on D1, D2');
    expect(md).toContain('## What to fix, research further or clarify');
    expect(md).toContain('| D2 · Transport | Research further |');
  });
});
