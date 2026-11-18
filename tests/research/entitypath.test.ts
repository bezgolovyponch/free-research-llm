import { describe, expect, it } from 'vitest';
import { directoryEntityKey, entityIdOf } from '../../src/research/entitypath.mjs';

describe('directory entity keys', () => {
  const nl = 'https://www.europages.nl/nl/company/tumodakids-sl-20046954';
  const it_ = 'https://www.europages.it/it/company/tumodakids-sl-20046954';

  it('reads the numeric company id from a directory profile path', () => {
    expect([nl, it_, 'https://www.europages.nl/nl/company/wakted-bv-22364007/products/1', 'https://shop.test/about'].map(entityIdOf)).toEqual(['20046954', '20046954', '22364007', null]);
  });

  it('gives one key to the same company listed on two language hosts of one directory, as in the live tumodakids pair', () => {
    const shared = new Set(['europages']);
    const key = (profileUrl: string, pageHost: string) => directoryEntityKey({ name: 'tumodakids sl', profileUrl, pageHost, sharedStems: shared, fallback: profileUrl });
    expect(key(nl, 'www.europages.nl')).toBe(key(it_, 'www.europages.it'));
    expect(key(nl, 'www.europages.nl')).not.toBe(key('https://www.europages.nl/nl/company/wakted-bv-22364007', 'www.europages.nl'));
  });

  it('keeps the profile url as the key when the directory is seen on one host only', () => {
    expect(directoryEntityKey({ name: 'tumodakids sl', profileUrl: nl, pageHost: 'www.europages.nl', sharedStems: new Set(), fallback: 'x' })).toBe(nl);
    expect(directoryEntityKey({ name: 'a shop', profileUrl: null, pageHost: 'shop.test', sharedStems: new Set(['shop']), fallback: 'shop.test' })).toBe('shop.test');
  });
});
