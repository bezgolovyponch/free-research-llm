import { describe, expect, it } from 'vitest';
import { absoluteUrl, decodeText, domainOf } from '../../src/search/html.mjs';

describe('html helpers', () => {
  it('resolves links against the page, drops fragments and non-web schemes', () => {
    expect(absoluteUrl('/a?b=1&amp;c=2#x', 'https://site.example/p/q')).toBe('https://site.example/a?b=1&c=2');
    expect(absoluteUrl('mailto:x@site.example', 'https://site.example/')).toBe('');
    expect(domainOf('https://www.site.example/x')).toBe('site.example');
    expect(domainOf('not a url')).toBe('');
  });
});

describe('decodeText', () => {
  it('decodes JSON escapes: \\uXXXX, \\/ and \\"', () => {
    expect(decodeText('+33 2')).toBe('+33 2');
    expect(decodeText('\\u002B33 2')).toBe('+33 2');
    expect(decodeText('https:\\/\\/x.example\\/a.jpg')).toBe('https://x.example/a.jpg');
    expect(decodeText('say "hi"')).toBe('say "hi"');
    expect(decodeText('say \\"hi\\"')).toBe('say "hi"');
  });

  it('decodes named, decimal and hex entities', () => {
    expect(decodeText('&euro; 12')).toBe('&euro; 12');
    expect(decodeText('&#8364; 12')).toBe('€ 12');
    expect(decodeText('&#43;31 85')).toBe('+31 85');
    expect(decodeText('&#x2B;31')).toBe('+31');
    expect(decodeText('&#X2b;31')).toBe('+31');
    expect(decodeText('a&b')).toBe('a&b');
    expect(decodeText('<>"&apos;')).toBe('<>"\'');
    expect(decodeText('&nbsp;x')).toBe(' x');
  });

  it('decodes entities in one pass', () => {
    expect(decodeText('&euro;')).toBe('&euro;');
    expect(decodeText('&#43;')).toBe('+');
    expect(decodeText('&amp;')).toBe('&');
    expect(decodeText('&lt;&gt;&quot;')).toBe('<>"');
    expect(decodeText('&amp;#43;')).toBe('&#43;');
    expect(decodeText('&amp;euro;')).toBe('&euro;');
  });

  it('leaves unknown entities as written', () => {
    expect(decodeText('&foo;')).toBe('&foo;');
    expect(decodeText('&constructor;')).toBe('&constructor;');
    expect(decodeText('&#x110000;')).toBe('&#x110000;');
  });

  it('returns an empty string for null and undefined', () => {
    expect(decodeText(null)).toBe('');
    expect(decodeText(undefined)).toBe('');
  });
});
