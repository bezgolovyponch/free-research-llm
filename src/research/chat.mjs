import { chatPrompt, resultsChatPrompt } from './prompts.mjs';
import { ReplyAudit, auditFeedback } from '../chat/reply-audit.mjs';
import { filesBlock } from '../chat/media.mjs';
import { addSpec, evaluateAll, normalizeSpec } from './specs.mjs';
import { ROOT_ID } from './tree.mjs';
import { NotFoundError } from './engine.mjs';
import { MAX_THREAD } from './notify.mjs';
import { droppedNote, groundSpec } from './grounding.mjs';

export const OWNER_ONLY_REPLY = 'That is a question about the app itself, not this research. Only the person who runs the app can ask its App assistant.';

const MAX_ACTIONS = 5;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_POLL_MS = 500;
const ACTION_ORDER = { edit: 0, add: 1, remove: 2, expand: 3, suggest: 4, rerun: 5 };
const RESULTS_ACTIONS = new Set(['expand', 'suggest', 'rerun']);
export const RESULTS_KEY = 'R';
const FILE_TEXT_IN_THREAD = 4000;

export function resultsProposalLabel(a) {
  if (a.type === 'rerun') return `Re-research ${a.nodeId}${a.hint ? `: ${String(a.hint).slice(0, 80)}` : ''}`;
  if (a.type === 'expand') return `Split ${a.nodeId} into sub-issues${a.hint ? `: ${String(a.hint).slice(0, 80)}` : ''}`;
  return `Suggest sub-issues for ${a.nodeId}`;
}

export function projectUrls(project) {
  const urls = [];
  for (const n of project.nodes ?? []) {
    for (const s of n.sources ?? []) if (s.url) urls.push(s.url);
    for (const s of n.sources ?? []) for (const l of s.links ?? []) urls.push(typeof l === 'string' ? l : l.url);
    for (const i of n.finding?.items ?? []) if (i.url) urls.push(i.url);
    for (const u of n.sourceUrls ?? []) urls.push(u);
  }
  for (const i of project.acceptanceResult?.items ?? []) if (i.url) urls.push(i.url);
  return urls.filter(Boolean);
}

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
  constructor({ engine, suggester, improver = null, appChat = null, media = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.appChat = appChat;
    this.media = media;
    this.engine = engine;
    this.suggester = suggester;
    this.improver = improver;
    this.sleep = sleep;
  }

  async pause(id) {
    const looping = Boolean(this.improver?.isActive(id));
    const hours = looping ? this.improver.remainingHours(id) : 0;
    const scope = looping ? (this.improver.scopeOf?.(id) ?? []) : [];
    const exclude = looping ? (this.improver.excludeOf?.(id) ?? []) : [];
    const running = !looping && this.engine.running.has(id);
    if (looping) this.improver.stop(id);
    if (running) this.engine.cancel(id);
    for (let waited = 0; (this.improver?.isActive(id) || this.engine.running.has(id)) && waited < IDLE_TIMEOUT_MS; waited += IDLE_POLL_MS) await this.sleep(IDLE_POLL_MS);
    return { looping, running, hours, scope, exclude };
  }

  resume(id, paused, actions) {
    if (paused.looping && paused.hours > 0.01) return this.improver.start(id, { hours: paused.hours, nodes: paused.scope ?? [], exclude: paused.exclude ?? [] });
    if (paused.running && !actions.some((a) => a.type === 'rerun')) return this.engine.start(id);
    return null;
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

  async ask({ project, focus, key, thread, text, desired = '', files, feedback = '' }) {
    const block = filesBlock(files);
    const messages = key === RESULTS_KEY ? resultsChatPrompt({ project, thread, message: text, files: block, feedback }) : chatPrompt({ project, node: focus, thread, message: text, desired, files: block, feedback });
    const reply = await this.engine.router.complete({ purpose: key === RESULTS_KEY ? 'results-chat' : 'chat', tier: 'fast', messages });
    const actions = validActions(reply.data?.actions, project, key === RESULTS_KEY ? ROOT_ID : key).filter((a) => key !== RESULTS_KEY || RESULTS_ACTIONS.has(a.type));
    return { reply, actions, spec: reply.data?.spec ?? null, scope: reply.data?.scope === 'app' ? 'app' : '', text: String(reply.data?.reply ?? reply.data?.answer ?? '').slice(0, 4000) || '(no reply text)' };
  }

  async send(id, nodeId, message, { files = [], desired = '', appRedirect = true } = {}) {
    const text = String(message ?? '').trim().slice(0, 4000);
    const want = String(desired ?? '').trim().slice(0, 600);
    if (!text && !files.length) throw new Error('write a message first');
    if (nodeId !== RESULTS_KEY && !want) throw new Error('write the desired output too: the result you want this to reach (it becomes a regression check)');
    const project = await this.engine.load(id);
    const key = nodeId === RESULTS_KEY ? RESULTS_KEY : nodeId && nodeId !== ROOT_ID ? nodeId : ROOT_ID;
    const focus = key !== ROOT_ID && key !== RESULTS_KEY ? project.nodes.find((n) => n.id === key) : null;
    if (key !== ROOT_ID && key !== RESULTS_KEY && !focus) throw new NotFoundError(`node ${nodeId} not found`);
    const read = files.length && this.media ? await this.media.readAll(files) : [];
    const thread = project.chats?.[key] ?? [];
    const ask = { project, focus, key, thread, text: text || 'Read the attached files and tell me what they mean for this.', desired: want, files: read };
    let answer = await this.ask(ask);
    if (answer.scope === 'app' && !appRedirect && !answer.actions.length) return { redirected: 'owner', reply: OWNER_ONLY_REPLY, actions: [], thread };
    if (answer.scope === 'app' && this.appChat && !answer.actions.length) {
      const moved = await this.appChat.send(text, { files, from: `${project.id}/${key}` });
      return { redirected: 'app', appThread: moved.thread, reply: moved.thread.at(-1)?.content ?? '', actions: [], thread };
    }
    const audit = new ReplyAudit({ allowedUrls: projectUrls(project) });
    const doneFor = (a) => (key === RESULTS_KEY ? [] : a.actions.map((x) => ({ ...x, ok: true })));
    let verdict = audit.audit(answer.text, { done: doneFor(answer) });
    let revised = false;
    if (!verdict.passed) {
      const second = await this.ask({ ...ask, feedback: auditFeedback(verdict.issues) });
      const secondVerdict = audit.audit(second.text, { done: doneFor(second) });
      revised = true;
      if (second.scope !== 'app' && secondVerdict.issues.length <= verdict.issues.length) {
        answer = second;
        verdict = secondVerdict;
      }
    }
    const proposing = key === RESULTS_KEY;
    const actions = proposing ? [] : answer.actions;
    const proposals = proposing ? answer.actions.map((a, i) => ({ pid: `p${i + 1}`, state: 'proposed', ...a, label: resultsProposalLabel(a) })) : [];
    const reply = answer.reply;
    const busy = actions.length && (this.improver?.isActive(id) || this.engine.running.has(id));
    const paused = busy ? await this.pause(id) : null;
    const results = [];
    if (focus) {
      for (const file of read) {
        try {
          await this.engine.addAttachment(id, focus.id, { name: file.name, text: file.text, readBy: file.model || 'the app' });
          results.push({ type: 'attach', nodeId: focus.id, ok: true });
        } catch (error) {
          results.push({ type: 'attach', nodeId: focus.id, ok: false, error: error.message });
        }
      }
    }
    for (const action of actions) {
      try {
        await this.apply(id, action);
        results.push({ type: action.type, nodeId: action.type === 'add' ? action.parentId : action.nodeId, ok: true });
      } catch (error) {
        results.push({ type: action.type, nodeId: action.nodeId, ok: false, error: error.message });
      }
    }
    if (paused) this.resume(id, paused, actions);
    const fresh = await this.engine.load(id);
    const at = new Date().toISOString();
    if (paused) results.push({ type: paused.looping ? 'loop paused and resumed' : 'run paused and resumed', nodeId: key, ok: true });
    const grounded = key !== RESULTS_KEY && want ? groundSpec(normalizeSpec(answer.spec, { request: text, desired: want }), { desired: want, request: text }) : null;
    const spec = grounded ? addSpec(fresh, key, grounded.spec) : null;
    if (grounded?.dropped.length) results.push({ type: 'check', nodeId: key, ok: true, detail: droppedNote(grounded.dropped) });
    if (spec) {
      evaluateAll(fresh);
      results.push({ type: 'check', nodeId: key, ok: true, specId: spec.id });
    }
    const userMessage = { role: 'user', content: text, at, ...(want ? { desired: want } : {}), ...(spec ? { specId: spec.id } : {}), ...(read.length ? { files: read.map((f) => ({ ...f, text: f.text.slice(0, FILE_TEXT_IN_THREAD) })) } : {}) };
    fresh.chats = { ...(fresh.chats ?? {}), [key]: [...thread, userMessage, { role: 'assistant', content: verdict.text, at, model: `${reply.provider}/${reply.model}`, actions: results, ...(proposals.length ? { proposals } : {}), audit: { passed: verdict.passed, issues: verdict.issues, revised } }].slice(-MAX_THREAD) };
    this.engine.emit(fresh, 'chat', `${key}: chat — ${results.length ? results.map((r) => `${r.type}${r.ok ? '' : ' (failed)'}`).join(', ') : 'no changes'}`, { nodeId: key });
    await this.engine.store.save(fresh);
    return { reply: verdict.text, actions: results, proposals, thread: fresh.chats[key] };
  }

  async decide(id, key, at, pid, { accept = true } = {}) {
    const project = await this.engine.load(id);
    const message = (project.chats?.[key] ?? []).find((m) => m.role === 'assistant' && m.at === at && (m.proposals ?? []).some((p) => p.pid === pid));
    if (!message) throw new NotFoundError('that proposal no longer exists');
    const proposal = message.proposals.find((p) => p.pid === pid);
    if (proposal.state !== 'proposed') throw new NotFoundError(`already ${proposal.state}`);
    let error = '';
    if (accept) {
      try {
        await this.apply(id, proposal);
      } catch (e) {
        error = e.message;
      }
    }
    const fresh = await this.engine.load(id);
    const stored = fresh.chats[key].find((m) => m.role === 'assistant' && m.at === at && m.proposals).proposals.find((p) => p.pid === pid);
    stored.state = !accept ? 'dismissed' : error ? 'failed' : 'done';
    if (error) stored.result = { message: error };
    this.engine.emit(fresh, 'chat', `${key}: proposal ${proposal.type} ${proposal.nodeId} ${stored.state}`, { nodeId: proposal.nodeId });
    await this.engine.store.save(fresh);
    return { proposal: stored, thread: fresh.chats[key], error };
  }
}
