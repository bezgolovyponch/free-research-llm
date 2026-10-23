import { ROOT_ID } from './tree.mjs';
import { asksForItems } from './deliverable.mjs';

export const CANDIDATES_TITLE = 'Candidate listings (identification)';

export const SIMILAR = 0.6;
export const MIN_CHILDREN = 2;
export const MAX_DRIVERS = 7;
export const MAX_DEPTH = 3;
const STOP = new Set('the a an and or of in on for to with by from at as is are was what which how many much does do each per its their this that into within eur 2024 2025 2026 2027 identify find list'.split(' '));
const ID_PREFIX = /^\s*(?:Q|D\d+(?:\.\d+)*)\s*[:·.\-–—]\s*/i;

export function stem(word) {
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('es') && !w.endsWith('ses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('al')) w = w.slice(0, -2);
  return w;
}

export function words(text) {
  return new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9äöüßáčďéěíňóřšťúůýžñçãõ]+/i).filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
}

export function similarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return (2 * both) / (x.size + y.size);
}

export function entities(text, context = text) {
  const lower = new Set(String(context ?? '').split(/[^\p{L}\p{N}]+/u).filter((t) => t && /^\p{Ll}/u.test(t)).map((t) => stem(t.toLowerCase())));
  const out = new Set();
  for (const t of String(text ?? '').split(/[^\p{L}\p{N}]+/u)) {
    if (t.length < 2 || !/^\p{Lu}/u.test(t)) continue;
    const key = stem(t.toLowerCase());
    if (!lower.has(key) && !STOP.has(key)) out.add(key);
  }
  return out;
}

export function sameSubject(a, b) {
  const both = `${a} ${b}`;
  const x = entities(a, both);
  const y = entities(b, both);
  const onlyX = [...x].some((e) => !y.has(e));
  const onlyY = [...y].some((e) => !x.has(e));
  return !(onlyX && onlyY);
}

export function alike(a, b, threshold = SIMILAR) {
  return similarity(a, b) >= threshold && sameSubject(a, b);
}

const textOf = (n) => `${String(n.title ?? '').replace(ID_PREFIX, '')} ${n.question ?? ''}`;

export function cleanTitle(title) {
  return String(title ?? '').replace(ID_PREFIX, '').trim();
}

function ancestry(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const up = (id) => {
    const out = new Set();
    for (let c = byId.get(byId.get(id)?.parentId); c; c = byId.get(c.parentId)) out.add(c.id);
    return out;
  };
  return { byId, up };
}

export function depthOf(nodes, node) {
  const { byId } = ancestry(nodes);
  let d = 0;
  for (let c = node; c && c.parentId !== ROOT_ID; c = byId.get(c.parentId)) d++;
  return d + 1;
}

export function restates(text, question) {
  const x = words(text);
  const q = words(question);
  if (!x.size || !q.size) return false;
  const both = [...x].filter((w) => q.has(w)).length;
  return both / q.size >= 0.4 && both / x.size >= 0.6;
}

export function duplicateOf(candidate, nodes, question = '') {
  if (question && candidate.parentId === ROOT_ID && restates(textOf(candidate), question)) return ROOT_ID;
  const peers = nodes.filter((n) => n.id !== candidate.id && n.parentId === candidate.parentId);
  return peers.find((n) => alike(textOf(candidate), textOf(n)))?.id ?? null;
}

export function duplicateAmong(candidate, peers) {
  return peers.find((n) => n.id !== candidate.id && alike(textOf(candidate), textOf(n)))?.id ?? null;
}

const PLACEHOLDER_TITLE = /^(?:Q|D\d+(?:\.\d+)*|[A-Z]|\d+[a-z]?|[-–—\s]*)$/i;
const TITLE_WORDS = 8;

export function titleFromQuestion(question) {
  const plain = String(question ?? '').replace(/[?.!]+$/, '').replace(/^(?:what|which|how many|how much|how|where|when|is|are|do|does|can)\s+(?:is|are|the|do|does)?\s*/i, '');
  const text = plain.split(/\s+/).filter(Boolean).slice(0, TITLE_WORDS).join(' ');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

export function mergeDuplicateDrivers(nodes, question = '') {
  const fixes = [];
  const drivers = nodes.filter((n) => n.parentId === ROOT_ID);
  const hasKids = (id) => nodes.some((m) => m.parentId === id);
  const canonical = new Map();
  for (const d of drivers) {
    const twin = duplicateOf(d, drivers.filter((m) => m.id !== d.id && !canonical.has(m.id) && drivers.indexOf(m) < drivers.indexOf(d)), question);
    if (!twin || twin === ROOT_ID) continue;
    canonical.set(d.id, canonical.get(twin) ?? twin);
  }
  for (const [id, target] of canonical) {
    const host = nodes.find((n) => n.id === target);
    if (!host || (!hasKids(host.id) && (host.finding?.items ?? []).length)) continue;
    const node = nodes.find((n) => n.id === id);
    node.parentId = host.id;
    if (!hasKids(host.id) || host.status !== 'pending') Object.assign(host, { status: 'pending', finding: null, verification: null, critique: null, error: null });
    fixes.push({ code: 'merged-duplicate', nodeId: id, detail: `${id} duplicated ${host.id}; moved under it with its findings` });
  }
  return fixes;
}

export function groupCandidateDrivers(nodes) {
  const drivers = nodes.filter((n) => n.parentId === ROOT_ID);
  if (drivers.length <= MAX_DRIVERS) return [];
  const kids = (id) => nodes.filter((n) => n.parentId === id);
  const identifies = (d) => asksForItems(d) || /\b(?:identify|candidates?|find)\b/i.test(`${d.title ?? ''} ${d.question ?? ''}`);
  const listingKids = (d) => kids(d.id).filter(asksForItems).length;
  const host = drivers.filter(identifies).sort((a, b) => listingKids(b) - listingKids(a) || drivers.indexOf(a) - drivers.indexOf(b))[0];
  if (!host) return [];
  const moving = drivers.filter((d) => d.id !== host.id && asksForItems(d));
  if (!moving.length) return [];
  for (const d of moving) d.parentId = host.id;
  Object.assign(host, { title: CANDIDATES_TITLE, status: 'pending', finding: null, verification: null, critique: null, error: null });
  return [{ code: 'grouped-candidates', nodeId: host.id, detail: `${moving.map((d) => d.id).join(', ')} search for listings; moved under ${host.id} "${CANDIDATES_TITLE}" (funnel: identify → screen → include)` }];
}

export function repairTree(nodes, question = '') {
  const fixes = [];
  fixes.push(...mergeDuplicateDrivers(nodes, question));
  fixes.push(...groupCandidateDrivers(nodes));
  const { up } = ancestry(nodes);
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const title = cleanTitle(n.title);
    if (title && title !== n.title) {
      fixes.push({ code: 'id-in-title', nodeId: n.id, detail: `"${n.title}" → "${title}"` });
      n.title = title;
    }
    if (PLACEHOLDER_TITLE.test(cleanTitle(n.title)) && n.id !== ROOT_ID) {
      const named = titleFromQuestion(n.question);
      if (named) {
        fixes.push({ code: 'placeholder-title', nodeId: n.id, detail: `"${n.title ?? ''}" → "${named}"` });
        n.title = named;
      }
    }
    const ancestors = up(n.id);
    const below = new Set(nodes.filter((m) => up(m.id).has(n.id)).map((m) => m.id));
    const deps = (n.dependsOn ?? []).filter((d) => d !== n.id && ids.has(d) && !ancestors.has(d) && !below.has(d));
    if (deps.length !== (n.dependsOn ?? []).length) {
      fixes.push({ code: 'dependency-on-own-branch', nodeId: n.id, detail: `removed ${(n.dependsOn ?? []).filter((d) => !deps.includes(d)).join(', ')}` });
      n.dependsOn = deps;
    }
  }
  return fixes;
}

export function auditTree(nodes, question = '') {
  const issues = [];
  const kids = (id) => nodes.filter((n) => n.parentId === id);
  const drivers = kids(ROOT_ID);
  if (drivers.length > MAX_DRIVERS) issues.push({ code: 'too-many-drivers', nodeId: ROOT_ID, detail: `${drivers.length} top-level drivers (max ${MAX_DRIVERS})` });
  for (const n of nodes) {
    const children = kids(n.id);
    if (children.length === 1) issues.push({ code: 'single-child', nodeId: n.id, detail: `${n.id} has one sub-question (${children[0].id}); a split needs at least ${MIN_CHILDREN}` });
    if (depthOf(nodes, n) > MAX_DEPTH) issues.push({ code: 'too-deep', nodeId: n.id, detail: `${n.id} is ${depthOf(nodes, n)} levels deep (max ${MAX_DEPTH})` });
    if (ID_PREFIX.test(n.title ?? '')) issues.push({ code: 'id-in-title', nodeId: n.id, detail: `title starts with an id: "${n.title}"` });
    const dup = duplicateOf(n, nodes.filter((m) => m.id < n.id || m.parentId !== n.parentId), question);
    if (dup === ROOT_ID) issues.push({ code: 'restates-question', nodeId: n.id, detail: `${n.id} restates the whole question instead of one driver of it` });
    else if (dup) issues.push({ code: 'duplicate', nodeId: n.id, detail: `${n.id} duplicates or overlaps ${dup}` });
    if (n.parentId !== ROOT_ID) {
      const parent = nodes.find((m) => m.id === n.parentId);
      const own = parent ? similarity(textOf(n), textOf(parent)) : 0;
      const healthy = drivers.filter((d) => d.id !== n.parentId && !n.id.startsWith(`${d.id}.`) && !duplicateOf(d, nodes.filter((m) => m.id < d.id || m.parentId !== d.parentId), question));
      const better = healthy.map((d) => ({ id: d.id, s: similarity(textOf(n), textOf(d)) })).sort((a, b) => b.s - a.s)[0];
      if (better && better.s >= SIMILAR && better.s > own + 0.25) issues.push({ code: 'misplaced', nodeId: n.id, detail: `${n.id} fits under ${better.id} better than under ${n.parentId}` });
    }
    const { up } = ancestry(nodes);
    const bad = (n.dependsOn ?? []).filter((d) => up(n.id).has(d) || nodes.some((m) => m.id === d && up(m.id).has(n.id)));
    if (bad.length) issues.push({ code: 'dependency-on-own-branch', nodeId: n.id, detail: `${n.id} depends on its own branch (${bad.join(', ')})` });
  }
  return issues;
}

export const BLOCKING = new Set(['duplicate', 'restates-question', 'too-many-drivers']);

export function auditFeedback(issues) {
  return issues.length ? `The tree failed these structural checks; fix every one:\n${issues.map((i) => `- ${i.code}: ${i.detail}`).join('\n')}` : '';
}
