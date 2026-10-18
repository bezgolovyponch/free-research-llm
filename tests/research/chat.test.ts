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

describe('NodeChat priority', () => {
  it('pauses a running loop, applies the user change, resumes it with the remaining time', async () => {
    const calls: string[] = [];
    let active = true;
    const improver = {
      isActive: () => active,
      remainingHours: () => 3,
      stop: () => { calls.push('stop'); setTimeout(() => { active = false; }, 5); },
      start: (_id: string, opts: { hours: number }) => { calls.push(`start ${opts.hours}`); },
    };
    const project = { id: 'p', question: 'q', acceptance: {}, nodes: [{ id: 'D1', parentId: 'Q', question: 'q1', searchQueries: [], status: 'weak', sources: [] }], chats: {} };
    const engine = {
      running: new Set(),
      load: async () => structuredClone(project),
      store: { save: async (p: typeof project) => { Object.assign(project, p); return p; } },
      emit: () => {},
      editNode: async (_id: string, nodeId: string) => { calls.push(`edit ${nodeId} while ${active ? 'looping' : 'paused'}`); },
      router: { complete: async () => ({ data: { reply: 'ok', actions: [{ type: 'edit', nodeId: 'D1', fields: { question: 'sharper' } }] }, provider: 'x', model: 'y' }) },
    };
    const chat = new NodeChat({ engine, suggester: {}, improver, sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) });
    const result = await chat.send('p', 'D1', 'make it sharper');
    expect(calls).toEqual(['stop', 'edit D1 while paused', 'start 3']);
    expect(result.actions.map((a: { type: string }) => a.type)).toEqual(['edit', 'loop paused and resumed']);
    expect(project.chats.D1.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
  });
});

