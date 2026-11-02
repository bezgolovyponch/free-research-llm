const STOP = new Set('that this with from have been were their there which about around more less than also only very cost costs price prices year years month months'.split(' '));
const ENGLISH = new Set(['the', 'and', 'of', 'to', 'is', 'are', 'for', 'with', 'in', 'on']);
const FOREIGN = new Set(['de', 'la', 'el', 'que', 'und', 'der', 'die', 'je', 'na', 'se', 've', 'pro', 'da', 'em', 'os', 'bir', 'ile', 'od', 'za', 'del', 'los', 'para']);
const THOUSANDS = /(?<!\d)\d{1,3}(?:[ .,  ]\d{3})+(?!\d)/g;

const plain = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const joinThousands = (text) => text.replace(THOUSANDS, (m) => m.replace(/[ .,  ]/g, ''));

export function normalize(text) {
  return joinThousands(plain(text)).replace(/[^a-z0-9%€$£]+/g, ' ').trim();
}

export function numbers(text) {
  const joined = joinThousands(String(text ?? '').replace(/[  ]/g, ' ')).replace(/(\d),(\d)/g, '$1.$2');
  const out = [];
  for (const m of joined.matchAll(/\d+(?:\.\d+)?/g)) {
    const raw = m[0];
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (/^\d{4}$/.test(raw) && n >= 1900 && n <= 2099) continue;
    out.push(n);
  }
  return out;
}

export function terms(text) {
  const out = new Set();
  for (const word of normalize(text).split(' ')) {
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
      if (claim?.assumption === true || typeof claim?.quote !== 'string' || !claim.quote || !/\d/.test(String(claim?.text ?? ''))) continue;
      out.push({ nodeId: node.id, text: claim.text, quote: claim.quote, urls: (claim.sourceIds ?? []).map((id) => urls.get(id)).filter(Boolean) });
    }
  }
  return out;
}

export function judgeClaim({ text, quote }, pageTexts = []) {
  const pages = (Array.isArray(pageTexts) ? pageTexts : []).filter((p) => typeof p === 'string' && p);
  const wanted = normalize(quote);
  if (pages.length && !pages.some((p) => normalize(p).includes(wanted))) return { status: 'refuted', detail: 'quote not on the cited page' };
  if (!pages.length) return { status: 'unconfirmed', detail: 'cited page could not be read' };
  const quoteNumbers = numbers(quote);
  for (const n of numbers(text)) if (!quoteNumbers.includes(n)) return { status: 'refuted', detail: `number ${n} not in the quote` };
  if (looksEnglish(quote)) {
    const quoteTerms = terms(quote);
    const claimTerms = [...terms(text)];
    const missing = claimTerms.filter((t) => !quoteTerms.has(t));
    if (missing.length * 2 > claimTerms.length) return { status: 'refuted', detail: `quote is about something else: missing ${missing.slice(0, 3).join(', ')}` };
  }
  if (!looksEnglish(quote)) return { status: 'confirmed', detail: 'quote and numbers found; meaning not compared (not English)' };
  return { status: 'confirmed', detail: 'quote, numbers and key terms found' };
}
