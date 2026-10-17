import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../src/app.mjs';
import { ScriptedProvider } from '../src/llm/scripted-provider.mjs';
import { startServer } from '../src/server.mjs';

let base: string;
let close: () => void;
let dir: string;

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
}

async function waitFor(id: string, phase: string) {
  for (let i = 0; i < 400; i++) {
    const { body } = await call('GET', `/api/projects/${id}`);
    if (body.phase === phase && body.report) return body;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`project never reached ${phase}`);
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-server-'));
  const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({ enabled: false, backends: [], lastErrors: [] }) };
  const app = new App({ env: {}, dataDir: dir, providers: [new ScriptedProvider()], search });
  const started = await startServer({ app, port: 0 });
  base = started.url;
  close = () => started.server.close();
});

afterAll(async () => {
  close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('HTTP server', () => {
  it('serves the UI, status and templates', async () => {
    const page = await call('GET', '/');
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/<title>Free Research LLM<\/title>/);
    expect((await call('GET', '/api/status')).body).toMatchObject({ ready: true });
    expect((await call('GET', '/api/templates')).body.map((t: { id: string }) => t.id)).toContain('glamping-location');
  });

  it('creates a project, runs it in the background, streams events and exports Markdown', async () => {
    const created = await call('POST', '/api/projects', { question: 'Where should I build a 6-tent glamping site in Czechia?', constraints: { budget: '€250k' } });
    expect(created.status).toBe(200);
    const events = await fetch(`${base}/api/projects/${created.body.id}/events`);
    const reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toMatch(/^data: .*"type":"hello"/);
    await reader.cancel();
    const done = await waitFor(created.body.id, 'done');
    expect(done.report.verdict).toBeTruthy();
    const md = await call('GET', `/api/projects/${created.body.id}/report.md`);
    expect(md.body).toMatch(/## Verdict/);
    const rerun = await call('POST', `/api/projects/${created.body.id}/nodes/D1.1/rerun`, { hint: 'use 2026 data' });
    expect(rerun.status).toBe(200);
    await waitFor(created.body.id, 'done');
    expect((await call('GET', '/api/projects')).body[0].id).toBe(created.body.id);
  });

  it('returns clean errors for bad input and unknown resources', async () => {
    expect((await call('POST', '/api/projects', { question: 'x' })).status).toBe(400);
    expect((await call('GET', '/api/projects/does-not-exist')).status).toBe(404);
    expect((await call('GET', '/api/projects/..%2F..%2Fetc')).status).toBe(404);
    expect((await call('GET', '/nope')).status).toBe(404);
  });
});
