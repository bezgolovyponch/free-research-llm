import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ProjectJournal, diffProject, emptyShadow, journalEntry, keptRows, lostPieces, replayJournal, shadowOf } from './journal.mjs';

const ID_PATTERN = /^[a-z0-9-]{6,64}$/;
const DEFAULT_MAX_CACHED = 8;
export const DEFAULT_REASON = 'automatic save';
export const USER_ACTIONS = Object.freeze(['delete', 're-decompose', 'restore', 'loop']);
export const SNAPSHOTS_KEPT = 5;

export class RemovalRefusedError extends Error {
  constructor(message, { nodes = [] } = {}) {
    super(message);
    this.name = 'RemovalRefusedError';
    this.nodes = nodes;
  }
}

export class StoreBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreBusyError';
  }
}

export function storePaths({ root, dataDir = null }) {
  const base = dataDir ?? path.join(root, 'data');
  const projects = dataDir ?? path.join(root, 'data', 'projects');
  return { base, projects, journal: path.join(base, 'journal'), snapshots: path.join(projects, 'snapshots'), logs: path.join(base, 'logs') };
}

export function snapshotStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function snapshotTime(stamp) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(String(stamp));
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : null;
}

function summarize(p) {
  if (!p || typeof p.id !== 'string' || typeof p.question !== 'string') return null;
  return {
    id: p.id,
    question: p.question,
    templateId: p.templateId,
    phase: p.phase,
    verdict: p.report?.verdict ?? null,
    demo: Boolean(p.demo),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    expected: p.acceptance?.expected ?? '',
    expectedScore: p.acceptanceResult?.score ?? null,
    nodes: (p.nodes ?? []).length,
    good: (p.nodes ?? []).filter((n) => ['verified', 'supported'].includes(n.status)).length,
    loop: p.improve ? { baseline: p.improve.baseline ?? null, best: p.improve.best ?? null, trials: (p.improve.trials ?? []).length, kept: (p.improve.trials ?? []).filter((t) => t.outcome === 'kept').length, active: Boolean(p.improve.active), error: p.improve.error ?? null, deadline: p.improve.deadline ?? null, stopReason: p.improve.stopReason ?? null, scope: p.improve.scope ?? [], exclude: p.improve.exclude ?? [] } : null,
  };
}

export class ProjectStore {
  constructor({ dir, maxCached = DEFAULT_MAX_CACHED, isBusy = () => false, journalDir = path.join(dir, 'journal'), snapshotDir = path.join(dir, 'snapshots'), keepSnapshots = SNAPSHOTS_KEPT, onEvent = () => {} }) {
    this.dir = dir;
    this.maxCached = maxCached;
    this.isBusy = isBusy;
    this.cache = new Map();
    this.summaries = new Map();
    this.writes = new Map();
    this.shadows = new Map();
    this.journal = new ProjectJournal({ dir: journalDir });
    this.snapshotDir = snapshotDir;
    this.keepSnapshots = keepSnapshots;
    this.onEvent = onEvent;
  }

  remember(project) {
    this.cache.delete(project.id);
    this.cache.set(project.id, project);
    for (const id of this.cache.keys()) {
      if (this.cache.size <= this.maxCached) break;
      if (id === project.id || this.writes.has(id) || this.isBusy(id)) continue;
      this.cache.delete(id);
      this.shadows.delete(id);
    }
    return project;
  }

  async readFile(id) {
    try {
      return JSON.parse(await fs.readFile(this.file(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  file(id) {
    if (!ID_PATTERN.test(id)) throw new Error(`invalid project id "${id}"`);
    return path.join(this.dir, `${id}.json`);
  }

  newId(question) {
    const slug = String(question).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'project';
    return `${slug}-${crypto.randomBytes(3).toString('hex')}`;
  }

  async shadowFor(id) {
    if (this.shadows.has(id)) return this.shadows.get(id);
    const stored = await this.readFile(id);
    const shadow = stored ? shadowOf(stored) : emptyShadow();
    this.shadows.set(id, shadow);
    return shadow;
  }

  async save(project, { reason = DEFAULT_REASON, userAction = null } = {}) {
    if (userAction !== null && !USER_ACTIONS.includes(userAction)) throw new Error(`unknown user action "${userAction}" (one of: ${USER_ACTIONS.join(', ')})`);
    project.updatedAt = new Date().toISOString();
    this.remember(project);
    const target = this.file(project.id);
    const previous = this.writes.get(project.id) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const diff = diffProject(await this.shadowFor(project.id), project);
      const lost = lostPieces(diff);
      if (lost.length && !userAction) this.refuse(project.id, { reason, lost });
      const ts = new Date().toISOString();
      const snapshot = diff.nodes.after < diff.nodes.before || (diff.rows.removed.length && !diff.sweepChanged) ? await this.snapshot(project.id, ts) : null;
      await this.journal.append(project.id, journalEntry({ id: project.id, reason, userAction, diff, snapshot, ts }));
      const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(project, null, 2));
      await fs.rename(tmp, target);
      this.shadows.set(project.id, diff.next);
    });
    this.writes.set(project.id, write);
    try {
      await write;
    } finally {
      if (this.writes.get(project.id) === write) this.writes.delete(project.id);
    }
    return project;
  }

  refuse(id, { reason, lost }) {
    const message = `save refused: it would remove ${lost.length} researched piece(s) (${lost.join(', ')}) with no user action behind it (reason given: ${reason}); the stored copy is unchanged. A piece is removed only by delete, re-decompose, restore or a loop trial; an automatic repair must mark it covered instead`;
    this.cache.delete(id);
    this.onEvent(id, { ts: new Date().toISOString(), type: 'error', message });
    throw new RemovalRefusedError(message, { nodes: lost });
  }

  snapshotFile(id, stamp) {
    return path.join(this.snapshotDir, `${id}-${stamp}.json`);
  }

  async snapshot(id, ts) {
    const file = this.snapshotFile(id, snapshotStamp(new Date(ts)));
    try {
      await fs.mkdir(this.snapshotDir, { recursive: true });
      await fs.copyFile(this.file(id), file);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    for (const old of (await this.snapshots(id)).slice(this.keepSnapshots)) await fs.rm(old.path, { force: true });
    return path.basename(file);
  }

  async snapshots(id) {
    this.file(id);
    const names = (await fs.readdir(this.snapshotDir).catch(() => [])).filter((name) => name.startsWith(`${id}-`) && name.endsWith('.json'));
    return names
      .map((name) => ({ file: name, path: path.join(this.snapshotDir, name), at: snapshotTime(name.slice(id.length + 1, -5)) }))
      .filter((s) => s.at)
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  async restorable(id) {
    const [snapshots, journal] = await Promise.all([this.snapshots(id), this.journal.summary(id)]);
    const described = await Promise.all(snapshots.map(async ({ file, at, path: full }) => {
      try {
        const copy = JSON.parse(await fs.readFile(full, 'utf8'));
        return { file, at, phase: copy.phase ?? null, nodes: (copy.nodes ?? []).length, rows: keptRows(copy).length };
      } catch {
        return { file, at, phase: null, nodes: null, rows: null };
      }
    }));
    return { snapshots: described, journal };
  }

  async restore(id, { snapshot = '', before = '' } = {}) {
    this.file(id);
    if (this.isBusy(id)) throw new StoreBusyError('stop the run or the loop first: the research is running');
    if (!snapshot && !before) throw new Error('name a snapshot file or pass --before <ISO time>');
    const current = (await this.get(id)) ?? { nodes: [], candidates: null };
    const counts = (p) => ({ nodes: (p.nodes ?? []).length, rows: keptRows(p).length });
    const was = counts(current);
    let project;
    let detail;
    if (snapshot) {
      const name = path.basename(String(snapshot));
      const candidates = (await this.snapshots(id)).filter((s) => s.file === name);
      const file = candidates[0]?.path ?? path.resolve(String(snapshot));
      project = JSON.parse(await fs.readFile(file, 'utf8'));
      if (project?.id !== id) throw new Error(`${name} is not a snapshot of ${id}`);
      detail = `snapshot ${name}`;
    } else {
      if (Number.isNaN(Date.parse(before))) throw new Error(`--before needs an ISO time, got "${before}"`);
      const entries = await this.journal.read(id);
      project = structuredClone(current);
      const undone = replayJournal(project, entries, { before: new Date(before).toISOString() });
      if (!undone.entries) throw new Error(`the journal of ${id} has no entry at or after ${before}`);
      detail = `journal replay to before ${before}: ${undone.entries} save(s) undone, pieces restored ${undone.nodes.restored}, reverted ${undone.nodes.reverted}, added ones dropped ${undone.nodes.dropped}; rows restored ${undone.rows.restored}, reverted ${undone.rows.reverted}, dropped ${undone.rows.dropped}`;
    }
    const now = counts(project);
    const message = `restored from ${detail}; pieces ${was.nodes} → ${now.nodes}, kept rows ${was.rows} → ${now.rows}`;
    await this.save(project, { reason: `restore: ${detail}`, userAction: 'restore' });
    this.onEvent(id, { ts: new Date().toISOString(), type: 'restore', message });
    return { ok: true, message, from: snapshot ? 'snapshot' : 'journal', nodes: { before: was.nodes, after: now.nodes }, rows: { before: was.rows, after: now.rows } };
  }

  async get(id) {
    if (this.cache.has(id)) return this.remember(this.cache.get(id));
    const project = await this.readFile(id);
    if (!project) return null;
    this.shadows.set(id, shadowOf(project));
    return this.remember(project);
  }

  async list() {
    await fs.mkdir(this.dir, { recursive: true });
    const files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    const present = new Set(files.map((f) => f.slice(0, -5)));
    for (const id of this.summaries.keys()) if (!present.has(id)) this.summaries.delete(id);
    const rows = await Promise.all(files.map((f) => this.summaryOf(f.slice(0, -5)).catch(() => null)));
    return rows.filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async summaryOf(id) {
    const cached = this.cache.get(id);
    if (cached) return summarize(cached);
    const { mtimeMs } = await fs.stat(this.file(id));
    const known = this.summaries.get(id);
    if (known?.mtimeMs === mtimeMs) return known.summary;
    const summary = summarize(await this.readFile(id));
    this.summaries.set(id, { mtimeMs, summary });
    return summary;
  }

  async remove(id) {
    await this.writes.get(id)?.catch(() => {});
    this.cache.delete(id);
    this.shadows.delete(id);
    await fs.rm(this.file(id), { force: true });
  }
}
