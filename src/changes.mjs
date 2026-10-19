import fs from 'node:fs/promises';
import path from 'node:path';

export const TICKET_ID = /^C\d{1,5}$/;
const STATES = new Set(['queued', 'running', 'done', 'failed', 'reverted']);

function text(value, max) {
  return String(value ?? '').replace(/\r/g, '').trim().slice(0, max);
}

function list(value, max) {
  return (Array.isArray(value) ? value : value ? [value] : []).map((v) => text(v, 300)).filter(Boolean).slice(0, max);
}

export function normalizeTicket(raw) {
  const request = text(raw?.request, 3000);
  const desired = text(raw?.desired, 1500);
  if (request.length < 8 || desired.length < 3) return null;
  return { title: text(raw?.title || request.split('\n')[0], 90), request, desired, tests: list(raw?.tests, 8), area: text(raw?.area, 80) };
}

export function ticketMarkdown(t) {
  return `# ${t.id} · ${t.title}

Requested in the App chat on ${t.createdAt.slice(0, 16).replace('T', ' ')}. The free-model coder implements it in a sandbox copy and applies it only when the quality gate passes; \`node src/frl.mjs change ${t.id} --claude\` hands it to Claude Code instead.

## Request (what the user wants)

${t.request}

## Desired output (the result that must exist when this is done)

${t.desired}

## Tests and checks to add or change

${t.tests.length ? t.tests.map((x) => `- ${x}`).join('\n') : '- Derive them from the desired output: every changed logic module gets its test in tests/**, UI flows get an e2e case in e2e/**.'}
${t.area ? `\n## Area\n\n${t.area}\n` : ''}
## How to work

1. Run AUDIT-PROTOCOL.md Part 1 before planning. Ask the user in this terminal when a decision is theirs.
2. Keep CONCEPT.md: a model proposes, code decides; chats stay in their scope; nothing runs without a gate or a button.
3. Done means: the desired output exists in the running app, \`npm run quality\` prints \`quality gate: PASSED\`, SESSION-LOG.md has the entry, and AUDIT-PROTOCOL.md Part 2 is answered.
4. Do not commit or push unless the request says so.
`;
}

export function claudePrompt(id) {
  return `Implement the app change in data/changes/${id}.md. Follow AUDIT-PROTOCOL.md and CONCEPT.md.`;
}

export class ChangeBook {
  constructor({ dir }) {
    this.dir = dir;
    this.queue = Promise.resolve();
  }

  async all() {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir, 'index.json'), 'utf8'));
    } catch {
      return [];
    }
  }

  update(change) {
    const next = this.queue.catch(() => {}).then(async () => {
      const tickets = await this.all();
      const result = await change(tickets);
      await fs.mkdir(this.dir, { recursive: true });
      const file = path.join(this.dir, 'index.json');
      await fs.writeFile(`${file}.tmp`, JSON.stringify(tickets, null, 1));
      await fs.rename(`${file}.tmp`, file);
      return result;
    });
    this.queue = next;
    return next;
  }

  async create(raw) {
    const fields = normalizeTicket(raw);
    if (!fields) throw new Error('a change needs a request (8+ characters) and a desired output');
    return this.update(async (tickets) => {
      let n = tickets.length + 1;
      while (tickets.some((t) => t.id === `C${n}`)) n++;
      const ticket = { id: `C${n}`, ...fields, state: 'queued', createdAt: new Date().toISOString(), result: null };
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(path.join(this.dir, `${ticket.id}.md`), ticketMarkdown(ticket));
      tickets.push(ticket);
      return ticket;
    });
  }

  async get(id) {
    return (await this.all()).find((t) => t.id === id) ?? null;
  }

  async report(id, { state, passed = null, summary = '', files = null } = {}) {
    if (!TICKET_ID.test(String(id))) throw new Error('unknown change id');
    if (!STATES.has(state)) throw new Error(`state must be one of ${[...STATES].join(', ')}`);
    return this.update((tickets) => {
      const ticket = tickets.find((t) => t.id === id);
      if (!ticket) throw new Error(`change ${id} not found`);
      ticket.state = state;
      ticket.updatedAt = new Date().toISOString();
      if (state === 'done' || state === 'failed' || state === 'reverted') ticket.result = { passed: Boolean(passed), summary: text(summary, 1500), at: ticket.updatedAt };
      if (files) ticket.files = list(files, 60);
      return ticket;
    });
  }
}
