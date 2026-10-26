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
    const { candidatesCsv, csvField, itemsCsv, piecesCsv, resultsJson } = await import('../src/report.mjs');
    const pieces = piecesCsv(p).split('\r\n');
    expect(pieces[0]).toBe('piece,title,role,grade,answer,action,why,next step,priority,moves the verdict,sources,first source');
    expect(pieces[1]).toBe("D1,Prices,driver,verified,'=SUM(A1),Done,,,,,1,https://m.de/1");
    expect(pieces[2]).toContain('D2,Transport,driver,weak,about 400,Research further');
    expect(pieces[2]).toContain('Search for: carrier quotes');
    expect(itemsCsv(p).split('\r\n')[1]).toBe('"Golf, ""2012""",2400,EUR,https://m.de/1,D1,,');
    expect(csvField('-cmd')).toBe("'-cmd");
    const withTable = { ...p, candidates: { kept: [{ title: 'Terreno Aljezur', url: 'https://imo.example/a', price: 450000000, currency: 'VND', value: 15000, unit: 'EUR', area: 300, areaUnit: 'm²', place: 'Aljezur', country: 'Portugal', coast: true, sourceUrl: 'https://imo.example/r', via: ['json-ld', 'cards'], site: { coastKm: 2.5, beachKm: 3, beaches: 10, viewpoints: 12, attractions: 8, reserves: 2, protectedAreas: 4, hikingRoutes: 6, campsites: 3, lodging: 120, climate: { workable: 9, comfortable: 6, hottest: 27.5, coldest: 7 } }, fit: { score: 0.71, zoning: 'agricultural', pitches: 4 } }], toCheck: [{ title: 'No price', url: 'https://imo.example/b', price: null, currency: '', value: null, unit: 'EUR', area: null, areaUnit: '', place: '', country: '', coast: false, sourceUrl: '', via: [], toCheck: 'price not shown' }] } };
    expect(candidatesCsv(withTable).split('\r\n')).toEqual([
      'status,tier,verdict,entry cost EUR,area m²,units,lake km,why it fits,risks,legal path,title,price,currency,price in EUR,area,area unit,place,country,sea stated,url,found on,read by,missing,site fit,sea km,beach km,workable months,comfortable months,hottest month max °C,things to explore within 15 km,lodging within 15 km,zoning,pitches',
      'kept,,,,,,,,,,Terreno Aljezur,450000000,VND,15000,300,m²,Aljezur,Portugal,yes,https://imo.example/a,https://imo.example/r,json-ld cards,,0.71,2.5,3,9,6,27.5,42,120,agricultural,4',
      'to check,,,,,,,,,,No price,,,,,,,,,https://imo.example/b,,,price not shown,,,,,,,,,,',
      '',
    ]);
    expect(resultsJson(withTable).candidates.kept).toHaveLength(1);
    const planned = { ...withTable, candidates: { kept: [{ ...withTable.candidates.kept[0], site: { ...withTable.candidates.kept[0].site, lakeKm: 1.2 }, plan: { tier: 'trade-off', verdict: 'trade-off with potential: lake', entry: { total: 18490 }, areaM2: 300, units: 4, why: ['sea 2.5 km', '9 workable months'], risks: ['ask the Câmara'], path: 'Rural camping park' } }], toCheck: [] } };
    expect(candidatesCsv(planned).split('\r\n')[1]).toMatch(/^kept,trade-off,trade-off with potential: lake,18490,300,4,1\.2,sea 2\.5 km \| 9 workable months,ask the Câmara,Rural camping park,Terreno Aljezur,/);
    const json = resultsJson(p);
    expect(json).toMatchObject({ bestEstimate: { value: '18' }, confidence: { provisional: true, byChecks: 'low' }, actions: [{ nodeId: 'D2', action: 'research' }], items: [{ url: 'https://m.de/1' }] });
    expect(json.pieces[0].sources).toEqual([{ id: 'S1', title: 't', url: 'https://m.de/1' }]);
    const md = toMarkdown(p as never);
    expect(md).toContain('**Best estimate:** 18 % margin (range 9–24) · rests on D1, D2');
    expect(md).toContain('## What to fix, research further or clarify');
    expect(md).toContain('| D2 · Transport | Research further |');
  });
});
