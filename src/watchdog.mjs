export const WATCH_EVERY_MS = 5 * 60 * 1000;
export const MAX_REVIVALS = 3;
export const REVIVAL_WINDOW_MS = 6 * 3600 * 1000;
export const MIN_HOURS_LEFT = 0.05;

export function crashedLoop(improve, now) {
  if (!improve || improve.active || !improve.error || improve.stopReason === 'stopped by user') return null;
  const hoursLeft = (Date.parse(improve.deadline ?? '') - now) / 3600000;
  return hoursLeft > MIN_HOURS_LEFT ? { hoursLeft, scope: improve.scope ?? [], exclude: improve.exclude ?? [], error: improve.error } : null;
}

export class Watchdog {
  constructor({ listProjects, isLooping, startLoop, ensureLocal = async () => ({ started: false }), note = () => {}, now = () => Date.now() }) {
    this.listProjects = listProjects;
    this.isLooping = isLooping;
    this.startLoop = startLoop;
    this.ensureLocal = ensureLocal;
    this.note = note;
    this.now = now;
    this.revivals = new Map();
    this.ticking = false;
  }

  allowed(key) {
    const recent = (this.revivals.get(key) ?? []).filter((at) => this.now() - at < REVIVAL_WINDOW_MS);
    this.revivals.set(key, recent);
    if (recent.length >= MAX_REVIVALS) return false;
    recent.push(this.now());
    return true;
  }

  async tick() {
    if (this.ticking) return [];
    this.ticking = true;
    const actions = [];
    try {
      for (const project of await this.listProjects()) {
        const crash = this.isLooping(project.id) ? null : crashedLoop(project.improve, this.now());
        if (!crash) continue;
        if (!this.allowed(`loop:${project.id}`)) {
          actions.push(`loop ${project.id} not restarted: ${MAX_REVIVALS} restarts in 6 h`);
          continue;
        }
        await this.startLoop(project.id, { hours: crash.hoursLeft, nodes: crash.scope, exclude: crash.exclude });
        actions.push(`loop ${project.id} restarted with ${crash.hoursLeft.toFixed(1)} h left after: ${String(crash.error).slice(0, 120)}`);
      }
      const local = await this.ensureLocal({ mayStart: () => this.allowed('local-model') });
      if (local.started) actions.push(`local model restarted (pid ${local.pid})`);
      else if (local.refused) actions.push(`local model not restarted: ${MAX_REVIVALS} restarts in 6 h`);
    } finally {
      this.ticking = false;
    }
    for (const action of actions) this.note(action);
    return actions;
  }
}
