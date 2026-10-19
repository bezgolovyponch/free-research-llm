import path from 'node:path';

export const EDITABLE_ROOTS = ['src/', 'tests/', 'e2e/', 'public/'];
export const EDITABLE_DOCS = /^[A-Za-z0-9_-]+\.md$/;
export const PROTECTED = [
  /^src\/coder\//,
  /^tests\/coder\//,
  /^src\/secrets\.mjs$/,
  /^src\/auth\.mjs$/,
  /^src\/terminal\//,
  /^scripts\//,
  /^\.githooks\//,
  /^package(-lock)?\.json$/,
  /^(vitest|playwright)\.config\./,
  /^AUDIT-PROTOCOL\.md$/,
];
const MAX_EDITS = 24;
const MAX_FILE_CHARS = 200000;

export class EditError extends Error {}

export function editablePath(file) {
  const rel = String(file ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel || rel.includes('\0') || path.posix.isAbsolute(rel) || path.posix.normalize(rel) !== rel || rel.split('/').includes('..')) return null;
  if (PROTECTED.some((p) => p.test(rel))) return null;
  return EDITABLE_ROOTS.some((r) => rel.startsWith(r)) || EDITABLE_DOCS.test(rel) ? rel : null;
}

export function normalizeEdits(raw) {
  const list = Array.isArray(raw?.edits) ? raw.edits : Array.isArray(raw) ? raw : [];
  const edits = [];
  const refused = [];
  for (const e of list.slice(0, MAX_EDITS)) {
    const file = editablePath(e?.file);
    if (!file) {
      refused.push(String(e?.file ?? '?'));
      continue;
    }
    if (typeof e.content === 'string') edits.push({ file, content: e.content.slice(0, MAX_FILE_CHARS) });
    else if (typeof e.search === 'string' && e.search.length && typeof e.replace === 'string') edits.push({ file, search: e.search, replace: e.replace });
    else refused.push(file);
  }
  return { edits, refused };
}

export function applyEdit(current, edit) {
  if ('content' in edit) return edit.content;
  if (current == null) throw new EditError(`${edit.file}: file does not exist, so a search/replace edit cannot apply (send "content" to create it)`);
  const at = current.indexOf(edit.search);
  if (at < 0) throw new EditError(`${edit.file}: the search text was not found exactly; copy it character for character from the file shown`);
  if (current.indexOf(edit.search, at + 1) >= 0) throw new EditError(`${edit.file}: the search text appears more than once; include more surrounding lines`);
  return current.slice(0, at) + edit.replace + current.slice(at + edit.search.length);
}

export function countTests(text) {
  return (String(text ?? '').match(/(^|[^\w.])(it|test)(\.each\([^)]*\))?\(\s*['"`]/gm) ?? []).length;
}
