import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ID_PATTERN = /^[a-z0-9-]{6,64}$/;
const DEFAULT_MAX_CACHED = 8;

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
  constructor({ dir, maxCached = DEFAULT_MAX_CACHED, isBusy = () => false }) {
    this.dir = dir;
    this.maxCached = maxCached;
    this.isBusy = isBusy;
    this.cache = new Map();
    this.summaries = new Map();
    this.writes = new Map();
  }

  remember(project) {
    this.cache.delete(project.id);
    this.cache.set(project.id, project);
    for (const id of this.cache.keys()) {
      if (this.cache.size <= this.maxCached) break;
      if (id === project.id || this.writes.has(id) || this.isBusy(id)) continue;
      this.cache.delete(id);
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

  async save(project) {
    project.updatedAt = new Date().toISOString();
    this.remember(project);
    const target = this.file(project.id);
    const previous = this.writes.get(project.id) ?? Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(project, null, 2));
      await fs.rename(tmp, target);
    });
    this.writes.set(project.id, write);
    await write;
    if (this.writes.get(project.id) === write) this.writes.delete(project.id);
    return project;
  }

  async get(id) {
    if (this.cache.has(id)) return this.remember(this.cache.get(id));
    const project = await this.readFile(id);
    return project ? this.remember(project) : null;
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
    await fs.rm(this.file(id), { force: true });
  }
}
