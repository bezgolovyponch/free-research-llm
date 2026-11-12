import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../src/app.mjs';
import { ScriptedProvider } from '../src/llm/scripted-provider.mjs';
import { startServer, withResults } from '../src/server.mjs';
import { plotResearch } from './helpers/research-shapes';

let base: string;
let close: () => void;
let dir: string;

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
}

async function waitFor(id: string, phase: string) {
  const until = Date.now() + 45000;
  while (Date.now() < until) {
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

  it('creates a project, runs it in the background, streams events and exports Markdown', { timeout: 90000 }, async () => {
    const created = await call('POST', '/api/projects', { question: 'Where should I build a 6-tent glamping site in Czechia?', constraints: { budget: '€250k' } });
    expect(created.status).toBe(200);
    const events = await fetch(`${base}/api/projects/${created.body.id}/events`);
    const reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toMatch(/^data: .*"type":"hello"/);
    await reader.cancel();
    const done = await waitFor(created.body.id, 'done');
    expect(done.report.verdict).toBeTruthy();
    expect(typeof done.results.audit.errors).toBe('number');
    expect(typeof done.results.audit.warnings).toBe('number');
    expect(Array.isArray(done.results.audit.findings)).toBe(true);
    const md = await call('GET', `/api/projects/${created.body.id}/report.md`);
    expect(md.body).toMatch(/## Verdict/);
    const rerun = await call('POST', `/api/projects/${created.body.id}/nodes/D1.1/rerun`, { hint: 'use 2026 data' });
    expect(rerun.status).toBe(200);
    await waitFor(created.body.id, 'done');
    expect((await call('GET', '/api/projects')).body[0].id).toBe(created.body.id);
  });

  it('serves cross-research principles via /api/principles', async () => {
    const { principlesFrom } = await import('../src/research/lessons.mjs');
    const lessons = [
      { type: 'source', change: 'Portuguese rural parks need municipal plan approval', outcome: 'kept', gain: 0.1, researchId: 'p1' },
      { type: 'source', change: 'Portuguese rural parks need municipal plan approval', outcome: 'kept', gain: 0.2, researchId: 'p2' },
      { type: 'source', change: 'Portuguese rural parks need municipal plan approval', outcome: 'kept', gain: 0.15, researchId: 'p3' },
      { type: 'gate', change: 'Sea distance must be measured', outcome: 'kept', gain: 0.05, researchId: 'p1' },
    ];
    const principles = principlesFrom(lessons, 'source');
    expect(principles).toMatchObject([{ change: 'Portuguese rural parks need municipal plan approval', verdict: 'helps', tests: 3, kept: 3 }]);
    await app.lessons.add(lessons);
    const res = await call('GET', '/api/principles?type=source');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: [{ change: 'Portuguese rural parks need municipal plan approval', verdict: 'helps' }] });
  });

  it('filters /api/principles?project=<id> to the research kind of that project', async () => {
    await app.store.save({ id: 'kind-filter-test-1', question: 'Plots to buy for glamping', nodes: [], brief: { kind: { label: 'plot of land', terms: ['plot', 'terreno'] } } });
    await app.lessons.add([
      { type: 'source', kind: 'plot of land', change: 'Read the listing page itself, e.g. https://www.imovirtual.com/pt/anuncio/terreno-rustico-em-paiao-figueira-da-foz-ID1j2CX, not the search snippet', outcome: 'kept', gain: 0.1, researchId: 'p1' },
      { type: 'source', kind: 'plot of land', change: 'Read the listing page itself, e.g. https://www.imovirtual.com/pt/anuncio/terreno-rustico-em-paiao-figueira-da-foz-ID1j2CX, not the search snippet', outcome: 'kept', gain: 0.1, researchId: 'p2' },
      { type: 'source', kind: 'plot of land', change: 'Read the listing page itself, e.g. https://www.imovirtual.com/pt/anuncio/terreno-rustico-em-paiao-figueira-da-foz-ID1j2CX, not the search snippet', outcome: 'kept', gain: 0.1, researchId: 'p3' },
      { type: 'source', kind: 'wholesale second-hand clothing supplier', change: 'Replace the search-engine lookups with brand-filtered category pages on https://www.zagumi.com/nl/used-clothing/', outcome: 'kept', gain: 0.2, researchId: 'b2f5b7' },
      { type: 'source', kind: 'wholesale second-hand clothing supplier', change: 'Replace the search-engine lookups with brand-filtered category pages on https://www.zagumi.com/nl/used-clothing/', outcome: 'kept', gain: 0.2, researchId: 'b2f5b7x' },
      { type: 'source', kind: 'wholesale second-hand clothing supplier', change: 'Replace the search-engine lookups with brand-filtered category pages on https://www.zagumi.com/nl/used-clothing/', outcome: 'kept', gain: 0.2, researchId: 'b2f5b7y' },
    ]);
    const res = await call('GET', '/api/principles?project=kind-filter-test-1');
    expect(res.status).toBe(200);
    const changes = Object.values(res.body).flat().map((p: { change: string }) => p.change);
    expect(changes).toContain('Read the listing page itself, e.g. https://www.imovirtual.com/pt/anuncio/terreno-rustico-em-paiao-figueira-da-foz-ID1j2CX, not the search snippet');
    expect(changes).not.toContain('Replace the search-engine lookups with brand-filtered category pages on https://www.zagumi.com/nl/used-clothing/');
    expect((await call('GET', '/api/principles?project=missing-project')).status).toBe(404);
  });

  it('reports the meaning check and the nature of the results, and rechecks claims on request', { timeout: 90000 }, async () => {
    const created = await call('POST', '/api/projects', { question: 'Which camp permit costs apply in Czechia?' });
    const done = await waitFor(created.body.id, 'done');
    expect(done.results.support).toMatchObject({ version: 2, stale: 0 });
    expect(done.results.support.toConfirm).toBe(0);
    expect(done.results.nature.lines[0]).toMatch(/^Fits are the current conclusion/);
    expect(done.results.lease).toBeNull();
    const recheck = await call('POST', `/api/projects/${created.body.id}/recheck-support`, {});
    expect(recheck.status).toBe(200);
    expect(recheck.body).toMatchObject({ ok: true, message: expect.stringMatching(/^rechecked 0 piece\(s\)/) });
    expect((await call('POST', '/api/projects/missing/recheck-support', {})).status).toBe(404);
  });

  it('adds the lease alert for plots that cannot be bought, with the horizon from the request', () => {
    const leaseRow = (url: string, paybackMonths: number) => ({ url, title: 'Đất ven biển', place: 'Phan Thiết', country: 'Vietnam', countryCode: 'VN', plan: { tier: 'blocked', checks: [{ id: 'legal', label: 'Legal path', ok: false }, { id: 'sea', label: 'Sea within reach', ok: true }], withoutOwning: { path: 'operate without owning', sources: ['vn-lease'], units: 3, months: 8, setupEur: 5000, revenueEur: 20000, paybackMonths, landShareMax: 0.75, paysBackInYear: paybackMonths <= 8, missing: [] } } });
    const project = { id: 'x', question: 'Plots for glamping, pay back within 1 year', nodes: [], candidates: { kept: [leaseRow('https://batdongsan.com.vn/ban-dat-xa-1', 2), leaseRow('https://batdongsan.com.vn/ban-dat-xa-2', 11)] } };
    const lease = withResults(project).results.lease;
    expect(lease).toMatchObject({ horizonMonths: 12, feasibleCount: 1, notFeasible: 1, countries: ['Vietnam'] });
    expect(lease.headline).toMatch(/^1 plot\(s\) in Vietnam cannot be bought by a foreign buyer but can be leased/);
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

  it('decide passes the chosen implementer: "with free models" never starts Claude Code, even when the model proposed it', async () => {
    const started: Array<[string, string]> = [];
    app.coder.start = ((id: string, engine: string) => { started.push([id, engine]); return { started: true, message: `${id} queued for the ${engine} coder` }; }) as typeof app.coder.start;
    app.coder.available = (() => true) as typeof app.coder.available;
    const sent = await call('POST', '/api/chat', { message: 'make the Run button green in the header' });
    expect(sent.body.proposals[0]).toMatchObject({ type: 'change', engine: 'claude', state: 'proposed' });
    const decided = await call('POST', '/api/chat/decide', { at: sent.body.thread.at(-1).at, pid: sent.body.proposals[0].pid, accept: true, engine: 'free' });
    expect(decided.body.proposal).toMatchObject({ state: 'done', engine: 'free', result: { engine: 'free' } });
    expect(started).toEqual([[decided.body.proposal.result.ticketId, 'free']]);
    expect(await app.changes.get(decided.body.proposal.result.ticketId)).toMatchObject({ engine: 'free' });
    const again = await call('POST', '/api/chat', { message: 'make the Run button green in the header' });
    expect((await call('POST', '/api/chat/decide', { at: again.body.thread.at(-1).at, pid: again.body.proposals[0].pid, accept: true, engine: 'gpt' })).status).toBe(409);
  });

  it('refuses cross-site writes and a foreign Host on this computer, and keeps the page of the app working', async () => {
    const port = new URL(base).port;
    const raw = (method: string, url: string, headers: Record<string, string>, body = '') => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: url, method, headers }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      request.on('error', reject);
      request.end(body);
    });
    const keys: unknown[][] = [];
    const setKey = app.setKey;
    app.setKey = (async (...args: unknown[]) => { keys.push(args); }) as never;
    try {
      const host = `127.0.0.1:${port}`;
      const hostile = JSON.stringify({ provider: 'custom', key: 'k', baseURL: 'https://evil.example/v1' });
      const simple = { host, origin: 'https://evil.example', 'content-type': 'text/plain' };
      const crossSite = await raw('POST', '/api/keys', simple, hostile);
      expect(crossSite.status).toBe(403);
      expect(crossSite.body).toMatch(/another website/);
      expect((await raw('POST', '/api/terminal', simple, JSON.stringify({ cols: 80 }))).status).toBe(403);
      expect((await raw('POST', '/api/keys', { ...simple, origin: 'null' }, hostile)).status).toBe(403);
      expect(keys).toEqual([]);
      expect(app.terminal.list()).toEqual([]);
      const rebound = await raw('GET', '/api/status', { host: `attacker.example:${port}` });
      expect(rebound.status).toBe(403);
      expect(rebound.body).not.toMatch(/providers/);
      expect((await raw('GET', '/', { host: `attacker.example:${port}` })).status).toBe(403);
      expect((await raw('GET', '/api/status', { host })).status).toBe(200);
      expect((await raw('GET', '/api/status', { host: `localhost:${port}` })).status).toBe(200);
      const own = JSON.stringify({ provider: 'custom', key: 'k', baseURL: 'http://localhost:3001/v1' });
      expect((await raw('POST', '/api/keys', { host, origin: `http://${host}`, 'content-type': 'application/json' }, own)).status).toBe(200);
      expect(keys).toEqual([['custom', 'k', 'http://localhost:3001/v1']]);
    } finally {
      app.setKey = setKey;
    }
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
    expect((await fetch(`${base}/api/projects/${created.id}/candidates.csv`)).headers.get('content-disposition')).toBe(`attachment; filename="${created.id}-candidates.csv"`);
    const xlsx = await fetch(`${base}/api/projects/${created.id}/results.xlsx`);
    expect(xlsx.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(xlsx.headers.get('content-disposition')).toBe(`attachment; filename="${created.id}-results.xlsx"`);
    expect(Buffer.from(await xlsx.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');
    const zip = await fetch(`${base}/api/projects/${created.id}/results.zip`);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(zip.headers.get('content-disposition')).toBe(`attachment; filename="${created.id}-results.zip"`);
    expect(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');
    expect(done.results.model).toMatchObject({ kind: 'decision', probability: expect.any(Number), changedSince: [] });
    expect(typeof done.report.model).toBe('string');
    expect(Array.isArray(done.results.treeAudit)).toBe(true);
    const rewritten = (await call('POST', `/api/projects/${created.id}/synthesize`)).body;
    expect(rewritten.report.basis).toBeTruthy();
  });

  it('lists the snapshots and journal of a research and restores it through the API, but not while it runs', async () => {
    const project = plotResearch();
    project.id = 'plots-restore-through-api-1';
    await app.store.save(project, { reason: 'research created' });
    expect((await call('DELETE', `/api/projects/${project.id}/nodes/D1.1`)).status).toBe(200);
    const view = (await call('GET', `/api/projects/${project.id}/snapshots`)).body;
    expect(view.snapshots).toHaveLength(1);
    expect(view.snapshots[0]).toMatchObject({ nodes: 3, rows: 3, phase: 'done' });
    expect(view.journal).toMatchObject({ entries: 2, removals: [{ userAction: 'delete', nodes: ['D1.1'], rows: 0 }] });
    expect((await call('GET', `/api/projects/${project.id}`)).body.nodes.map((n: { id: string }) => n.id)).toEqual(['D1', 'D2']);
    app.engine.running.add(project.id);
    expect((await call('POST', `/api/projects/${project.id}/restore`, { snapshot: view.snapshots[0].file })).status).toBe(409);
    app.engine.running.delete(project.id);
    expect((await call('POST', `/api/projects/${project.id}/restore`, {})).status).toBe(400);
    const restored = (await call('POST', `/api/projects/${project.id}/restore`, { snapshot: view.snapshots[0].file }));
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ ok: true, from: 'snapshot', nodes: { before: 2, after: 3 } });
    expect((await call('GET', `/api/projects/${project.id}`)).body.nodes.map((n: { id: string }) => n.id)).toEqual(['D1', 'D1.1', 'D2']);
    await app.logs.queue;
    const log = (await call('GET', `/api/projects/${project.id}/logs`)).body;
    expect(log.some((e: { type: string; message: string }) => e.type === 'restore' && /pieces 2 → 3/.test(e.message))).toBe(true);
    expect((await call('GET', `/api/projects/no-such-research-00/snapshots`)).status).toBe(404);
  });
});

describe('teammates', () => {
  it('turns Run or Improve on a running research into one more lane instead of an error', { timeout: 90000 }, async () => {
    const created = await call('POST', '/api/projects', { question: 'Which Czech city suits a small specialty bakery best?' });
    await waitFor(created.body.id, 'done');
    for (let i = 0; i < 400 && app.engine.running.has(created.body.id); i++) await new Promise((r) => setTimeout(r, 25));
    app.engine.running.add(created.body.id);
    try {
      const join = await call('POST', `/api/projects/${created.body.id}/run`, { clientId: 'pc-browser' });
      expect(join.status).toBe(200);
      expect(join.body).toEqual({ joined: true, already: false, lanes: 3, mine: true });
      expect((await call('POST', `/api/projects/${created.body.id}/run`, { clientId: 'pc-browser' })).body).toMatchObject({ already: true, lanes: 3 });
      expect((await call('GET', `/api/projects/${created.body.id}`)).body).toMatchObject({ lanes: 3, helpers: ['pc-browser'] });
      expect((await call('POST', `/api/projects/${created.body.id}/improve`, { hours: 0.01, clientId: 'mac-browser' })).body).toMatchObject({ joined: true, lanes: 4 });
      expect((await call('POST', `/api/projects/${created.body.id}/leave`, { clientId: 'pc-browser' })).body).toEqual({ left: true, lanes: 3, mine: false });
    } finally {
      app.engine.running.delete(created.body.id);
      app.engine.leave(created.body.id);
    }
    expect((await call('GET', `/api/projects/${created.body.id}`)).body.lanes).toBe(2);
  });

  it('keeps a joined browser on the team after a restart: its page reconnects and the lane comes back, and the hello carries the build', { timeout: 90000 }, async () => {
    const created = await call('POST', '/api/projects', { question: 'Which Czech city suits a small specialty bakery best?' });
    await waitFor(created.body.id, 'done');
    for (let i = 0; i < 400 && app.engine.running.has(created.body.id); i++) await new Promise((r) => setTimeout(r, 25));
    app.engine.running.add(created.body.id);
    try {
      await call('POST', `/api/projects/${created.body.id}/run`, { clientId: 'pc-browser' });
      app.engine.leave(created.body.id);
      expect(app.engine.teamOf(created.body.id).helpers).toEqual([]);
      const controller = new AbortController();
      const res = await fetch(`${base}/api/projects/${created.body.id}/events?client=pc-browser`, { signal: controller.signal });
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      controller.abort();
      expect(first).toContain(`"build":"${app.build}"`);
      expect(app.engine.teamOf(created.body.id).helpers).toEqual(['pc-browser']);
      expect((await call('GET', '/api/status')).body.build).toBe(app.build);
    } finally {
      app.engine.running.delete(created.body.id);
      app.engine.leave(created.body.id);
    }
  });
});

describe('research share links', () => {
  it('opens one research from another computer and nothing else, until the owner turns the link off', async () => {
    const shareDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-server-share-'));
    const search = { enabled: false, lastErrors: [], search: async () => [], describe: () => ({ enabled: false, backends: [], lastErrors: [] }) };
    const shareApp = new App({ env: {}, dataDir: shareDir, providers: [new ScriptedProvider()], search });
    const started = await startServer({ app: shareApp, port: 0, token: 'owner-token' });
    const remote = { 'x-forwarded-for': '203.0.113.9' };
    const owner = async (method: string, url: string, body?: unknown) => (await fetch(started.url + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
    try {
      const shared = await owner('POST', '/api/projects', { question: 'Which Czech city is best for a small bakery?' });
      const other = await owner('POST', '/api/projects', { question: 'Where should I open a coffee kiosk in Brno?' });
      expect(await owner('GET', `/api/projects/${shared.id}/share`)).toMatchObject({ enabled: false, links: [] });
      const view = await owner('POST', `/api/projects/${shared.id}/share`);
      expect(view).toMatchObject({ projectId: shared.id, enabled: true, remote: true });
      for (const link of view.links) expect(link.url).toMatch(new RegExp(`/\\?share=${view.token}#p=${shared.id}$`));

      const entry = await fetch(`${started.url}/?share=${view.token}`, { headers: remote, redirect: 'manual' });
      expect(entry.status).toBe(302);
      const cookie = String(entry.headers.get('set-cookie')).split(';')[0];
      expect(cookie).toBe(`frl_share=${view.token}`);
      const helper = async (method: string, url: string) => {
        const res = await fetch(started.url + url, { method, headers: { ...remote, cookie, 'content-type': 'application/json' } });
        return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
      };
      expect((await helper('GET', '/')).status).toBe(200);
      expect((await helper('GET', '/api/whoami')).body).toEqual({ share: shared.id, canShare: true });
      expect((await helper('GET', '/api/projects')).body.map((p: { id: string }) => p.id)).toEqual([shared.id]);
      expect((await helper('GET', `/api/projects/${shared.id}`)).body.question).toMatch(/bakery/);
      expect((await helper('GET', '/api/status')).body).toMatchObject({ ledger: [], coders: [] });
      expect((await helper('GET', '/api/status')).body.thisDevice).toMatchObject({ host: '127.0.0.1', helping: false, servers: null });
      shareApp.peers.results.set('127.0.0.1', { checkedAt: 0, endpoints: [{ id: 'llamacpp-lan', label: 'llama.cpp', url: 'http://127.0.0.1:8090/v1', ok: false, detail: 'no answer (PC off or asleep, server not started, or blocked by Windows Firewall)' }] });
      const device = (await helper('GET', '/api/status')).body.thisDevice;
      expect(device).toMatchObject({ helping: false, checkedAt: '1970-01-01T00:00:00.000Z', servers: [{ label: 'llama.cpp', ok: false }] });
      expect(device.setup === null || device.setup.includes(`/pc-setup.ps1?share=${view.token}`)).toBe(true);
      expect((await owner('GET', '/api/status')).thisDevice).toBeUndefined();
      for (const [m, u] of [['GET', `/api/projects/${other.id}`], ['DELETE', `/api/projects/${shared.id}`], ['POST', `/api/projects/${shared.id}/share`], ['POST', '/api/projects'], ['GET', '/api/terminal'], ['GET', '/api/router'], ['GET', '/api/chat'], ['GET', '/api/access']]) expect((await helper(m, u)).status, `${m} ${u}`).toBe(403);
      expect((await fetch(`${started.url}/api/projects`, { headers: remote })).status).toBe(401);
      expect((await fetch(`${started.url}/favicon.ico`, { headers: remote })).status).toBe(204);
      const script = await fetch(`${started.url}/pc-setup.ps1?share=${view.token}`, { headers: remote, redirect: 'manual' });
      expect(script.status).toBe(200);
      expect(await script.text()).toContain('llama-server.exe');
      expect((await fetch(`${started.url}/pc-setup.ps1`, { headers: remote })).status).toBe(401);
      expect(view.pcSetup === null || view.pcSetup.includes(`/pc-setup.ps1?share=${view.token}`)).toBe(true);
      const reachable = await fetch(`${started.url}/reachable`, { headers: remote });
      expect(reachable.status).toBe(200);
      expect(await reachable.text()).toContain('is reachable');
      await shareApp.logs.queue;
      const access = (await shareApp.logs.read('history')).filter((e: { type: string }) => e.type === 'access').map((e: { message: string }) => e.message);
      expect(access).toContain('other device 127.0.0.1 opened / · research link (' + shared.id + ')');
      expect(access.some((m: string) => /refused: missing or wrong access token/.test(m))).toBe(true);
      expect(access.some((m: string) => m.includes('favicon'))).toBe(false);

      expect(await owner('DELETE', `/api/projects/${shared.id}/share`)).toMatchObject({ enabled: false, token: null });
      const after = await helper('GET', `/api/projects/${shared.id}`);
      expect(after.status).toBe(401);
      expect(after.body).toMatch(/turned off or replaced/);
    } finally {
      started.server.close();
      await shareApp.logs.queue;
      await fs.rm(shareDir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
