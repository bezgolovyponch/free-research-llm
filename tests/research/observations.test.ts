import { describe, expect, it, vi } from 'vitest';
import { normalizeText, columnQuoteInQuestion, numberInQuote, tableSpec, extract, dedupeKey, toCSV, toJSON } from '../../src/research/observations.mjs';

describe('observations module', () => {
  describe('normalizeText', () => {
    it('normalizes whitespace', () => {
      expect(normalizeText('  hello   world  ')).toBe('hello world');
    });
    it('handles null', () => {
      expect(normalizeText(null)).toBe('');
    });
  });

  describe('columnQuoteInQuestion', () => {
    it('returns true when quote is in question', () => {
      expect(columnQuoteInQuestion('monthly rate', 'What is the monthly rate?', '')).toBe(true);
    });
    it('returns true when quote is in expected', () => {
      expect(columnQuoteInQuestion('USD/ton', '', 'monthly rate in USD/ton')).toBe(true);
    });
    it('returns false when quote not found', () => {
      expect(columnQuoteInQuestion('random', 'What is the rate?', 'monthly rate')).toBe(false);
    });
    it('handles case insensitivity', () => {
      expect(columnQuoteInQuestion('MONTHLY', 'what is the monthly rate?', '')).toBe(true);
    });
  });

  describe('numberInQuote', () => {
    it('returns true when number appears in quote', () => {
      expect(numberInQuote(100, 'The rate is 100 USD/ton')).toBe(true);
      expect(numberInQuote(150.5, 'Rate: 150.5')).toBe(true);
    });
    it('returns false when number not in quote', () => {
      expect(numberInQuote(100, 'The rate is high')).toBe(false);
    });
    it('handles commas in numbers', () => {
      expect(numberInQuote(1000, 'Rate: 1,000')).toBe(true);
    });
  });

  describe('dedupeKey', () => {
    it('creates unique key from row', () => {
      const key = dedupeKey({ time: '2026-12', entity: 'Asia-Europe', value: 100, source: 'https://example.com' });
      expect(key).toBe('2026-12|Asia-Europe|100|https://example.com');
    });
  });

  describe('toCSV', () => {
    it('generates CSV from table', () => {
      const table = {
        columns: ['time', 'lane', 'rate', 'unit'],
        rows: [
          { time: '2026-12', lane: 'Asia-Europe', rate: 100, unit: 'USD/ton' },
          { time: '2027-01', lane: 'Transpacific', rate: 200, unit: 'USD/ton' }
        ]
      };
      const csv = toCSV(table);
      expect(csv).toContain('time,lane,rate,unit');
      expect(csv).toContain('2026-12,Asia-Europe,100,USD/ton');
    });

    it('escapes quotes and commas', () => {
      const table = {
        columns: ['time', 'note'],
        rows: [
          { time: '2026-12', note: 'rate, with comma' },
          { time: '2027-01', note: 'rate "quoted"' }
        ]
      };
      const csv = toCSV(table);
      expect(csv).toContain('"rate, with comma"');
      expect(csv).toContain('"rate ""quoted"""');
    });

    it('returns empty string for empty table', () => {
      expect(toCSV({ columns: [], rows: [] })).toBe('');
      expect(toCSV(null)).toBe('');
    });
  });

  describe('toJSON', () => {
    it('generates JSON from table', () => {
      const table = {
        columns: ['time', 'rate'],
        rows: [
          { time: '2026-12', rate: 100 },
          { time: '2027-01', rate: 200 }
        ]
      };
      const json = toJSON(table);
      const parsed = JSON.parse(json);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].time).toBe('2026-12');
    });

    it('returns empty array for empty table', () => {
      expect(toJSON({ columns: [], rows: [] })).toBe('[]');
      expect(toJSON(null)).toBe('[]');
    });
  });

  describe('tableSpec', () => {
    it('filters columns by quote in question', async () => {
      const mockRouter = {
        complete: vi.fn().mockResolvedValue({
          data: {
            observationUnit: 'monthly rate per lane',
            columns: [
              { name: 'time', type: 'time', unit: '', quoteFromAsker: 'monthly' },
              { name: 'lane', type: 'entity', unit: '', quoteFromAsker: 'lane' },
              { name: 'rate', type: 'value', unit: 'USD/ton', quoteFromAsker: 'rate' },
              { name: 'invalid', type: 'entity', unit: '', quoteFromAsker: 'not in question' }
            ]
          }
        })
      };
      const project = { question: 'What is the monthly rate per lane?', acceptance: { expected: 'monthly rate in USD/ton' } };
      const spec = await tableSpec(project, mockRouter);
      expect(spec.columns).toHaveLength(3);
      expect(spec.columns.map(c => c.name)).toEqual(['time', 'lane', 'rate']);
    });
  });
});
