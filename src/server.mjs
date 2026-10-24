#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { App, ROOT_DIR } from './app.mjs';
import { KeychainSecrets } from './secrets.mjs';
import { AccessGate, newAccessToken } from './auth.mjs';
import { NotFoundError, ProjectBusyError } from './research/engine.mjs';
import { TEMPLATES } from './research/templates.mjs';
import { itemsCsv, piecesCsv, resultsJson, toMarkdown } from './report.mjs';
import { resultStatus } from './research/gaps.mjs';
import { resultModel } from './research/result.mjs';
import { auditTree, cleanTitle } from './research/treeaudit.mjs';
import { knowledgeRecord } from './research/knowledge.mjs';
import { ProposalError } from './appchat.mjs';
import { UnsupportedFileError } from './chat/media.mjs';
import { CONSOLE_COMMANDS } from './terminal/catalog.mjs';
import { attachTerminalSockets } from './terminal/socket.mjs';
import { accessLinks, lanAddresses } from './service.mjs';
import { ShareBook, shareAllows, shareLinks } from './share.mjs';
import { REACHABLE_PAGE, RemoteVisits } from './visits.mjs';
import { EventStream } from './events.mjs';
import { clientNodes } from './research/compact.mjs';
import { HeapGuard } from './heapguard.mjs';
import { pcSetupCommand, pcSetupScript } from './local/pcsetup.mjs';
import { ensureLocalModel } from './local/autostart.mjs';
import os from 'node:os';

const MAX_BODY = 32 * 1024 * 1024;
const VENDOR = {
  '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
  '/vendor/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'],
};

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
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large (max 32 MB)');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

export function withResults(project) {
  if (!project || typeof project !== 'object' || !Array.isArray(project.nodes) || typeof project.question !== 'string') return project;
  const { plan, ...status } = resultStatus(project);
  const results = { status, actions: plan.slice(0, 40), model: resultModel(project), treeAudit: auditTree(project.nodes, project.question) };
  return { ...project, nodes: clientNodes(project.nodes).map((n) => (cleanTitle(n.title) !== n.title ? { ...n, title: cleanTitle(n.title) } : n)), results, report: project.report ? { ...project.report, status: results.status, actions: results.actions } : null };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
}

function statusFor(error) {
  if (error instanceof HttpError) return error.status;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ProjectBusyError || error instanceof ProposalError) return 409;
  if (error instanceof UnsupportedFileError) return 415;
  return 400;
}

function sharedStatus(status, projectId) {
  return { ...status, ledger: [], calls: 0, improving: status.improving.filter((id) => id === projectId), improveAll: {}, coders: [] };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function deny(res, reason, { address = '', research = false } = {}) {
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  const next = research
    ? 'Open the research link you were given again, copied in full: it must contain <code>?share=</code>. Close any older tab of this app first.'
    : 'Open the research link you were given, copied in full: it must contain <code>?share=</code>. The owner gets it in the research under More → Share this research, or with <code>node src/frl.mjs share</code>.';
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access needed</title><body style="font:16px system-ui;padding:24px;max-width:560px"><h2>Free Research LLM</h2><p><b>Why:</b> ${escapeHtml(reason)}.</p><p><b>Next:</b> ${next}</p><p style="color:#666;font-size:14px">This device: ${escapeHtml(address || 'unknown')}. The owner sees this attempt in History.</p></body>`);
}

export function createServer(app, gate = new AccessGate()) {
  const routes = [
    ['GET', /^\/api\/status$/, async (req) => {
      const status = req.access.share ? sharedStatus(app.status(), req.access.share) : app.status();
      return gate.isLoopback(req) ? status : { ...status, thisDevice: deviceView(req) };
    }],
    ['GET', /^\/api\/whoami$/, async (req) => ({ share: req.access.share ?? null, canShare: Boolean(gate.shares?.available) })],
    ['GET', /^\/api\/projects\/([\w-]+)\/share$/, async (req, [id]) => shareView(id)],
    ['POST', /^\/api\/projects\/([\w-]+)\/share$/, async (req, [id]) => {
      if (!gate.shares) throw new HttpError(409, 'sharing needs the app started by "node src/frl.mjs start --remote" or "node src/frl.mjs install"');
      await app.engine.load(id);
      await gate.shares.enable(id);
      return shareView(id);
    }],
    ['DELETE', /^\/api\/projects\/([\w-]+)\/share$/, async (req, [id]) => {
      if (gate.shares) await gate.shares.revoke(id);
      return shareView(id);
    }],
    ['POST', /^\/api\/providers\/refresh$/, async () => {
      await app.refreshProviders();
      return app.status();
    }],
    ['POST', /^\/api\/keys\/reload$/, async () => app.reloadKeys()],
    ['POST', /^\/api\/keys$/, async (req) => {
      const body = await readJson(req);
      await app.setKey(body.provider, body.key, body.baseURL);
      return app.status();
    }],
    ['GET', /^\/api\/router$/, async (req) => app.routerAdmin.view({ verify: new URL(req.url, 'http://x').searchParams.get('verify') === '1' })],
    ['POST', /^\/api\/router\/keys$/, async (req) => {
      const body = await readJson(req);
      try {
        return await app.routerAdmin.save(String(body.name ?? ''), body.value, { force: body.force === true });
      } catch (error) {
        if (error instanceof RangeError) throw new HttpError(400, error.message);
        throw error;
      }
    }],
    ['POST', /^\/api\/router\/keys\/([A-Z0-9_]+)\/test$/, async (req, [name]) => {
      try {
        return await app.routerAdmin.test(name);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
    }],
    ['DELETE', /^\/api\/router\/keys\/([A-Z0-9_]+)$/, async (req, [name]) => {
      try {
        return await app.routerAdmin.remove(name);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
    }],
    ['POST', /^\/api\/router\/strategy$/, async (req) => {
      try {
        return await app.routerAdmin.setStrategy(String((await readJson(req)).strategy ?? ''));
      } catch (error) {
        throw new HttpError(400, error.message);
      }
    }],
    ['POST', /^\/api\/router\/use$/, async (req) => {
      const body = await readJson(req);
      try {
        return await app.routerAdmin.use(String(body.id ?? ''), body.on !== false);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
    }],
    ['POST', /^\/api\/router\/order$/, async (req) => {
      try {
        return await app.routerAdmin.order((await readJson(req)).order);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
    }],
    ['GET', /^\/api\/templates$/, async () => TEMPLATES],
    ['GET', /^\/api\/projects$/, async (req) => (await app.store.list()).filter((p) => !req.access.share || p.id === req.access.share)],
    ['POST', /^\/api\/projects$/, async (req) => {
      const body = await readJson(req);
      if (!app.router.ready) throw new HttpError(409, 'no model provider is ready — open Setup and connect a free model (or start with: npm run demo)');
      const project = await app.engine.createProject(body);
      if (body.autoRun !== false) app.engine.start(project.id);
      return project;
    }],
    ['GET', /^\/api\/projects\/([\w-]+)$/, async (req, [id]) => {
      return { ...withResults(await app.engine.load(id)), ...app.engine.teamOf(id) };
    }],
    ['DELETE', /^\/api\/projects\/([\w-]+)$/, async (req, [id]) => {
      if (app.engine.running.has(id) || app.improver.isActive(id)) throw new ProjectBusyError('stop it first: the research is running');
      const project = await app.store.get(id);
      await app.store.remove(id);
      if (project) app.noteApp(`Research deleted: ${String(project.question).slice(0, 110)}`);
      return { ok: true };
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/leave$/, async (req, [id]) => {
      await app.engine.load(id);
      return app.engine.leaveOne(id, String((await readJson(req)).clientId ?? ''));
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/run$/, async (req, [id]) => {
      await app.engine.load(id);
      const clientId = String((await readJson(req)).clientId ?? '');
      if (app.improver.isActive(id)) return app.improver.join(id, clientId);
      if (app.engine.running.has(id)) return app.engine.join(id, clientId);
      app.engine.start(id);
      return { ok: true };
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/reset$/, async (req, [id]) => {
      if (app.improver.isActive(id)) throw new ProjectBusyError('the self-improving loop is running; stop it first');
      return app.engine.resetResearch(id, await readJson(req));
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/tree$/, async (req, [id]) => app.engine.buildTree(id)],
    ['PATCH', /^\/api\/projects\/([\w-]+)$/, async (req, [id]) => app.engine.updateProject(id, await readJson(req))],
    ['GET', /^\/api\/projects\/([\w-]+)\/logs$/, async (req, [id]) => app.logs.read(`project-${id}`)],
    ['GET', /^\/api\/logs\/model-calls$/, async () => app.logs.read('model-calls')],
    ['GET', /^\/api\/history$/, async () => app.history()],
    ['GET', /^\/api\/chat$/, async () => app.appChat.thread()],
    ['POST', /^\/api\/chat$/, async (req) => {
      const body = await readJson(req);
      return app.appChat.send(body.message, { files: body.files ?? [] });
    }],
    ['POST', /^\/api\/chat\/decide$/, async (req) => {
      const body = await readJson(req);
      return app.appChat.decide(String(body.at ?? ''), String(body.pid ?? ''), { accept: body.accept !== false });
    }],
    ['GET', /^\/api\/changes$/, async () => app.changes.all()],
    ['GET', /^\/api\/changes\/(C\d{1,5})\/?$/, async (req, [id]) => {
      const ticket = await app.changes.get(id);
      if (!ticket) throw new HttpError(404, `change ${id} not found`);
      return { ticket, attempts: await app.changes.attempts(id) };
    }],
    ['POST', /^\/api\/changes\/(C\d{1,5})\/report$/, async (req, [id]) => {
      const ticket = await app.changes.report(id, await readJson(req));
      if (ticket.state === 'running') app.noteApp(`Change ${id} started in the Terminal: ${ticket.title}`);
      if (ticket.result) app.noteApp(`Change ${id} ${ticket.state === 'done' ? 'finished' : 'did not finish'} — ${ticket.result.passed ? 'quality gate PASSED' : 'quality gate FAILED'}: ${ticket.title}${ticket.result.summary ? `\n${ticket.result.summary}` : ''}`);
      return ticket;
    }],
    ['POST', /^\/api\/changes\/(C\d{1,5})\/run$/, async (req, [id]) => {
      const ticket = await app.changes.get(id);
      if (!ticket) throw new HttpError(404, `change ${id} not found`);
      if (ticket.state === 'done') throw new HttpError(409, `${id} is already applied; undo it first`);
      const body = await readJson(req);
      try {
        const { started, message } = app.coder.start(id, body.engine ?? ticket.engine ?? 'free');
        return { started, message, engine: body.engine ?? ticket.engine ?? 'free' };
      } catch (error) {
        throw new HttpError(409, error.message);
      }
    }],
    ['POST', /^\/api\/changes\/(C\d{1,5})\/undo$/, async (req, [id]) => {
      try {
        return await app.coder.undo(id);
      } catch (error) {
        throw new HttpError(409, error.message);
      }
    }],
    ['GET', /^\/api\/access$/, async () => ({ remote: app.remote, links: accessLinks({ port: app.port, token: app.remote ? gate.token : '', lan: app.remote ? lanAddresses(os.networkInterfaces()) : [] }) })],
    ['GET', /^\/api\/terminal$/, async () => ({ mode: await app.terminal.mode(), platform: process.platform, sessions: app.terminal.list(), commands: CONSOLE_COMMANDS })],
    ['POST', /^\/api\/terminal$/, async (req) => (await app.terminal.create(await readJson(req))).describe()],
    ['DELETE', /^\/api\/terminal\/([0-9a-f]{12})$/, async (req, [id]) => ({ ok: app.terminal.close(id) })],
    ['POST', /^\/api\/app\/restart$/, async () => {
      if (process.env.FRL_SUPERVISED !== '1' || !app.onRestart) throw new HttpError(409, 'the app is not running as the always-on service, so nothing would start it again: run "node src/frl.mjs install" first, or stop it and start it by hand');
      setTimeout(() => app.onRestart(), 300);
      return { ok: true, message: 'restarting: the page reconnects in a few seconds' };
    }],
    ['GET', /^\/api\/projects\/([\w-]+)\/handoff$/, async (req, [id]) => (await app.handoffs.read(id)) ?? { projectId: id, note: 'no handoff yet: one is written every time a run or loop stops' }],
    ['POST', /^\/api\/projects\/([\w-]+)\/synthesize$/, async (req, [id]) => {
      if (app.improver.isActive(id)) throw new ProjectBusyError('the self-improving loop is running; stop it first');
      return app.engine.resynthesize(id);
    }],
    ['GET', /^\/api\/projects\/([\w-]+)\/knowledge$/, async (req, [id]) => knowledgeRecord(await app.engine.load(id))],
    ['POST', /^\/api\/projects\/([\w-]+)\/chat$/, async (req, [id]) => {
      const body = await readJson(req);
      return app.chat.send(id, body.nodeId || 'Q', body.request ?? body.message, { files: body.files ?? [], desired: body.desired ?? '', appRedirect: !req.access.share });
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/chat\/decide$/, async (req, [id]) => {
      const body = await readJson(req);
      return app.chat.decide(id, String(body.key ?? 'R'), String(body.at ?? ''), String(body.pid ?? ''), { accept: body.accept !== false });
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/nodes\/([\w.-]+)\/attachments$/, async (req, [id, nodeId]) => {
      const body = await readJson(req);
      if (!body.data) return app.engine.addAttachment(id, nodeId, body);
      const file = await app.media.read(body);
      return app.engine.addAttachment(id, nodeId, { name: file.name, text: file.text, readBy: file.model || 'the app' });
    }],
    ['DELETE', /^\/api\/projects\/([\w-]+)\/nodes\/([\w.-]+)\/attachments\/(U\d+)$/, async (req, [id, nodeId, attachmentId]) => app.engine.removeAttachment(id, nodeId, attachmentId)],
    ['POST', /^\/api\/projects\/([\w-]+)\/nodes\/([\w.-]+)\/suggest$/, async (req, [id, nodeId]) => app.suggester.suggest(id, nodeId)],
    ['POST', /^\/api\/projects\/([\w-]+)\/improve$/, async (req, [id]) => {
      await app.engine.load(id);
      const body = await readJson(req);
      if (app.improver.isActive(id)) return app.improver.join(id, String(body.clientId ?? ''));
      if (app.engine.running.has(id)) return app.engine.join(id, String(body.clientId ?? ''));
      return app.improver.start(id, body);
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/improve\/stop$/, async (req, [id]) => app.improver.stop(id)],
    ['POST', /^\/api\/improve-all$/, async (req) => {
      const body = await readJson(req);
      const result = await app.improver.startAll(body);
      app.noteApp(`Improve-all started for ${Number(body.hours) || 8} h (${Number(body.sliceMinutes) || 20} min per research)`);
      return result;
    }],
    ['POST', /^\/api\/improve-all\/stop$/, async () => {
      const result = await app.improver.stopAll();
      app.noteApp('Improve-all stopped');
      return result;
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

  function deviceView(req) {
    const host = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
    const report = app.peers?.report(host) ?? null;
    const helping = Boolean(report?.endpoints.some((e) => e.ok));
    const setup = req.access.share ? shareView(req.access.share).pcSetup : null;
    return { host, checkedAt: report ? new Date(report.checkedAt).toISOString() : null, helping, servers: report?.endpoints ?? null, setup };
  }

  function shareView(id) {
    const status = gate.shares?.status(id) ?? { enabled: false, since: null, token: null };
    const bases = app.remote ? accessLinks({ port: app.port, lan: lanAddresses(os.networkInterfaces()) }).filter((l) => !l.url.includes('127.0.0.1')) : [];
    return { projectId: id, ...status, remote: app.remote, links: status.token ? shareLinks(bases, { projectId: id, token: status.token }) : [], pcSetup: status.token && bases[0] ? pcSetupCommand(bases[0].url, status.token) : null };
  }

  async function serveEvents(req, res, id) {
    const project = await app.engine.load(id);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    req.socket?.setKeepAlive?.(true, 15000);
    const stream = new EventStream({ res, render: (current) => ({ ...withResults(current), ...app.engine.teamOf(id) }) });
    app.liveStreams ??= new Set();
    app.liveStreams.add(stream);
    stream.push({ type: 'hello', message: 'connected' }, project);
    const unsubscribe = app.engine.subscribe(id, (event, current) => stream.push(event, current));
    const ping = setInterval(() => stream.ping(), 20000);
    const done = () => {
      app.liveStreams?.delete(stream);
      clearInterval(ping);
      unsubscribe();
      stream.close();
    };
    req.on('close', done);
    res.on('close', done);
  }

  const visits = new RemoteVisits({ note: (message) => void app.logs.append('history', { type: 'access', message }) });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/reachable') return send(res, 200, REACHABLE_PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204, { 'cache-control': 'max-age=86400' });
      return res.end();
    }
    const access = gate.decide(req, url);
    if (!gate.isLoopback(req)) visits.record(req, url.pathname, access);
    if (!access.allowed) return deny(res, access.reason, { address: String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, ''), research: /share|research link/.test(access.reason) });
    if (access.share && !shareAllows({ method: req.method, pathname: url.pathname, projectId: access.share })) return send(res, 403, { error: 'this link opens one research only' });
    req.access = access;
    if (!gate.isLoopback(req) && access.allowed) app.peers?.note(req.socket?.remoteAddress);
    const page = url.pathname === '/' || url.pathname === '/index.html';
    if (access.setCookie && page) {
      res.writeHead(302, { 'set-cookie': access.setCookie, location: url.pathname + url.hash });
      return res.end();
    }
    if (access.setCookie) res.setHeader('set-cookie', access.setCookie);
    if (req.method === 'GET' && url.pathname === '/pc-setup.ps1') return send(res, 200, pcSetupScript(), 'text/plain; charset=utf-8');
    try {
      if (req.method === 'GET' && VENDOR[url.pathname]) {
        const [file, type] = VENDOR[url.pathname];
        res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=86400' });
        return res.end(await fs.readFile(path.join(ROOT_DIR, file)));
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, await fs.readFile(path.join(ROOT_DIR, 'public', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
      }
      const events = url.pathname.match(/^\/api\/projects\/([\w-]+)\/events$/);
      if (req.method === 'GET' && events) return await serveEvents(req, res, events[1]);
      const handoff = url.pathname.match(/^\/api\/projects\/([\w-]+)\/handoff\.md$/);
      if (req.method === 'GET' && handoff) return send(res, 200, (await app.handoffs.markdown(handoff[1])) ?? '# No handoff yet\n\nOne is written every time a run or loop stops.\n', 'text/markdown; charset=utf-8');
      const report = url.pathname.match(/^\/api\/projects\/([\w-]+)\/report\.md$/);
      if (req.method === 'GET' && report) {
        const project = await app.engine.load(report[1]);
        res.setHeader('content-disposition', `attachment; filename="${project.id}.md"`);
        return send(res, 200, toMarkdown(project), 'text/markdown; charset=utf-8');
      }
      const exported = url.pathname.match(/^\/api\/projects\/([\w-]+)\/(results\.json|pieces\.csv|items\.csv)$/);
      if (req.method === 'GET' && exported) {
        const project = await app.engine.load(exported[1]);
        const [kind, ext] = exported[2].split('.');
        res.setHeader('content-disposition', `attachment; filename="${project.id}-${kind}.${ext}"`);
        if (ext === 'json') return send(res, 200, resultsJson(project));
        return send(res, 200, `\ufeff${kind === 'pieces' ? piecesCsv(project) : itemsCsv(project)}`, 'text/csv; charset=utf-8');
      }
      for (const [method, pattern, handler] of routes) {
        const match = url.pathname.match(pattern);
        if (match && req.method === method) return send(res, 200, withResults(await handler(req, match.slice(1))));
      }
      throw new HttpError(404, 'not found');
    } catch (error) {
      if (!res.headersSent) send(res, statusFor(error), { error: error.message });
    }
  });
}

export async function startServer({ app = new App(), port = Number(process.env.PORT || 4600), host = process.env.HOST || '127.0.0.1', token = '', behindProxy = process.env.FRL_BEHIND_PROXY === '1' } = {}) {
  await app.refreshProviders();
  const shares = await new ShareBook({ file: path.join(app.dataDir, 'shares.json'), secret: token }).load();
  const gate = new AccessGate({ token, behindProxy, shares });
  const server = createServer(app, gate);
  attachTerminalSockets(server, { hub: app.terminal, gate });
  await new Promise((resolve) => server.listen(port, host, resolve));
  app.port = server.address().port;
  app.remote = Boolean(token);
  return { app, server, url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const local = process.env.FRL_LOCAL_AUTOSTART === '0' ? { started: false } : await ensureLocalModel({ root: ROOT_DIR }).catch(() => ({ started: false }));
  if (local.started) console.log(`  local model restarted on port ${local.port} (pid ${local.pid}); it is ready once loaded`);
  const secrets = new KeychainSecrets();
  const fromKeychain = process.env.FRL_KEYCHAIN === '0' ? [] : await secrets.fillMissing(process.env);
  const remote = (Boolean(process.env.HOST) && process.env.HOST !== '127.0.0.1' && process.env.HOST !== 'localhost') || process.env.FRL_BEHIND_PROXY === '1';
  let token = process.env.FRL_ACCESS_TOKEN || '';
  if (remote && !token) {
    token = newAccessToken();
    try {
      await secrets.write('FRL_ACCESS_TOKEN', token);
    } catch {
      console.log('  could not save a new access token in the key store: run "node src/frl.mjs install" (it creates one), then restart');
    }
  }
  const { app, url } = await startServer({ app: new App({ secrets: process.env.FRL_KEYCHAIN === '0' ? null : secrets, dataDir: process.env.FRL_DATA_DIR || undefined }), token: remote ? token : '' });
  if (remote) console.log('  remote access ON: other devices need the token link from "frl url"');
  if (fromKeychain.length) console.log(`  keys from macOS Keychain: ${fromKeychain.join(', ')}`);
  const status = app.status();
  const ready = status.providers.filter((p) => p.state === 'ready');
  void app.logs.append('history', { type: 'session', message: `app started · models: ${ready.map((p) => p.id).join(', ') || 'none'} · search: ${status.search.backends.join(', ')}` });
  app.noteApp(`App started on ${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'} · remote access ${remote ? 'on' : 'off'} · models: ${ready.map((p) => p.id).join(', ') || 'none'} · search: ${status.search.backends.join(', ')} · terminal: ${await app.terminal.mode()}`);
  console.log(`\n  Free Research LLM is running → ${url}\n`);
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`  ${signal}: saving handoffs for running work…`);
    await app.shutdown();
    void app.logs.append('history', { type: 'session', message: `app stopped (${signal}); state saved` });
    await app.logs.queue;
    process.exit(0);
  };
  app.onRestart = () => void stop('restart requested');
  await app.seedLedger();
  setInterval(() => app.routerAdmin.apply(), 60000).unref();
  app.startHousekeeping();
  app.startPeerWatch();
  new HeapGuard({ onHigh: (mb) => {
    void app.logs.append('history', { type: 'session', message: `memory at ${mb} MB: restarting gracefully before it runs out (work is saved and the loop resumes)` });
    app.onRestart?.();
  } }).start({ onSample: (sample) => void app.logs.append('memory', sample), extra: () => ({ streams: app.liveStreams?.size ?? 0 }) });
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  if (process.env.FRL_AUTO_RESUME !== '0') {
    const resumed = await app.resumeInterrupted();
    if (resumed.length) console.log(`  resumed after restart: ${resumed.join(', ')}`);
  }
  const stale = await app.settleStale();
  if (stale.length) console.log(`  marked as stopped (they were running when the app last stopped): ${stale.join(', ')}`);
  console.log(ready.length ? `  models: ${ready.map((p) => `${p.id} (${p.fast})`).join(', ')}` : '  models: NONE connected yet — run ./keys.command (or open Setup in the page)');
  if (ready.length) console.log(`  route deep: ${status.route.deep.join(' → ')}\n  route fast: ${status.route.fast.join(' → ')}`);
  console.log(`  search: ${status.search.backends.join(', ') || 'off'}${status.demo ? '\n  DEMO MODE: scripted answers, not real research' : ''}\n`);
}
