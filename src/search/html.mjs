export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export const TABLE_MAX_ROWS = 60;
export const TABLE_MAX_COLUMNS = 12;

function cellText(html) {
  return htmlToText(html).replace(/\s+/g, ' ').trim();
}

function rowsOf(table) {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => [...row[1].matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((cell) => cellText(cell[2])));
}

export function tableLines(table) {
  const rows = rowsOf(table);
  if (!rows.length || rows.length > TABLE_MAX_ROWS || rows.some((cells) => cells.length > TABLE_MAX_COLUMNS)) return null;
  const lines = [];
  let header = null;
  for (const cells of rows) {
    const filled = cells.filter(Boolean);
    if (filled.length <= 1) {
      if (filled.length) lines.push(filled[0]);
      header = null;
      continue;
    }
    if (!header) {
      header = cells;
      lines.push(filled.join(' | '));
      continue;
    }
    if (cells.length !== header.length) {
      lines.push(filled.join(' | '));
      continue;
    }
    const labelled = !header[0] && Boolean(cells[0]);
    const pairs = cells.map((cell, at) => (!cell || (labelled && at === 0) ? null : header[at] ? `${header[at]} ${cell}` : cell)).filter(Boolean);
    lines.push(labelled ? `${cells[0]}: ${pairs.join('; ')}` : pairs.join('; '));
  }
  return lines.join('\n');
}

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function withTableHeaders(html) {
  return String(html ?? '').replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (whole, inner) => {
    if (/<table\b/i.test(inner)) return whole;
    const lines = tableLines(inner);
    return lines === null ? whole : `<p>${lines.split('\n').map(escapeHtml).join('<br>')}</p>`;
  });
}

export function absoluteUrl(href, base) {
  try {
    const url = new URL(String(href).replace(/&amp;/g, '&'), base);
    if (!/^https?:$/.test(url.protocol)) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

const ESCAPE_PATTERN = /\\u([0-9a-fA-F]{4})|\\(["/])|&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));|&([a-zA-Z]+);/g;

const MAX_CODE_POINT = 0x10ffff;

function decodeEscape(match, unicodeHex, escaped, hexCode, decimalCode, name) {
  if (unicodeHex) return String.fromCharCode(parseInt(unicodeHex, 16));
  if (escaped) return escaped;
  const code = hexCode ? parseInt(hexCode, 16) : Number(decimalCode);
  if (decimalCode !== undefined || hexCode !== undefined) {
    return code <= MAX_CODE_POINT ? String.fromCodePoint(code) : match;
  }
  return NAMED_ENTITIES.get(name) ?? match;
}

export function decodeText(text) {
  return String(text ?? '').replace(ESCAPE_PATTERN, decodeEscape);
}
