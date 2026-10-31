import fs from 'node:fs/promises';

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export class InstanceLock {
  constructor({ file, pid = process.pid, isAlive = processAlive }) {
    this.file = file;
    this.pid = pid;
    this.isAlive = isAlive;
  }

  async owner() {
    try {
      const held = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return Number.isInteger(held.pid) && held.pid !== this.pid && this.isAlive(held.pid) ? held : null;
    } catch {
      return null;
    }
  }

  async acquire(extra = {}) {
    const holder = await this.owner();
    if (holder) return { acquired: false, holder };
    await fs.writeFile(this.file, JSON.stringify({ pid: this.pid, startedAt: new Date().toISOString(), ...extra }));
    return { acquired: true };
  }

  async release() {
    try {
      const held = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (held.pid === this.pid) await fs.rm(this.file, { force: true });
    } catch {
      return;
    }
  }
}
