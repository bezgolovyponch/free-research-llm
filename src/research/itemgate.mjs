import { currencyOf, looksLikeListing } from './acceptance.mjs';
import { toNumber } from './calc.mjs';

const MAX_REJECTED = 20;
const SEARCH_TITLE = /\b(?:search|results|listings)\b/i;
const SWAP = /(?:\btrade\b|\bswap\b|\btroca\b|\bpermuta|\btakas\b|\bechange\b)/i;
const RENTAL = /(?:arrend|alug|alquil|kiralik|for[ -]rent|to[ -]rent|\brent(?:al|ing)?\b|a[ -]louer|\blouer\b|\bverhuur|\bmiete|pron[aá]j[eé]m|pronajm|\bn[aá]jem\b|\bwynaj[eę]m)/i;
const WANTED = /(?:\bkoup[ií]m\b|\bhled[aá]m\b|\bpopt[aá]v[aá]m\b|\bkupi[eę]\b|\bszukam\b|\bwanted\b|\blooking for\b)/i;

function priceOf(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    return toNumber(value);
  } catch {
    return null;
  }
}

export function plain(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function decodedUrl(url) {
  const text = String(url ?? '').replace(/[+_-]/g, ' ');
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function hasTerm(text, term) {
  return new RegExp(`(?:^|[^a-z])${plain(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:e?s)?(?![a-z])`).test(text);
}

export function isKind(item, kind) {
  if (!kind?.terms?.length) return true;
  const text = plain(`${item.title} ${decodedUrl(item.url)}`);
  return kind.terms.some((term) => hasTerm(text, term)) && !(kind.not ?? []).some((term) => hasTerm(text, term));
}

export function screenItem(item, { valueRange = null, unit = '', convert = (v) => v, kind = null, kindKnown = false } = {}) {
  const reasons = [];
  if (!looksLikeListing(item.url) || SEARCH_TITLE.test(item.title ?? '')) reasons.push('not a single listing page');
  if (!kindKnown && !isKind(item, kind)) reasons.push(`not a ${kind.label}`);
  const offer = `${item.title ?? ''} ${decodedUrl(item.url)}`;
  if (kind && RENTAL.test(offer)) reasons.push('offered for rent, not for sale');
  if (kind && SWAP.test(offer)) reasons.push('offered as a swap, not for sale');
  if (kind && WANTED.test(offer)) reasons.push('a wanted ad, not an offer');
  const raw = priceOf(item.value);
  if (valueRange && raw !== null) {
    const wanted = currencyOf(unit);
    const from = currencyOf(item.unit) || wanted;
    const value = wanted && from && from !== wanted ? convert(raw, from, wanted) : raw;
    if (value === null || value < valueRange[0] || value > valueRange[1]) reasons.push(`price ${raw} ${item.unit || unit} is outside ${valueRange[0]}–${valueRange[1]} ${unit}`.trim());
  }
  return { ok: reasons.length === 0, reasons, priced: raw !== null };
}

export function screenItems(items = [], options = {}) {
  const kept = [];
  const rejected = [];
  for (const item of items) {
    const verdict = screenItem(item, options);
    if (verdict.ok) kept.push(verdict.priced ? item : { ...item, toCheck: 'price not given; read from the page' });
    else rejected.push({ ...item, reasons: verdict.reasons });
  }
  return { kept, rejected: rejected.slice(0, MAX_REJECTED) };
}
