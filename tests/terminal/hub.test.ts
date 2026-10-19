import { describe, expect, it } from 'vitest';
import { TerminalHub, shellEnv, shellFor } from '../../src/terminal/hub.mjs';

function fakePty() {
  const spawned: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = [];
  let onData: (d: string) => void = () => {};
  let onExit: (e: { exitCode: number }) => void = () => {};
  const written: string[] = [];
  const sizes: number[][] = [];
  const proc = {
    onData: (fn: (d: string) => void) => { onData = fn; },
    onExit: (fn: (e: { exitCode: number }) => void) => { onExit = fn; },
    write: (d: string) => { written.push(d); onData(`echo:${d}`); },
    resize: (c: number, r: number) => sizes.push([c, r]),
    kill: () => onExit({ exitCode: 0 }),
  };
  return { spawned, written, sizes, emit: (d: string) => onData(d), module: { spawn: (file: string, args: string[], opts: Record<string, unknown>) => { spawned.push({ file, args, opts }); return proc; } } };
}

describe('TerminalHub', () => {
  it('runs a real shell session that several devices share, with scrollback for late joiners', async () => {
    const pty = fakePty();
    const hub = new TerminalHub({ cwd: '/app', env: { SHELL: '/bin/zsh', FRL_ACCESS_TOKEN: 'secret', GROQ_API_KEY: 'k' }, platform: 'darwin', loadPty: async () => pty.module });
    expect(await hub.mode()).toBe('full');
    const session = await hub.create({ cols: 120, rows: 40 });
    expect(pty.spawned[0]).toMatchObject({ file: '/bin/zsh', args: ['-l'], opts: { cwd: '/app', cols: 120, rows: 40 } });
    expect(pty.spawned[0].opts.env).not.toHaveProperty('FRL_ACCESS_TOKEN');
    const mac: unknown[] = [];
    const windows: unknown[] = [];
    hub.attach(session.id, { send: (m: unknown) => mac.push(m) });
    session.input('ls\r');
    hub.attach(session.id, { send: (m: unknown) => windows.push(m) });
    expect(windows[0]).toMatchObject({ type: 'replay', data: 'echo:ls\r' });
    pty.emit('done');
    expect(mac.at(-1)).toEqual({ type: 'output', data: 'done' });
    expect(windows.at(-1)).toEqual({ type: 'output', data: 'done' });
    session.resize(9999, 1);
    expect(pty.sizes[0]).toEqual([400, 5]);
    expect(hub.list()[0]).toMatchObject({ id: session.id, mode: 'full', viewers: 2 });
    expect(hub.close(session.id)).toBe(true);
    expect(hub.list()).toEqual([]);
    expect(hub.attach('nope', { send: () => {} })).toBeNull();
  });

  it('falls back to a basic piped shell when node-pty is missing, and can be turned off', async () => {
    const hub = new TerminalHub({ cwd: process.cwd(), env: { ...process.env, FRL_SHELL: '/bin/sh' }, platform: 'linux', loadPty: async () => { throw new Error('no pty'); } });
    expect(await hub.mode()).toBe('basic');
    const session = await hub.create();
    const seen: string[] = [];
    hub.attach(session.id, { send: (m: { type: string; data?: string }) => { if (m.data) seen.push(m.data); } });
    session.input('echo FRL_$((6*7))\r');
    for (let i = 0; i < 50 && !seen.join('').includes('FRL_42'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(seen.join('')).toContain('FRL_42');
    hub.closeAll();
    const off = new TerminalHub({ cwd: '/', enabled: false });
    expect(await off.mode()).toBe('off');
    await expect(off.create()).rejects.toThrow(/turned off/);
  });

  it('picks PowerShell on Windows and a login shell elsewhere', () => {
    expect(shellFor('win32', {})).toEqual({ file: 'powershell.exe', args: ['-NoLogo', '-ExecutionPolicy', 'Bypass'] });
    expect(shellFor('linux', {})).toEqual({ file: '/bin/bash', args: ['-l'] });
    expect(shellEnv({ FRL_ACCESS_TOKEN: 'x', A: '1' })).toMatchObject({ A: '1', TERM: 'xterm-256color' });
  });
});
