import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

export const SCROLLBACK_CHARS = 200000;
const HIDDEN_ENV = ['FRL_ACCESS_TOKEN'];

export function shellFor(platform, env) {
  if (platform === 'win32') return { file: env.FRL_SHELL || 'powershell.exe', args: ['-NoLogo', '-ExecutionPolicy', 'Bypass'] };
  if (platform === 'darwin') return { file: env.FRL_SHELL || env.SHELL || '/bin/zsh', args: ['-l'] };
  return { file: env.FRL_SHELL || env.SHELL || '/bin/bash', args: ['-l'] };
}

export function shellEnv(env) {
  const copy = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', FRL_IN_TERMINAL: '1' };
  for (const name of HIDDEN_ENV) delete copy[name];
  return copy;
}

class PipeProcess {
  constructor(child) {
    this.child = child;
  }

  onData(fn) {
    this.child.stdout.on('data', (d) => fn(d.toString('utf8')));
    this.child.stderr.on('data', (d) => fn(d.toString('utf8')));
  }

  onExit(fn) {
    this.child.on('exit', (code) => fn({ exitCode: code ?? 0 }));
    this.child.on('error', (error) => fn({ exitCode: 1, error: error.message }));
  }

  write(data) {
    if (this.child.stdin.writable) this.child.stdin.write(data.replace(/\r/g, '\n'));
  }

  resize() {}

  kill() {
    this.child.kill();
  }
}

export class TerminalSession {
  constructor({ id, title, proc, mode }) {
    this.id = id;
    this.title = title;
    this.proc = proc;
    this.mode = mode;
    this.createdAt = new Date().toISOString();
    this.buffer = '';
    this.clients = new Set();
    this.exited = null;
    proc.onData((data) => this.output(data));
    proc.onExit(({ exitCode }) => {
      this.exited = { code: exitCode, at: new Date().toISOString() };
      this.output(`\r\n[shell ended with code ${exitCode}]\r\n`);
      for (const c of this.clients) c.send({ type: 'exit', code: exitCode });
    });
  }

  output(data) {
    this.buffer = (this.buffer + data).slice(-SCROLLBACK_CHARS);
    for (const c of this.clients) c.send({ type: 'output', data });
  }

  input(data) {
    if (this.exited) return;
    if (this.mode === 'basic') this.output(String(data).replace(/\r/g, '\r\n'));
    this.proc.write(String(data));
  }

  resize(cols, rows) {
    const c = Math.max(20, Math.min(400, Number(cols) || 80));
    const r = Math.max(5, Math.min(200, Number(rows) || 24));
    this.proc.resize(c, r);
  }

  describe() {
    return { id: this.id, title: this.title, mode: this.mode, createdAt: this.createdAt, viewers: this.clients.size, exited: this.exited };
  }
}

export class TerminalHub {
  constructor({ cwd, env = process.env, platform = process.platform, loadPty = async () => (await import('node-pty')).default, spawnImpl = spawn, enabled = true } = {}) {
    this.cwd = cwd;
    this.env = env;
    this.platform = platform;
    this.loadPty = loadPty;
    this.spawnImpl = spawnImpl;
    this.enabled = enabled;
    this.sessions = new Map();
    this.ptyModule = undefined;
  }

  async pty() {
    if (this.ptyModule === undefined) {
      try {
        this.ptyModule = await this.loadPty();
      } catch {
        this.ptyModule = null;
      }
    }
    return this.ptyModule;
  }

  async mode() {
    if (!this.enabled) return 'off';
    return (await this.pty()) ? 'full' : 'basic';
  }

  async create({ cols = 100, rows = 30 } = {}) {
    if (!this.enabled) throw new Error('the terminal is turned off (FRL_TERMINAL=0)');
    const shell = shellFor(this.platform, this.env);
    const env = shellEnv(this.env);
    const pty = await this.pty();
    const id = crypto.randomBytes(6).toString('hex');
    let proc;
    let mode = 'full';
    try {
      proc = pty ? pty.spawn(shell.file, shell.args, { name: 'xterm-256color', cols, rows, cwd: this.cwd, env }) : null;
    } catch {
      proc = null;
    }
    if (!proc) {
      mode = 'basic';
      proc = new PipeProcess(this.spawnImpl(shell.file, this.platform === 'win32' ? ['-NoLogo', '-NoExit', '-Command', '-'] : ['-i'], { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }));
    }
    const session = new TerminalSession({ id, title: `${shell.file.split(/[\\/]/).pop()} ${this.sessions.size + 1}`, proc, mode });
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  list() {
    return [...this.sessions.values()].map((s) => s.describe());
  }

  attach(id, client) {
    const session = this.get(id);
    if (!session) return null;
    session.clients.add(client);
    client.send({ type: 'replay', data: session.buffer, session: session.describe() });
    return () => session.clients.delete(client);
  }

  close(id) {
    const session = this.get(id);
    if (!session) return false;
    if (!session.exited) session.proc.kill();
    for (const c of session.clients) c.send({ type: 'closed' });
    session.clients.clear();
    this.sessions.delete(id);
    return true;
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
