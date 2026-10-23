import { gradeAverage, scoreProject } from './score.mjs';
import { appendAppMessage, loopSummary } from './notify.mjs';
import { variantPrompt } from './prompts.mjs';
import { METHODS, ROOT_ID, blankNode, isLeaf, nextNodeId, urlList } from './tree.mjs';
import { cleanTitle, duplicateAmong, duplicateOf } from './treeaudit.mjs';
import { passingSpecs, regressions, specHolders } from './specs.mjs';
import { Mutex } from './lanes.mjs';
import { mergeTrial, trialConflict } from './trialmerge.mjs';

const GRADE_RANK = { verified: 3, supported: 2, weak: 1, unsupported: 0, failed: 0, pending: 0, researching: 0 };
const MAX_HOURS = 72;
const MAX_TRIALS_KEPT = 200;
const QUOTA_PAUSE_MS = 5 * 60 * 1000;
const MIN_GAIN = 0.001;
const REMOVAL_MIN_GAIN = 0.01;
const DEFAULT_SLICE_MINUTES = 20;
const QUOTA_ERROR = /no model provider|cooling down|rate limit|quota/i;

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function strings(value, max) {
  return (Array.isArray(value) ? value : value ? [value] : []).map((v) => String(v).trim()).filter(Boolean).slice(0, max);
}

export function projectScore(project, pieces = []) {
  const base = scoreProject(project, pieces);
  const acceptance = project?.acceptanceResult?.score ?? null;
  return { ...base, acceptance, score: acceptance === null ? base.score : round(0.6 * acceptance + 0.4 * base.score) };
}

export function distinctResearches(list) {
  const newest = new Map();
  for (const p of list.filter((x) => !x.demo)) {
    const key = String(p.question ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const seen = newest.get(key);
    if (!seen || String(p.updatedAt) > String(seen.updatedAt)) newest.set(key, p);
  }
  return [...newest.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map((p) => p.id);
}

export function inScope(nodes, scope, exclude = []) {
  if (!scope?.length) return new Set(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ids = new Set();
  for (const selected of scope.filter((id) => byId.has(id))) {
    for (let cursor = byId.get(selected); cursor; cursor = byId.get(cursor.parentId)) {
      for (const n of nodes) if (n.parentId === cursor.parentId) ids.add(n.id);
    }
    const below = new Set([selected]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const n of nodes) if (below.has(n.parentId) && !below.has(n.id)) { below.add(n.id); grew = true; }
    }
    for (const id of below) ids.add(id);
  }
  for (const id of exclude) ids.delete(id);
  return ids;
}

export function scopeScore(project, scope, pieces = [], exclude = []) {
  const ids = inScope(project.nodes, scope, exclude);
  const nodes = project.nodes.filter((n) => ids.has(n.id));
  const grades = gradeAverage(nodes, pieces);
  const keys = specHolders(project).filter(([id]) => ids.has(id)).flatMap(([id, h]) => h.specs.map((s) => `${id}/${s.id}`));
  const passing = passingSpecs(project);
  const specs = keys.length ? keys.filter((k) => passing.has(k)).length / keys.length : null;
  return { score: round(specs === null ? grades : 0.5 * grades + 0.5 * specs), grades: round(grades), specs, nodes: nodes.length };
}

export function scoredPieces(project, scope = [], exclude = []) {
  return [...inScope(project.nodes, scope, exclude)];
}

export function allChecksPass(before, after) {
  const keys = (p) => specHolders(p).flatMap(([id, h]) => h.specs.map((s) => `${id}/${s.id}`));
  const passing = passingSpecs(after);
  return [...new Set([...keys(before), ...keys(after)])].every((k) => passing.has(k));
}

export function acceptsTrial(before, after, removed = []) {
  return after > before + (removed.length ? REMOVAL_MIN_GAIN : MIN_GAIN);
}

function canGain(project, node) {
  if (node.status !== 'verified') return true;
  if ((node.specs ?? []).some((spec) => !spec.last?.passed)) return true;
  const expectedUnmet = Boolean(project.acceptanceResult) && project.acceptanceResult.score < 0.999;
  return expectedUnmet && (node.finding?.items ?? []).length > 0;
}

export function improvementTargets(project, scope = [], exclude = []) {
  const ids = inScope(project.nodes, scope, exclude);
  const leaves = project.nodes
    .filter((n) => ids.has(n.id) && isLeaf(project.nodes, n) && canGain(project, n))
    .sort((a, b) => (GRADE_RANK[a.status] ?? 0) - (GRADE_RANK[b.status] ?? 0) || b.impact * b.uncertainty - a.impact * a.uncertainty);
  return [...(exclude.includes(ROOT_ID) ? [] : [ROOT_ID]), ...leaves.map((n) => n.id)];
}

function nodeFields(raw, id, parentId) {
  const question = String(raw?.question ?? '').trim().slice(0, 400);
  if (!question) return null;
  return blankNode({
    id,
    parentId,
    title: cleanTitle(String(raw?.title || question)).slice(0, 90),
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
      if (node && !duplicateOf(node, project.nodes, project.question)) {
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
    if (child && !duplicateAmong(child, [node, ...project.nodes.filter((n) => n.parentId === node.id)])) {
      project.nodes.push(child);
      touched.push(child.id);
    }
  }
  return touched;
}

export class ProjectImprover {
  constructor({ engine, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), checkpoint = async () => {} }) {
    this.engine = engine;
    this.checkpoint = checkpoint;
    this.now = now;
    this.sleep = sleep;
    this.active = new Map();
  }

  isActive(id) {
    return this.active.has(id);
  }

  scopeOf(id) {
    return this.active.get(id)?.scope ?? [];
  }

  excludeOf(id) {
    return this.active.get(id)?.exclude ?? [];
  }

  remainingHours(id) {
    const state = this.active.get(id);
    return state ? Math.max(0, (state.deadline - this.now()) / 3600000) : 0;
  }

  async saveHandoff(id, reason, resume = {}) {
    try {
      const project = await this.engine.load(id);
      await this.engine.onStop(project, { reason, resume });
      await this.engine.store.save(project);
    } catch {
      return;
    }
  }

  async shutdown() {
    for (const [id, state] of this.active) {
      state.stopped = true;
      state.shutdown = true;
      if (state.before) await this.restore(id, state.before).catch(() => {});
      await this.saveHandoff(id, 'app stopped', { loopHoursLeft: Math.max(0, (state.deadline - this.now()) / 3600000), loopScope: state.scope ?? [], loopExclude: state.exclude ?? [] });
    }
  }

  async restore(id, before) {
    const current = await this.engine.load(id);
    await this.engine.store.save({ ...before, chats: current.chats, log: current.log, improve: current.improve });
  }

  stopped(state) {
    return state.stopped || this.all?.stopped;
  }

  start(id, { hours = 1, nodes = [], exclude = [] } = {}) {
    if (this.active.has(id)) throw new Error('the self-improving loop is already running for this project');
    const h = Math.min(MAX_HOURS, Math.max(0.05, Number(hours) || 1));
    const scope = (Array.isArray(nodes) ? nodes : []).map(String).filter((n) => n && n !== ROOT_ID).slice(0, 60);
    const skipped = scope.length ? (Array.isArray(exclude) ? exclude : []).map(String).filter((n) => n && !scope.includes(n)).slice(0, 120) : [];
    const state = { stopped: false, deadline: this.now() + h * 3600 * 1000, hours: h, scope, exclude: skipped };
    this.active.set(id, state);
    void (async () => {
      this.engine.quiet.add(id);
      try {
        await this.loop(id, state);
      } catch (error) {
        await this.record(id, { active: false, error: error.message });
      } finally {
        this.active.delete(id);
        this.engine.quiet.delete(id);
        if (!state.shutdown) await this.saveHandoff(id, state.stopped ? 'loop stopped by user' : 'loop ended');
      }
    })();
    return { ok: true, deadline: new Date(state.deadline).toISOString() };
  }

  startAll({ hours = 8, sliceMinutes = DEFAULT_SLICE_MINUTES } = {}) {
    if (this.all) throw new Error('the loop over all researches is already running');
    const h = Math.min(MAX_HOURS, Math.max(0.05, Number(hours) || 8));
    const sliceMs = Math.max(1, Number(sliceMinutes) || DEFAULT_SLICE_MINUTES) * 60 * 1000;
    const state = { stopped: false, deadline: this.now() + h * 3600 * 1000, hours: h, current: null, rounds: 0 };
    this.all = state;
    void (async () => {
      try {
        await this.cycle(state, sliceMs);
      } finally {
        this.all = null;
      }
    })();
    return { ok: true, deadline: new Date(state.deadline).toISOString() };
  }

  stopAll() {
    if (!this.all) return { ok: false };
    this.all.stopped = true;
    for (const id of this.active.keys()) this.stop(id);
    return { ok: true };
  }

  allStatus() {
    return this.all ? { active: true, deadline: new Date(this.all.deadline).toISOString(), current: this.all.current, rounds: this.all.rounds } : { active: false };
  }

  async cycle(state, sliceMs) {
    while (this.live(state)) {
      const ids = distinctResearches(await this.engine.store.list());
      if (!ids.length) break;
      for (const id of ids) {
        if (!this.live(state)) break;
        if (this.active.has(id) || this.engine.running.has(id)) continue;
        const slice = { stopped: false, deadline: Math.min(state.deadline, this.now() + sliceMs), hours: round(sliceMs / 3600000) };
        state.current = id;
        this.active.set(id, slice);
        this.engine.quiet.add(id);
        try {
          await this.loop(id, slice);
        } catch (error) {
          await this.record(id, { active: false, error: error.message });
        } finally {
          this.active.delete(id);
          this.engine.quiet.delete(id);
          if (!slice.shutdown) await this.saveHandoff(id, 'improve-all slice ended');
        }
      }
      state.rounds += 1;
    }
    state.current = null;
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
    if (trial) trial = { ...trial, scoreDelta: round(trial.score - trial.before) };
    if (trial) improve.trials = [...improve.trials, trial].slice(-MAX_TRIALS_KEPT);
    project.improve = improve;
    if ('active' in patch) appendAppMessage(project, loopSummary(improve, !patch.active));
    if (trial?.outcome === 'kept') appendAppMessage(project, `Kept a change on ${trial.nodeId}: ${trial.change}. Score ${trial.before} → ${trial.score}.`);
    if ('active' in patch) this.engine.emit(project, 'improve-state', patch.active ? `self-improving loop started for ${improve.hours} h` : `self-improving loop ended: ${patch.stopReason ?? patch.error ?? 'stopped'} · baseline ${improve.baseline} → best ${improve.best}`);
    if (trial) this.engine.emit(project, 'improve', `${trial.nodeId}: ${trial.outcome} (${trial.score}) — ${trial.change}`, { nodeId: trial.nodeId });
    await this.engine.store.save(project);
    return improve;
  }

  live(state) {
    return !state.stopped && this.now() < state.deadline;
  }

  async loop(id, state) {
    let project = await this.engine.load(id);
    const scope = state.scope ?? [];
    const exclude = state.exclude ?? [];
    state.pieces = new Set();
    state.lock = new Mutex();
    state.measure = (p) => (scope.length ? scopeScore(p, scope, [...state.pieces], exclude) : projectScore(p, [...state.pieces]));
    await this.record(id, { active: true, startedAt: new Date(this.now()).toISOString(), deadline: new Date(state.deadline).toISOString(), hours: state.hours, scope, exclude, error: null });
    project = project.phase !== 'done' ? await this.engine.run(id) : await this.engine.regroundAndRescore(id);
    state.pieces = new Set(scoredPieces(project, scope, exclude));
    state.best = state.measure(project);
    await this.record(id, { baseline: state.best.score, best: state.best.score });
    let quiet = 0;
    await this.saveCheckpoint(id, state);
    while (this.live(state)) {
      const improved = await this.pass(id, state);
      await this.saveCheckpoint(id, state);
      quiet = improved ? 0 : quiet + 1;
      await state.lock.run(async () => this.record(id, { passes: ((await this.engine.load(id)).improve?.passes ?? 0) + 1, quietPasses: quiet }));
    }
    state.spawn = null;
    this.engine.leave(id);
    await this.record(id, { active: false, finishedAt: new Date(this.now()).toISOString(), stopReason: state.stopped ? 'stopped by user' : 'time limit reached' });
  }

  async saveCheckpoint(id, state) {
    if (!state.hours || state === this.all) return;
    try {
      await this.checkpoint(id, { loopHoursLeft: Math.max(0, (state.deadline - this.now()) / 3600000), loopScope: state.scope ?? [], loopExclude: state.exclude ?? [] });
    } catch {
      return;
    }
  }

  async pass(id, state) {
    const tried = new Set();
    const claimed = new Set();
    let improved = false;
    const lanes = new Set();
    const lane = async () => {
      while (this.live(state)) {
        const current = await this.engine.load(id);
        const nodeId = improvementTargets(current, state.scope ?? [], state.exclude ?? []).find((t) => !tried.has(t) && !claimed.has(t));
        if (!nodeId) return;
        tried.add(nodeId);
        claimed.add(nodeId);
        try {
          if ((await this.trial(id, nodeId, state)).kept) improved = true;
        } finally {
          claimed.delete(nodeId);
        }
      }
    };
    const spawn = () => {
      const running = lane().finally(() => lanes.delete(running));
      lanes.add(running);
    };
    for (let i = 0; i < this.engine.lanesFor(id); i++) spawn();
    state.spawn = () => {
      if (lanes.size && lanes.size < this.engine.lanesFor(id)) spawn();
    };
    while (lanes.size) await Promise.race(lanes);
    return improved;
  }

  join(id) {
    const state = this.active.get(id);
    const joined = this.engine.join(id);
    state?.spawn?.();
    return joined;
  }

  async propose(project, nodeId, best) {
    const node = nodeId === ROOT_ID ? { id: ROOT_ID } : project.nodes.find((n) => n.id === nodeId);
    const trials = (project.improve?.trials ?? []).filter((t) => t.nodeId === nodeId);
    const reply = await this.engine.router.complete({ purpose: 'improve', tier: 'deep', messages: variantPrompt({ project, node, score: best, trials }) });
    return reply.data ?? {};
  }

  async trial(id, nodeId, state) {
    const snapshot = structuredClone(await this.engine.load(id));
    const base = { at: new Date(this.now()).toISOString(), nodeId, before: state.best.score };
    const note = (trial) => state.lock.run(() => this.record(id, {}, trial));
    try {
      const variant = await this.propose(snapshot, nodeId, state.best);
      const change = String(variant.change ?? 'variant').slice(0, 240);
      const project = structuredClone(snapshot);
      if (this.stopped(state)) return { kept: false };
      const touched = applyVariant(project, nodeId, variant);
      const removed = touched.filter((t) => !project.nodes.some((n) => n.id === t));
      if (removed.length) base.removedPieceId = removed.join(', ');
      if (!touched.length) {
        await note({ ...base, change, outcome: 'no-change', score: state.best.score });
        return { kept: false };
      }
      const oldNode = snapshot.nodes.find((n) => n.id === nodeId);
      for (const t of touched) if (project.nodes.some((n) => n.id === t)) this.engine.resetWithAncestors(project, t);
      const researched = nodeId !== ROOT_ID && oldNode && isLeaf(project.nodes, project.nodes.find((n) => n.id === nodeId));
      if (researched) {
        const node = project.nodes.find((n) => n.id === nodeId);
        await this.engine.researchLeaf(project, node);
        if (this.stopped(state)) {
          await note({ ...base, change, outcome: 'reverted-stopped', score: state.best.score });
          return { kept: false };
        }
        if ((GRADE_RANK[node.status] ?? 0) < (GRADE_RANK[oldNode.status] ?? 0)) {
          await note({ ...base, change, outcome: 'reverted-piece', score: state.best.score, detail: `${nodeId} fell from ${oldNode.status} to ${node.status}` });
          return { kept: false };
        }
        const broken = regressions(snapshot, project).filter((k) => k.startsWith(`${nodeId}/`));
        if (broken.length) {
          await note({ ...base, change, outcome: 'reverted-regression', score: state.best.score, detail: `breaks passing check(s): ${broken.join(', ')}` });
          return { kept: false };
        }
      }
      return await state.lock.run(() => this.commit(id, { snapshot, project, touched, removed, researched, nodeId, base, change }, state));
    } catch (error) {
      await note({ ...base, change: 'trial failed', outcome: 'error', score: state.best.score, detail: error.message.slice(0, 200) });
      if (QUOTA_ERROR.test(error.message) && this.live(state)) await this.sleep(Math.min(QUOTA_PAUSE_MS, Math.max(0, state.deadline - this.now())));
      return { kept: false };
    }
  }

  async commit(id, { snapshot, project, touched, removed, researched, nodeId, base, change }, state) {
    const best = state.best;
    const current = await this.engine.load(id);
    const before = structuredClone(current);
    const reject = async (outcome, detail, score = best.score) => {
      await this.restore(id, before);
      await this.record(id, {}, { ...base, before: best.score, change, outcome, score, ...(detail ? { detail } : {}) });
      return { kept: false };
    };
    if (this.stopped(state)) {
      await this.record(id, {}, { ...base, change, outcome: 'reverted-stopped', score: best.score });
      return { kept: false };
    }
    const conflict = trialConflict(snapshot, current, project, touched);
    if (conflict) {
      await this.record(id, {}, { ...base, change, outcome: 'conflict', score: best.score, detail: `${conflict}; tried again in the next pass` });
      return { kept: false };
    }
    state.before = before;
    try {
      const merged = mergeTrial(current, snapshot, project, touched);
      for (const t of touched) if (merged.nodes.some((n) => n.id === t)) this.engine.resetWithAncestors(merged, t);
      if (researched) merged.nodes[merged.nodes.findIndex((n) => n.id === nodeId)] = structuredClone(project.nodes.find((n) => n.id === nodeId));
      await this.engine.store.save({ ...merged, chats: current.chats, log: current.log, improve: current.improve });
      const after = await this.engine.run(id);
      if (this.stopped(state) || after.phase === 'cancelled') return await reject('reverted-stopped');
      const broken = regressions(before, after);
      if (broken.length) return await reject('reverted-regression', `breaks passing check(s): ${broken.join(', ')}`);
      if (removed.length && !allChecksPass(before, after)) return await reject('reverted-regression', `removing ${base.removedPieceId} needs every regression check to pass`);
      const score = (state.measure ?? projectScore)(after);
      if (acceptsTrial(best.score, score.score, removed)) {
        for (const piece of scoredPieces(after, state.scope ?? [], state.exclude ?? [])) state.pieces?.add(piece);
        state.best = score;
        await this.record(id, { best: score.score }, { ...base, before: best.score, change, outcome: 'kept', score: score.score });
        return { kept: true, score };
      }
      return await reject('reverted-whole', '', score.score);
    } catch (error) {
      return await reject('error', error.message.slice(0, 200));
    } finally {
      state.before = null;
    }
  }
}
