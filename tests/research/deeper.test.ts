import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readDeeperForUnknown, runChecksOnItems } from '../../src/research/deeper.mjs';

const wholesaleChecklist = [
  { clause: 'wholesale', items: [{ clause: 'wholesale', question: 'Does this sell wholesale?', hard: true }] },
];

describe('readDeeperForUnknown', () => {
  let mockReadPage;

  beforeEach(() => {
    mockReadPage = vi.fn();
    vi.clearAllMocks();
  });

  it('returns item unchanged when no unknown hard checks', async () => {
    const item = {
      url: 'http://example.com/item',
      pageText: 'Some page text',
      checks: [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'yes', clause: 'wholesale' },
        { id: 'brands|Does this carry brand?', hard: false, answer: 'yes', clause: 'brands' },
      ],
    };
    const checklist = wholesaleChecklist;
    const cache = {};

    const result = await readDeeperForUnknown(item, mockReadPage, checklist, cache);

    expect(result).toBe(item);
    expect(mockReadPage).not.toHaveBeenCalled();
  });

  it('returns item unchanged when no pageText', async () => {
    const item = {
      url: 'http://example.com/item',
      pageText: '',
      checks: [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'unknown', clause: 'wholesale' },
      ],
    };
    const checklist = wholesaleChecklist;
    const cache = {};

    const result = await readDeeperForUnknown(item, mockReadPage, checklist, cache);

    expect(result).toBe(item);
    expect(mockReadPage).not.toHaveBeenCalled();
  });

  it('reads deeper pages for unknown hard checks and updates to yes when found', async () => {
    const item = {
      url: 'http://example.com/item',
      pageText: 'Main page with <a href="/wholesale-details">wholesale details</a> and <a href="/wholesale-more">wholesale more</a>',
      checks: [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'unknown', clause: 'wholesale' },
      ],
    };
    const checklist = wholesaleChecklist;
    const cache = {};

    mockReadPage
      .mockResolvedValueOnce({ text: 'We sell wholesale in bulk', status: 200 })
      .mockResolvedValueOnce({ text: 'Another page', status: 200 });

    const result = await readDeeperForUnknown(item, mockReadPage, checklist, cache);

    expect(result.checks[0].answer).toBe('yes');
    expect(result.checks[0].quote).toBe('confirmed on linked page');
    expect(mockReadPage).toHaveBeenCalledTimes(1);
  });

  it('uses cache for deeper page checks', async () => {
    const item = {
      url: 'http://example.com/item',
      pageText: 'Main page with <a href="/wholesale-details">wholesale details</a>',
      checks: [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'unknown', clause: 'wholesale' },
      ],
    };
    const checklist = wholesaleChecklist;
    const cache = {
      'http://example.com/wholesale-details::wholesale|Does this sell wholesale?': [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'yes', clause: 'wholesale' },
      ],
    };

    mockReadPage.mockResolvedValue({ text: 'We sell wholesale in bulk', status: 200 });

    const result = await readDeeperForUnknown(item, mockReadPage, checklist, cache);

    expect(result.checks[0].answer).toBe('yes');
    expect(mockReadPage).not.toHaveBeenCalled();
  });

  it('stops at first yes and does not check remaining urls', async () => {
    const item = {
      url: 'http://example.com/item',
      pageText: 'Main page with <a href="/wholesale-details">wholesale details</a> and <a href="/wholesale-more">wholesale more</a>',
      checks: [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'unknown', clause: 'wholesale' },
      ],
    };
    const checklist = wholesaleChecklist;
    const cache = {};

    mockReadPage
      .mockResolvedValueOnce({ text: 'We sell wholesale in bulk', status: 200 })
      .mockResolvedValueOnce({ text: 'Another page', status: 200 });

    await readDeeperForUnknown(item, mockReadPage, checklist, cache);

    expect(mockReadPage).toHaveBeenCalledTimes(1);
  });

  it('keeps answer as unknown when no deeper page confirms', async () => {
    const item = {
      url: 'http://example.com/item',
      pageText: 'Main page with <a href="/wholesale-details">wholesale details</a>',
      checks: [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'unknown', clause: 'wholesale' },
      ],
    };
    const checklist = wholesaleChecklist;
    const cache = {};

    mockReadPage.mockResolvedValue({ text: 'No details here', status: 200 });

    const result = await readDeeperForUnknown(item, mockReadPage, checklist, cache);

    expect(result.checks[0].answer).toBe('unknown');
  });
});

describe('runChecksOnItems', () => {
  let mockReadPage;

  beforeEach(() => {
    mockReadPage = vi.fn();
    vi.clearAllMocks();
  });

  it('runs judgeItem on items without checks', async () => {
    const items = [
      { url: 'http://example.com/item1', pageText: 'We sell wholesale clothing in bulk' },
      { url: 'http://example.com/item2', pageText: 'We sell retail clothing only' },
      { url: 'http://example.com/item3', pageText: '' },
    ];
    const checklist = wholesaleChecklist;
    const checkCache = {};

    await runChecksOnItems(items, mockReadPage, checklist, checkCache);

    expect(items[0].checks).toBeDefined();
    expect(items[0].checks[0].answer).toBe('yes');
    expect(items[1].checks).toBeDefined();
    expect(items[1].checks[0].answer).toBe('unknown');
    expect(items[2].checks).toBeUndefined();
  });

  it('skips items that already have checks', async () => {
    const items = [
      { url: 'http://example.com/item1', pageText: 'We sell wholesale clothing', checks: [{ id: 'wholesale|Does this sell wholesale?', answer: 'yes' }] },
      { url: 'http://example.com/item2', pageText: 'We sell retail clothing only' },
    ];
    const checklist = wholesaleChecklist;
    const checkCache = {};

    await runChecksOnItems(items, mockReadPage, checklist, checkCache);

    expect(items[0].checks[0].answer).toBe('yes');
    expect(items[1].checks).toBeDefined();
    expect(items[1].checks[0].answer).toBe('unknown');
  });

  it('runs readDeeperForUnknown on items with checks', async () => {
    const items = [
      { url: 'http://example.com/item1', pageText: 'Main page with <a href="/wholesale-details">wholesale details</a>', checks: [{ id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'unknown', clause: 'wholesale' }] },
      { url: 'http://example.com/item2', pageText: 'We sell wholesale clothing', checks: [{ id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'yes', clause: 'wholesale' }] },
    ];
    const checklist = wholesaleChecklist;
    const checkCache = {};

    mockReadPage.mockResolvedValue({ text: 'We sell wholesale in bulk', status: 200 });

    await runChecksOnItems(items, mockReadPage, checklist, checkCache);

    expect(mockReadPage).toHaveBeenCalled();
    expect(items[0].checks[0].answer).toBe('yes');
  });
});