import { describe, expect, it } from 'vitest';
import { CONSOLE_COMMANDS, commandById } from '../../src/terminal/catalog.mjs';

describe('console commands', () => {
  it('have unique ids and run the same command on macOS, Windows and Linux', () => {
    expect(new Set(CONSOLE_COMMANDS.map((c) => c.id)).size).toBe(CONSOLE_COMMANDS.length);
    for (const c of CONSOLE_COMMANDS) expect(c.run).not.toMatch(/&&|\|\||;|\.command|\.sh\b/);
    expect(commandById('keys-check')?.run).toBe('node src/frl.mjs keys check');
    expect(commandById('rm -rf /')).toBeNull();
  });
});
