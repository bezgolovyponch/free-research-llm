import { ENGINE_LABELS, engineOf } from '../changes.mjs';

export class ChangeRunner {
  constructor({ coders, changes }) {
    this.coders = coders;
    this.changes = changes;
  }

  engines() {
    return Object.entries(this.coders).map(([id, coder]) => ({
      id,
      label: ENGINE_LABELS[id] ?? id,
      available: typeof coder?.available === 'function' ? Boolean(coder.available().installed) : true,
    }));
  }

  available(engine) {
    const id = engineOf(engine);
    const coder = this.coders[id];
    if (!coder) return false;
    return typeof coder.available === 'function' ? Boolean(coder.available().installed) : true;
  }

  busy(id) {
    return Object.values(this.coders).some((coder) => Boolean(coder?.busy?.(id)));
  }

  start(id, engine = 'free') {
    const which = engineOf(engine);
    const coder = this.coders[which];
    if (!coder) throw new Error(`no ${which} coder is configured on this computer`);
    if (!this.available(which)) throw new Error(which === 'claude' ? 'Claude Code is not installed on this computer: install it from https://docs.claude.com/en/docs/claude-code, or use the free-model coder' : `the ${which} coder is not available here`);
    return coder.start(id);
  }

  async undo(id) {
    const ticket = await this.changes.get(id);
    if (!ticket) throw new Error(`change ${id} not found`);
    const coder = this.coders[engineOf(ticket.engine)];
    if (!coder) throw new Error(`the ${ticket.engine} coder is not available here`);
    return coder.undo(id);
  }
}
