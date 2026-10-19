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

let app: App;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-server-'));
  const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({ enabled: false, backends: [], lastErrors: [] }) };
  app = new App({ env: {}, dataDir: dir, providers: [new ScriptedProvider()], search });
  const started = await startServer({ app, port: 0 });
  base = started.url;
  close = () => started.server.close();
});

afterAll(async () => {
  close();
  await app.logs.queue;
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
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

  it('serves the terminal, its commands, the access links and the xterm files, and refuses restarts it cannot recover from', async () => {
    const info = await call('GET', '/api/terminal');
    expect(info.body).toMatchObject({ mode: expect.stringMatching(/full|basic/), sessions: [] });
    expect(info.body.commands.map((c: { id: string }) => c.id)).toContain('keys-setup');
    const session = await call('POST', '/api/terminal', { cols: 80, rows: 24 });
    expect(session.body.id).toMatch(/^[0-9a-f]{12}$/);
    expect((await call('DELETE', `/api/terminal/${session.body.id}`)).body).toEqual({ ok: true });
    expect((await call('GET', '/api/access')).body).toEqual({ remote: false, links: [{ label: 'this Mac', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) }] });
    const js = await fetch(`${base}/vendor/xterm.js`);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect((await call('POST', '/api/app/restart')).status).toBe(409);
  });

  it('turns an app-chat research request into a proposal, then into a research only on confirm', async () => {
    const before = (await call('GET', '/api/projects')).body.length;
    const sent = await call('POST', '/api/chat', { message: 'start a new research on e-bikes' });
    expect(sent.body.proposals[0]).toMatchObject({ type: 'create', state: 'proposed' });
    expect((await call('GET', '/api/projects')).body.length).toBe(before);
    const decided = await call('POST', '/api/chat/decide', { at: sent.body.thread.at(-1).at, pid: 'p1' });
    expect(decided.body.proposal.state).toBe('done');
    expect((await call('GET', '/api/projects')).body.length).toBe(before + 1);
    expect((await call('POST', '/api/chat/decide', { at: 'nope', pid: 'p1' })).status).toBe(409);
    expect((await call('POST', '/api/chat', { message: 'read this', files: [{ name: 'a.docx', data: 'eA==' }] })).status).toBe(415);
  });

  it('lists app change tickets and records the gate result the terminal reports', async () => {
    const ticket = await app.changes.create({ request: 'Add a CSV export to the Results tab', desired: 'A Download CSV button' });
    expect((await call('GET', '/api/changes')).body.map((t: { id: string }) => t.id)).toContain(ticket.id);
    const done = await call('POST', `/api/changes/${ticket.id}/report`, { state: 'done', passed: true, summary: 'PASS  tests 183 passed' });
    expect(done.body).toMatchObject({ state: 'done', result: { passed: true } });
    expect((await call('POST', '/api/changes/C999/report', { state: 'done' })).status).toBe(400);
    await new Promise((r) => setTimeout(r, 50));
    expect((await app.appChat.thread()).at(-1).content).toContain(`Change ${ticket.id} finished — quality gate PASSED`);
  });

  it('starts the coder the user picked on a ticket and undoes only an applied change', async () => {
    expect((await call('POST', '/api/changes/C999/run')).status).toBe(404);
    const ticket = await app.changes.create({ request: 'Show the loop score as a chart', desired: 'A chart in Gates & logs' });
    const started: Array<[string, string]> = [];
    app.coder.start = ((id: string, engine: string) => { started.push([id, engine]); return { started: true, message: `${id} queued for the ${engine} coder` }; }) as typeof app.coder.start;
    expect((await call('POST', `/api/changes/${ticket.id}/run`)).body).toMatchObject({ started: true, engine: 'free' });
    expect((await call('POST', `/api/changes/${ticket.id}/run`, { engine: 'claude' })).body).toMatchObject({ started: true, engine: 'claude', message: `${ticket.id} queued for the claude coder` });
    expect(started).toEqual([[ticket.id, 'free'], [ticket.id, 'claude']]);
    expect((await call('POST', `/api/changes/${ticket.id}/undo`)).status).toBe(409);
    await fs.writeFile(path.join(dir, 'changes', `${ticket.id}.attempts.jsonl`), `${JSON.stringify({ step: 'claude', gate: 'FAIL  tests' })}\n`);
    const detail = await call('GET', `/api/changes/${ticket.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ ticket: { id: ticket.id }, attempts: [{ step: 'claude', gate: 'FAIL  tests' }] });
    expect((await call('GET', '/api/changes/C999')).status).toBe(404);
  });

  it('serves the results exports and the current action plan with every project', async () => {
    const created = (await call('POST', '/api/projects', { question: 'Should I sell used e-bikes in Brno this spring?' })).body;
    await call('POST', `/api/projects/${created.id}/run`);
    const done = await waitFor(created.id, 'done');
    expect(done.report.status).toMatchObject({ coverage: expect.any(Number), confidence: expect.any(String) });
    expect(Array.isArray(done.report.actions)).toBe(true);
    expect(done.results.status).toEqual(done.report.status);
    const csv = await fetch(`${base}/api/projects/${created.id}/pieces.csv`);
    expect([csv.status, csv.headers.get('content-type'), csv.headers.get('content-disposition')]).toEqual([200, 'text/csv; charset=utf-8', `attachment; filename="${created.id}-pieces.csv"`]);
    expect((await csv.text()).replace(/^\ufeff/, '').startsWith('piece,title,role,grade')).toBe(true);
    expect((await call('GET', `/api/projects/${created.id}/results.json`)).body).toMatchObject({ question: 'Should I sell used e-bikes in Brno this spring?', pieces: expect.any(Array) });
    expect((await fetch(`${base}/api/projects/${created.id}/items.csv`)).status).toBe(200);
  });
});
