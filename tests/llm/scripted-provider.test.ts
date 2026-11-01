import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../src/llm/scripted-provider.mjs';
import { appChatPrompt } from '../../src/research/prompts.mjs';

const ask = async (message: string, thread: Array<{ role: string; content: string; at: string }>) => {
  const reply = await new ScriptedProvider().chat({ messages: appChatPrompt({ projects: [], status: { models: [], search: [], improving: [] }, thread, message }) });
  return JSON.parse(reply.content);
};

describe('ScriptedProvider app assistant', () => {
  it('answers the current message, not an earlier request still in the thread', async () => {
    const thread = [{ role: 'user', content: 'make the Run button green', at: '2026-11-01T11:58:00Z' }, { role: 'assistant', content: 'DEMO app assistant: here is the change ticket.', at: '2026-11-01T11:58:00Z', audit: { passed: true } }];
    const created = await ask('please start a new research on e-bikes', thread);
    expect(created.actions.map((a: { type: string }) => a.type)).toEqual(['create']);
    const changed = await ask('make the Run button green', []);
    expect(changed.actions.map((a: { type: string }) => a.type)).toEqual(['change']);
  });
});
