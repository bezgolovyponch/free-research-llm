import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppChat, validAppActions } from '../src/appchat.mjs';
import { ScriptedProvider } from '../src/llm/scripted-provider.mjs';
import { ModelRouter } from '../src/llm/router.mjs';
import { ResearchEngine } from '../src/research/engine.mjs';
import { ProjectStore } from '../src/store.mjs';

describe('validAppActions', () => {
  it('keeps known actions on existing researches and real questions only', () => {
    const actions = validAppActions([
      { type: 'improve', projectId: 'p1', hours: 2 },
      { type: 'improve', projectId: 'ghost' },
      { type: 'create', question: 'short' },
      { type: 'create', question: 'Which e-bike fleet size breaks even in Prague?' },
      { type: 'deleteEverything' },
    ], ['p1']);
    expect(actions.map((a) => a.type)).toEqual(['improve', 'create']);
  });
});

describe('AppChat', () => {
  it('answers across researches, creates a new research when asked and keeps the thread on disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-appchat-'));
    const router = new ModelRouter({ providers: [new ScriptedProvider()] });
    const engine = new ResearchEngine({ router, search: { enabled: false, lastErrors: [], search: async () => [] }, store: new ProjectStore({ dir: path.join(dir, 'projects') }) });
    const chat = new AppChat({ engine, improver: { isActive: () => false, start: () => {}, stop: () => {} }, router, file: path.join(dir, 'app-chat.json'), statusOf: () => ({ models: ['demo'], search: [], improving: [] }) });
    const result = await chat.send('please start a new research on e-bikes');
    expect(result.actions).toEqual([{ type: 'create', projectId: expect.any(String), ok: true }]);
    expect((await engine.store.list()).map((p: { question: string }) => p.question)).toContain('Which e-bike rental size breaks even in Prague?');
    expect((await chat.thread()).map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    await expect(chat.send('  ')).rejects.toThrow(/write a message/);
    for (let i = 0; i < 100 && engine.running.size; i++) await new Promise((r) => setTimeout(r, 10));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
});
