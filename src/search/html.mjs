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
