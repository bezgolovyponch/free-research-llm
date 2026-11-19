import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startedDirectly } from './tool-entry.mjs';

const KEPT_HEADERS = ['content-type', 'retry-after'];

const urlOf = (input) => (typeof input === 'string' ? input : (input?.url ?? String(input)));
const bare = (url) => url.replace(/\?.*$/, '');

export function tapeKey(url, body) {
  const raw = String(body ?? '');
  let normal = raw;
  try {
    normal = JSON.stringify(JSON.parse(raw));
  } catch {
    normal = raw;
  }
  return crypto.createHash('sha256').update(`${bare(url)}\n${normal}`).digest('hex');
}

const fileIn = (dir, key) => path.join(dir, key.slice(0, 2), `${key}.json`);

async function readAnswer(dirs, key) {
  for (const dir of dirs) {
    try {
      return JSON.parse(await fs.readFile(fileIn(dir, key), 'utf8'));
    } catch {
      continue;
    }
  }
  return null;
}

const replayOf = (answer) => new Response(answer.body, { status: answer.status, headers: answer.headers });

export function createAnswerTape({ dir, mode = 'auto', bases = [], fetchImpl = globalThis.fetch } = {}) {
  const stats = { hits: 0, misses: 0, recorded: 0, blocked: 0 };
  const dirs = [...bases, dir];

  async function tapeFetch(input, init) {
    const url = urlOf(input);
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    const taped = method === 'POST' && typeof init?.body === 'string';
    if (!taped) {
      if (mode === 'replay') {
        stats.blocked++;
        throw new Error(`network off in replay: ${method} ${bare(url)}`);
      }
      return fetchImpl(input, init);
    }
    const key = tapeKey(url, init.body);
    if (mode !== 'record') {
      const hit = await readAnswer(dirs, key);
      if (hit) {
        stats.hits++;
        return replayOf(hit);
      }
      stats.misses++;
      if (mode === 'replay') {
        stats.blocked++;
        throw new Error(`not on tape: ${key} ${bare(url)}`);
      }
    }
    const response = await fetchImpl(input, init);
    const body = await response.text();
    const headers = {};
    for (const name of KEPT_HEADERS) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    const file = fileIn(dir, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ url: bare(url), status: response.status, headers, body }));
    stats.recorded++;
    return replayOf({ body, status: response.status, headers });
  }

  return { fetch: tapeFetch, stats };
}

export async function tapeSummary(dir) {
  const statuses = {};
  let answers = 0;
  for (const sub of await fs.readdir(dir).catch(() => [])) {
    for (const name of await fs.readdir(path.join(dir, sub)).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const { status } = JSON.parse(await fs.readFile(path.join(dir, sub, name), 'utf8'));
      statuses[status] = (statuses[status] ?? 0) + 1;
      answers++;
    }
  }
  return { answers, statuses };
}

if (startedDirectly(import.meta.url)) {
  const [command, dir] = process.argv.slice(2);
  if (command !== 'stats' || !dir) {
    console.error('usage: node scripts/answer-tape.mjs stats <dir>');
    process.exit(2);
  }
  console.log(JSON.stringify(await tapeSummary(dir)));
}
