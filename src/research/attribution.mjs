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
  const assumedOnly = claims.length > 0 && factual.length === 0;
  const share = factual.length ? attributed.length / factual.length : assumedOnly ? 0 : 1;
  return { factual: factual.length, attributed: attributed.length, share, numericMissing, assumedOnly, passed: share >= MIN_ATTRIBUTED_SHARE && numericMissing.length === 0 };
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
  const answer = process.env.FRL_NUMBERS_OUTSIDE_URLS ? String(finding.answer ?? '').replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ') : finding.answer;
  const cleanedAnswer = stripDatesAndOrdinals(answer);
  return [...new Set(numbersIn(cleanedAnswer).filter((n) => !allowed.has(n)))];
}

const withoutUrls = (text) => String(text ?? '').replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
const figuresOf = (text) => numbersIn(withoutUrls(text)).filter((n) => Number(n) !== 0);
const claimNumbers = (claim) => numbersIn(`${claim?.text ?? ''} ${claim?.value ?? ''}`);

export function assumedFigures(nodes = [], asked = '') {
  const list = nodes ?? [];
  const askedNumbers = new Set(numbersIn(asked));
  const assumed = new Map();
  const visit = (node, path) => {
    if (assumed.has(node.id)) return assumed.get(node.id);
    if (path.has(node.id)) return [];
    const below = new Map(list.filter((child) => child.parentId === node.id).map((child) => [child.id, visit(child, new Set([...path, node.id]))]));
    const origins = new Map();
    const leaning = new Set();
    for (const claim of node.finding?.claims ?? []) {
      if (claim.assumption) {
        leaning.add(claim);
        for (const figure of claimNumbers(claim)) if (!origins.has(figure)) origins.set(figure, node.id);
        continue;
      }
      for (const id of claim.sourceIds ?? []) {
        for (const item of below.get(id) ?? []) {
          if (!numbersIn(claim.text).includes(item.figure)) continue;
          leaning.add(claim);
          if (!origins.has(item.figure)) origins.set(item.figure, item.from);
        }
      }
    }
    const sourced = new Set((node.finding?.claims ?? []).filter((claim) => !leaning.has(claim) && claim.attributed === true).flatMap((claim) => numbersIn(claim.text)));
    const figures = [...new Set(figuresOf(node.finding?.answer))].filter((figure) => origins.has(figure) && !sourced.has(figure) && !askedNumbers.has(figure)).map((figure) => ({ figure, from: origins.get(figure) }));
    assumed.set(node.id, figures);
    return figures;
  };
  for (const node of list) visit(node, new Set());
  return assumed;
}

export function assumedInText(text, assumed, nodes = [], asked = '') {
  const list = nodes ?? [];
  const leaves = list.filter((node) => !list.some((child) => child.parentId === node.id));
  const sourced = new Set(leaves.flatMap((node) => (node.finding?.claims ?? []).filter((claim) => !claim.assumption && claim.attributed === true).flatMap((claim) => numbersIn(claim.text))));
  const askedNumbers = new Set(numbersIn(asked));
  const from = new Map();
  for (const items of assumed?.values?.() ?? []) for (const item of items) if (!from.has(item.figure)) from.set(item.figure, item.from);
  return [...new Set(figuresOf(text))].filter((figure) => from.has(figure) && !sourced.has(figure) && !askedNumbers.has(figure)).map((figure) => ({ figure, from: from.get(figure) }));
}

export function shownFigure(figure) {
  const value = Number(figure);
  return Number.isInteger(value) && Math.abs(value) >= 1000 ? value.toLocaleString('en-US') : String(figure);
}

export function assumedNote(flagged = []) {
  return flagged.length ? ` — ${flagged.map((item) => `${shownFigure(item.figure)} rests on an assumption (${item.from}): no source read states it`).join('; ')}` : '';
}
