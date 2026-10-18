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

  async read(name, limit = 500) {
    try {
      const lines = (await fs.readFile(this.file(name), 'utf8')).trim().split('\n').filter(Boolean);
      return lines.slice(-limit).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }
}
