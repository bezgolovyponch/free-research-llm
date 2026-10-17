import fs from 'node:fs/promises';
import path from 'node:path';

export class PatchError extends Error {}

export class PatchSet {
  constructor({ root, allowlist }) {
    this.root = root;
    this.allowlist = allowlist;
    this.backups = new Map();
  }

  resolve(file) {
    const rel = path.normalize(String(file ?? '')).replace(/^(\.\/)+/, '');
    if (!this.allowlist.includes(rel)) throw new PatchError(`file not allowed: ${file}`);
    return path.join(this.root, rel);
  }

  async apply(edits) {
    if (!Array.isArray(edits) || !edits.length) throw new PatchError('no edits proposed');
    for (const edit of edits.slice(0, 4)) {
      const target = this.resolve(edit.file);
      const before = this.backups.get(target) ?? (await fs.readFile(target, 'utf8'));
      if (!this.backups.has(target)) this.backups.set(target, before);
      const current = await fs.readFile(target, 'utf8');
      const find = String(edit.find ?? '');
      const replace = String(edit.replace ?? '');
      if (find.length < 8) throw new PatchError('find text too short to be safe');
      const at = current.indexOf(find);
      if (at < 0) throw new PatchError(`find text not found in ${edit.file}`);
      if (current.indexOf(find, at + 1) >= 0) throw new PatchError(`find text is not unique in ${edit.file}`);
      if (find === replace) throw new PatchError('edit changes nothing');
      await fs.writeFile(target, current.slice(0, at) + replace + current.slice(at + find.length));
    }
    return [...this.backups.keys()].map((f) => path.relative(this.root, f));
  }

  async revert() {
    for (const [file, content] of this.backups) await fs.writeFile(file, content);
    this.backups.clear();
  }
}
