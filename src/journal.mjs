import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const ROW_FACTS = Object.freeze(['title', 'url', 'price', 'currency', 'area', 'areaUnit', 'place', 'country', 'countryCode', 'countryBy', 'coast', 'attrs', 'sourceUrl', 'nodeId', 'via', 'year', 'km', 'kw', 'engine', 'fuel']);

function hash(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

export function researched(node) {
  return Boolean(node?.finding) || (node?.sources?.length ?? 0) > 0 || (node?.listings?.length ?? 0) > 0 || (node?.attachments?.length ?? 0) > 0;
}

export function rowFactsKey(row) {
  const facts = {};
  for (const field of ROW_FACTS) if (row?.[field] !== undefined) facts[field] = row[field];
  return hash(JSON.stringify(facts));
}

function keyOf(row, index, seen) {
  const base = typeof row?.url === 'string' && row.url ? row.url : `#${index}`;
  let key = base;
  for (let n = 2; seen.has(key); n++) key = `${base}#${n}`;
  seen.add(key);
  return key;
}

export function keptRows(project) {
  return Array.isArray(project?.candidates?.kept) ? project.candidates.kept : [];
}

export function shadowOf(project) {
  const nodes = new Map();
  for (const node of project?.nodes ?? []) {
    if (!node || typeof node.id !== 'string' || nodes.has(node.id)) continue;
    nodes.set(node.id, { json: JSON.stringify(node), researched: researched(node) });
  }
  const rows = new Map();
  const seen = new Set();
  keptRows(project).forEach((row, index) => rows.set(keyOf(row, index, seen), { json: JSON.stringify(row), facts: rowFactsKey(row) }));
  return { nodes, rows, sweep: hash(JSON.stringify(project?.sweep ?? null)), nodeCount: (project?.nodes ?? []).length, rowCount: keptRows(project).length };
}

export function emptyShadow() {
  return { nodes: new Map(), rows: new Map(), sweep: hash('null'), nodeCount: 0, rowCount: 0 };
}

export function listingUrlsOf(project) {
  const urls = new Set();
  const add = (list) => {
    for (const item of Array.isArray(list) ? list : []) if (typeof item?.url === 'string') urls.add(item.url);
  };
  add(project?.candidates?.kept);
  add(project?.candidates?.toCheck);
  add(project?.candidates?.outside);
  for (const page of project?.sweep?.pages ?? []) add(page?.listings);
  for (const node of project?.nodes ?? []) {
    add(node?.listings);
    add(node?.finding?.items);
    add(node?.finding?.rejected);
    for (const source of node?.sources ?? []) add(source?.listings);
  }
  return urls;
}

export function diffProject(previous, project) {
  const next = shadowOf(project);
  const nodes = { before: previous.nodeCount, after: next.nodeCount, removed: [], replaced: [], added: [] };
  let index = 0;
  for (const [id, old] of previous.nodes) {
    const fresh = next.nodes.get(id);
    if (!fresh) nodes.removed.push({ index, id, node: JSON.parse(old.json) });
    else if (fresh.json !== old.json) nodes.replaced.push({ index, id, node: JSON.parse(old.json) });
    index += 1;
  }
  for (const id of next.nodes.keys()) if (!previous.nodes.has(id)) nodes.added.push(id);
  const stillHeld = listingUrlsOf(project);
  const rows = { before: previous.rowCount, after: next.rowCount, removed: [], moved: [], replaced: [], added: [] };
  index = 0;
  for (const [key, old] of previous.rows) {
    const fresh = next.rows.get(key);
    const url = key.replace(/#\d+$/, '');
    if (!fresh) {
      if (stillHeld.has(url)) rows.moved.push({ index, url });
      else rows.removed.push({ index, url, row: JSON.parse(old.json) });
    } else if (fresh.facts !== old.facts) rows.replaced.push({ index, url, row: JSON.parse(old.json) });
    index += 1;
  }
  for (const key of next.rows.keys()) if (!previous.rows.has(key)) rows.added.push(key.replace(/#\d+$/, ''));
  return { nodes, rows, sweepChanged: next.sweep !== previous.sweep, next };
}

export function lostPieces(diff) {
  return diff.nodes.removed.filter((entry) => researched(entry.node)).map((entry) => entry.id);
}

export function journalEntry({ id, reason, userAction, diff, snapshot = null, ts = new Date().toISOString() }) {
  return {
    ts,
    id,
    reason,
    userAction,
    nodes: { before: diff.nodes.before, after: diff.nodes.after, removed: diff.nodes.removed, replaced: diff.nodes.replaced, added: diff.nodes.added },
    rows: { before: diff.rows.before, after: diff.rows.after, removed: diff.rows.removed, moved: diff.rows.moved, replaced: diff.rows.replaced, added: diff.rows.added },
    snapshot,
  };
}

function insertAt(list, index, item) {
  list.splice(Math.min(Math.max(0, index), list.length), 0, item);
}

export function undoEntry(project, entry) {
  const counts = { nodes: { restored: 0, reverted: 0, dropped: 0 }, rows: { restored: 0, reverted: 0, dropped: 0 } };
  project.nodes = Array.isArray(project.nodes) ? project.nodes : [];
  const added = new Set(entry.nodes?.added ?? []);
  if (added.size) {
    const before = project.nodes.length;
    project.nodes = project.nodes.filter((n) => !added.has(n.id));
    counts.nodes.dropped = before - project.nodes.length;
  }
  for (const { index, id, node } of entry.nodes?.replaced ?? []) {
    const at = project.nodes.findIndex((n) => n.id === id);
    if (at >= 0) project.nodes[at] = node;
    else insertAt(project.nodes, index, node);
    counts.nodes.reverted += 1;
  }
  for (const { index, id, node } of entry.nodes?.removed ?? []) {
    if (project.nodes.some((n) => n.id === id)) continue;
    insertAt(project.nodes, index, node);
    counts.nodes.restored += 1;
  }
  const hasRows = Boolean(project.candidates) || (entry.rows?.removed ?? []).length || (entry.rows?.replaced ?? []).length;
  if (!hasRows) return counts;
  project.candidates = project.candidates ?? {};
  const kept = Array.isArray(project.candidates.kept) ? project.candidates.kept : [];
  const addedRows = new Set(entry.rows?.added ?? []);
  const remaining = addedRows.size ? kept.filter((row) => !addedRows.has(row.url)) : kept;
  counts.rows.dropped = kept.length - remaining.length;
  for (const { index, url, row } of entry.rows?.replaced ?? []) {
    const at = remaining.findIndex((r) => r.url === url);
    if (at >= 0) remaining[at] = row;
    else insertAt(remaining, index, row);
    counts.rows.reverted += 1;
  }
  for (const { index, url, row } of entry.rows?.removed ?? []) {
    if (remaining.some((r) => r.url === url)) continue;
    insertAt(remaining, index, row);
    counts.rows.restored += 1;
  }
  project.candidates.kept = remaining;
  return counts;
}

export function replayJournal(project, entries, { before } = {}) {
  const cutoff = before ? String(before) : '';
  const undone = entries.filter((entry) => entry?.ts && (!cutoff || entry.ts >= cutoff)).reverse();
  const totals = { entries: undone.length, nodes: { restored: 0, reverted: 0, dropped: 0 }, rows: { restored: 0, reverted: 0, dropped: 0 } };
  for (const entry of undone) {
    const counts = undoEntry(project, entry);
    for (const part of ['nodes', 'rows']) for (const key of Object.keys(counts[part])) totals[part][key] += counts[part][key];
  }
  return totals;
}

export class ProjectJournal {
  constructor({ dir }) {
    this.dir = dir;
  }

  file(id) {
    return path.join(this.dir, `${id}.jsonl`);
  }

  async append(id, entry) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(this.file(id), `${JSON.stringify(entry)}\n`);
  }

  async read(id) {
    let text;
    try {
      text = await fs.readFile(this.file(id), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const entries = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return entries;
  }

  async summary(id) {
    const entries = await this.read(id);
    const removals = entries.filter((e) => (e.nodes?.removed ?? []).length || (e.rows?.removed ?? []).length);
    return { entries: entries.length, first: entries[0]?.ts ?? null, last: entries.at(-1)?.ts ?? null, removals: removals.map((e) => ({ ts: e.ts, reason: e.reason, userAction: e.userAction ?? null, nodes: (e.nodes?.removed ?? []).map((r) => r.id), rows: (e.rows?.removed ?? []).length })) };
  }
}
