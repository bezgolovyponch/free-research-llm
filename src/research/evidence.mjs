import { tokens } from '../search/search.mjs';

export const EVIDENCE_CHARS = 2200;
export const PASSAGE_CHARS = 320;
export const MIN_PASSAGE_CHARS = 40;
const K1 = 1.2;
const B = 0.75;

export function passages(text, size = PASSAGE_CHARS) {
  const out = [];
  let current = '';
  for (const piece of String(text ?? '').split(/(?<=[.!?])\s+|\n+/)) {
    const part = piece.trim();
    if (!part) continue;
    current = current ? `${current} ${part}` : part;
    if (current.length < MIN_PASSAGE_CHARS) continue;
    for (let i = 0; i < current.length; i += size) out.push(current.slice(i, i + size));
    current = '';
  }
  if (current) out.push(current);
  return out;
}

export function bm25(docs, query) {
  const terms = [...new Set(tokens(query))];
  const bags = docs.map((d) => tokens(d));
  const avg = bags.reduce((n, b) => n + b.length, 0) / Math.max(1, bags.length) || 1;
  const df = new Map(terms.map((t) => [t, bags.filter((b) => b.includes(t)).length]));
  return bags.map((bag) => {
    const tf = new Map();
    for (const w of bag) if (df.has(w)) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (bags.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * bag.length) / avg)));
    }
    return score;
  });
}

export function selectEvidence(sources, query, budget = EVIDENCE_CHARS) {
  const chunks = sources.map((s) => passages(s.text || s.snippet || ''));
  const flat = chunks.flatMap((list, si) => list.map((text, pi) => ({ si, pi, text })));
  const scores = bm25(flat.map((c) => c.text), query);
  flat.forEach((c, i) => { c.score = scores[i]; });
  return sources.map((source, si) => {
    const mine = flat.filter((c) => c.si === si);
    const relevance = mine.reduce((best, c) => Math.max(best, c.score), 0);
    if (source.kind === 'data' || !mine.length) return { ...source, relevance };
    const chosen = [];
    let used = 0;
    for (const c of [...mine].sort((a, b) => b.score - a.score || a.pi - b.pi)) {
      if (c.score <= 0 && chosen.length) break;
      if (used + c.text.length > budget && chosen.length) continue;
      chosen.push(c);
      used += c.text.length + 3;
    }
    const evidence = chosen.sort((a, b) => a.pi - b.pi).map((c) => c.text).join(' … ');
    return { ...source, relevance, evidence };
  });
}

export function evidenceQuery(node, brief = null) {
  return [node.title, node.question, node.metric, ...(brief?.kind?.terms ?? []).slice(0, 4)].filter(Boolean).join(' ');
}

export function retrievalVerdict(ranked) {
  const web = ranked.filter((s) => s.kind !== 'data' && s.url);
  const useful = web.filter((s) => s.relevance > 0);
  if (!web.length) return 'none';
  if (useful.length >= 2) return 'correct';
  return useful.length ? 'ambiguous' : 'incorrect';
}

export function diverseOrder(ranked) {
  const data = ranked.filter((s) => s.kind === 'data');
  const groups = new Map();
  for (const s of ranked.filter((x) => x.kind !== 'data').sort((a, b) => b.relevance - a.relevance)) {
    const key = s.domain || s.url || s.id;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const order = [];
  for (let round = 0; order.length < ranked.length - data.length; round++) for (const list of groups.values()) if (list[round]) order.push(list[round]);
  return [...data, ...order];
}
