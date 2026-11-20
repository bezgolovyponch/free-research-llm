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
});

describe('pageChecker', () => {
  it('one checker answers several quotes of one page correctly (two present, one absent)', () => {
    const body = '<p>Price 12 EUR</p><p>Area 5 ha</p>';
    const check = pageChecker(body);
    expect(check('12 EUR')).toBe(true);
    expect(check('5 ha')).toBe(true);
    expect(check('10 EUR')).toBe(false);
  });

  it('HTML entity case: <p>Call &#43;31 85 130</p> contains +31 85 130', () => {
    const body = '<p>Call &#43;31 85 130</p>';
    const check = pageChecker(body);
    expect(check('+31 85 130')).toBe(true);
  });

  it('JSON escape case: a body {"telephone":"\\u002B33235078680"} contains +33235078680', () => {
    const body = '{"telephone":"\\u002B33235078680"}';
    const check = pageChecker(body);
    expect(check('+33235078680')).toBe(true);
  });

  it('quote split by a tag: <b>12</b> € contains 12 €', () => {
    const body = '<b>12</b> €';
    const check = pageChecker(body);
    expect(check('12 €')).toBe(true);
  });

  it('rejects empty quote', () => {
    const check = pageChecker('anything');
    expect(check('')).toBe(false);
  });

  it('rejects 2-character quote', () => {
    const check = pageChecker('anything');
    expect(check('an')).toBe(false);
  });

  it('rejects quote that differs only in letter case', () => {
    const body = 'Price 12 EUR';
    const check = pageChecker(body);
    expect(check('12 eur')).toBe(false);
  });

  it('rejects quote that is absent', () => {
    const body = '<p>Bale 12</p>';
    const check = pageChecker(body);
    expect(check('Bale 13')).toBe(false);
  });

  it('handles null body', () => {
    const check = pageChecker(null);
    expect(check('anything')).toBe(false);
  });

  it('a page of about 1.5 MB checked for 50 quotes through ONE checker finishes in under 3 seconds', () => {
    const largeBody = 'A '.repeat(750000);
    const check = pageChecker(largeBody);
    const quotes = Array.from({ length: 50 }, (_, i) => `Quote ${i}`);
    const start = performance.now();
    for (const q of quotes) {
      check(q);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });
});