import { describe, expect, it } from 'vitest';
import { pickSpans, quoteFromSpans, sentenceSpans, spansBlock } from '../../src/research/spans.mjs';
import { quoteFound } from '../../src/research/quote.mjs';
import { fakeEmbedder } from '../helpers/fakes';

describe('quotes are picked from the page, never typed', () => {
  const page = 'Pressed bales of mixed jackets. Sorted by hand into cream and A grade!\nMinimum order is one bale of 450 kg. Ok.';

  it('numbers the sentences of a page and keeps the short fragments out', () => {
    const spans = sentenceSpans(page);
    expect(spans.map((s: { id: string }) => s.id)).toEqual(['S1', 'S2', 'S3']);
    expect(spans[2].text).toBe('Minimum order is one bale of 450 kg.');
    expect(spansBlock(spans)).toBe('[S1] Pressed bales of mixed jackets.\n[S2] Sorted by hand into cream and A grade!\n[S3] Minimum order is one bale of 450 kg.');
    expect(spansBlock(spans, 40)).toBe('[S1] Pressed bales of mixed jackets.');
  });

  it('cuts a very long sentence into spans that are still found on the page', () => {
    const long = `${'word '.repeat(150)}end.`;
    const spans = sentenceSpans(long);
    expect(spans.length).toBe(3);
    expect(spans.every((s: { text: string }) => quoteFound(long, s.text))).toBe(true);
  });

  it('builds the quote from the chosen ids only, and gives nothing when an id is invented', () => {
    const spans = sentenceSpans(page);
    expect(quoteFromSpans(['S3'], spans)).toBe('Minimum order is one bale of 450 kg.');
    expect(quoteFromSpans(['[s1]', 'S2', 'S1'], spans)).toBe('Pressed bales of mixed jackets. Sorted by hand into cream and A grade!');
    expect(quoteFromSpans('S2', spans)).toBe('Sorted by hand into cream and A grade!');
    expect(quoteFromSpans(['S2', 'S9'], spans)).toBe('');
    expect(quoteFromSpans([], spans)).toBe('');
    expect(quoteFromSpans(undefined, spans)).toBe('');
    expect(quoteFound(page, quoteFromSpans(['S1', 'S2'], spans))).toBe(true);
    expect(['S1', 'S3'].every((id) => quoteFound(page, quoteFromSpans([id], spans)))).toBe(true);
  });
});

describe('pickSpans', () => {
  const spans = sentenceSpans('First sentence of the page. Second sentence of the page. Third sentence of the page. Fourth sentence of the page.');

  it('returns the best sentences in page order, whatever order the embedder ranks them in', async () => {
    const picked = await pickSpans(spans, 'query', fakeEmbedder([3, 0, 2, 1]), 2);
    expect(picked.map((s: { id: string }) => s.id)).toEqual(['S1', 'S4']);
  });

  it('falls back to the page opening when the embedder is unavailable or missing', async () => {
    expect((await pickSpans(spans, 'query', fakeEmbedder(null), 2)).map((s: { id: string }) => s.id)).toEqual(['S1', 'S2']);
    expect((await pickSpans(spans, 'query', null, 3)).map((s: { id: string }) => s.id)).toEqual(['S1', 'S2', 'S3']);
  });

  it('asks no embedder when everything fits', async () => {
    const embedder = fakeEmbedder();
    expect(await pickSpans(spans, 'query', embedder, 8)).toEqual(spans);
    expect(embedder.calls).toEqual([]);
  });
});
