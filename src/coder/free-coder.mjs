import fs from 'node:fs/promises';
import path from 'node:path';
import { CodeSandbox, diffStats, restoreBackup } from './sandbox.mjs';
import { EditError, editablePath, normalizeEdits } from './edits.mjs';
import { FULL_FILE_CHARS, REPO_MAP, fileView, rankFiles, ticketTerms } from './context.mjs';

export const MAX_ATTEMPTS = 6;
export const MAX_GATE_RUNS = 4;
const MAX_READ_FILES = 10;
const CONTEXT_CHARS = 60000;
const FAILURE_CHARS = 3500;

const CONVENTIONS = `Rules of this repository (the quality gate enforces most of them):
- Node ESM, files end in .mjs under src/. No comments of any kind in source.
- Every module src/<path>.mjs has a Vitest test tests/<path>.test.ts. Every new or changed logic needs a test that fails without it. UI flows get a Playwright case in e2e/*.spec.ts.
- Never write an API key, token or password into any file.
- A model proposes, code decides: chats never create, delete or run anything without a button or a gate.
- Tests may be added or changed, never removed or weakened.
- Keep the surrounding style; make the smallest change that reaches the desired output.`;

export function planPrompt(ticket, files, located = []) {
  return [
    { role: 'system', content: `You are the code planner of a Node.js app. Pick the files you must read to implement a change.\n${CONVENTIONS}` },
    { role: 'user', content: `CHANGE ${ticket.id}: ${ticket.title}\nREQUEST:\n${ticket.request}\nDESIRED OUTPUT:\n${ticket.desired}\nTESTS TO ADD:\n${(ticket.tests ?? []).join('\n') || 'derive from the desired output'}\nAREA: ${ticket.area || 'unknown'}\n\nREPOSITORY MAP:\n${REPO_MAP}\n\nFILES THAT CONTAIN THE TICKET'S WORDS (found by code): ${located.join(', ') || 'none'}\n\nREPOSITORY FILES:\n${files.join('\n')}\n\nReply JSON only: {"files":["up to ${MAX_READ_FILES} existing paths to read, most important first"],"plan":"3-6 short steps"}` },
  ];
}

export function editPrompt(ticket, { plan, sources, feedback, attempt }) {
  const shown = sources.map(({ file, text }) => `=== ${file} ===\n${text}`).join('\n\n');
  const map = `REPOSITORY MAP:\n${REPO_MAP}\n\n`;
  return [
    { role: 'system', content: `You are the implementer of a Node.js app. You change files by returning exact edits. A machine applies them in a sandbox copy and runs the quality gate (syntax, secrets, no comments, a test file per module, Vitest, Playwright). The change is applied to the real app only if the gate passes.\n${CONVENTIONS}` },
    { role: 'user', content: `CHANGE ${ticket.id}: ${ticket.title}\nREQUEST:\n${ticket.request}\nDESIRED OUTPUT:\n${ticket.desired}\nTESTS TO ADD:\n${(ticket.tests ?? []).join('\n') || 'derive from the desired output'}\nPLAN: ${plan || 'none'}\n${map}ATTEMPT ${attempt} of ${MAX_ATTEMPTS}${feedback ? `\n\nTHE PREVIOUS ATTEMPT FAILED. Fix exactly this (your earlier edits are already applied in the files below):\n${feedback}` : ''}\n\nFILES:\n${shown}\n\nReply JSON only:\n{"edits":[{"file":"path","search":"a short snippet copied character for character from the file shown (it may be part of a long line) that appears exactly once","replace":"the text that replaces that snippet"},{"file":"new/or/rewritten/path","content":"the whole file"}],"read":["extra paths to see next attempt, if needed"],"summary":"one sentence"}\nEditable: src/, tests/, e2e/, public/, top-level *.md. Not editable: the quality gate, the coder, auth, secrets, terminal, package.json.` },
  ];
}

export function failureFeedback(gate) {
  const failed = gate.summary.split('\n').filter((l) => l.startsWith('FAIL')).join('\n');
  const tail = String(gate.output ?? '').split('\n').filter((l) => /Error|error|expect|Expected|Received|✘|✗|×|FAIL|failed|locator|Timeout|›|at .*:\d+/.test(l)).slice(-70).join('\n');
  return `${failed}\n${tail}`.trim().slice(-FAILURE_CHARS);
}

export class FreeCoder {
  constructor({ router, root, workDir, changes, note = () => {}, restart = null, sandboxFactory = null }) {
    this.router = router;
    this.root = root;
    this.workDir = workDir;
    this.changes = changes;
    this.note = note;
    this.restart = restart;
    this.sandboxFactory = sandboxFactory ?? ((id) => new CodeSandbox({ root, dir: path.join(workDir, id) }));
    this.queue = Promise.resolve();
    this.active = null;
    this.waiting = new Set();
  }

  busy(id) {
    return this.active === id || this.waiting.has(id);
  }

  start(id) {
    if (this.busy(id)) return { started: false, message: `${id} is already being implemented` };
    this.waiting.add(id);
    const job = this.queue.then(() => this.run(id));
    this.queue = job.catch(() => {});
    return { started: true, job, message: `${id} queued for the free-model coder` };
  }

  async ask(messages, purpose) {
    const reply = await this.router.complete({ messages, tier: 'deep', json: true, purpose, temperature: 0.2 });
    return { ...(reply.data && typeof reply.data === 'object' && !Array.isArray(reply.data) ? reply.data : { edits: reply.data }), model: reply.model ?? null };
  }

  async sourcesFor(sandbox, files, terms) {
    const sources = [];
    let used = 0;
    for (const file of files) {
      const view = fileView(file, await sandbox.read(file), terms);
      const size = view.text.length + file.length;
      if (used + size > CONTEXT_CHARS) continue;
      used += size;
      sources.push(view);
    }
    return sources;
  }

  async log(id, entry) {
    const file = path.join(this.changes.dir, `${id}.attempts.jsonl`);
    await fs.mkdir(this.changes.dir, { recursive: true });
    await fs.appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  }

  async wholeFileRewrites(sandbox, edits) {
    const large = [];
    for (const e of edits) if ('content' in e && ((await sandbox.read(e.file)) ?? '').length > FULL_FILE_CHARS) large.push(e.file);
    return large;
  }

  async run(id) {
    this.waiting.delete(id);
    this.active = id;
    const ticket = await this.changes.get(id);
    if (!ticket) {
      this.active = null;
      throw new Error(`change ${id} not found`);
    }
    const sandbox = this.sandboxFactory(id);
    try {
      await this.changes.report(id, { state: 'running' });
      this.note(`Change ${id} started: free models implement it in a sandbox copy; the quality gate decides. ${ticket.title}`);
      const files = await sandbox.prepare();
      await fs.rm(path.join(this.changes.dir, `${id}.attempts.jsonl`), { force: true });
      const terms = ticketTerms(ticket);
      const located = rankFiles(await Promise.all(files.filter((f) => /^(src|public|e2e|tests)\//.test(f)).map(async (file) => ({ file, body: await sandbox.read(file) }))), terms);
      const planned = await this.ask(planPrompt(ticket, files, located), 'code-plan');
      const known = new Set(files);
      let reading = [...new Set([...located, ...(planned.files ?? []).map(editablePath).filter((f) => f && known.has(f))])].slice(0, MAX_READ_FILES);
      await this.log(id, { step: 'plan', located, files: reading, plan: String(planned.plan ?? '').slice(0, 600) });
      let feedback = '';
      let last = null;
      let gates = 0;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && gates < MAX_GATE_RUNS; attempt++) {
        const sources = await this.sourcesFor(sandbox, [...new Set([...sandbox.touched, ...reading])], terms);
        const reply = await this.ask(editPrompt(ticket, { plan: planned.plan, sources, feedback, attempt }), 'code');
        const { edits, refused } = normalizeEdits(reply);
        reading = [...new Set([...reading, ...(reply.read ?? []).map(editablePath).filter((f) => f && known.has(f))])].slice(0, MAX_READ_FILES + 4);
        const entry = { step: 'attempt', attempt, model: reply.model ?? null, shown: sources.map((v) => `${v.file}${v.partial ? ' (excerpts)' : ''}`), edits: edits.map((e) => e.file), refused, summary: String(reply.summary ?? '').slice(0, 300) };
        const large = await this.wholeFileRewrites(sandbox, edits);
        if (!edits.length || large.length) {
          feedback = large.length ? `Do not rewrite large files with "content": ${large.join(', ')}. Use search/replace with a snippet from the excerpts shown.` : `No usable edits were returned${refused.length ? `; refused paths: ${refused.join(', ')}` : ''}. Return at least one edit.`;
          await this.log(id, { ...entry, outcome: 'no-edits', feedback });
          continue;
        }
        try {
          await sandbox.apply(edits);
        } catch (error) {
          if (!(error instanceof EditError)) throw error;
          feedback = error.message;
          await this.log(id, { ...entry, outcome: 'edit-failed', feedback });
          continue;
        }
        gates++;
        last = await sandbox.gate();
        await this.log(id, { ...entry, outcome: last.passed ? 'gate-passed' : 'gate-failed', gate: last.summary });
        if (last.passed) {
          const backup = path.join(this.workDir, `${id}.backup`);
          await fs.rm(backup, { recursive: true, force: true });
          const promoted = await sandbox.promote(backup);
          const ticketDone = await this.changes.report(id, { state: 'done', passed: true, summary: last.summary, files: promoted });
          const restarting = Boolean(this.restart?.());
          const stats = diffStats({ root: this.root, backupDir: backup, files: promoted });
          this.note(`Change ${id} applied after attempt ${attempt}: quality gate PASSED.\nWhat changed:\n${stats.map((f) => `- ${f.file} +${f.added} −${f.removed}${f.created ? ' (new)' : ''}`).join('\n')}\n${last.summary}\nUndo: the Undo button next to ${id} in App changes.${restarting ? ' The app restarts to load it.' : ' Restart the app to load it: node src/frl.mjs restart'}`);
          return ticketDone;
        }
        feedback = failureFeedback(last);
        this.note(`Change ${id}, attempt ${attempt}: gate failed, retrying with the failure.\n${last.summary.split('\n').filter((l) => l.startsWith('FAIL')).join('\n')}`);
      }
      const summary = last?.summary || feedback.slice(0, 600);
      const failed = await this.changes.report(id, { state: 'failed', passed: false, summary });
      this.note(`Change ${id} not applied: no attempt passed the quality gate. The app is unchanged. Every attempt: data/changes/${id}.attempts.jsonl. Try again, or run it with Claude Code: node src/frl.mjs change ${id} --claude\n${summary}`);
      return failed;
    } catch (error) {
      const failed = await this.changes.report(id, { state: 'failed', passed: false, summary: error.message });
      const quota = /every provider failed|cooling down|no model provider/.test(error.message);
      this.note(`Change ${id} stopped: ${quota ? 'the free model quotas are used up for now. Press Try again after they reset (most reset daily), or add a free key in Setup' : error.message.slice(0, 300)}. The app is unchanged.`);
      return failed;
    } finally {
      await sandbox.discard();
      this.active = null;
    }
  }

  async undo(id) {
    const ticket = await this.changes.get(id);
    if (!ticket || ticket.state !== 'done') throw new Error(`only an applied change can be undone (${id} is ${ticket?.state ?? 'unknown'})`);
    const files = await restoreBackup(this.root, path.join(this.workDir, `${id}.backup`));
    const reverted = await this.changes.report(id, { state: 'reverted', passed: false, summary: `undone: ${files.join(', ')}` });
    const restarting = Boolean(this.restart?.());
    this.note(`Change ${id} undone: ${files.join(', ')} restored.${restarting ? ' The app restarts.' : ' Restart the app to load it: node src/frl.mjs restart'}`);
    return reverted;
  }
}
