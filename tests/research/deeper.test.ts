import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DeeperReader } from '../../src/research/deeper.mjs';

const wholesaleChecklist = [
  { clause: 'wholesale', items: [{ clause: 'wholesale', question: 'Does this sell wholesale?', hard: true }] },
];

describe('DeeperReader', () => {
  let mockJudge;
  let mockReadPage;
  let deeperReader;

  beforeEach(() => {
    mockJudge = {
      judge: vi.fn(),
    };
    mockReadPage = vi.fn();
    deeperReader = new DeeperReader({ judge: mockJudge, readPage: mockReadPage });
    vi.clearAllMocks();
  });

  it('returns item unchanged when no unknown hard checks', async () => {
    const item = {
      url: 'http://example.com/item',
      pageText: 'Some page text',
      links: [{ url: '/wholesale', text: 'wholesale' }],
      checks: [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'yes', clause: 'wholesale' },
        { id: 'brands|Does this carry brand?', hard: false, answer: 'yes', clause: 'brands' },
      ],
    };
    const checklist = wholesaleChecklist;
    const cache = {};

    const result = await deeperReader.readDeeperForUnknown(item, checklist, cache);

    expect(result).toBe(item);
    expect(mockReadPage).not.toHaveBeenCalled();
    expect(mockJudge.judge).not.toHaveBeenCalled();
  });

  it('returns item unchanged when no pageText', async () => {
    const item = {
      url: 'http://example.com/item',
      pageText: '',
      links: [],
      checks: [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'unknown', clause: 'wholesale' },
      ],
    };
    const checklist = wholesaleChecklist;
    const cache = {};

    const result = await deeperReader.readDeeperForUnknown(item, checklist, cache);

    expect(result).toBe(item);
    expect(mockReadPage).not.toHaveBeenCalled();
    expect(mockJudge.judge).not.toHaveBeenCalled();
  });

  it('reads deeper pages for unknown hard checks and updates to yes when found', async () => {
    const item = {
      url: 'http://example.com/item',
      pageText: 'Main page with wholesale details',
      links: [{ url: '/wholesale-details', text: 'wholesale details' }, { url: '/wholesale-more', text: 'wholesale more' }],
      checks: [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'unknown', clause: 'wholesale' },
      ],
    };
    const checklist = wholesaleChecklist;
    const cache = {};

    mockReadPage.mockResolvedValueOnce({ text: 'We sell wholesale in bulk', status: 200, links: [] });
    mockJudge.judge.mockResolvedValueOnce([
      { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'yes', quote: 'We sell wholesale in bulk', clause: 'wholesale' },
    ]);

    const result = await deeperReader.readDeeperForUnknown(item, checklist, cache);

    expect(result.checks[0].answer).toBe('yes');
    expect(result.checks[0].quote).toBe('We sell wholesale in bulk');
    expect(result.checks[0].source).toBe('http://example.com/wholesale-details');
    expect(mockReadPage).toHaveBeenCalledTimes(1);
    expect(mockReadPage).toHaveBeenCalledWith('http://example.com/wholesale-details');
    expect(mockJudge.judge).toHaveBeenCalledTimes(1);
  });

  it('uses cache for deeper page checks', async () => {
    const item = {
      url: 'http://example.com/item',
      pageText: 'Main page with wholesale details',
      links: [{ url: '/wholesale-details', text: 'wholesale details' }],
      checks: [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'unknown', clause: 'wholesale' },
      ],
    };
    const checklist = wholesaleChecklist;
    const cache = {
      'http://example.com/wholesale-details::wholesale|Does this sell wholesale?': [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'yes', quote: 'cached quote', clause: 'wholesale' },
      ],
    };

    mockReadPage.mockResolvedValue({ text: 'We sell wholesale in bulk', status: 200 });

    const result = await deeperReader.readDeeperForUnknown(item, checklist, cache);

    expect(result.checks[0].answer).toBe('yes');
    expect(result.checks[0].quote).toBe('cached quote');
    expect(mockReadPage).not.toHaveBeenCalled();
    expect(mockJudge.judge).not.toHaveBeenCalled();
  });

  it('stops at first yes and does not check remaining urls', async () => {
    const item = {
      url: 'http://example.com/item',
      pageText: 'Main page with wholesale details',
      links: [{ url: '/wholesale-details', text: 'wholesale details' }, { url: '/wholesale-more', text: 'wholesale more' }],
      checks: [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'unknown', clause: 'wholesale' },
      ],
    };
    const checklist = wholesaleChecklist;
    const cache = {};

    mockReadPage.mockResolvedValue({ text: 'We sell wholesale in bulk', status: 200, links: [] });
    mockJudge.judge.mockResolvedValue([
      { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'yes', quote: 'We sell wholesale in bulk', clause: 'wholesale' },
    ]);

    await deeperReader.readDeeperForUnknown(item, checklist, cache);

    expect(mockReadPage).toHaveBeenCalledTimes(1);
    expect(mockJudge.judge).toHaveBeenCalledTimes(1);
  });

  it('keeps answer as unknown when no deeper page confirms', async () => {
    const item = {
      url: 'http://example.com/item',
      pageText: 'Main page with wholesale details',
      links: [{ url: '/wholesale-details', text: 'wholesale details' }],
      checks: [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'unknown', clause: 'wholesale' },
      ],
    };
    const checklist = wholesaleChecklist;
    const cache = {};

    mockReadPage.mockResolvedValue({ text: 'No details here', status: 200, links: [] });
    mockJudge.judge.mockResolvedValue([
      { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'unknown', quote: '', clause: 'wholesale' },
    ]);

    const result = await deeperReader.readDeeperForUnknown(item, checklist, cache);

    expect(result.checks[0].answer).toBe('unknown');
    expect(result.checks[0].quote).toBeFalsy();
  });

  it('does not go deeper when check answer is no on the item page', async () => {
    const item = {
      url: 'http://example.com/item',
      pageText: 'Main page with wholesale details',
      links: [{ url: '/wholesale-details', text: 'wholesale details' }],
      checks: [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'no', clause: 'wholesale' },
      ],
    };
    const checklist = wholesaleChecklist;
    const cache = {};

    const result = await deeperReader.readDeeperForUnknown(item, checklist, cache);

    expect(result.checks[0].answer).toBe('no');
    expect(mockReadPage).not.toHaveBeenCalled();
    expect(mockJudge.judge).not.toHaveBeenCalled();
  });

  it('ignores other-host links', async () => {
    const item = {
      url: 'http://example.com/item',
      pageText: 'Main page with wholesale details',
      links: [
        { url: 'http://other-host.com/wholesale', text: 'wholesale details' },
        { url: '/wholesale-details', text: 'wholesale details' },
      ],
      checks: [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'unknown', clause: 'wholesale' },
      ],
    };
    const checklist = wholesaleChecklist;
    const cache = {};

    mockReadPage.mockResolvedValue({ text: 'We sell wholesale in bulk', status: 200, links: [] });
    mockJudge.judge.mockResolvedValue([
      { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'yes', quote: 'We sell wholesale in bulk', clause: 'wholesale' },
    ]);

    const result = await deeperReader.readDeeperForUnknown(item, checklist, cache);

    expect(result.checks[0].answer).toBe('yes');
    expect(mockReadPage).toHaveBeenCalledTimes(1);
    expect(mockReadPage).toHaveBeenCalledWith('http://example.com/wholesale-details');
  });

  it('cache hit = no readPage or judge call', async () => {
    const item = {
      url: 'http://example.com/item',
      pageText: 'Main page with wholesale details',
      links: [{ url: '/wholesale-details', text: 'wholesale details' }],
      checks: [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'unknown', clause: 'wholesale' },
      ],
    };
    const checklist = wholesaleChecklist;
    const cache = {
      'http://example.com/wholesale-details::wholesale|Does this sell wholesale?': [
        { id: 'wholesale|Does this sell wholesale?', hard: true, answer: 'yes', quote: 'cached quote', clause: 'wholesale' },
      ],
    };

    const result = await deeperReader.readDeeperForUnknown(item, checklist, cache);

    expect(result.checks[0].answer).toBe('yes');
    expect(result.checks[0].quote).toBe('cached quote');
    expect(mockReadPage).not.toHaveBeenCalled();
    expect(mockJudge.judge).not.toHaveBeenCalled();
  });
});