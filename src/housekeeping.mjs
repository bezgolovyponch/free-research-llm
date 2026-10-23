import fs from 'node:fs/promises';
import path from 'node:path';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const SWEEP_DEFAULTS = Object.freeze({
  everyHours: 6,
  workMaxAgeMs: 7 * DAY_MS,
  tmpMaxAgeMs: DAY_MS,
  orphanLogMaxAgeMs: 7 * DAY_MS,
  logMaxBytes: 5 * 1024 * 1024,
  logKeepLines: 20000,
  serverOutMaxBytes: 1024 * 1024,
  serverOutKeepLines: 2000,
});

export function sweepHoursFrom(env) {
  const raw = env.FRL_SWEEP_HOURS;
  if (raw === undefined || raw === '') return SWEEP_DEFAULTS.everyHours;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours : 0;
}

async function olderThan(file, maxAgeMs, now) {
  const stat = await fs.stat(file).catch(() => null);
  return Boolean(stat) && now - stat.mtimeMs > maxAgeMs;
}

async function entries(dir) {
  return fs.readdir(dir).catch(() => []);
}

export class TempSweeper {
  constructor({ dataDir, logs, projectExists, now = () => Date.now(), limits = SWEEP_DEFAULTS }) {
    this.dataDir = dataDir;
    this.logs = logs;
    this.projectExists = projectExists;
    this.now = now;
    this.limits = { ...SWEEP_DEFAULTS, ...limits };
    this.timer = null;
  }

  async sweep() {
    const now = this.now();
    const report = { work: [], tmp: [], orphanLogs: [], trimmedLogs: [] };
    report.work = await this.sweepWork(now);
    report.tmp = await this.sweepTmp(this.dataDir, now);
    report.orphanLogs = await this.sweepOrphanLogs(now);
    report.trimmedLogs = await this.logs.compact({ maxBytes: this.limits.logMaxBytes, keepLines: this.limits.logKeepLines });
    if (await this.trimServerOut()) report.trimmedLogs.push('server.out');
    return report;
  }

  async sweepWork(now) {
    const dir = path.join(this.dataDir, 'work');
    const removed = [];
    for (const entry of await entries(dir)) {
      const target = path.join(dir, entry);
      if (!(await olderThan(target, this.limits.workMaxAgeMs, now))) continue;
      await fs.rm(target, { recursive: true, force: true });
      removed.push(entry);
    }
    return removed;
  }

  async sweepTmp(dir, now) {
    const removed = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'llama') continue;
        removed.push(...(await this.sweepTmp(target, now)));
      } else if (entry.name.endsWith('.tmp') && (await olderThan(target, this.limits.tmpMaxAgeMs, now))) {
        await fs.rm(target, { force: true });
        removed.push(path.relative(this.dataDir, target));
      }
    }
    return removed;
  }

  async sweepOrphanLogs(now) {
    const removed = [];
    for (const entry of await entries(this.logs.dir)) {
      const match = /^project-(.+)\.jsonl$/.exec(entry);
      if (!match) continue;
      const file = path.join(this.logs.dir, entry);
      if (await this.projectExists(match[1])) continue;
      if (!(await olderThan(file, this.limits.orphanLogMaxAgeMs, now))) continue;
      await fs.rm(file, { force: true });
      removed.push(entry);
    }
    return removed;
  }

  async trimServerOut() {
    const file = path.join(this.logs.dir, 'server.out');
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.size <= this.limits.serverOutMaxBytes) return false;
    const lines = (await fs.readFile(file, 'utf8')).split('\n');
    await fs.writeFile(file, lines.slice(-this.limits.serverOutKeepLines).join('\n'));
    return true;
  }

  schedule(everyHours, onReport) {
    this.stop();
    if (!everyHours) return;
    const run = async () => {
      try {
        onReport(await this.sweep());
      } catch {
        return;
      }
    };
    void run();
    this.timer = setInterval(() => void run(), everyHours * HOUR_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function describeSweep(report) {
  const parts = [
    report.work.length && `${report.work.length} old coder work folders`,
    report.tmp.length && `${report.tmp.length} .tmp files`,
    report.orphanLogs.length && `${report.orphanLogs.length} logs of deleted research`,
    report.trimmedLogs.length && `trimmed ${report.trimmedLogs.join(', ')}`,
  ].filter(Boolean);
  return parts.length ? `temp sweep: ${parts.join(' · ')}` : '';
}
