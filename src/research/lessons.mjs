import fs from 'node:fs/promises';
import { similarChange } from './playbook.mjs';

export const LESSONS_KEPT = 2000;
export const PRINCIPLE_MIN_TESTS = 3;
export const PRINCIPLE_KEEP_RATE = 0.5;
export const PRINCIPLE_SIMILARITY = 0.5;
const TESTED = new Set(['kept', 'reverted-whole', 'reverted-piece', 'reverted-regression', 'no-gain', 'reverted-noise']);

export function lessonsFromTrials(trials = [], { researchId, type = '' } = {}) {
  return trials
    .filter((t) => TESTED.has(t.outcome) && t.change)
    .map((t) => ({
      researchId,
      nodeId: t.nodeId,
      type: t.type || type,
      change: String(t.change).slice(0, 300),
      outcome: t.outcome,
      gain: Math.round((Number(t.score) - Number(t.before)) * 1000) / 1000 || 0,
      at: t.at,
    }));
}

export function principlesFrom(lessons = [], type = null) {
  const clusters = [];
  for (const l of lessons) {
    if (type && l.type !== type) continue;
    let c = clusters.find((x) => similarChange(x.change, l.change) >= PRINCIPLE_SIMILARITY);
    if (!c) clusters.push((c = { change: l.change, tests: 0, kept: 0, researches: new Set(), gains: [] }));
    c.tests++;
    if (l.outcome === 'kept') {
      c.kept++;
      c.gains.push(l.gain);
    }
    c.researches.add(l.researchId);
  }
  return clusters
    .filter((c) => c.tests >= PRINCIPLE_MIN_TESTS)
    .map((c) => {
      const rate = c.kept / c.tests;
      const meanGain = c.gains.length ? Math.round((c.gains.reduce((a, b) => a + b, 0) / c.gains.length) * 1000) / 1000 : 0;
      const verdict = rate >= PRINCIPLE_KEEP_RATE ? 'helps' : rate === 0 ? 'does not help' : 'mixed';
      return { change: c.change, verdict, tests: c.tests, kept: c.kept, researches: c.researches.size, meanGain, statement: `${c.change}: ${verdict} (kept ${c.kept} of ${c.tests} tests across ${c.researches.size} research${c.researches.size === 1 ? '' : 'es'}${c.kept ? `, mean gain ${meanGain}` : ''})` };
    })
    .sort((a, b) => b.kept / b.tests - a.kept / a.tests || b.tests - a.tests);
}

export class LessonBook {
  constructor({ file = '' } = {}) {
    this.file = file;
    this.lessons = [];
    this.loaded = !file;
    this.writing = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.lessons = Array.isArray(parsed?.lessons) ? parsed.lessons : [];
    } catch {
      this.lessons = [];
    }
    this.loaded = true;
    return this;
  }

  async add(entries = []) {
    await this.load();
    const seen = new Set(this.lessons.map((l) => `${l.researchId}|${l.nodeId}|${l.at}|${l.change}`));
    const fresh = entries.filter((l) => {
      const key = `${l.researchId}|${l.nodeId}|${l.at}|${l.change}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!fresh.length) return 0;
    this.lessons = [...this.lessons, ...fresh].slice(-LESSONS_KEPT);
    this.save();
    return fresh.length;
  }

  async forType(type, { excludeResearch = null } = {}) {
    await this.load();
    return this.lessons.filter((l) => l.type === type && l.researchId !== excludeResearch);
  }

  save() {
    if (this.file) this.writing = this.writing.then(() => fs.writeFile(this.file, JSON.stringify({ lessons: this.lessons }))).catch(() => {});
  }
}
