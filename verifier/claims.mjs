const STOP = new Set('that this with from have been were their there which about around more less than also only very cost costs price prices year years month months'.split(' '));
const ENGLISH = new Set(['the', 'and', 'of', 'to', 'is', 'are', 'for', 'with', 'in', 'on']);
const FOREIGN = new Set(['de', 'la', 'el', 'que', 'und', 'der', 'die', 'je', 'na', 'se', 've', 'pro', 'da', 'em', 'os', 'bir', 'ile', 'od', 'za', 'del', 'los', 'para']);
const THOUSANDS = /(?<!\d)\d{1,3}(?:[ .,  ]\d{3})+(?!\d)/g;

const plain = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const joinThousands = (text) => text.replace(THOUSANDS, (m) => m.replace(/[ .,  ]/g, ''));

const SOURCE_ID = /\b[SDUQ]\d+(?:\.\d+)*\b/g;
const MEASURED = /^\s*(?:km|kms|kilometers?|kilometres?|mi|miles?|nm|m|meters?|metres?|cm|mm|ft|feet|square\s*(?:meters?|metres?|m|feet|ft)|sq\s*m|sqm|m2|ha|hectares?)(?![a-z])/i;

const withoutIds = (text) => String(text ?? '').replace(SOURCE_ID, ' ');

export function normalize(text) {
  return joinThousands(plain(text)).replace(/[^a-z0-9%€$£]+/g, ' ').trim();
}

export function numbers(text) {
  const joined = joinThousands(withoutIds(text).replace(/[  ]/g, ' ')).replace(/(\d),(\d)/g, '$1.$2');
  const out = [];
  for (const m of joined.matchAll(/\d+(?:\.\d+)?/g)) {
    const raw = m[0];
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (/^\d{4}$/.test(raw) && n >= 1900 && n <= 2099 && !MEASURED.test(joined.slice(m.index + raw.length))) continue;
    out.push(n);
  }
  return out;
}

export function terms(text) {
  const out = new Set();
  for (const word of normalize(withoutIds(text)).split(' ')) {
    if (!/^[a-z]{4,}$/.test(word) || STOP.has(word)) continue;
    out.add(word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word);
  }
  return out;
}

export function looksEnglish(text) {
  const words = String(text ?? '').toLowerCase().split(/[^a-z]+/);
  const english = words.filter((w) => ENGLISH.has(w)).length;
  return english >= 2 || (!words.some((w) => FOREIGN.has(w)) && !/[À-ɏ]/.test(String(text ?? '')));
}

export function claimsToCheck(project) {
  const out = [];
  for (const node of project?.nodes ?? []) {
    const urls = new Map((node.sources ?? []).map((s) => [s.id, s.url]));
    for (const claim of node.finding?.claims ?? []) {
      if (claim?.assumption === true || typeof claim?.quote !== 'string' || !claim.quote || !/\d/.test(withoutIds(claim?.text ?? ''))) continue;
      const cited = (claim.sourceIds ?? []).map((id) => urls.get(id)).filter(Boolean);
      if (!cited.length) continue;
      out.push({ nodeId: node.id, text: claim.text, quote: claim.quote, urls: cited });
    }
  }
  return out;
}

export function judgeClaim({ text, quote }, pageTexts = []) {
  const pages = (Array.isArray(pageTexts) ? pageTexts : []).filter((p) => typeof p === 'string' && p);
  const wanted = normalize(quote);
  const normalized = pages.map(normalize);
  if (normalized.length && !normalized.some((p) => p.includes(wanted))) return { status: 'refuted', detail: 'quote not on the cited page' };
  if (!normalized.length) return { status: 'unconfirmed', detail: 'cited page could not be read' };
  const quoteNumbers = numbers(quote);
  for (const n of numbers(text)) if (!quoteNumbers.includes(n)) return { status: 'refuted', detail: `number ${n} not in the quote` };
  if (looksEnglish(quote)) {
    const found = normalized.find((p) => p.includes(wanted)) ?? '';
    const at = found.indexOf(wanted);
    const context = normalize(found.slice(Math.max(0, at - 240), at + wanted.length + 240));
    const contextTerms = terms(context);
    const claimTerms = [...terms(text)];
    const missing = claimTerms.filter((t) => !contextTerms.has(t));
    if (missing.length * 2 > claimTerms.length) return { status: 'refuted', detail: `quote is about something else: missing ${missing.slice(0, 3).join(', ')}` };
  }
  if (!looksEnglish(quote)) return { status: 'confirmed', detail: 'quote and numbers found; meaning not compared (not English)' };
  return { status: 'confirmed', detail: 'quote, numbers and key terms found' };
}
