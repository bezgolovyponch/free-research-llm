import fs from 'node:fs/promises';
import path from 'node:path';
import { appChatPrompt } from './research/prompts.mjs';
import { MAX_THREAD } from './research/notify.mjs';

const ACTIONS = new Set(['create', 'improve', 'stop', 'open']);
const MAX_ACTIONS = 3;

export function validAppActions(raw, projectIds) {
  const ids = new Set(projectIds);
  return (Array.isArray(raw) ? raw : [])
    .filter((a) => a && ACTIONS.has(a.type))
    .filter((a) => (a.type === 'create' ? String(a.question ?? '').trim().length >= 8 : ids.has(String(a.projectId))))
    .slice(0, MAX_ACTIONS);
}

export class AppChat {
  constructor({ engine, improver, router, file, statusOf }) {
    this.engine = engine;
    this.improver = improver;
    this.router = router;
    this.file = file;
    this.statusOf = statusOf;
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

  async apply(action) {
    if (action.type === 'create') {
      const project = await this.engine.createProject({ question: action.question, expected: action.expected ?? '' });
      void (async () => {
        try {
          await this.engine.buildTree(project.id);
        } catch {
          return;
        }
      })();
      return { type: 'create', projectId: project.id, ok: true };
    }
    if (action.type === 'improve') {
      this.improver.start(action.projectId, { hours: Number(action.hours) || 2 });
      return { type: 'improve', projectId: action.projectId, ok: true };
    }
    if (action.type === 'stop') {
      if (this.improver.isActive(action.projectId)) this.improver.stop(action.projectId);
      else this.engine.cancel(action.projectId);
      return { type: 'stop', projectId: action.projectId, ok: true };
    }
    return { type: 'open', projectId: action.projectId, ok: true };
  }

  async send(message) {
    const text = String(message ?? '').trim().slice(0, 4000);
    if (!text) throw new Error('write a message first');
    const [thread, projects] = await Promise.all([this.thread(), this.engine.store.list()]);
    const reply = await this.router.complete({ purpose: 'app-chat', tier: 'fast', messages: appChatPrompt({ projects, status: this.statusOf(), thread, message: text }) });
    const results = [];
    for (const action of validAppActions(reply.data?.actions, projects.map((p) => p.id))) {
      try {
        results.push(await this.apply(action));
      } catch (error) {
        results.push({ type: action.type, projectId: action.projectId, ok: false, error: error.message });
      }
    }
    const at = new Date().toISOString();
    const next = [...thread, { role: 'user', content: text, at }, { role: 'assistant', content: String(reply.data?.reply ?? '').slice(0, 4000) || '(no reply text)', at, model: `${reply.provider}/${reply.model}`, actions: results }];
    await this.save(next);
    return { thread: next.slice(-MAX_THREAD), actions: results };
  }
}
