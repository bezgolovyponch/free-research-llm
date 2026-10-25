import { describe, expect, it } from 'vitest';
import { absoluteUrl, domainOf } from '../../src/search/html.mjs';

describe('html helpers', () => {
  it('resolves links against the page, drops fragments and non-web schemes', () => {
    expect(absoluteUrl('/a?b=1&amp;c=2#x', 'https://site.example/p/q')).toBe('https://site.example/a?b=1&c=2');
    expect(absoluteUrl('mailto:x@site.example', 'https://site.example/')).toBe('');
    expect(domainOf('https://www.site.example/x')).toBe('site.example');
    expect(domainOf('not a url')).toBe('');
  });
});
