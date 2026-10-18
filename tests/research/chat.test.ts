import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../src/llm/scripted-provider.mjs';
import { ModelRouter } from '../../src/llm/router.mjs';
import { NodeChat, validActions } from '../../src/research/chat.mjs';
import { ResearchEngine } from '../../src/research/engine.mjs';
import { ProjectStore } from '../../src/store.mjs';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-chat-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }); });

const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({}) };

describe('validActions', () => {
  it('keeps only known action types on existing nodes, orders them and never edits the root', () => {
    const project = { nodes: [{ id: 'D1' }, { id: 'D1.1' }] };
    const actions = validActions([
      { type: 'rerun', nodeId: 'D1.1' },
      { type: 'setGrade', nodeId: 'D1.1', grade: 'verified' },
      { type: 'edit', nodeId: 'Q', fields: { question: 'x' } },
      { type: 'edit', fields: { question: 'sharper' } },
      { type: 'add', parentId: 'D9', question: 'orphan' },
      { type: 'add', question: 'child' },
    ], project, 'D1.1');
    expect(actions.map((a) => `${a.type}:${a.type === 'add' ? a.parentId : a.nodeId}`)).toEqual(['edit:D1.1', 'add:D1.1', 'rerun:D1.1']);
  });
});

describe('NodeChat', () => {
  it('answers, applies a validated re-research action and stores the thread on the node', async () => {
    const router = new ModelRouter({ providers: [new ScriptedProvider()] });
    const engine = new ResearchEngine({ router, search, store: new ProjectStore({ dir }) });
    const project = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    await engine.run(project.id);
    const chat = new NodeChat({ engine, suggester: { suggest: async () => ({}) } });
    const result = await chat.send(project.id, 'D1.1', 'please re-research this again with 2026 data');
    expect(result.reply).toMatch(/DEMO assistant/);
    expect(result.actions).toEqual([{ type: 'rerun', nodeId: 'D1.1', ok: true }]);
    for (let i = 0; i < 200 && engine.running.has(project.id); i++) await new Promise((r) => setTimeout(r, 10));
    const saved = await engine.load(project.id);
    expect(saved.chats['D1.1'].map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(saved.log.some((l: { type: string }) => l.type === 'chat')).toBe(true);
    await expect(chat.send(project.id, 'nope', 'hi')).rejects.toThrow(/not found/);
  });
});
