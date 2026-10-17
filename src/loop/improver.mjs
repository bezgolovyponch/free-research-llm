import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { PatchSet } from './patch.mjs';
import { scoreProject, summarizeIssues } from './score.mjs';

const run = promisify(execFile);

export const IMPROVABLE_FILES = ['src/research/prompts.mjs', 'src/research/templates.mjs'];

export function improvePrompt({ target, score, file, content }) {
  return [
    { role: 'system', content: 'You improve a research app by proposing one small, safe source edit. You reply with a single JSON object only.' },
    {
      role: 'user',
      content: `The app decomposes a question into sub-questions, researches each with web/Wikipedia sources, and grades every answer with mechanical checks.

TARGET QUESTION: ${target.question}
LAST RUN SCORE: ${score.score} (verified ${score.counts.verified}, supported ${score.counts.supported}, weak ${score.counts.weak}, unsupported ${score.counts.unsupported}, failed ${score.counts.failed}) verdict: ${score.verdict || 'none'}
NODES THAT FAILED CHECKS:
${summarizeIssues(score) || '- none'}

FILE YOU MAY EDIT: ${file}
\`\`\`js
${content}
\`\`\`

Pick the ONE change most likely to raise the share of verified/supported answers for this kind of question (better search queries, clearer research instructions, a sharper domain checklist). Rules:
- edit only text inside string/template literals (instructions, checklists, examples); never rename functions, exports, ids, TASK= markers or JSON field names
- "find" must be an exact, unique substring of the file (copy it verbatim, at least 20 characters); "replace" is its new text
- at most 2 edits, each under 600 characters

JSON shape: {"rationale":"one sentence","edits":[{"file":"${file}","find":"","replace":""}]}`,
    },
  ];
}

export class SelfImprover {
  constructor({ root, router, targets, log = console.log, push = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), exec = run }) {
    this.root = root;
    this.router = router;
    this.targets = targets;
    this.log = log;
    this.push = push;
    this.sleep = sleep;
    this.exec = exec;
    this.statePath = path.join(root, 'loop', 'state.json');
    this.historyPath = path.join(root, 'loop', 'history.jsonl');
  }

  async loadState() {
    try {
      return JSON.parse(await fs.readFile(this.statePath, 'utf8'));
    } catch {
      return { iteration: 0, best: {} };
    }
  }

  async saveState(state) {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2));
  }

  async record(entry) {
    await fs.mkdir(path.dirname(this.historyPath), { recursive: true });
    await fs.appendFile(this.historyPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    this.log(`[loop] ${entry.event}${entry.target ? ` ${entry.target}` : ''}${entry.score !== undefined ? ` score=${entry.score}` : ''}${entry.detail ? ` — ${entry.detail}` : ''}`);
  }

  async research(target) {
    const args = ['src/cli.mjs', target.question, '--template', target.template ?? 'auto'];
    for (const [k, v] of Object.entries(target.constraints ?? {})) args.push('--set', `${k}=${v}`);
    const env = { ...process.env, FRL_PAID_CALL_LIMIT: '0' };
    const { stdout } = await this.exec('node', args, { cwd: this.root, env, maxBuffer: 32 * 1024 * 1024, timeout: 3 * 60 * 60 * 1000 }).catch((error) => ({ stdout: String(error.stdout ?? '') }));
    const id = stdout.match(/^project: (\S+)/m)?.[1];
    if (!id) throw new Error(`research produced no project: ${stdout.slice(-300)}`);
    const project = JSON.parse(await fs.readFile(path.join(this.root, 'data', 'projects', `${id}.json`), 'utf8'));
    return { project, score: scoreProject(project) };
  }

  async testsPass() {
    try {
      await this.exec('npx', ['vitest', 'run'], { cwd: this.root, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
      return true;
    } catch {
      return false;
    }
  }

  async commit(message) {
    await this.exec('git', ['add', ...IMPROVABLE_FILES], { cwd: this.root });
    await this.exec('git', ['commit', '-q', '-m', `${message}\n\nAutomated by the free-model self-improvement loop.`], { cwd: this.root });
    if (this.push) await this.exec('git', ['push', '-q', 'origin', 'HEAD'], { cwd: this.root }).catch(() => {});
  }

  async iterate() {
    const state = await this.loadState();
    const target = this.targets[state.iteration % this.targets.length];
    const key = target.id;
    state.iteration++;
    await this.saveState(state);

    if (state.best[key] === undefined) {
      const baseline = await this.research(target);
      state.best[key] = { score: baseline.score.score, project: baseline.project.id, issues: baseline.score.issues.length };
      await this.saveState(state);
      await this.record({ event: 'baseline', target: key, score: baseline.score.score, detail: `${baseline.score.counts.verified + baseline.score.counts.supported}/${baseline.score.total} good · ${baseline.score.verdict}` });
      this.lastScore = { ...this.lastScore, [key]: baseline.score };
      return;
    }

    const lastScore = this.lastScore?.[key] ?? (await this.research(target)).score;
    const file = IMPROVABLE_FILES[state.iteration % IMPROVABLE_FILES.length];
    const content = await fs.readFile(path.join(this.root, file), 'utf8');
    const reply = await this.router.complete({ purpose: 'self-improve', tier: 'deep', messages: improvePrompt({ target, score: lastScore, file, content }) });
    const proposal = reply.data ?? {};
    const patch = new PatchSet({ root: this.root, allowlist: IMPROVABLE_FILES });
    try {
      await patch.apply(proposal.edits);
    } catch (error) {
      await patch.revert();
      await this.record({ event: 'proposal-rejected', target: key, detail: error.message });
      return;
    }
    if (!(await this.testsPass())) {
      await patch.revert();
      await this.record({ event: 'tests-failed-reverted', target: key, detail: proposal.rationale });
      return;
    }
    const trial = await this.research(target);
    const best = state.best[key].score;
    if (trial.score.score >= best) {
      await this.commit(`loop: ${String(proposal.rationale ?? 'improve research prompts').slice(0, 72)} (${key} ${best} -> ${trial.score.score})`);
      state.best[key] = { score: trial.score.score, project: trial.project.id, issues: trial.score.issues.length };
      await this.saveState(state);
      await this.record({ event: 'kept', target: key, score: trial.score.score, detail: `${best} -> ${trial.score.score}: ${proposal.rationale}` });
    } else {
      await patch.revert();
      await this.record({ event: 'reverted-worse', target: key, score: trial.score.score, detail: `${trial.score.score} < ${best}: ${proposal.rationale}` });
    }
    this.lastScore = { ...this.lastScore, [key]: trial.score };
  }

  async runForever({ pauseMs = 60000, quotaPauseMs = 15 * 60000, maxIterations = Infinity } = {}) {
    for (let i = 0; i < maxIterations; i++) {
      try {
        await this.iterate();
        await this.sleep(pauseMs);
      } catch (error) {
        const quota = /cooling down|rate|quota|429|402/i.test(error.message);
        await this.record({ event: quota ? 'quota-pause' : 'error', detail: error.message.slice(0, 300) });
        await this.sleep(quota ? quotaPauseMs : pauseMs);
      }
    }
  }
}
