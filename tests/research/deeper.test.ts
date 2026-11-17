import { describe, expect, it, vi } from 'vitest';
import { DeeperReader, deeperOrder } from '../../src/research/deeper.mjs';

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

const EUROPAGES_ITEM_URL = 'https://www.europages.nl/nl/company/jonathan-frips-22341946/products/vetements-occasion-friperie-vintage-36522';
const EUROPAGES_ANOTHER_COMPANY_URL = 'https://www.europages.nl/nl/company/striebel-textil-123/products/some-product';
const EUROPAGES_SAME_COMPANY_OTHER_URL = 'https://www.europages.nl/nl/company/jonathan-frips-22341946/products/another-product';
const EUROPAGES_PROFILE_URL = 'https://www.europages.nl/nl/company/jonathan-frips-22341946';

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

  it('stops reading deeper pages at its budget and reports progress every 10 pages', async () => {
    const links = Array.from({ length: 3 }, (_, i) => ({ url: `https://shop.example.org/shipping-${i}`, text: 'Shipping countries' }));
    const pages = Object.fromEntries(links.map((l) => [l.url, { text: 'No countries named', status: 200, links: [] }]));
    const readPage = vi.fn(async (url) => pages[url] ?? itemPage(links));
    const judge = { judge: vi.fn(async () => []) };
    const progress: number[] = [];
    const reader = new DeeperReader({ judge, readPage, budget: 10, onProgress: (r: { read: number }) => progress.push(r.read) });
    for (let i = 0; i < 6; i++) await reader.readDeeperForUnknown({ ...unknownItem(), url: `https://shop.example.org/item-${i}` }, checklist, {});
    expect(reader.read).toBe(10);
    expect(reader.spent()).toBe(true);
    expect(judge.judge).toHaveBeenCalledTimes(10);
    expect(progress).toEqual([10]);
  });
});

describe('deeperOrder', () => {
  const hardList = [{ clause: 'c', items: [{ question: 'q0', hard: true }, { question: 'q1', hard: true }, { question: 'q2', hard: true }] }];
  const item = (url: string, answers: string[], gate: Record<string, unknown> = {}) => ({ url, live: true, listing: true, ...gate, checks: answers.map((answer, i) => ({ id: `c|q${i}`, hard: true, answer, clause: 'c' })) });

  it('skips items a hard "no" already rejected and items with nothing unknown, closest to confirmation first', () => {
    const order = deeperOrder([item('a', ['unknown', 'unknown', 'yes']), item('b', ['no', 'unknown', 'yes']), item('c', ['yes', 'unknown', 'yes']), item('d', ['yes', 'yes', 'yes']), { url: 'e', live: true, listing: true }], { checklist: hardList });
    expect(order.map((i: { url: string }) => i.url)).toEqual(['c', 'a']);
  });

  it('never reads an item that fails the page gate: a dead link, a value out of range or a failed purpose check cannot be confirmed', () => {
    const spec = { valueRange: { min: 0, max: 100 } };
    const items = [
      item('dead', ['yes', 'unknown', 'yes'], { live: false }),
      item('out-of-range', ['yes', 'unknown', 'yes'], { inRange: false }),
      item('off-purpose', ['yes', 'unknown', 'yes'], { inRange: true, purpose: [{ passed: false }] }),
      item('open', ['unknown', 'unknown', 'yes'], { inRange: true, purpose: [{ passed: true }] }),
    ];
    expect(deeperOrder(items, { checklist: hardList, spec }).map((i: { url: string }) => i.url)).toEqual(['open']);
    expect(deeperOrder(items, { checklist: hardList, spec, kind: { label: 'car' } }).map((i: { url: string }) => i.url)).toEqual(['open']);
  });
});

describe('DeeperReader company pages', () => {
  const LOCATION_ID = 'supplier located in nl|Is this provider located in the Netherlands?';
  const locationList = [{ clause: 'supplier located in nl', items: [{ question: 'Is this provider located in the Netherlands?', hard: true }] }];
  const CONTACT_URL = 'https://shop.example.org/contact';

  it('reads the contact page for a check whose words no link carries', async () => {
    const readPage = vi.fn(async (url: string) => (url === ITEM_URL ? itemPage([{ url: '/products/bales', text: 'Bales' }, { url: CONTACT_URL, text: 'Contact' }]) : { text: 'Adres: Keizersgracht 1, Amsterdam', status: 200, links: [] }));
    const judge = { judge: vi.fn(async (page: { url: string }) => (page.url === CONTACT_URL ? [{ id: LOCATION_ID, answer: 'yes', quote: 'Keizersgracht 1, Amsterdam', hard: true, clause: 'supplier located in nl' }] : [])) };
    const item = { url: ITEM_URL, checks: [{ id: LOCATION_ID, hard: true, answer: 'unknown', clause: 'supplier located in nl' }] };
    await new DeeperReader({ judge, readPage }).readDeeperForUnknown(item, locationList, {});
    expect(readPage.mock.calls.map((c) => c[0])).toEqual([ITEM_URL, CONTACT_URL]);
    expect(item.checks[0]).toMatchObject({ answer: 'yes', source: CONTACT_URL });
  });
});

describe('DeeperReader entity prefix filtering', () => {
  const unknownItemAt = (url: string, answer = 'unknown') => ({
    url,
    checks: [{ id: CHECK_ID, hard: true, answer, clause: 'ships abroad' }],
  });

  it('skips a link to another company\'s product page on the same Europages host, even when its text carries the check\'s words', async () => {
    const { reader, readPage } = setup({
      [EUROPAGES_ITEM_URL]: itemPage([{ url: EUROPAGES_ANOTHER_COMPANY_URL, text: 'Shipping countries' }]),
    });
    const item = unknownItemAt(EUROPAGES_ITEM_URL);
    await reader.readDeeperForUnknown(item, checklist, {});
    expect(readPage.mock.calls.map((c) => c[0])).toEqual([EUROPAGES_ITEM_URL, EUROPAGES_PROFILE_URL]);
    expect(item.checks[0].answer).toBe('unknown');
  });

  it('reads a link to the same company\'s other product page on Europages', async () => {
    const { reader, readPage } = setup({
      [EUROPAGES_ITEM_URL]: itemPage([{ url: EUROPAGES_SAME_COMPANY_OTHER_URL, text: 'Shipping countries' }]),
      [EUROPAGES_SAME_COMPANY_OTHER_URL]: { text: 'We ship to 30 countries', status: 200, links: [] },
    }, {
      [EUROPAGES_SAME_COMPANY_OTHER_URL]: [{ id: CHECK_ID, answer: 'yes', quote: 'We ship to 30 countries', hard: true, clause: 'ships abroad' }],
    });
    const item = unknownItemAt(EUROPAGES_ITEM_URL);
    await reader.readDeeperForUnknown(item, checklist, {});
    expect(readPage.mock.calls.map((c) => c[0])).toEqual([EUROPAGES_ITEM_URL, EUROPAGES_SAME_COMPANY_OTHER_URL]);
    expect(item.checks[0]).toMatchObject({ answer: 'yes', source: EUROPAGES_SAME_COMPANY_OTHER_URL });
  });

  it('reads the company profile page for an unknown location check even when the item page has no link to it', async () => {
    const locationCheck = 'supplier located in nl|Is this provider located in the Netherlands?';
    const locationList = [{ clause: 'supplier located in nl', items: [{ question: 'Is this provider located in the Netherlands?', hard: true }] }];

    const readPage = vi.fn(async (url) => {
      if (url === EUROPAGES_ITEM_URL) return itemPage([{ url: EUROPAGES_ANOTHER_COMPANY_URL, text: 'Netherlands location' }]);
      if (url === EUROPAGES_PROFILE_URL) return { text: 'Adres: Keizersgracht 1, Amsterdam', status: 200, links: [] };
      return null;
    });
    const judge = {
      judge: vi.fn(async (page) =>
        page.url === EUROPAGES_PROFILE_URL
          ? [{ id: locationCheck, answer: 'yes', quote: 'Keizersgracht 1, Amsterdam', hard: true, clause: 'supplier located in nl' }]
          : [],
      ),
    };
    const item = {
      url: EUROPAGES_ITEM_URL,
      checks: [{ id: locationCheck, hard: true, answer: 'unknown', clause: 'supplier located in nl' }],
    };
    await new DeeperReader({ judge, readPage }).readDeeperForUnknown(item, locationList, {});
    expect(readPage).toHaveBeenCalledWith(EUROPAGES_PROFILE_URL);
    expect(item.checks[0]).toMatchObject({ answer: 'yes', source: EUROPAGES_PROFILE_URL });
  });
});

describe('DeeperReader entity prefix without a language segment', () => {
  it('keeps the reads inside the company when its path has no language part', async () => {
    const item = 'https://supplier-directory.example/company/acme-77/products/bales';
    const own = 'https://supplier-directory.example/company/acme-77/shipping';
    const other = 'https://supplier-directory.example/company/other-88/shipping';
    const { reader, readPage } = setup({ [item]: itemPage([{ url: other, text: 'Shipping countries' }, { url: own, text: 'Shipping countries' }]), [own]: { text: 'We ship to 30 countries', status: 200, links: [] } }, { [own]: yes('We ship to 30 countries') });
    const checked = { url: item, checks: [{ id: CHECK_ID, hard: true, answer: 'unknown', clause: 'ships abroad' }] };
    await reader.readDeeperForUnknown(checked, checklist, {});
    expect(readPage.mock.calls.map((c) => c[0])).not.toContain(other);
    expect(checked.checks[0]).toMatchObject({ answer: 'yes', source: own });
  });
});
