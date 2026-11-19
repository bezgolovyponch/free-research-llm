export const MAX_SPAN_CHARS = 320;
export const MIN_SPAN_WORDS = 3;

export function sentenceSpans(text, { limit = 6000 } = {}) {
  const body = String(text ?? '').slice(0, limit);
  const parts = body.split(/(?<=[.!?])\s+|\n+/).map((part) => part.replace(/\s+/g, ' ').trim()).filter((part) => part.split(' ').length >= MIN_SPAN_WORDS);
  const spans = [];
  for (const part of parts) for (let at = 0; at < part.length; at += MAX_SPAN_CHARS) spans.push(part.slice(at, at + MAX_SPAN_CHARS));
  return spans.map((span, index) => ({ id: `S${index + 1}`, text: span }));
}

export function spansBlock(spans, maxChars = 6000) {
  const lines = [];
  let used = 0;
  for (const span of spans ?? []) {
    const line = `[${span.id}] ${span.text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

export function spanIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id ?? '').trim().replace(/^\[|\]$/g, '').toUpperCase()).filter(Boolean))];
}

export function quoteFromSpans(ids, spans) {
  const byId = new Map((spans ?? []).map((span) => [span.id.toUpperCase(), span.text]));
  const picked = spanIds(ids);
  if (!picked.length || picked.some((id) => !byId.has(id))) return '';
  return picked.map((id) => byId.get(id)).join(' ');
}

export function pickRanked(spans, ranked) {
  const chosen = new Set(ranked?.order ?? []);
  return (spans ?? []).filter((_, index) => chosen.has(index));
}

export async function pickSpans(spans, query, embedder, k = 8) {
  const list = spans ?? [];
  if (list.length <= k) return list;
  const ranked = embedder ? await embedder.rank(query, list.map((span) => span.text), k) : null;
  if (!ranked) return list.slice(0, k);
  const chosen = new Set(ranked.order);
  return list.filter((_, index) => chosen.has(index));
}
