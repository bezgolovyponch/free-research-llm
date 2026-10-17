export class JsonExtractError extends Error {}

function stripFences(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1] : text;
}

function balancedObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function withoutTrailingCommas(text) {
  return text.replace(/,\s*([}\]])/g, '$1');
}

export function closeTruncatedJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const stack = [];
  let inString = false;
  let escaped = false;
  let lastSafe = -1;
  let lastSafeStack = [];
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (!stack.length) return text.slice(start, i + 1);
      lastSafe = i;
      lastSafeStack = [...stack];
    } else if (ch === ',' && (stack.length === 1 || stack[stack.length - 1] === ']')) {
      lastSafe = i - 1;
      lastSafeStack = [...stack];
    }
  }
  if (lastSafe < 0) return null;
  return text.slice(start, lastSafe + 1) + lastSafeStack.reverse().join('');
}

export function extractJson(text) {
  if (text && typeof text === 'object') return text;
  const raw = String(text ?? '').trim();
  const candidates = [raw, stripFences(raw), balancedObject(stripFences(raw)), balancedObject(raw)].filter(Boolean);
  for (const candidate of candidates) {
    for (const attempt of [candidate, withoutTrailingCommas(candidate)]) {
      try {
        const parsed = JSON.parse(attempt);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        continue;
      }
    }
  }
  const closed = closeTruncatedJson(stripFences(raw));
  if (closed) {
    try {
      const parsed = JSON.parse(withoutTrailingCommas(closed));
      if (parsed && typeof parsed === 'object') return Object.assign(parsed, { _truncated: true });
    } catch {
      return failExtract(raw);
    }
  }
  return failExtract(raw);
}

function failExtract(raw) {
  throw new JsonExtractError(`model reply is not valid JSON: ${raw.slice(0, 160)}`);
}
