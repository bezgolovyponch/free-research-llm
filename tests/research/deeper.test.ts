import { describe, expect, it, vi } from 'vitest';
import { DeeperReader } from '../../src/research/deeper.mjs';

const CHECK_ID = 'ships abroad|Does this ship to other countries?';
const checklist = [
  { clause: 'ships abroad', items: [{ question: 'Does this ship to other countries?', hard: true }] },
  { clause: 'cheap', items: [{ question: 'Is the price low?', hard: false }] },
];
const ITEM_URL = 'https://shop.example.org/item';
const DEEP_URL = 'https://shop.example.org/shipping-countries';

function setup(pages, verdicts = {}) {
  const readPage = vi.fn(async (url) => pages[url] ?? null);
  const judge = { judge: vi.fn(async (item) => verdicts[item.url] ?? []) };
  return { readPage, judge, reader: new DeeperReader({ judge, readPage }) };
}

const unknownItem = (answer = 'unknown') => ({ url: ITEM_URL, checks: [{ id: CHECK_ID, hard: true, answer, clause: 'ships abroad' }] });
const itemPage = (links) => ({ text: 'Our shop', status: 200, links });
const yes = (quote) => [{ id: CHECK_ID, answer: 'yes', quote, hard: true, clause: 'ships abroad' }];

describe('DeeperReader', () => {
  it('reads the item page for its links, then a same-host link, and keeps the deeper quote and source', async () => {
    const { reader, readPage, judge } = setup(
      { [ITEM_URL]: itemPage([{ url: DEEP_URL, text: 'Shipping countries' }]), [DEEP_URL]: { text: 'We ship to 30 countries', status: 200, links: [] } },
      { [DEEP_URL]: yes('We ship to 30 countries') },
    );
    const item = unknownItem();
    await reader.readDeeperForUnknown(item, checklist, {});
    expect(readPage.mock.calls.map((c) => c[0])).toEqual([ITEM_URL, DEEP_URL]);
    expect(item.checks[0]).toMatchObject({ answer: 'yes', quote: 'We ship to 30 countries', source: DEEP_URL });
  });

  it('judges the deeper page on that one check only', async () => {
    const { reader, judge } = setup(
      { [ITEM_URL]: itemPage([{ url: DEEP_URL, text: 'Shipping countries' }]), [DEEP_URL]: { text: 'We ship to 30 countries', links: [] } },
      { [DEEP_URL]: yes('We ship to 30 countries') },
    );
    await reader.readDeeperForUnknown(unknownItem(), checklist, {});
    const asked = judge.judge.mock.calls[0][2];
    expect(asked).toHaveLength(1);
    expect(asked[0].items.map((i) => i.question)).toEqual(['Does this ship to other countries?']);
  });

  it('never reads a link on another host', async () => {
    const { reader, readPage } = setup({ [ITEM_URL]: itemPage([{ url: 'https://elsewhere.example.net/shipping', text: 'Shipping countries' }]) });
    const item = unknownItem();
    await reader.readDeeperForUnknown(item, checklist, {});
    expect(readPage.mock.calls.map((c) => c[0])).toEqual([ITEM_URL]);
    expect(item.checks[0].answer).toBe('unknown');
  });

  it('a "no" on the item page is final and reads nothing', async () => {
    const { reader, readPage, judge } = setup({ [ITEM_URL]: itemPage([{ url: DEEP_URL, text: 'Shipping countries' }]) });
    const item = unknownItem('no');
    await reader.readDeeperForUnknown(item, checklist, {});
    expect(readPage).not.toHaveBeenCalled();
    expect(judge.judge).not.toHaveBeenCalled();
    expect(item.checks[0].answer).toBe('no');
  });

  it('stays unknown when no deeper page confirms', async () => {
    const { reader } = setup(
      { [ITEM_URL]: itemPage([{ url: DEEP_URL, text: 'Shipping countries' }]), [DEEP_URL]: { text: 'Contact us', links: [] } },
      { [DEEP_URL]: [{ id: CHECK_ID, answer: 'unknown', quote: '' }] },
    );
    const item = unknownItem();
    await reader.readDeeperForUnknown(item, checklist, {});
    expect(item.checks[0].answer).toBe('unknown');
  });

  it('a cached deeper verdict is reused without reading or judging that page again', async () => {
    const { reader, readPage, judge } = setup({ [ITEM_URL]: itemPage([{ url: DEEP_URL, text: 'Shipping countries' }]) });
    const item = unknownItem();
    await reader.readDeeperForUnknown(item, checklist, { [`${DEEP_URL}::${CHECK_ID}`]: yes('cached quote') });
    expect(readPage.mock.calls.map((c) => c[0])).toEqual([ITEM_URL]);
    expect(judge.judge).not.toHaveBeenCalled();
    expect(item.checks[0]).toMatchObject({ answer: 'yes', quote: 'cached quote', source: DEEP_URL });
  });

  it('reads at most 3 deeper pages and stops at the first yes', async () => {
    const links = [1, 2, 3, 4].map((n) => ({ url: `https://shop.example.org/shipping-${n}`, text: 'Shipping countries' }));
    const { reader, readPage } = setup(
      { [ITEM_URL]: itemPage(links), ...Object.fromEntries(links.map((l) => [l.url, { text: 'page', links: [] }])) },
      { 'https://shop.example.org/shipping-2': [{ id: CHECK_ID, answer: 'yes', quote: 'page' }] },
    );
    await reader.readDeeperForUnknown(unknownItem(), checklist, {});
    expect(readPage.mock.calls.map((c) => c[0])).toEqual([ITEM_URL, 'https://shop.example.org/shipping-1', 'https://shop.example.org/shipping-2']);
  });
});
