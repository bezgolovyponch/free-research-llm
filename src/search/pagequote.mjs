import { decodeText } from './html.mjs';

const MIN_QUOTE_LENGTH = 3;
const TAG = /<[^<>]*>/g;

function flat(text) {
  return decodeText(text).replace(/\s+/g, ' ').trim();
}

export function pageChecker(body) {
  const source = String(body ?? '');
  const flatSource = flat(source);
  const flatSourceNoTags = flat(source.replace(TAG, ' '));
  return function checkQuote(quote) {
    const wanted = flat(quote);
    if (wanted.length < MIN_QUOTE_LENGTH) return false;
    return flatSource.includes(wanted) || flatSourceNoTags.includes(wanted);
  };
}

export function quoteOnPage(body, quote) {
  return pageChecker(body)(quote);
}