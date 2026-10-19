import http from 'node:http';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AccessGate } from '../../src/auth.mjs';
import { TerminalHub } from '../../src/terminal/hub.mjs';
import { attachTerminalSockets, sameOrigin } from '../../src/terminal/socket.mjs';

function open(url: string, headers: Record<string, string>) {
  return new Promise<{ ws?: WebSocket; status?: number }>((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => resolve({ ws }));
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.on('error', () => resolve({ status: 0 }));
  });
}

describe('terminal socket', () => {
  it('streams a shared shell to a same-origin browser and refuses cross-site pages and strangers', async () => {
    const hub = new TerminalHub({ cwd: process.cwd(), env: { ...process.env, FRL_SHELL: '/bin/sh' }, platform: 'linux', loadPty: async () => { throw new Error('none'); } });
    const server = http.createServer();
    attachTerminalSockets(server, { hub, gate: new AccessGate({ token: 't0ken' }) });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const session = await hub.create();
    const base = `ws://127.0.0.1:${port}/api/terminal/${session.id}/ws`;
    expect((await open(base, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await open(base, { origin: `http://127.0.0.1:${port}`, 'x-forwarded-for': '1.2.3.4' })).status).toBe(401);
    expect((await open(`ws://127.0.0.1:${port}/api/terminal/000000000000/ws`, { origin: `http://127.0.0.1:${port}` })).status).toBe(404);
    const { ws } = await open(base, { origin: `http://127.0.0.1:${port}` });
    const seen: string[] = [];
    ws!.on('message', (m) => seen.push(String(m)));
    ws!.send(JSON.stringify({ type: 'input', data: 'echo SOCK_$((2*21))\r' }));
    for (let i = 0; i < 60 && !seen.join('').includes('SOCK_42'); i++) await new Promise((r) => setTimeout(r, 25));
    expect(seen.join('')).toContain('SOCK_42');
    ws!.close();
    hub.closeAll();
    await new Promise((r) => server.close(r));
  });

  it('compares the page origin with the host the browser asked for', () => {
    expect(sameOrigin({ headers: { origin: 'http://10.0.0.5:4600', host: '10.0.0.5:4600' } })).toBe(true);
    expect(sameOrigin({ headers: { origin: 'https://mac.tail1.ts.net', host: '127.0.0.1:4600', 'x-forwarded-host': 'mac.tail1.ts.net' } })).toBe(true);
    expect(sameOrigin({ headers: { host: '10.0.0.5:4600' } })).toBe(false);
    expect(sameOrigin({ headers: { origin: 'not a url', host: 'x' } })).toBe(false);
  });
});
