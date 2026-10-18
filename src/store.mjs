import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ID_PATTERN = /^[a-z0-9-]{6,64}$/;

export class ProjectStore {
  constructor({ dir }) {
    this.dir = dir;
    this.cache = new Map();
    this.writes = new Map();
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
    this.cache.set(project.id, project);
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
    if (this.cache.has(id)) return this.cache.get(id);
    try {
      const project = JSON.parse(await fs.readFile(this.file(id), 'utf8'));
      this.cache.set(id, project);
      return project;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async list() {
    await fs.mkdir(this.dir, { recursive: true });
    const files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    const projects = await Promise.all(files.map((f) => this.get(f.slice(0, -5)).catch(() => null)));
    return projects
      .filter((p) => p && typeof p.id === 'string' && typeof p.question === 'string')
      .map((p) => ({
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
        loop: p.improve ? { baseline: p.improve.baseline ?? null, best: p.improve.best ?? null, trials: (p.improve.trials ?? []).length, kept: (p.improve.trials ?? []).filter((t) => t.outcome === 'kept').length } : null,
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async remove(id) {
    await this.writes.get(id)?.catch(() => {});
    this.cache.delete(id);
    await fs.rm(this.file(id), { force: true });
  }
}
