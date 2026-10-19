import fs from 'node:fs/promises';
import path from 'node:path';
import { appChatPrompt } from './research/prompts.mjs';
import { MAX_THREAD } from './research/notify.mjs';
import { ReplyAudit, auditFeedback } from './chat/reply-audit.mjs';
import { CONSOLE_COMMANDS, commandById } from './terminal/catalog.mjs';
import { ENGINES, engineOf, normalizeTicket } from './changes.mjs';

const DIRECT = new Set(['open', 'stop', 'links']);
const PROPOSALS = new Set(['create', 'delete', 'improve', 'command', 'change']);
const MAX_ACTIONS = 3;
const MAX_LOOP_HOURS = 24;
const FILE_TEXT_IN_THREAD = 4000;

export class ProposalError extends Error {}

export function validAppActions(raw, projectIds) {
  const ids = new Set(projectIds);
  const direct = [];
  const proposals = [];
  for (const a of (Array.isArray(raw) ? raw : []).slice(0, MAX_ACTIONS * 4)) {
    if (!a || typeof a !== 'object') continue;
    if (DIRECT.has(a.type)) {
      if (a.type === 'links' || ids.has(String(a.projectId))) direct.push(a.type === 'links' ? { type: 'links' } : { type: a.type, projectId: String(a.projectId) });
      continue;
    }
    if (!PROPOSALS.has(a.type)) continue;
    if (a.type === 'create' && String(a.question ?? '').trim().length >= 8) proposals.push({ type: 'create', question: String(a.question).trim().slice(0, 600), expected: String(a.expected ?? '').trim().slice(0, 400) });
    if ((a.type === 'delete' || a.type === 'improve') && ids.has(String(a.projectId))) proposals.push({ type: a.type, projectId: String(a.projectId), ...(a.type === 'improve' ? { hours: Math.min(MAX_LOOP_HOURS, Math.max(0.25, Number(a.hours) || 2)) } : {}) });
    if (a.type === 'command' && commandById(String(a.id))) proposals.push({ type: 'command', id: String(a.id), run: commandById(String(a.id)).run });
    if (a.type === 'change' && normalizeTicket(a)) proposals.push({ type: 'change', ...normalizeTicket(a), engine: ENGINES.includes(a.engine) ? a.engine : null });
  }
  return { direct: direct.slice(0, MAX_ACTIONS), proposals: proposals.slice(0, MAX_ACTIONS).map((p, i) => ({ pid: `p${i + 1}`, state: 'proposed', ...p })) };
}

export function proposalLabel(p, projects = []) {
  const name = (id) => projects.find((x) => x.id === id)?.question?.slice(0, 70) ?? id;
  if (p.type === 'create') return `Start research: ${p.question.slice(0, 90)}`;
  if (p.type === 'delete') return `Delete research: ${name(p.projectId)}`;
  if (p.type === 'improve') return `Run the improve loop ${p.hours} h on: ${name(p.projectId)}`;
  if (p.type === 'change') return `App change: ${p.title} — create the ticket; the quality gate decides whether it reaches the app`;
  return `Run in Terminal: ${p.run}`;
}

export class AppChat {
  constructor({ engine, improver, router, file, statusOf, docs, facts = async () => ({}), media = null, changes = null, coder = null }) {
    this.changes = changes;
    this.coder = coder;
    this.engine = engine;
    this.improver = improver;
    this.router = router;
    this.file = file;
    this.statusOf = statusOf;
    this.docs = docs;
    this.facts = facts;
    this.media = media;
    this.queue = Promise.resolve();
  }

  async thread() {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      return [];
    }
  }

  async save(thread) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(thread.slice(-MAX_THREAD)));
    await fs.rename(tmp, this.file);
  }

  update(change) {
    const next = this.queue.catch(() => {}).then(async () => {
      const thread = await this.thread();
      const result = await change(thread);
      await this.save(thread);
      return { thread: thread.slice(-MAX_THREAD), result };
    });
    this.queue = next;
    return next;
  }

  note(content) {
    return this.update((thread) => {
      thread.push({ role: 'app', content: String(content).slice(0, 2000), at: new Date().toISOString() });
    });
  }

  auditor(facts) {
    const links = facts.links ?? [];
    return new ReplyAudit({
      allowedUrls: [...(this.docs?.urls() ?? []), ...links.map((l) => l.url)],
      allowedHosts: links.map((l) => {
        try {
          return new URL(l.url).host;
        } catch {
          return '';
        }
      }).filter(Boolean),
      commands: [...(this.docs?.commands() ?? []), ...CONSOLE_COMMANDS.map((c) => c.run)],
    });
  }

  async ask({ text, files, projects, thread, facts, docs, feedback }) {
    const reply = await this.router.complete({ purpose: 'app-chat', tier: 'fast', messages: appChatPrompt({ projects, status: this.statusOf(), facts, docs, commands: CONSOLE_COMMANDS, thread, message: text, files, feedback }) });
    const actions = validAppActions(reply.data?.actions, projects.map((p) => p.id));
    return { reply, actions, text: String(reply.data?.reply ?? '').slice(0, 4000) || '(no reply text)' };
  }

  async runDirect(action) {
    if (action.type === 'stop') {
      if (this.improver.isActive(action.projectId)) this.improver.stop(action.projectId);
      else this.engine.cancel(action.projectId);
    }
    return { ...action, ok: true };
  }

  async send(message, { files = [], from = '' } = {}) {
    const text = String(message ?? '').trim().slice(0, 4000);
    if (!text && !files.length) throw new Error('write a message first');
    const read = files.length && this.media ? await this.media.readAll(files) : [];
    const [thread, projects, facts, tickets] = await Promise.all([this.thread(), this.engine.store.list(), this.facts(), this.changes ? this.changes.all() : []]);
    facts.changes = tickets.slice(-8);
    await this.docs?.load();
    const docs = this.docs?.search(`${text} ${read.map((f) => f.name).join(' ')}`) ?? [];
    const audit = this.auditor(facts);
    const context = { text: text || 'Read the attached files and tell me what they contain.', files: read, projects, thread, facts, docs };
    let answer = await this.ask(context);
    let verdict = audit.audit(answer.text, { done: answer.actions.direct.map((a) => ({ ...a, ok: true })) });
    let revised = false;
    if (!verdict.passed) {
      const second = await this.ask({ ...context, feedback: auditFeedback(verdict.issues) });
      const secondVerdict = audit.audit(second.text, { done: second.actions.direct.map((a) => ({ ...a, ok: true })) });
      revised = true;
      if (secondVerdict.issues.length <= verdict.issues.length) {
        answer = second;
        verdict = secondVerdict;
      }
    }
    const done = [];
    for (const action of answer.actions.direct) {
      try {
        done.push(await this.runDirect(action));
      } catch (error) {
        done.push({ ...action, ok: false, error: error.message });
      }
    }
    const proposals = answer.actions.proposals.map((p) => ({ ...p, label: proposalLabel(p, projects) }));
    const at = new Date().toISOString();
    const userMessage = { role: 'user', content: text, at, ...(from ? { from } : {}), ...(read.length ? { files: read.map((f) => ({ ...f, text: f.text.slice(0, FILE_TEXT_IN_THREAD) })) } : {}) };
    const assistant = { role: 'assistant', content: verdict.text, at, model: `${answer.reply.provider}/${answer.reply.model}`, actions: done, proposals, audit: { passed: verdict.passed, issues: verdict.issues, revised } };
    const saved = await this.update((t) => {
      t.push(userMessage, assistant);
    });
    return { thread: saved.thread, actions: done, proposals, audit: assistant.audit };
  }

  async runProposal(p) {
    if (p.type === 'create') {
      if (!this.router.ready) throw new ProposalError('no model is connected: open Setup & keys first');
      const project = await this.engine.createProject({ question: p.question, expected: p.expected ?? '' });
      void (async () => {
        try {
          await this.engine.buildTree(project.id);
        } catch {
          return;
        }
      })();
      return { projectId: project.id, message: `Research created and its tree is being built: ${p.question.slice(0, 120)}` };
    }
    if (p.type === 'delete') {
      if (this.improver.isActive(p.projectId) || this.engine.running.has(p.projectId)) throw new ProposalError('stop it first: the research is running');
      await this.engine.store.remove(p.projectId);
      return { projectId: p.projectId, message: `Research deleted: ${p.projectId}` };
    }
    if (p.type === 'improve') {
      if (this.engine.running.has(p.projectId)) throw new ProposalError('a research run is active; stop it first');
      this.improver.start(p.projectId, { hours: p.hours });
      return { projectId: p.projectId, message: `Improve loop started for ${p.hours} h` };
    }
    if (p.type === 'change') {
      if (!this.changes) throw new ProposalError('app changes are not available here');
      const engine = engineOf(p.engine);
      if (this.coder?.available && !this.coder.available(engine)) throw new ProposalError(engine === 'claude' ? 'Claude Code is not installed on this computer: install it from https://docs.claude.com/en/docs/claude-code, or ask for the change with the free-model coder' : `the ${engine} coder is not available here`);
      const ticket = await this.changes.create({ ...p, engine });
      if (!this.coder) return { ticketId: ticket.id, run: `node src/frl.mjs change ${ticket.id} --claude`, message: `Change ${ticket.id} created (data/changes/${ticket.id}.md) and sent to the Terminal for Claude Code.` };
      const started = this.coder.start(ticket.id, engine);
      if (started && started.started === false) throw new ProposalError(started.message || `change ${ticket.id} could not start`);
      return { ticketId: ticket.id, engine, message: `Change ${ticket.id} created (data/changes/${ticket.id}.md). ${engine === 'claude' ? 'Claude Code implements it in a sandbox copy, on your Claude plan' : 'Free models implement it in a sandbox copy'}; it reaches the app only if the quality gate passes. Progress is posted here.` };
    }
    return { message: `Sent to the Terminal: ${p.run}` };
  }

  async decide(at, pid, { accept = true, engine = null } = {}) {
    const { thread, result } = await this.update(async (t) => {
      const message = t.find((m) => m.role === 'assistant' && m.at === at && (m.proposals ?? []).some((p) => p.pid === pid));
      if (!message) throw new ProposalError('that proposal no longer exists');
      const proposal = message.proposals.find((p) => p.pid === pid);
      if (proposal.state !== 'proposed') throw new ProposalError(`already ${proposal.state}`);
      if (!accept) {
        proposal.state = 'dismissed';
        return { proposal };
      }
      if (engine != null) {
        if (!ENGINES.includes(engine)) throw new ProposalError(`engine must be one of ${ENGINES.join(', ')}`);
        proposal.engine = engine;
      }
      try {
        const outcome = await this.runProposal(proposal);
        proposal.state = 'done';
        proposal.result = outcome;
        t.push({ role: 'app', content: outcome.message, at: new Date().toISOString(), ...(outcome.projectId && proposal.type !== 'delete' ? { projectId: outcome.projectId } : {}) });
        return { proposal };
      } catch (error) {
        if (proposal.type === 'change' && /not installed|not available/.test(error.message)) {
          proposal.error = error.message;
          return { proposal, error: error.message };
        }
        proposal.state = 'failed';
        proposal.result = { message: error.message };
        return { proposal, error: error.message };
      }
    });
    return { thread, ...result };
  }
}
