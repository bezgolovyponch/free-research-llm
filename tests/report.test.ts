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
