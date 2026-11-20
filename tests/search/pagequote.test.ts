import { describe, expect, it } from 'vitest';
import { quoteOnPage, pageChecker } from '../../src/search/pagequote.mjs';

describe('quoteOnPage', () => {
  it('finds a quote whose entities are decoded on the page', () => {
    expect(quoteOnPage('<p>Call &#43;31 85 130</p>', '+31 85 130')).toBe(true);
    expect(quoteOnPage('<p>Price &euro; 12</p>', '&euro; 12')).toBe(true);
  });

  it('finds a quote whose JSON escapes are decoded on the page', () => {
    expect(quoteOnPage('{"telephone":"+33235078680"}', '+33235078680')).toBe(true);
    expect(quoteOnPage('{"telephone":"\\u002B33235078680"}', '+33235078680')).toBe(true);
    expect(quoteOnPage('{"url":"https:\\/\\/x.example\\/a.jpg"}', 'https://x.example/a.jpg')).toBe(true);
  });

  it('finds a quote split by tags', () => {
    expect(quoteOnPage('<b>12</b> €', '12 €')).toBe(true);
    expect(quoteOnPage('<span>12</span><span>EUR</span>', '12 EUR')).toBe(true);
  });

  it('rejects an empty quote and a quote shorter than three characters', () => {
    expect(quoteOnPage('anything', '')).toBe(false);
    expect(quoteOnPage('anything', 'an')).toBe(false);
    expect(quoteOnPage('anything', '  a ')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(quoteOnPage('Price 12 EUR', '12 eur')).toBe(false);
  });

  it('is accent-sensitive', () => {
    expect(quoteOnPage('Pozemek Čechy', 'Pozemek Cechy')).toBe(false);
  });

  it('rejects a quote that is absent', () => {
    expect(quoteOnPage('<p>Bale 12</p>', 'Bale 13')).toBe(false);
  });

  it('handles null body', () => {
    expect(quoteOnPage(null, 'anything')).toBe(false);
  });

  it('does not decode an entity twice', () => {
    expect(quoteOnPage('<p>&amp;#43;31 85</p>', '+31 85')).toBe(false);
  });
});

describe('pageChecker', () => {
  it('one checker answers several quotes of one page correctly (two present, one absent)', () => {
    const body = '<p>Price 12 EUR</p><p>Area 5 ha</p>';
    const check = pageChecker(body);
    expect(check('12 EUR')).toBe(true);
    expect(check('5 ha')).toBe(true);
    expect(check('10 EUR')).toBe(false);
  });

  it('a page of about 1.5 MB with tags, entities and JSON escapes is built and checked for 50 quotes in under 3 seconds', () => {
    const filler = '<div class="row"><span>Item &amp; more &#43;1&nbsp;m</span> {"name":"caf\\u00e9"}</div>\n';
    const ending = Array.from(
      { length: 25 },
      (_, i) => `<li><b>Lot ${i}</b> &amp; price &#43;${i}&nbsp;EUR caf\\u00e9 ${i}</li>`,
    ).join('');
    const body = filler.repeat(Math.ceil(1500000 / filler.length)) + ending;
    const present = Array.from({ length: 25 }, (_, i) => `Lot ${i} & price +${i} EUR café ${i}`);
    const absent = Array.from({ length: 25 }, (_, i) => `Lot ${i + 100} & price +${i} EUR café ${i}`);
    const start = performance.now();
    const check = pageChecker(body);
    const found = present.map((quote) => check(quote));
    const missed = absent.map((quote) => check(quote));
    const elapsed = performance.now() - start;
    expect(body.length).toBeGreaterThan(1400000);
    expect(body.length).toBeLessThan(1600000);
    expect(found).toEqual(Array(25).fill(true));
    expect(missed).toEqual(Array(25).fill(false));
    expect(elapsed).toBeLessThan(3000);
  });

  it('a body of 1.5 million < characters with no > is built and checked for a 5-character quote in under 3 seconds', () => {
    const body = '<'.repeat(1500000);
    const start = performance.now();
    const found = pageChecker(body)('abcde');
    const elapsed = performance.now() - start;
    expect(found).toBe(false);
    expect(elapsed).toBeLessThan(3000);
  });
});
