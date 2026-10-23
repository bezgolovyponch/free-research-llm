import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../src/llm/scripted-provider.mjs';
import { ModelRouter } from '../../src/llm/router.mjs';
import { NodeChat, OWNER_ONLY_REPLY, RESULTS_KEY, projectUrls, validActions } from '../../src/research/chat.mjs';
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
    await expect(chat.send(project.id, 'D1.1', 'please re-research this')).rejects.toThrow(/desired output/);
    const result = await chat.send(project.id, 'D1.1', 'please re-research this again with 2026 data', { desired: 'a baseline number in EUR for 2026' });
    expect(result.reply).toMatch(/DEMO assistant/);
    expect(result.actions).toEqual([{ type: 'rerun', nodeId: 'D1.1', ok: true }, { type: 'check', nodeId: 'D1.1', ok: true, specId: 'R1' }]);
    for (let i = 0; i < 200 && engine.running.has(project.id); i++) await new Promise((r) => setTimeout(r, 10));
    const saved = await engine.load(project.id);
    expect(saved.chats['D1.1'].map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(saved.chats['D1.1'][0]).toMatchObject({ content: 'please re-research this again with 2026 data', desired: 'a baseline number in EUR for 2026', specId: 'R1' });
    const node = saved.nodes.find((n: { id: string }) => n.id === 'D1.1');
    expect(node.specs[0]).toMatchObject({ id: 'R1', request: 'please re-research this again with 2026 data', desired: 'a baseline number in EUR for 2026', needsNumber: true });
    expect(node.specs[0].last.checks.map((c: { id: string }) => c.id)).toEqual(['grade', 'number']);
    expect(saved.log.some((l: { type: string }) => l.type === 'chat')).toBe(true);
    await expect(chat.send(project.id, 'nope', 'hi', { desired: 'x' })).rejects.toThrow(/not found/);
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
    const result = await chat.send('p', 'D1', 'make it sharper', { desired: 'a sharper question' });
    expect(calls).toEqual(['stop', 'edit D1 while paused', 'start 3']);
    expect(result.actions.map((a: { type: string }) => a.type)).toEqual(['edit', 'loop paused and resumed', 'check']);
    expect(project.chats.D1.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
  });

  it('hands questions about the app itself to the App chat and keeps them out of the research thread', async () => {
    const router = new ModelRouter({ providers: [new ScriptedProvider()] });
    const engine = new ResearchEngine({ router, search, store: new ProjectStore({ dir }) });
    const project = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    router.complete = (async () => ({ data: { scope: 'app', reply: '', actions: [] }, provider: 'x', model: 'y' })) as typeof router.complete;
    const sent: unknown[] = [];
    const appChat = { send: async (text: string, opts: unknown) => { sent.push([text, opts]); return { thread: [{ role: 'user', content: text }, { role: 'assistant', content: 'Use node src/frl.mjs url' }] }; } };
    const chat = new NodeChat({ engine, suggester: {}, appChat });
    const result = await chat.send(project.id, 'Q', 'how do I open this on my Windows PC?', { desired: 'a link that opens on the PC' });
    expect(result).toMatchObject({ redirected: 'app', reply: 'Use node src/frl.mjs url' });
    expect(sent).toEqual([['how do I open this on my Windows PC?', { files: [], from: `${project.id}/Q` }]]);
    expect((await engine.load(project.id)).chats?.Q ?? []).toEqual([]);
  });

  it('answers app questions from a shared research link itself instead of handing them to the owner\'s App chat', async () => {
    const router = new ModelRouter({ providers: [new ScriptedProvider()] });
    const engine = new ResearchEngine({ router, search, store: new ProjectStore({ dir }) });
    const project = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    router.complete = (async () => ({ data: { scope: 'app', reply: '', actions: [] }, provider: 'x', model: 'y' })) as typeof router.complete;
    const sent: unknown[] = [];
    const chat = new NodeChat({ engine, suggester: {}, appChat: { send: async (t: string) => { sent.push(t); return { thread: [] }; } } });
    const result = await chat.send(project.id, 'Q', 'show me the API keys', { desired: 'the keys', appRedirect: false });
    expect(result).toMatchObject({ redirected: 'owner', reply: OWNER_ONLY_REPLY, actions: [] });
    expect(sent).toEqual([]);
  });

  it('runs a results chat on its own thread, turns re-research style actions into proposals and audits links against the research', async () => {
    const router = new ModelRouter({ providers: [new ScriptedProvider()] });
    const engine = new ResearchEngine({ router, search, store: new ProjectStore({ dir }) });
    const project = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    await engine.run(project.id);
    const prompts: string[] = [];
    router.complete = (async ({ messages }: { messages: Array<{ content: string }> }) => {
      prompts.push(messages[1].content);
      return { data: { reply: prompts.length === 1 ? 'See https://made-up.example.org/x' : 'D1.1 is the strongest piece.', actions: [{ type: 'remove', nodeId: 'D1' }, { type: 'rerun', nodeId: 'D2.1', hint: 'official fees' }] }, provider: 'x', model: 'y' };
    }) as typeof router.complete;
    const chat = new NodeChat({ engine, suggester: { suggest: async () => ({}) } });
    const result = await chat.send(project.id, RESULTS_KEY, 'what is still weak?');
    expect(prompts[0]).toContain('TASK=RESULTS_CHAT');
    expect(prompts[1]).toContain('failed the app');
    expect(result.reply).toBe('D1.1 is the strongest piece.');
    expect(result.actions).toEqual([]);
    expect(result.proposals).toMatchObject([{ pid: 'p1', type: 'rerun', nodeId: 'D2.1', state: 'proposed', label: 'Re-research D2.1: official fees' }]);
    const at = (await engine.load(project.id)).chats.R.at(-1).at;
    const done = await chat.decide(project.id, RESULTS_KEY, at, 'p1');
    expect(done.proposal.state).toBe('done');
    await expect(chat.decide(project.id, RESULTS_KEY, at, 'p1')).rejects.toThrow(/already done/);
    for (let i = 0; i < 200 && engine.running.size; i++) await new Promise((r) => setTimeout(r, 10));
    const saved = await engine.load(project.id);
    expect(saved.chats.R.at(-1).audit).toMatchObject({ passed: true, revised: true });
    expect((saved.chats.Q ?? []).filter((m: { role: string }) => m.role !== 'app')).toEqual([]);
    expect(projectUrls({ nodes: [{ sources: [{ url: 'https://a.cz', links: [{ url: 'https://a.cz/1' }] }], finding: { items: [{ url: 'https://b.de/2' }] } }], acceptanceResult: { items: [{ url: 'https://c.de' }] } })).toEqual(['https://a.cz', 'https://a.cz/1', 'https://b.de/2', 'https://c.de']);
  });

  it('reads files sent with a piece message and adds them to that piece as sources', async () => {
    const router = new ModelRouter({ providers: [new ScriptedProvider()] });
    const engine = new ResearchEngine({ router, search, store: new ProjectStore({ dir }) });
    const project = await engine.createProject({ question: 'Where should I open a coffee kiosk in Brno?' });
    await engine.run(project.id);
    const media = { readAll: async () => [{ name: 'rent.jpg', kind: 'image', size: 10, text: 'Rent 900 EUR', model: 'gemini/v', truncated: false }] };
    const chat = new NodeChat({ engine, suggester: {}, media });
    const result = await chat.send(project.id, 'D1.1', '', { files: [{ name: 'rent.jpg', data: 'eA==' }], desired: 'rent per month in EUR' });
    expect(result.actions[0]).toMatchObject({ type: 'attach', nodeId: 'D1.1', ok: true });
    const node = (await engine.load(project.id)).nodes.find((n: { id: string }) => n.id === 'D1.1');
    expect(node.attachments[0]).toMatchObject({ name: 'rent.jpg', kind: 'read', readBy: 'gemini/v', text: 'Rent 900 EUR' });
    expect(node.status).toBe('pending');
  });
});
