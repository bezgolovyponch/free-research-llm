import { describe, expect, it } from 'vitest';
import { AcceptanceChecker, collectDeliverables, hasCriteria, normalizeAcceptance, parseAmounts, toAmount } from '../../src/research/acceptance.mjs';

describe('acceptance', () => {
  it('parses European and English price formats with currencies', () => {
    expect(parseAmounts('Preis 2.500 € VB, 3 999,- €, € 1,234.50, 8 000 PLN, 59 900 Kč')).toEqual([
      { value: 2500, currency: 'EUR' }, { value: 3999, currency: 'EUR' }, { value: 1234.5, currency: 'EUR' }, { value: 8000, currency: 'PLN' }, { value: 59900, currency: 'CZK' },
    ]);
    expect(toAmount('12.345,67')).toBe(12345.67);
  });

  it('normalizes a spec and knows when there is nothing to check', () => {
    const spec = normalizeAcceptance({ itemCount: '10', urlsLive: 1, valueRange: [4000, 2000], unit: 'EUR', mustMention: ['car'] }, '10 links');
    expect(spec).toEqual({ expected: '10 links', itemCount: 10, urlsLive: true, valueRange: [2000, 4000], unit: 'EUR', mustMention: ['car'] });
    expect(hasCriteria(normalizeAcceptance({}, 'memo'))).toBe(false);
  });

  it('collects items only from gated nodes, deduplicated by URL', () => {
    const nodes = [
      { id: 'A', status: 'verified', finding: { items: [{ url: 'https://m.example/1' }, { url: 'https://m.example/1' }] } },
      { id: 'B', status: 'weak', finding: { items: [{ url: 'https://m.example/2' }] } },
    ];
    expect(collectDeliverables(nodes)).toEqual([{ url: 'https://m.example/1', nodeId: 'A' }]);
  });

  it('checks count, live deep links and price range with currency conversion', async () => {
    const pages: Record<string, { text: string; status: number }> = {
      'https://m.example/car/1': { text: `${'Used car Golf '.repeat(20)} 9 000 zł`, status: 200 },
      'https://m.example/car/2': { text: `${'Used car Astra '.repeat(20)} 9 500 €`, status: 200 },
      'https://m.example/': { text: 'home '.repeat(100), status: 200 },
    };
    const checker = new AcceptanceChecker({ readPage: async (url: string) => pages[url] ?? { text: '', status: 404 }, convert: (v: number, from: string) => (from === 'PLN' ? v / 4 : v) });
    const spec = normalizeAcceptance({ itemCount: 4, urlsLive: true, valueRange: [2000, 4000], unit: 'EUR', mustMention: ['used'] });
    const result = await checker.evaluate(spec, [{ url: 'https://m.example/car/1' }, { url: 'https://m.example/car/2' }, { url: 'https://m.example/' }]);
    const value = Object.fromEntries(result.checks.map((c: { id: string; value: number }) => [c.id, c.value]));
    expect(value).toEqual({ count: 0.75, live: 0.5, range: 0.25, mentions: 0.5 });
    expect(result.items.map((i: { live: boolean; inRange: boolean }) => [i.live, i.inRange])).toEqual([[true, true], [true, false], [false, false]]);
    expect(result.score).toBe(0.5);
  });
});
