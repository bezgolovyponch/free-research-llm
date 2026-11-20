import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../src/llm/scripted-provider.mjs';
import { ModelRouter } from '../../src/llm/router.mjs';
import { ResearchEngine } from '../../src/research/engine.mjs';
import { ProjectStore } from '../../src/store.mjs';
import { TASK_MARKERS } from '../../src/research/prompts.mjs';

const fakeSearch = {
  enabled: true,
  lastErrors: [],
  async search(queries: string[]) {
    return [
      { kind: 'web', title: 'One', url: 'https://one.example/a', domain: 'one.example', snippet: 's', text: `about ${queries[0]}` },
      { kind: 'web', title: 'Two', url: 'https://two.example/b', domain: 'two.example', snippet: 's', text: `more evidence from a second independent source about ${queries[0]}` },
    ];
  },
  describe: () => ({ enabled: true, backends: ['fake'], lastErrors: [] }),
};

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-engine-chosen-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function engineWith(provider: ScriptedProvider | object, search: object = fakeSearch, lanes = 2) {
  const router = new ModelRouter({ providers: [provider] });
  return { router, engine: new ResearchEngine({ router, search, store: new ProjectStore({ dir }), lanes }) };
}

describe('ResearchEngine chosen option', () => {
  it('stores chosenOption id when model returns chosen matching second option', async () => {
    const scripted = new ScriptedProvider();
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => scripted.describe(),
      async chat(args: { messages: Array<{ role: string; content: string }>; tier: string }) {
        const prompt = args.messages.at(-1)!.content;
        if (prompt.includes(TASK_MARKERS.synthesize)) {
          return {
            content: JSON.stringify({
              verdict: 'GO-IF — margin stays above 0 after real costs are confirmed',
              confidence: 'low',
              bestEstimate: { value: '300', unit: 'EUR net margin per unit', low: '120', high: '450', basis: 'D2.2' },
              summary: 'Test summary',
              keyNumbers: [{ label: 'Net margin per unit', value: '300', unit: 'EUR', nodeId: 'D2.2' }],
              scenarios: [{ name: 'base', assumptions: 'test numbers', outcome: '300 EUR margin' }],
              sensitivity: [{ variable: 'cost', effect: 'cost above 1200 EUR flips to NO-GO' }],
              risks: ['test data is not real'],
              openQuestions: ['which model provider will you connect?'],
              nextSteps: [{ step: 'Connect a free model', why: 'real research needs a real model', how: 'Setup tab' }],
              actions: [{ action: 'Confirm real costs before committing', why: 'margin rests on D2.2', nodeIds: ['D2.2'], impact: 4, horizon: '0-1 months' }],
              options: [{ option: 'GO', support: ['D2.2'], against: ['D1'] }, { option: 'NO-GO', support: ['D1'], against: ['D2.2'] }, { option: 'GO-IF', support: ['D2.2'], against: ['D1'] }],
              chosen: 'NO-GO',
            }),
            model: 'm',
            provider: 'demo',
            usage: {},
          };
        }
        return scripted.chat(args as never);
      },
    };
    const { engine } = engineWith(provider);
    const project = await engine.createProject({ question: 'Is it profitable to buy used RAV4 hybrids in Germany and sell them in Poland?' });
    const done = await engine.run(project.id);
    expect(done.report.options).toHaveLength(3);
    expect(done.report.options.map((o) => o.id)).toEqual(['O1', 'O2', 'O3']);
    expect(done.report.options.map((o) => o.option)).toEqual(['GO', 'NO-GO', 'GO-IF']);
    expect(done.report.chosenOption).toBe('O2');
    expect(done.report.chosenOptionNote).toBeUndefined();
    expect(done.report.verdict).toContain('GO-IF');
  });

  it('assigns ids O1.. over kept options when first option text is empty', async () => {
    const scripted = new ScriptedProvider();
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => scripted.describe(),
      async chat(args: { messages: Array<{ role: string; content: string }>; tier: string }) {
        const prompt = args.messages.at(-1)!.content;
        if (prompt.includes(TASK_MARKERS.synthesize)) {
          return {
            content: JSON.stringify({
              verdict: 'GO — test',
              confidence: 'low',
              bestEstimate: { value: '300', unit: 'EUR', low: '120', high: '450', basis: 'D2.2' },
              summary: 'Test summary',
              keyNumbers: [],
              scenarios: [],
              sensitivity: [],
              risks: [],
              openQuestions: [],
              nextSteps: [],
              actions: [],
              options: [{ option: '', support: [], against: [] }, { option: 'NO-GO', support: ['D1'], against: [] }, { option: 'GO-IF', support: ['D2'], against: [] }],
              chosen: 'NO-GO',
            }),
            model: 'm',
            provider: 'demo',
            usage: {},
          };
        }
        return scripted.chat(args as never);
      },
    };
    const { engine } = engineWith(provider);
    const project = await engine.createProject({ question: 'Test question' });
    const done = await engine.run(project.id);
    expect(done.report.options).toHaveLength(2);
    expect(done.report.options.map((o) => o.id)).toEqual(['O1', 'O2']);
    expect(done.report.options.map((o) => o.option)).toEqual(['NO-GO', 'GO-IF']);
    expect(done.report.chosenOption).toBe('O1');
  });

  it('sets chosenOption null with no note when model returns no chosen', async () => {
    const scripted = new ScriptedProvider();
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => scripted.describe(),
      async chat(args: { messages: Array<{ role: string; content: string }>; tier: string }) {
        const prompt = args.messages.at(-1)!.content;
        if (prompt.includes(TASK_MARKERS.synthesize)) {
          return {
            content: JSON.stringify({
              verdict: 'GO — test',
              confidence: 'low',
              bestEstimate: { value: '300', unit: 'EUR', low: '120', high: '450', basis: 'D2.2' },
              summary: 'Test summary',
              keyNumbers: [],
              scenarios: [],
              sensitivity: [],
              risks: [],
              openQuestions: [],
              nextSteps: [],
              actions: [],
              options: [{ option: 'GO', support: ['D1'], against: [] }, { option: 'NO-GO', support: [], against: ['D1'] }],
            }),
            model: 'm',
            provider: 'demo',
            usage: {},
          };
        }
        return scripted.chat(args as never);
      },
    };
    const { engine } = engineWith(provider);
    const project = await engine.createProject({ question: 'Test question' });
    const done = await engine.run(project.id);
    expect(done.report.chosenOption).toBeNull();
    expect(done.report.chosenOptionNote).toBeUndefined();
  });

  it('sets chosenOption null with note when chosen does not match any option', async () => {
    const scripted = new ScriptedProvider();
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => scripted.describe(),
      async chat(args: { messages: Array<{ role: string; content: string }>; tier: string }) {
        const prompt = args.messages.at(-1)!.content;
        if (prompt.includes(TASK_MARKERS.synthesize)) {
          return {
            content: JSON.stringify({
              verdict: 'GO — test',
              confidence: 'low',
              bestEstimate: { value: '300', unit: 'EUR', low: '120', high: '450', basis: 'D2.2' },
              summary: 'Test summary',
              keyNumbers: [],
              scenarios: [],
              sensitivity: [],
              risks: [],
              openQuestions: [],
              nextSteps: [],
              actions: [],
              options: [{ option: 'GO', support: ['D1'], against: [] }, { option: 'NO-GO', support: [], against: ['D1'] }],
              chosen: 'something else',
            }),
            model: 'm',
            provider: 'demo',
            usage: {},
          };
        }
        return scripted.chat(args as never);
      },
    };
    const { engine } = engineWith(provider);
    const project = await engine.createProject({ question: 'Test question' });
    const done = await engine.run(project.id);
    expect(done.report.chosenOption).toBeNull();
    expect(done.report.chosenOptionNote).toBe('not among the options');
  });

  it('persists chosenOption through save and load', async () => {
    const scripted = new ScriptedProvider();
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => scripted.describe(),
      async chat(args: { messages: Array<{ role: string; content: string }>; tier: string }) {
        const prompt = args.messages.at(-1)!.content;
        if (prompt.includes(TASK_MARKERS.synthesize)) {
          return {
            content: JSON.stringify({
              verdict: 'GO-IF — test',
              confidence: 'low',
              bestEstimate: { value: '300', unit: 'EUR', low: '120', high: '450', basis: 'D2.2' },
              summary: 'Test summary',
              keyNumbers: [],
              scenarios: [],
              sensitivity: [],
              risks: [],
              openQuestions: [],
              nextSteps: [],
              actions: [],
              options: [{ option: 'GO', support: ['D1'], against: [] }, { option: 'NO-GO', support: [], against: ['D1'] }, { option: 'GO-IF', support: ['D2'], against: [] }],
              chosen: 'NO-GO',
            }),
            model: 'm',
            provider: 'demo',
            usage: {},
          };
        }
        return scripted.chat(args as never);
      },
    };
    const { engine } = engineWith(provider);
    const project = await engine.createProject({ question: 'Test question' });
    const done = await engine.run(project.id);
    expect(done.report.chosenOption).toBe('O2');
    const loaded = await engine.store.readFile(done.id);
    expect(loaded.report.chosenOption).toBe('O2');
    expect(loaded.report.options.map((o) => o.id)).toEqual(['O1', 'O2', 'O3']);
  });

  it('loads old project without chosenOption key without throwing', async () => {
    const scripted = new ScriptedProvider();
    const provider = {
      id: 'demo',
      ready: true,
      describe: () => scripted.describe(),
      async chat(args: { messages: Array<{ role: string; content: string }>; tier: string }) {
        const prompt = args.messages.at(-1)!.content;
        if (prompt.includes(TASK_MARKERS.synthesize)) {
          return {
            content: JSON.stringify({
              verdict: 'GO — test',
              confidence: 'low',
              bestEstimate: { value: '300', unit: 'EUR', low: '120', high: '450', basis: 'D2.2' },
              summary: 'Test summary',
              keyNumbers: [],
              scenarios: [],
              sensitivity: [],
              risks: [],
              openQuestions: [],
              nextSteps: [],
              actions: [],
              options: [{ option: 'GO', support: ['D1'], against: [] }, { option: 'NO-GO', support: [], against: ['D1'] }],
            }),
            model: 'm',
            provider: 'demo',
            usage: {},
          };
        }
        return scripted.chat(args as never);
      },
    };
    const { engine } = engineWith(provider);
    const project = await engine.createProject({ question: 'Test question' });
    const done = await engine.run(project.id);
    const stored = await engine.store.readFile(done.id);
    delete stored.report.chosenOption;
    delete stored.report.chosenOptionNote;
    await engine.store.save(stored);
    const loaded = await engine.store.readFile(done.id);
    expect(loaded.report.options.map((o) => o.id)).toEqual(['O1', 'O2']);
    expect(loaded.report.chosenOption).toBeUndefined();
  });
});