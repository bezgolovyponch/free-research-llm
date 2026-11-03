import * as cheerio from 'cheerio';
import { headlinePrice, looksLikeListing, parseAmounts } from '../research/acceptance.mjs';
import { absoluteUrl } from './html.mjs';

export const SCHEMA_SAMPLE_CHARS = 12000;
export const MIN_SCHEMA_ITEMS = 3;
const FIELD_NAME = /^[a-z][a-z0-9 _-]{0,30}$/i;
const NUMBER_WITH_UNIT = /^[+-]?\d[\d.,\s]*\s*[^\d\s]{0,6}$/;

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function numberIn(text) {
  const digits = String(text).replace(/(\d)[\s.,](?=\d{3}(?!\d))/g, '$1').match(/-?\d+(?:[.,]\d+)?/);
  if (!digits) return null;
  const n = Number(digits[0].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function fieldValue($, element, field) {
  const node = field.selector ? $(element).find(field.selector).first() : $(element);
  if (!node.length) return '';
  if (field.type === 'attribute') return collapse(node.attr(field.attribute || 'href') ?? '');
  node.find('br').replaceWith(' ');
  return collapse(node.text());
}

export function validSchema(schema) {
  if (!schema || typeof schema.baseSelector !== 'string' || !schema.baseSelector.trim() || !Array.isArray(schema.fields)) return false;
  const names = schema.fields.map((f) => f?.name);
  return names.includes('url') && names.includes('title') && schema.fields.every((f) => f && FIELD_NAME.test(String(f.name ?? '')) && typeof (f.selector ?? '') === 'string');
}

export function applySchema(html, base, schema) {
  if (!validSchema(schema)) return [];
  let $;
  try {
    $ = cheerio.load(String(html ?? ''));
  } catch {
    return [];
  }
  const items = [];
  const seen = new Set();
  let elements;
  try {
    elements = $(schema.baseSelector).toArray();
  } catch {
    return [];
  }
  for (const element of elements) {
    const values = {};
    try {
      for (const field of schema.fields) values[field.name] = fieldValue($, element, field);
    } catch {
      continue;
    }
    const url = values.url ? absoluteUrl(values.url, base) : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const price = values.price ? headlinePrice(parseAmounts(values.price)) : null;
    const attrs = {};
    for (const [name, value] of Object.entries(values)) {
      if (['url', 'title', 'price', 'place'].includes(name) || !value) continue;
      attrs[name] = value.slice(0, 160);
      if (NUMBER_WITH_UNIT.test(value)) {
        const n = numberIn(value);
        if (n !== null) attrs[`${name}#n`] = n;
      }
    }
    items.push({ title: values.title || url, url, value: price?.value ?? null, unit: price?.currency ?? '', place: values.place ?? '', ...(Object.keys(attrs).length ? { attrs } : {}), via: ['schema'] });
  }
  return items;
}

export function schemaSample(html, base, maxChars = SCHEMA_SAMPLE_CHARS) {
  const cleaned = String(html ?? '')
    .replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s([a-z-:]+)="[^"]{81,}"/gi, '')
    .replace(/\s{2,}/g, ' ');
  let start = 0;
  for (const m of cleaned.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    const url = absoluteUrl(m[1], base);
    if (url && looksLikeListing(url)) {
      start = Math.max(0, m.index - 300);
      break;
    }
  }
  return cleaned.slice(start, start + maxChars);
}

export function schemaPrompt({ host, kind = '', sample }) {
  return [
    { role: 'system', content: 'You write CSS selectors that extract listings from one website. Answer with JSON only.' },
    { role: 'user', content: `Website: ${host}. Items listed: ${kind || 'items for sale'}.
Below is a sample of one listing page's HTML. Return {"baseSelector": "...", "fields": [{"name": "...", "selector": "...", "type": "text" | "attribute", "attribute": "href"}]}.
- baseSelector matches exactly one element per listing.
- Field selectors are relative to that element; use "" for the element itself.
- Required fields: "url" (type attribute, attribute href, the link to the single listing page), "title", "price" (the price text with its currency), and "place" when the card shows where the item is.
- Add every other per-listing fact the card shows (year, mileage, power, fuel, size, rooms, date, condition and similar) with short English names.
- CSS only, no XPath, no :contains.

HTML sample:
${sample}` },
  ];
}

export function verifySchema(items, genericItems = [], { minItems = MIN_SCHEMA_ITEMS } = {}) {
  const list = items ?? [];
  const generic = genericItems ?? [];
  const share = (rows, test) => (rows.length ? rows.filter(test).length / rows.length : 0);
  const priced = list.filter((i) => i.value !== null && i.value !== undefined).length;
  const placed = list.filter((i) => String(i.place ?? '').trim()).length;
  const withFacts = list.filter((i) => i.attrs && Object.keys(i.attrs).length).length;
  const result = (ok, reason) => ({ ok, reason, items: list, priced, placed, facts: withFacts });
  if (list.length < minItems) return result(false, `found ${list.length} listing(s), fewer than ${minItems}`);
  if (list.length < 0.8 * generic.length) return result(false, `found ${list.length} listing(s), the generic reader found ${generic.length}`);
  if (share(list, (i) => looksLikeListing(i.url)) < 0.8) return result(false, 'most links are not single listing pages');
  if (priced / list.length < 0.7) return result(false, `only ${priced} of ${list.length} listing(s) have a price`);
  const genericPriced = generic.filter((i) => i.value !== null && i.value !== undefined).length;
  const genericPlaced = generic.filter((i) => String(i.place ?? '').trim()).length;
  const adds = priced > genericPriced || (placed / list.length >= 0.5 && genericPlaced === 0) || withFacts / list.length >= 0.5;
  if (!adds) return result(false, 'adds nothing the generic reader did not already find');
  return result(true, 'verified on the page');
}
