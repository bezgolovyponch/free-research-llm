import { chatPrompt } from './prompts.mjs';
import { ROOT_ID } from './tree.mjs';
import { NotFoundError } from './engine.mjs';

const MAX_THREAD = 100;
const MAX_ACTIONS = 5;
const ACTION_ORDER = { edit: 0, add: 1, remove: 2, expand: 3, suggest: 4, rerun: 5 };

export function validActions(raw, project, focusId) {
  const ids = new Set([ROOT_ID, ...project.nodes.map((n) => n.id)]);
  return (Array.isArray(raw) ? raw : [])
    .filter((a) => a && a.type in ACTION_ORDER)
    .map((a) => ({ ...a, nodeId: String(a.nodeId ?? focusId), parentId: String(a.parentId ?? focusId) }))
    .filter((a) => (a.type === 'add' ? ids.has(a.parentId) && String(a.question ?? '').trim() : ids.has(a.nodeId) && (a.nodeId !== ROOT_ID || a.type === 'suggest')))
    .slice(0, MAX_ACTIONS)
    .sort((a, b) => ACTION_ORDER[a.type] - ACTION_ORDER[b.type]);
}

export class NodeChat {
  constructor({ engine, suggester }) {
    this.engine = engine;
    this.suggester = suggester;
  }

  async apply(id, action) {
    const e = this.engine;
    if (action.type === 'edit') await e.editNode(id, action.nodeId, action.fields ?? {});
    if (action.type === 'add') await e.addNode(id, action.parentId, { question: action.question, searchQueries: action.searchQueries, sourceUrls: action.sourceUrls, method: action.method });
    if (action.type === 'remove') await e.removeNode(id, action.nodeId);
    if (action.type === 'expand') await e.expandNode(id, action.nodeId, action.hint ?? '');
    if (action.type === 'suggest') await this.suggester.suggest(id, action.nodeId);
    if (action.type === 'rerun') await e.rerunNode(id, action.nodeId, action.hint ?? '');
  }

  async send(id, nodeId, message) {
    const text = String(message ?? '').trim().slice(0, 4000);
    if (!text) throw new Error('write a message first');
    const project = await this.engine.load(id);
    const focus = nodeId && nodeId !== ROOT_ID ? project.nodes.find((n) => n.id === nodeId) : null;
    if (nodeId && nodeId !== ROOT_ID && !focus) throw new NotFoundError(`node ${nodeId} not found`);
    const key = focus?.id ?? ROOT_ID;
    const thread = project.chats?.[key] ?? [];
    const reply = await this.engine.router.complete({ purpose: 'chat', tier: 'fast', messages: chatPrompt({ project, node: focus, thread, message: text }) });
    const actions = validActions(reply.data?.actions, project, key);
    const results = [];
    for (const action of actions) {
      try {
        await this.apply(id, action);
        results.push({ type: action.type, nodeId: action.type === 'add' ? action.parentId : action.nodeId, ok: true });
      } catch (error) {
        results.push({ type: action.type, nodeId: action.nodeId, ok: false, error: error.message });
      }
    }
    const fresh = await this.engine.load(id);
    const at = new Date().toISOString();
    const answer = String(reply.data?.reply ?? reply.data?.answer ?? '').slice(0, 4000) || '(no reply text)';
    fresh.chats = { ...(fresh.chats ?? {}), [key]: [...thread, { role: 'user', content: text, at }, { role: 'assistant', content: answer, at, model: `${reply.provider}/${reply.model}`, actions: results }].slice(-MAX_THREAD) };
    this.engine.emit(fresh, 'chat', `${key}: chat — ${results.length ? results.map((r) => `${r.type}${r.ok ? '' : ' (failed)'}`).join(', ') : 'no changes'}`, { nodeId: key });
    await this.engine.store.save(fresh);
    return { reply: answer, actions: results, thread: fresh.chats[key] };
  }
}
