import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppChat, ProposalError, proposalLabel, validAppActions } from '../src/appchat.mjs';
import { DocsIndex } from '../src/chat/docs.mjs';
import { ScriptedProvider } from '../src/llm/scripted-provider.mjs';
import { ModelRouter } from '../src/llm/router.mjs';
import { ResearchEngine } from '../src/research/engine.mjs';
import { ProjectStore } from '../src/store.mjs';

describe('validAppActions', () => {
  it('runs only open/stop/links directly and turns create, delete, loops and commands into proposals', () => {
    const { direct, proposals } = validAppActions([
      { type: 'open', projectId: 'p1' },
      { type: 'improve', projectId: 'p1', hours: 99 },
      { type: 'improve', projectId: 'ghost' },
      { type: 'create', question: 'short' },
      { type: 'create', question: 'Which e-bike fleet size breaks even in Prague?' },
      { type: 'command', id: 'keys-check' },
      { type: 'command', id: 'rm -rf /' },
      { type: 'deleteEverything' },
      { type: 'links' },
    ], ['p1']);
    expect(direct).toEqual([{ type: 'open', projectId: 'p1' }, { type: 'links' }]);
    expect(proposals.map((p) => [p.pid, p.type, p.state])).toEqual([['p1', 'improve', 'proposed'], ['p2', 'create', 'proposed'], ['p3', 'command', 'proposed']]);
    expect(proposals[0]).toMatchObject({ hours: 24 });
    expect(proposals[2]).toMatchObject({ run: 'node src/frl.mjs keys check' });
    expect(proposalLabel(proposals[2])).toBe('Run in Terminal: node src/frl.mjs keys check');
    expect(validAppActions('nonsense', [])).toEqual({ direct: [], proposals: [] });
  });
});

async function setup(replies?: Array<Record<string, unknown>>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-appchat-'));
  const scripted = new ScriptedProvider();
  const router = new ModelRouter({ providers: [scripted] });
  if (replies) {
    const queue = [...replies];
    router.complete = (async () => ({ data: queue.shift(), provider: 'demo', model: 'm' })) as typeof router.complete;
  }
  await fs.writeFile(path.join(dir, 'GUIDE.md'), '# Other devices\n\nRun `node src/frl.mjs url` and open the link. Download Node from https://nodejs.org/en/download\n');
  const engine = new ResearchEngine({ router, search: { enabled: false, lastErrors: [], search: async () => [] }, store: new ProjectStore({ dir: path.join(dir, 'projects') }) });
  const improver = { started: [] as unknown[], isActive: () => false, start(id: string, o: unknown) { this.started.push([id, o]); }, stop: () => {} };
  const chat = new AppChat({ engine, improver, router, docs: new DocsIndex({ root: dir, files: ['GUIDE.md'] }), facts: async () => ({ platform: 'macOS', remote: true, links: [{ label: 'same Wi-Fi', url: 'http://192.168.1.5:4600' }] }), file: path.join(dir, 'chat', 'app-chat.json'), statusOf: () => ({ models: ['demo'], search: [], improving: [] }) });
  return { dir, engine, chat, improver };
}

describe('AppChat', () => {
  it('never creates a research by itself: it proposes one, and only the confirm button creates it', async () => {
    const { dir, engine, chat } = await setup();
    const result = await chat.send('please start a new research on e-bikes');
    expect(result.actions).toEqual([]);
    expect(result.proposals).toMatchObject([{ type: 'create', state: 'proposed', label: expect.stringContaining('Start research') }]);
    expect(await engine.store.list()).toEqual([]);
    const assistant = result.thread.at(-1);
    const decided = await chat.decide(assistant.at, 'p1');
    expect(decided.proposal).toMatchObject({ state: 'done', result: { projectId: expect.any(String) } });
    expect((await engine.store.list()).map((p: { question: string }) => p.question)).toEqual(['Which e-bike rental size breaks even in Prague?']);
    expect(decided.thread.at(-1)).toMatchObject({ role: 'app', content: expect.stringContaining('Research created') });
    await expect(chat.decide(assistant.at, 'p1')).rejects.toThrow(ProposalError);
    await expect(chat.send('  ')).rejects.toThrow(/write a message/);
    for (let i = 0; i < 100 && engine.running.size; i++) await new Promise((r) => setTimeout(r, 10));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('audits every reply: an invented link, a fake key or a claimed action is revised once, then flagged and removed', async () => {
    const { dir, chat } = await setup([
      { reply: 'Open https://app.example.com/research/x. API_KEY=abcd1234. I have deleted the old research.', actions: [] },
      { reply: 'Run `node src/frl.mjs url` on this Mac and open the same Wi-Fi link http://192.168.1.5:4600 on the other PC.', actions: [{ type: 'links' }] },
    ]);
    const result = await chat.send('give me the link for another PC and the keys');
    const reply = result.thread.at(-1);
    expect(reply.audit).toEqual({ passed: true, issues: [], revised: true });
    expect(reply.content).toContain('http://192.168.1.5:4600');
    expect(result.actions).toEqual([{ type: 'links', ok: true }]);
    const { dir: dir2, chat: stubborn } = await setup([
      { reply: 'Link: https://app.example.com/x and API_KEY=abcd1234', actions: [] },
      { reply: 'Link: https://app.example.com/x and API_KEY=abcd1234', actions: [] },
    ]);
    const flagged = (await stubborn.send('link?')).thread.at(-1);
    expect(flagged.audit.passed).toBe(false);
    expect(flagged.content).not.toMatch(/example\.com|abcd1234/);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(dir2, { recursive: true, force: true });
  });

  it('turns a request to change the app into a change ticket proposal, created only on confirm', async () => {
    const { dir, chat } = await setup([{ reply: 'Press the button: Claude Code will implement it in the Terminal.', actions: [{ type: 'change', title: 'CSV export', request: 'Add a CSV export of delivered items to the Results tab', desired: 'A Download CSV button on the Results tab', tests: ['e2e: download has one row per item'] }] }]);
    const { ChangeBook } = await import('../src/changes.mjs');
    const book = new ChangeBook({ dir: path.join(dir, 'changes') });
    (chat as unknown as { changes: unknown }).changes = book;
    const r = await chat.send('add a CSV export of the delivered items');
    expect(r.proposals[0]).toMatchObject({ type: 'change', title: 'CSV export', label: expect.stringContaining('App change: CSV export') });
    expect(await book.all()).toEqual([]);
    const decided = await chat.decide(r.thread.at(-1).at, 'p1');
    expect(decided.proposal.result).toMatchObject({ ticketId: 'C1', run: 'node src/frl.mjs change C1 --claude' });
    expect((await book.all())[0]).toMatchObject({ id: 'C1', state: 'queued', desired: 'A Download CSV button on the Results tab' });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('hands a confirmed change ticket to the free-model coder instead of the Terminal when one is present', async () => {
    const { dir, chat } = await setup([{ reply: 'A ticket.', actions: [{ type: 'change', title: 'Score chart', request: 'Show the loop score per trial as a chart', desired: 'A line chart in Gates & logs' }] }]);
    const { ChangeBook } = await import('../src/changes.mjs');
    const started: string[] = [];
    Object.assign(chat as unknown as Record<string, unknown>, { changes: new ChangeBook({ dir: path.join(dir, 'changes') }), coder: { start: (id: string) => { started.push(id); return { started: true }; } } });
    const r = await chat.send('chart the loop score');
    expect(r.proposals[0].label).toContain('free models implement it and the quality gate decides');
    const decided = await chat.decide(r.thread.at(-1).at, 'p1');
    expect(started).toEqual(['C1']);
    expect(decided.proposal.result.run).toBeUndefined();
    expect(decided.proposal.result.message).toContain('only if the quality gate passes');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('never feeds replies written before the audit existed back to the model', async () => {
    const { dir, chat } = await setup();
    const prompts: string[] = [];
    (chat as unknown as { router: { complete: unknown } }).router.complete = async ({ messages }: { messages: Array<{ content: string }> }) => {
      prompts.push(messages[1].content);
      return { data: { reply: 'Run `node src/frl.mjs url`.', actions: [] }, provider: 'demo', model: 'm' };
    };
    await chat.update((t: unknown[]) => { t.push({ role: 'user', content: 'old question', at: '2026-10-18T20:00:00Z' }, { role: 'assistant', content: 'Here is https://app.example.com and API_KEY=abcd1234', at: '2026-10-18T20:00:01Z' }); });
    await chat.send('how do I open it on another PC?');
    expect(prompts[0]).toContain('USER: old question');
    expect(prompts[0]).not.toContain('app.example.com');
    expect(prompts[0]).not.toContain('abcd1234');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('records app reports in the app thread, in order, and dismisses proposals', async () => {
    const { dir, chat, improver, engine } = await setup([{ reply: 'Press the button to start the loop.', actions: [{ type: 'improve', projectId: 'p-x', hours: 3 }, { type: 'command', id: 'keys-check' }] }]);
    await Promise.all([chat.note('App started'), chat.note('Keys reloaded')]);
    expect((await chat.thread()).map((m: { content: string }) => m.content)).toEqual(['App started', 'Keys reloaded']);
    const project = await engine.createProject({ question: 'Which van conversion sells fastest in Prague?' });
    (chat as unknown as { ask: unknown }).ask = async () => ({ reply: { provider: 'demo', model: 'm' }, text: 'Press the button to start the loop.', actions: validAppActions([{ type: 'improve', projectId: project.id, hours: 3 }, { type: 'command', id: 'keys-check' }], [project.id]) });
    const r = await chat.send('run the loop 3 hours');
    const at = r.thread.at(-1).at;
    expect((await chat.decide(at, 'p2', { accept: false })).proposal.state).toBe('dismissed');
    expect((await chat.decide(at, 'p1')).proposal.state).toBe('done');
    expect(improver.started).toEqual([[project.id, { hours: 3 }]]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
