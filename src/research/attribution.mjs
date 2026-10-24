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
  const share = factual.length ? attributed.length / factual.length : 1;
  return { factual: factual.length, attributed: attributed.length, share, numericMissing, passed: share >= MIN_ATTRIBUTED_SHARE && numericMissing.length === 0 };
}

export function ungroundedNumbers(finding, node = {}) {
  const allowed = new Set([
    ...(finding.claims ?? []).flatMap((c) => numbersIn(`${c.text} ${c.value ?? ''}`)),
    ...numbersIn(JSON.stringify(finding.calculation ?? {})),
    ...numbersIn(node.question ?? ''),
  ]);
  return [...new Set(numbersIn(finding.answer).filter((n) => !allowed.has(n) && Number(n) > 12))];
}
