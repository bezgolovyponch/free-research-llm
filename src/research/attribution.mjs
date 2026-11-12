export const MIN_ATTRIBUTED_SHARE = 0.6;
export const QUOTE_MIN_CHARS = 12;
export const QUOTE_MAX_WORDS = 40;

export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(\d)[\s,.'’](?=\d{3}\b)/g, '$1')
    .replace(/[^a-z0-9%€$£]+/g, ' ')
    .trim();
}

export function numbersIn(text) {
  const plain = String(text ?? '').replace(/(\d)[\s,.'’](?=\d{3}\b)/g, '$1');
  return [...plain.matchAll(/(?<![A-Za-z\d.])\d+(?:[.,]\d+)?/g)].map((m) => m[0].replace(',', '.')).filter((n) => !/^(?:19|20)\d{2}$/.test(n));
}

export function quoteFound(quote, sources, ids) {
  const wanted = normalizeText(quote);
  if (wanted.length < QUOTE_MIN_CHARS || wanted.split(' ').length > QUOTE_MAX_WORDS) return false;
  return sources.filter((s) => !ids.length || ids.includes(s.id)).some((s) => normalizeText(`${s.text ?? ''} ${s.snippet ?? ''} ${s.title ?? ''}`).includes(wanted));
}

export function attributeClaims(claims = [], sources = []) {
  return claims.map((c) => {
    if (c.assumption) return { ...c, attributed: null };
    const found = Boolean(c.quote) && quoteFound(c.quote, sources, c.sourceIds ?? []);
    const quoted = new Set(numbersIn(c.quote));
    const numbersHeld = numbersIn(c.text).every((n) => quoted.has(n));
    return { ...c, attributed: found && numbersHeld, ...(found && !numbersHeld ? { attributionNote: 'the quote does not contain the claim\'s number' } : {}) };
  });
}

export function attributionSummary(claims = []) {
  const factual = claims.filter((c) => !c.assumption);
  const attributed = factual.filter((c) => c.attributed);
  const numeric = factual.filter((c) => numbersIn(c.text).length);
  const numericMissing = numeric.filter((c) => !c.attributed);
  const share = factual.length ? attributed.length / factual.length : 0;
  return { factual: factual.length, attributed: attributed.length, share, numericMissing, passed: factual.length > 0 && share >= MIN_ATTRIBUTED_SHARE && numericMissing.length === 0 };
}

function stripDatesAndOrdinals(text) {
  return String(text ?? '')
    .replace(/^\s*\d+\.\s*/gm, '')
    .replace(/\(\s*\d+\s*\)/g, '')
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\b/gi, '')
    .replace(/\b\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/gi, '')
    .replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/gi, '')
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, '');
}

export function ungroundedNumbers(finding, node = {}) {
  const allowed = new Set([
    ...(finding.claims ?? []).flatMap((c) => numbersIn(`${c.text} ${c.value ?? ''}`)),
    ...numbersIn(JSON.stringify(finding.calculation ?? {})),
    ...numbersIn(node.question ?? ''),
    ...numbersIn(node.title ?? ''),
    ...numbersIn(node.metric ?? ''),
  ]);
  const cleanedAnswer = stripDatesAndOrdinals(finding.answer);
  return [...new Set(numbersIn(cleanedAnswer).filter((n) => !allowed.has(n)))];
}
