export const METHODS = ['lookup', 'calculation', 'comparison', 'estimate', 'data'];
export const MAX_NODES = 30;
export const ROOT_ID = 'Q';

function clampScore(value, fallback = 3) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : fallback;
}

function text(value, max = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function list(value, max = 6) {
  return (Array.isArray(value) ? value : value ? [value] : []).map((v) => text(v, 200)).filter(Boolean).slice(0, max);
}

export function listingSpec(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const countries = list(raw.countries, 4).map((c) => c.toUpperCase().slice(0, 2)).filter((c) => /^[A-Z]{2}$/.test(c));
  const minEur = Number(raw.minEur);
  const maxEur = Number(raw.maxEur);
  const spec = { countries, make: text(raw.make, 40), model: text(raw.model, 40), minEur: Number.isFinite(minEur) ? minEur : 0, maxEur: Number.isFinite(maxEur) && maxEur > 0 ? maxEur : 1000000 };
  return spec.make || spec.model || countries.length ? spec : null;
}

export function urlList(value, max = 4) {
  return list(value, max * 2).filter((u) => /^https?:\/\/[^\s]+\.[^\s]+/.test(u)).slice(0, max);
}

function safeId(value, index) {
  const id = text(value, 24).replace(/[^A-Za-z0-9._-]/g, '');
  return id && id !== ROOT_ID ? id : `N${index + 1}`;
}

export function blankNode(fields) {
  return {
    id: '',
    parentId: ROOT_ID,
    title: '',
    question: '',
    why: '',
    hypothesis: '',
    metric: '',
    unit: '',
    method: 'lookup',
    searchQueries: [],
    sourceUrls: [],
    listings: null,
    instructions: '',
    dependsOn: [],
    impact: 3,
    uncertainty: 3,
    status: 'pending',
    attempts: 0,
    finding: null,
    verification: null,
    critique: null,
    sources: [],
    ...fields,
  };
}

function dropCycles(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map();
  const visit = (node) => {
    state.set(node.id, 'visiting');
    node.dependsOn = node.dependsOn.filter((dep) => {
      const target = byId.get(dep);
      if (!target || dep === node.id) return false;
      if (state.get(dep) === 'visiting') return false;
      if (!state.has(dep)) visit(target);
      return true;
    });
    state.set(node.id, 'done');
  };
  for (const node of nodes) if (!state.has(node.id)) visit(node);
}

function fixParents(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    let cursor = node.parentId;
    const seen = new Set([node.id]);
    while (cursor && cursor !== ROOT_ID) {
      if (seen.has(cursor) || !byId.has(cursor)) {
        node.parentId = ROOT_ID;
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor).parentId;
    }
    if (!node.parentId) node.parentId = ROOT_ID;
  }
}

export function normalizeTree(raw, question) {
  const input = Array.isArray(raw?.nodes) ? raw.nodes.slice(0, MAX_NODES) : [];
  const seen = new Set();
  const nodes = [];
  input.forEach((item, index) => {
    let id = safeId(item?.id, index);
    while (seen.has(id)) id = `${id}_${index}`;
    seen.add(id);
    nodes.push(blankNode({
      id,
      parentId: item?.parentId ? text(item.parentId, 24) : ROOT_ID,
      title: text(item?.title, 90) || text(item?.question, 90) || id,
      question: text(item?.question, 400) || text(item?.title, 400),
      why: text(item?.why, 300),
      hypothesis: text(item?.hypothesis, 300),
      metric: text(item?.metric, 120),
      unit: text(item?.unit, 40),
      method: METHODS.includes(item?.method) ? item.method : 'lookup',
      searchQueries: list(item?.searchQueries, 3),
      sourceUrls: urlList(item?.sourceUrls),
      listings: listingSpec(item?.listings),
      dependsOn: list(item?.dependsOn, 6),
      impact: clampScore(item?.impact),
      uncertainty: clampScore(item?.uncertainty),
    }));
  });
  fixParents(nodes);
  dropCycles(nodes);
  return {
    decision: text(raw?.decision, 400) || text(question, 400),
    successCriteria: text(raw?.successCriteria, 400),
    assumptionsToConfirm: list(raw?.assumptionsToConfirm, 8),
    nodes,
  };
}

export function childrenOf(nodes, id) {
  return nodes.filter((n) => n.parentId === id);
}

export function isLeaf(nodes, node) {
  return !nodes.some((n) => n.parentId === node.id);
}

export function priority(node) {
  return node.impact * node.uncertainty;
}

export function depthOf(nodes, node) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let depth = 1;
  let cursor = node;
  while (cursor && cursor.parentId && cursor.parentId !== ROOT_ID && depth < 20) {
    cursor = byId.get(cursor.parentId);
    depth++;
  }
  return depth;
}

export function prerequisitesOf(nodes, node) {
  return [...new Set([...childrenOf(nodes, node.id).map((c) => c.id), ...node.dependsOn])];
}

export function researchOrder(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const done = new Set();
  const order = [];
  const remaining = new Set(nodes.map((n) => n.id));
  while (remaining.size) {
    const ready = [...remaining]
      .map((id) => byId.get(id))
      .filter((n) => prerequisitesOf(nodes, n).every((p) => done.has(p) || !byId.has(p)));
    const batch = ready.length ? ready : [byId.get([...remaining][0])];
    batch.sort((a, b) => priority(b) - priority(a) || a.id.localeCompare(b.id));
    for (const n of batch) {
      order.push(n.id);
      done.add(n.id);
      remaining.delete(n.id);
    }
  }
  return order;
}

export function nextNodeId(nodes, parentId) {
  const base = parentId === ROOT_ID ? 'D' : `${parentId}.`;
  let i = 1;
  while (nodes.some((n) => n.id === `${base}${i}`)) i++;
  return `${base}${i}`;
}

export function progress(nodes) {
  const total = nodes.length;
  const finished = nodes.filter((n) => ['verified', 'supported', 'weak', 'unsupported', 'failed'].includes(n.status)).length;
  const verified = nodes.filter((n) => ['verified', 'supported'].includes(n.status)).length;
  return { total, finished, verified };
}
