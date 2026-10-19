export const FULL_FILE_CHARS = 24000;
const WINDOW_CHARS = 1500;
const EXCERPT_CHARS = 14000;
const STOP_WORDS = new Set(['that', 'this', 'with', 'from', 'should', 'also', 'show', 'shows', 'when', 'which', 'have', 'into', 'every', 'each', 'there', 'their', 'then', 'than', 'only', 'must', 'test', 'tests', 'check', 'add', 'make', 'running', 'output', 'desired', 'request', 'change', 'text', 'number', 'many']);

export function ticketTerms(ticket) {
  const text = [ticket.title, ticket.request, ticket.desired, ticket.area, ...(ticket.tests ?? [])].join(' ');
  const quoted = [...text.matchAll(/["“`']([^"”`']{4,60})["”`']/g)].map((m) => m[1].replace(/\s*\(.*$/, '').trim()).filter((q) => q.length >= 4);
  const words = (text.match(/[A-Za-z][A-Za-z0-9_&-]{3,}/g) ?? []).filter((w) => !STOP_WORDS.has(w.toLowerCase()));
  return [...new Set([...quoted, ...words])].slice(0, 40);
}

function lineOf(body, at) {
  let n = 1;
  for (let i = body.indexOf('\n'); i >= 0 && i < at; i = body.indexOf('\n', i + 1)) n++;
  return n;
}

export function excerpt(body, terms, { window = WINDOW_CHARS, max = EXCERPT_CHARS } = {}) {
  const lower = body.toLowerCase();
  const hits = [];
  terms.forEach((term, rank) => {
    const t = term.toLowerCase();
    const weight = term.includes(' ') ? 6 : term.length > 8 ? 3 : 1;
    for (let at = lower.indexOf(t), n = 0; at >= 0 && n < 6; at = lower.indexOf(t, at + t.length), n++) hits.push({ at, weight: weight / (1 + rank / 20) });
  });
  const windows = [];
  for (const hit of hits) {
    const start = Math.max(0, hit.at - window / 2);
    const end = Math.min(body.length, hit.at + window / 2);
    const near = windows.find((w) => start <= w.end && end >= w.start);
    if (near) {
      near.start = Math.min(near.start, start);
      near.end = Math.max(near.end, end);
      near.score += hit.weight;
    } else windows.push({ start, end, score: hit.weight });
  }
  const chosen = [];
  let used = 0;
  for (const w of windows.sort((a, b) => b.score - a.score)) {
    if (used + (w.end - w.start) > max) continue;
    chosen.push(w);
    used += w.end - w.start;
  }
  if (!chosen.length) return body.slice(0, Math.min(max, window * 2));
  return chosen
    .sort((a, b) => a.start - b.start)
    .map((w) => `--- excerpt from line ${lineOf(body, w.start)} ---\n${body.slice(w.start, w.end)}`)
    .join('\n');
}

export function fileView(file, body, terms) {
  if (body == null) return { file, text: '(file does not exist yet)', partial: false };
  if (body.length <= FULL_FILE_CHARS) return { file, text: body, partial: false };
  return { file, text: `(EXCERPTS of a ${body.length}-character file; edit it only with search/replace, never "content")\n${excerpt(body, terms)}`, partial: true };
}

export const REPO_MAP = `public/index.html is the whole web UI (HTML, CSS and JavaScript in one file: tabs, panels, chats, Gates & logs).
src/server.mjs: HTTP routes. src/app.mjs: composition. src/appchat.mjs: App chat. src/research/*: research engine, gates, loop (improve.mjs), score.mjs, specs.mjs, chat.mjs, prompts.mjs.
src/llm/*: free-model router. src/search/*: search and marketplaces. tests/** mirrors src/** (Vitest). e2e/*.spec.ts: Playwright on a demo server.`;

export function rankFiles(entries, terms, limit = 4) {
  const scored = entries.map(({ file, body }) => {
    const lower = String(body ?? '').toLowerCase();
    let score = 0;
    for (const term of terms) {
      const t = term.toLowerCase();
      if (!lower.includes(t)) continue;
      score += term.includes(' ') ? 10 : term.length > 8 ? 2 : 0.5;
    }
    return { file, score };
  });
  return scored.filter((s) => s.score >= 2).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, limit).map((s) => s.file);
}
