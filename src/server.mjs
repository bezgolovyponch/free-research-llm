#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { App, ROOT_DIR } from './app.mjs';
import { KeychainSecrets } from './secrets.mjs';
import { NotFoundError, ProjectBusyError } from './research/engine.mjs';
import { TEMPLATES } from './research/templates.mjs';
import { toMarkdown } from './report.mjs';

const MAX_BODY = 8 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large (max 8 MB)');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
}

function statusFor(error) {
  if (error instanceof HttpError) return error.status;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ProjectBusyError) return 409;
  return 400;
}

export function createServer(app) {
  const routes = [
    ['GET', /^\/api\/status$/, async () => app.status()],
    ['POST', /^\/api\/providers\/refresh$/, async () => {
      await app.refreshProviders();
      return app.status();
    }],
    ['POST', /^\/api\/keys$/, async (req) => {
      const body = await readJson(req);
      await app.setKey(body.provider, body.key, body.baseURL);
      return app.status();
    }],
    ['GET', /^\/api\/templates$/, async () => TEMPLATES],
    ['GET', /^\/api\/projects$/, async () => app.store.list()],
    ['POST', /^\/api\/projects$/, async (req) => {
      const body = await readJson(req);
      if (!app.router.ready) throw new HttpError(409, 'no model provider is ready — open Setup and connect a free model (or start with: npm run demo)');
      const project = await app.engine.createProject(body);
      if (body.autoRun !== false) app.engine.start(project.id);
      return project;
    }],
    ['GET', /^\/api\/projects\/([\w-]+)$/, async (req, [id]) => app.engine.load(id)],
    ['DELETE', /^\/api\/projects\/([\w-]+)$/, async (req, [id]) => {
      await app.store.remove(id);
      return { ok: true };
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/run$/, async (req, [id]) => {
      await app.engine.load(id);
      if (app.engine.running.has(id)) throw new ProjectBusyError('already running');
      app.engine.start(id);
      return { ok: true };
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/cancel$/, async (req, [id]) => {
      app.engine.cancel(id);
      return { ok: true };
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/nodes\/([\w.-]+)\/rerun$/, async (req, [id, nodeId]) => {
      const body = await readJson(req);
      return app.engine.rerunNode(id, nodeId, body.hint);
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/nodes\/([\w.-]+)\/expand$/, async (req, [id, nodeId]) => {
      const body = await readJson(req);
      return app.engine.expandNode(id, nodeId, body.hint);
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/nodes\/([\w.-]+)\/children$/, async (req, [id, parentId]) => app.engine.addNode(id, parentId, await readJson(req))],
    ['PATCH', /^\/api\/projects\/([\w-]+)\/nodes\/([\w.-]+)$/, async (req, [id, nodeId]) => app.engine.editNode(id, nodeId, await readJson(req))],
    ['DELETE', /^\/api\/projects\/([\w-]+)\/nodes\/([\w.-]+)$/, async (req, [id, nodeId]) => app.engine.removeNode(id, nodeId)],
  ];

  async function serveEvents(req, res, id) {
    const project = await app.engine.load(id);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const push = (event, current) => res.write(`data: ${JSON.stringify({ event, project: current })}\n\n`);
    push({ type: 'hello', message: 'connected' }, project);
    const unsubscribe = app.engine.subscribe(id, push);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, await fs.readFile(path.join(ROOT_DIR, 'public', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
      }
      const events = url.pathname.match(/^\/api\/projects\/([\w-]+)\/events$/);
      if (req.method === 'GET' && events) return await serveEvents(req, res, events[1]);
      const report = url.pathname.match(/^\/api\/projects\/([\w-]+)\/report\.md$/);
      if (req.method === 'GET' && report) {
        const project = await app.engine.load(report[1]);
        res.setHeader('content-disposition', `attachment; filename="${project.id}.md"`);
        return send(res, 200, toMarkdown(project), 'text/markdown; charset=utf-8');
      }
      for (const [method, pattern, handler] of routes) {
        const match = url.pathname.match(pattern);
        if (match && req.method === method) return send(res, 200, await handler(req, match.slice(1)));
      }
      throw new HttpError(404, 'not found');
    } catch (error) {
      if (!res.headersSent) send(res, statusFor(error), { error: error.message });
    }
  });
}

export async function startServer({ app = new App(), port = Number(process.env.PORT || 4600), host = process.env.HOST || '127.0.0.1' } = {}) {
  await app.refreshProviders();
  const server = createServer(app);
  await new Promise((resolve) => server.listen(port, host, resolve));
  return { app, server, url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const fromKeychain = await new KeychainSecrets().fillMissing(process.env);
  const { app, url } = await startServer();
  if (fromKeychain.length) console.log(`  keys from macOS Keychain: ${fromKeychain.join(', ')}`);
  const status = app.status();
  const ready = status.providers.filter((p) => p.state === 'ready');
  console.log(`\n  Free Research LLM is running → ${url}\n`);
  console.log(ready.length ? `  models: ${ready.map((p) => `${p.id} (${p.fast})`).join(', ')}` : '  models: NONE connected yet — run ./keys.command (or open Setup in the page)');
  if (ready.length) console.log(`  route deep: ${status.route.deep.join(' → ')}\n  route fast: ${status.route.fast.join(' → ')}`);
  console.log(`  search: ${status.search.backends.join(', ') || 'off'}${status.demo ? '\n  DEMO MODE: scripted answers, not real research' : ''}\n`);
}
