import { plain } from './itemgate.mjs';

export function quoteFound(text, quote) {
  return plain(String(text ?? '').replace(/\s+/g, ' ')).includes(plain(String(quote ?? '').replace(/\s+/g, ' ')));
}