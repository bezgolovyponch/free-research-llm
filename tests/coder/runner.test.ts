import { describe, expect, it } from 'vitest';
import { ChangeRunner } from '../../src/coder/runner.mjs';

describe('ChangeRunner', () => {
  it('picks the coder the user asked for, reports who is available and refuses a missing one', async () => {
    const started: string[] = [];
    const runner = new ChangeRunner({
      changes: { get: async () => ({ id: 'C1', engine: 'claude' }) } as never,
      coders: {
        free: { start: (id: string) => (started.push(`free:${id}`), { started: true }) },
        claude: { start: (id: string) => (started.push(`claude:${id}`), { started: true }), available: () => ({ installed: true, version: '2.1.0' }) },
      },
    });
    expect(runner.engines()).toEqual([{ id: 'free', label: 'free models', available: true }, { id: 'claude', label: 'Claude Code (uses your Claude plan)', available: true }]);
    runner.start('C1', 'claude');
    runner.start('C2');
    expect(started).toEqual(['claude:C1', 'free:C2']);
    const missing = new ChangeRunner({ changes: { get: async () => null } as never, coders: { free: { start: () => ({ started: true }) } } });
    expect(() => missing.start('C3', 'claude')).toThrow(/no claude coder/);
    const undone: string[] = [];
    const undoRunner = new ChangeRunner({ changes: { get: async (id: string) => ({ id, engine: 'claude' }) } as never, coders: { free: { undo: async (id: string) => (undone.push(`free:${id}`), { id }) }, claude: { undo: async (id: string) => (undone.push(`claude:${id}`), { id }) } } });
    await undoRunner.undo('C5');
    expect(undone).toEqual(['claude:C5']);
  });
});
