import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SHARE_TOKEN_LENGTH = 32;
const SHARED_API = /^\/api\/projects\/([\w-]+)(\/.*)?$/;
const OWNER_ONLY_SUBPATHS = new Set(['/share']);
const SHARED_PAGES = new Set(['/', '/index.html']);
const SHARED_READS = new Set(['/api/status', '/api/templates', '/api/whoami', '/api/projects']);

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function shareAllows({ method, pathname, projectId }) {
  if (method === 'GET' && (SHARED_PAGES.has(pathname) || pathname.startsWith('/vendor/') || SHARED_READS.has(pathname))) return true;
  const match = SHARED_API.exec(pathname);
  if (!match || match[1] !== projectId) return false;
  const rest = match[2] ?? '';
  if (OWNER_ONLY_SUBPATHS.has(rest)) return false;
  return !(rest === '' && method === 'DELETE');
}

export function shareLinks(bases, { projectId, token }) {
  return bases.map(({ label, url }) => ({ label, url: `${url}/?share=${encodeURIComponent(token)}#p=${encodeURIComponent(projectId)}` }));
}

export class ShareBook {
  constructor({ file, secret }) {
    this.file = file;
    this.secret = secret;
    this.entries = {};
  }

  get available() {
    return Boolean(this.secret);
  }

  async load() {
    try {
      this.entries = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      this.entries = {};
    }
    return this;
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.entries, null, 2));
    await fs.rename(temp, this.file);
  }

  tokenFor(projectId) {
    const entry = this.entries[projectId];
    if (!entry?.enabled || !this.available) return null;
    return crypto.createHmac('sha256', this.secret).update(`share:${projectId}:${entry.version}`).digest('base64url').slice(0, SHARE_TOKEN_LENGTH);
  }

  status(projectId) {
    const entry = this.entries[projectId];
    return { enabled: Boolean(entry?.enabled), since: entry?.enabled ? entry.since : null, token: this.tokenFor(projectId) };
  }

  async enable(projectId) {
    if (!this.available) throw new Error('remote access is off: run "node src/frl.mjs install" (always on) or "node src/frl.mjs start --remote", then share again');
    const entry = this.entries[projectId];
    if (!entry?.enabled) this.entries[projectId] = { version: (entry?.version ?? 0) + 1, enabled: true, since: new Date().toISOString() };
    await this.save();
    return this.status(projectId);
  }

  async revoke(projectId) {
    const entry = this.entries[projectId];
    if (entry?.enabled) {
      this.entries[projectId] = { version: entry.version, enabled: false, since: null };
      await this.save();
    }
    return this.status(projectId);
  }

  match(token) {
    if (!token || !this.available) return null;
    for (const projectId of Object.keys(this.entries)) {
      const expected = this.tokenFor(projectId);
      if (expected && sameSecret(token, expected)) return projectId;
    }
    return null;
  }
}
