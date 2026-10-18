import { scoreProject } from '../loop/score.mjs';
import { variantPrompt } from './prompts.mjs';
import { METHODS, ROOT_ID, blankNode, isLeaf, nextNodeId, urlList } from './tree.mjs';

const GRADE_RANK = { verified: 3, supported: 2, weak: 1, unsupported: 0, failed: 0, pending: 0, researching: 0 };
const MAX_HOURS = 72;
const MAX_TRIALS_KEPT = 200;
const QUOTA_PAUSE_MS = 5 * 60 * 1000;
const MIN_GAIN = 0.001;
const QUOTA_ERROR = /no model provider|cooling down|rate limit|quota/i;

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function strings(value, max) {
  return (Array.isArray(value) ? value : value ? [value] : []).map((v) => String(v).trim()).filter(Boolean).slice(0, max);
}

export function projectScore(project) {
  const base = scoreProject(project);
  const acceptance = project?.acceptanceResult?.score ?? null;
  return { ...base, acceptance, score: acceptance === null ? base.score : round(0.6 * acceptance + 0.4 * base.score) };
}

export function improvementTargets(project) {
  const leaves = project.nodes
    .filter((n) => isLeaf(project.nodes, n))
    .sort((a, b) => (GRADE_RANK[a.status] ?? 0) - (GRADE_RANK[b.status] ?? 0) || b.impact * b.uncertainty - a.impact * a.uncertainty);
  return [ROOT_ID, ...leaves.map((n) => n.id)];
}

function nodeFields(raw, id, parentId) {
  const question = String(raw?.question ?? '').trim().slice(0, 400);
  if (!question) return null;
  return blankNode({
    id,
    parentId,
    title: String(raw?.title || question).slice(0, 90),
    question,
    method: METHODS.includes(raw?.method) ? raw.method : 'lookup',
    searchQueries: strings(raw?.searchQueries, 3),
    sourceUrls: urlList(raw?.sourceUrls),
  });
}

export function applyVariant(project, nodeId, variant) {
  const touched = [];
  if (nodeId === ROOT_ID) {
    for (const raw of (Array.isArray(variant?.add) ? variant.add : []).slice(0, 2)) {
      const node = nodeFields(raw, nextNodeId(project.nodes, ROOT_ID), ROOT_ID);
      if (node) {
        project.nodes.push(node);
        touched.push(node.id);
      }
    }
    const remove = new Set(strings(variant?.remove, 2).filter((id) => project.nodes.some((n) => n.id === id && n.parentId === ROOT_ID)));
    if (remove.size && project.nodes.filter((n) => n.parentId === ROOT_ID).length - remove.size >= 2) {
      const doomed = new Set(remove);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of project.nodes) if (doomed.has(n.parentId) && !doomed.has(n.id)) { doomed.add(n.id); grew = true; }
      }
      project.nodes = project.nodes.filter((n) => !doomed.has(n.id));
      for (const n of project.nodes) n.dependsOn = n.dependsOn.filter((d) => !doomed.has(d));
      touched.push(...remove);
    }
    return touched;
  }
  const node = project.nodes.find((n) => n.id === nodeId);
  if (!node) return touched;
  if (typeof variant?.question === 'string' && variant.question.trim()) node.question = variant.question.trim().slice(0, 400);
  if (Array.isArray(variant?.searchQueries) && strings(variant.searchQueries, 3).length) node.searchQueries = strings(variant.searchQueries, 3);
  if (Array.isArray(variant?.sourceUrls) && urlList(variant.sourceUrls).length) node.sourceUrls = urlList(variant.sourceUrls);
  if (METHODS.includes(variant?.method)) node.method = variant.method;
  if (typeof variant?.instructions === 'string' && variant.instructions.trim()) node.instructions = variant.instructions.trim().slice(0, 2000);
  touched.push(node.id);
  for (const raw of (Array.isArray(variant?.split) ? variant.split : []).slice(0, 3)) {
    const child = nodeFields(raw, nextNodeId(project.nodes, node.id), node.id);
    if (child) {
      project.nodes.push(child);
      touched.push(child.id);
    }
  }
  return touched;
}

export class ProjectImprover {
  constructor({ engine, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.engine = engine;
    this.now = now;
    this.sleep = sleep;
    this.active = new Map();
  }

  isActive(id) {
    return this.active.has(id);
  }

  start(id, { hours = 1 } = {}) {
    if (this.active.has(id)) throw new Error('the self-improving loop is already running for this project');
    const h = Math.min(MAX_HOURS, Math.max(0.05, Number(hours) || 1));
    const state = { stopped: false, deadline: this.now() + h * 3600 * 1000, hours: h };
    this.active.set(id, state);
    void (async () => {
      try {
        await this.loop(id, state);
      } catch (error) {
        await this.record(id, { active: false, error: error.message });
      } finally {
        this.active.delete(id);
      }
    })();
    return { ok: true, deadline: new Date(state.deadline).toISOString() };
  }

  stop(id) {
    const state = this.active.get(id);
    if (!state) return { ok: false };
    state.stopped = true;
    this.engine.cancel(id);
    return { ok: true };
  }

  async record(id, patch, trial) {
    const project = await this.engine.load(id);
    const improve = { trials: [], ...(project.improve ?? {}), ...patch };
    if (trial) improve.trials = [...improve.trials, trial].slice(-MAX_TRIALS_KEPT);
    project.improve = improve;
    if (trial) this.engine.emit(project, 'improve', `${trial.nodeId}: ${trial.outcome} (${trial.score}) — ${trial.change}`, { nodeId: trial.nodeId });
    await this.engine.store.save(project);
    return improve;
  }

  live(state) {
    return !state.stopped && this.now() < state.deadline;
  }

  async loop(id, state) {
    let project = await this.engine.load(id);
    await this.record(id, { active: true, startedAt: new Date(this.now()).toISOString(), deadline: new Date(state.deadline).toISOString(), hours: state.hours, error: null });
    if (project.phase !== 'done') project = await this.engine.run(id);
    let best = projectScore(project);
    await this.record(id, { baseline: best.score, best: best.score });
    let quiet = 0;
    while (this.live(state)) {
      let improved = false;
      for (const nodeId of improvementTargets(await this.engine.load(id))) {
        if (!this.live(state)) break;
        const outcome = await this.trial(id, nodeId, best, state);
        if (outcome.kept) {
          best = outcome.score;
          improved = true;
        }
      }
      quiet = improved ? 0 : quiet + 1;
      await this.record(id, { passes: ((await this.engine.load(id)).improve?.passes ?? 0) + 1, quietPasses: quiet });
    }
    await this.record(id, { active: false, finishedAt: new Date(this.now()).toISOString(), stopReason: state.stopped ? 'stopped by user' : 'time limit reached' });
  }

  async propose(project, nodeId, best) {
    const node = nodeId === ROOT_ID ? { id: ROOT_ID } : project.nodes.find((n) => n.id === nodeId);
    const trials = (project.improve?.trials ?? []).filter((t) => t.nodeId === nodeId);
    const reply = await this.engine.router.complete({ purpose: 'improve', tier: 'deep', messages: variantPrompt({ project, node, score: best, trials }) });
    return reply.data ?? {};
  }

  async trial(id, nodeId, best, state) {
    const before = await this.engine.load(id);
    const base = { at: new Date(this.now()).toISOString(), nodeId, before: best.score };
    try {
      const variant = await this.propose(before, nodeId, best);
      const change = String(variant.change ?? 'variant').slice(0, 240);
      const project = structuredClone(before);
      const touched = applyVariant(project, nodeId, variant);
      if (!touched.length) {
        await this.record(id, {}, { ...base, change, outcome: 'no-change', score: best.score });
        return { kept: false };
      }
      const oldNode = before.nodes.find((n) => n.id === nodeId);
      for (const t of touched) if (project.nodes.some((n) => n.id === t)) this.engine.resetWithAncestors(project, t);
      if (nodeId !== ROOT_ID && oldNode && isLeaf(project.nodes, project.nodes.find((n) => n.id === nodeId))) {
        const node = project.nodes.find((n) => n.id === nodeId);
        await this.engine.researchLeaf(project, node);
        if ((GRADE_RANK[node.status] ?? 0) < (GRADE_RANK[oldNode.status] ?? 0)) {
          await this.engine.store.save(before);
          await this.record(id, {}, { ...base, change, outcome: 'reverted-piece', score: best.score, detail: `${nodeId} fell from ${oldNode.status} to ${node.status}` });
          return { kept: false };
        }
      }
      await this.engine.store.save(project);
      const after = await this.engine.run(id);
      if (!this.live(state) && state.stopped) {
        await this.engine.store.save(before);
        await this.record(id, {}, { ...base, change, outcome: 'reverted-stopped', score: best.score });
        return { kept: false };
      }
      const score = projectScore(after);
      if (score.score > best.score + MIN_GAIN) {
        await this.record(id, { best: score.score }, { ...base, change, outcome: 'kept', score: score.score });
        return { kept: true, score };
      }
      await this.engine.store.save(before);
      await this.record(id, {}, { ...base, change, outcome: 'reverted-whole', score: score.score });
      return { kept: false };
    } catch (error) {
      await this.engine.store.save(before);
      await this.record(id, {}, { ...base, change: 'trial failed', outcome: 'error', score: best.score, detail: error.message.slice(0, 200) });
      if (QUOTA_ERROR.test(error.message) && this.live(state)) await this.sleep(Math.min(QUOTA_PAUSE_MS, Math.max(0, state.deadline - this.now())));
      return { kept: false };
    }
  }
}
