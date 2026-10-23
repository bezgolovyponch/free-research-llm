import fs from 'node:fs/promises';
import path from 'node:path';

export class EventLog {
  constructor({ dir }) {
    this.dir = dir;
    this.queue = Promise.resolve();
  }

  file(name) {
    return path.join(this.dir, `${String(name).replace(/[^\w.-]/g, '_')}.jsonl`);
  }

  append(name, record) {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
    this.queue = this.queue.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.appendFile(this.file(name), line);
    }).catch(() => {});
    return this.queue;
  }

  compact({ maxBytes, keepLines }) {
    const trimmed = [];
    this.queue = this.queue.then(async () => {
      for (const entry of await fs.readdir(this.dir).catch(() => [])) {
        if (!entry.endsWith('.jsonl')) continue;
        const file = path.join(this.dir, entry);
        if ((await fs.stat(file)).size <= maxBytes) continue;
        const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
        await fs.writeFile(file, `${lines.slice(-keepLines).join('\n')}\n`);
        trimmed.push(entry);
      }
    }).catch(() => {});
    return this.queue.then(() => trimmed);
  }

  async read(name, limit = 500) {
    try {
      const lines = (await fs.readFile(this.file(name), 'utf8')).trim().split('\n').filter(Boolean);
      return lines.slice(-limit).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }
}
