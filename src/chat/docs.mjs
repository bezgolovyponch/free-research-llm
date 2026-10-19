import fs from 'node:fs/promises';
import path from 'node:path';
import { shellLines, urlsIn } from './reply-audit.mjs';

export const APP_DOCS = ['CONCEPT.md', 'GUIDE.md', 'WINDOWS.md', 'CLOUD.md', 'KEYS.md', 'FREE-ROUTING.md', 'PROTOCOLS.md', 'README.md'];
const SECTION_CHARS = 1800;
const STOP = new Set('the a an and or to of in on for is it this that how what with my me i you do can be are from at by as'.split(' '));

export function words(text) {
  return String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}.]+/gu, ' ').split(' ').map((w) => w.replace(/^\.+|\.+$/g, '')).filter((w) => w.length > 1 && !STOP.has(w));
}

export function splitSections(file, markdown) {
  const sections = [];
  let current = { file, heading: file, lines: [] };
  for (const line of String(markdown).split('\n')) {
    const heading = line.match(/^#{1,3}\s+(.*)/);
    if (heading && !current.inFence) {
      if (current.lines.join('').trim()) sections.push(current);
      current = { file, heading: heading[1].trim(), lines: [] };
      continue;
    }
    if (line.startsWith('```')) current.inFence = !current.inFence;
    current.lines.push(line);
  }
  if (current.lines.join('').trim()) sections.push(current);
  return sections.map(({ file: f, heading, lines }) => ({ file: f, heading, text: lines.join('\n').trim() }));
}

export class DocsIndex {
  constructor({ root, files = APP_DOCS, readFile = (p) => fs.readFile(p, 'utf8') }) {
    this.root = root;
    this.files = files;
    this.readFile = readFile;
    this.sections = [];
    this.loadedAt = 0;
  }

  async load({ maxAgeMs = 60000 } = {}) {
    if (this.sections.length && Date.now() - this.loadedAt < maxAgeMs) return this;
    const sections = [];
    for (const file of this.files) {
      try {
        sections.push(...splitSections(file, await this.readFile(path.join(this.root, file))));
      } catch {
        continue;
      }
    }
    const df = new Map();
    for (const s of sections) {
      s.terms = words(`${s.heading} ${s.heading} ${s.text}`);
      for (const t of new Set(s.terms)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    this.df = df;
    this.sections = sections;
    this.loadedAt = Date.now();
    return this;
  }

  search(query, limit = 4) {
    const wanted = [...new Set(words(query))];
    const n = this.sections.length || 1;
    return this.sections
      .map((s) => {
        const counts = new Map();
        for (const t of s.terms) counts.set(t, (counts.get(t) ?? 0) + 1);
        const score = wanted.reduce((sum, t) => sum + (counts.has(t) ? (1 + Math.log(counts.get(t))) * Math.log(1 + n / (this.df.get(t) ?? n)) : 0), 0);
        return { section: s, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ section }) => ({ file: section.file, heading: section.heading, text: section.text.slice(0, SECTION_CHARS) }));
  }

  urls() {
    return [...new Set(this.sections.flatMap((s) => urlsIn(s.text)))];
  }

  commands() {
    return [...new Set(this.sections.flatMap((s) => shellLines(s.text)))];
  }
}
