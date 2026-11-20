import { describe, expect, it } from 'vitest';
import { median, quantile, parseTimeToIndex, aggregateObservations, computeTrend, seasonalOffsets, forecast, buildResultsTable } from '../../src/research/forecast.mjs';

describe('forecast pure functions', () => {
  describe('median', () => {
    it('returns median of odd-length array', () => {
      expect(median([1, 2, 3, 4, 5])).toBe(3);
    });
    it('returns median of even-length array', () => {
      expect(median([1, 2, 3, 4])).toBe(2.5);
    });
    it('returns null for empty array', () => {
      expect(median([])).toBeNull();
    });
  });

  describe('quantile', () => {
    it('returns 10th percentile with linear interpolation', () => {
      expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1)).toBeCloseTo(1.9, 1);
    });
    it('returns 90th percentile with linear interpolation', () => {
      expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1, 1);
    });
    it('returns null for empty array', () => {
      expect(quantile([], 0.5)).toBeNull();
    });
  });

  describe('parseTimeToIndex', () => {
    it('parses monthly format YYYY-MM', () => {
      expect(parseTimeToIndex('2026-12')).toBe(323);
      expect(parseTimeToIndex('2027-01')).toBe(324);
    });
    it('parses quarterly format YYYY-QN', () => {
      expect(parseTimeToIndex('2026-Q4')).toBe(107);
      expect(parseTimeToIndex('2027-Q1')).toBe(108);
    });
    it('parses year only', () => {
      expect(parseTimeToIndex('2026')).toBe(312);
    });
    it('parses Dec 2026 format', () => {
      expect(parseTimeToIndex('Dec 2026')).toBe(323);
    });
  });

  describe('aggregateObservations', () => {
    const spec = {
      columns: [
        { name: 'time', type: 'time', quoteFromAsker: 'monthly' },
        { name: 'lane', type: 'entity', quoteFromAsker: 'lane' },
        { name: 'rate', type: 'value', unit: 'USD/ton', quoteFromAsker: 'rate' }
      ]
    };

    it('aggregates observations by time and entity', () => {
      const observations = [
        { time: '2026-12', lane: 'Asia-Europe', value: 100, unit: 'USD/ton', source: 's1', quote: 'rate 100' },
        { time: '2026-12', lane: 'Asia-Europe', value: 120, unit: 'USD/ton', source: 's2', quote: 'rate 120' },
        { time: '2026-12', lane: 'Transpacific', value: 200, unit: 'USD/ton', source: 's3', quote: 'rate 200' },
        { time: '2027-01', lane: 'Asia-Europe', value: 110, unit: 'USD/ton', source: 's4', quote: 'rate 110' },
      ];
      const aggregated = aggregateObservations(observations, spec);
      expect(aggregated).toHaveLength(3);
      const aeDec = aggregated.find(a => a.time === '2026-12' && a.entity === 'Asia-Europe');
      expect(aeDec.median).toBe(110);
      expect(aeDec.count).toBe(2);
      expect(aeDec.min).toBe(100);
      expect(aeDec.max).toBe(120);
    });
  });

  describe('computeTrend', () => {
    it('computes Theil-Sen slope', () => {
      const aggregated = [
        { time: '2026-01', median: 100 },
        { time: '2026-02', median: 105 },
        { time: '2026-03', median: 110 },
        { time: '2026-04', median: 115 },
        { time: '2026-05', median: 120 },
      ];
      const trend = computeTrend(aggregated, { quoteFromAsker: 'monthly' });
      expect(trend.slope).toBeCloseTo(5, 0);
      expect(trend.points).toBe(5);
    });

    it('returns slope 0 for insufficient points', () => {
      const aggregated = [
        { time: '2026-01', median: 100 },
        { time: '2026-02', median: 105 },
      ];
      const trend = computeTrend(aggregated, { quoteFromAsker: 'monthly' });
      expect(trend.slope).toBe(0);
    });
  });

  describe('seasonalOffsets', () => {
    it('returns offsets when >= 12 periods', () => {
      const aggregated = Array.from({ length: 12 }, (_, i) => ({
        time: `2026-${String(i + 1).padStart(2, '0')}`,
        median: 100 + (i % 3) * 10
      }));
      const offsets = seasonalOffsets(aggregated, 'monthly');
      expect(Object.keys(offsets).length).toBeGreaterThan(0);
    });

    it('returns empty when < 12 periods', () => {
      const aggregated = Array.from({ length: 6 }, (_, i) => ({
        time: `2026-${String(i + 1).padStart(2, '0')}`,
        median: 100
      }));
      const offsets = seasonalOffsets(aggregated, 'monthly');
      expect(offsets).toEqual({});
    });
  });

  describe('forecast', () => {
    const spec = {
      columns: [
        { name: 'time', type: 'time', quoteFromAsker: 'monthly trend Dec 2026' },
        { name: 'rate', type: 'value', unit: 'USD/ton', quoteFromAsker: 'rate' }
      ]
    };

    it('produces forecast rows with drift + Theil-Sen', () => {
      const aggregated = [
        { time: '2026-01', median: 100 },
        { time: '2026-02', median: 105 },
        { time: '2026-03', median: 110 },
        { time: '2026-04', median: 115 },
        { time: '2026-05', median: 120 },
        { time: '2026-06', median: 125 },
        { time: '2026-07', median: 130 },
        { time: '2026-08', median: 135 },
        { time: '2026-09', median: 140 },
        { time: '2026-10', median: 145 },
        { time: '2026-11', median: 150 },
        { time: '2026-12', median: 155 },
      ];
      const rows = forecast(aggregated, spec, 3);
      expect(rows).toHaveLength(3);
      expect(rows[0].type).toBe('forecast');
      expect(rows[0].method).toContain('drift');
      expect(rows[0].label).toContain('forecast');
      expect(rows[0].low).not.toBeNull();
      expect(rows[0].high).not.toBeNull();
    });
  });

  describe('buildResultsTable', () => {
    it('combines observed and forecast rows', () => {
      const spec = { columns: [{ name: 'time' }, { name: 'rate' }] };
      const aggregated = [{ time: '2026-12', median: 100, unit: 'USD/ton', type: 'observed', source: 's1', quote: 'q', count: 1, min: 100, max: 100 }];
      const forecastRows = [{ time: '2027-01', value: 105, unit: 'USD/ton', type: 'forecast', method: 'test', basedOn: 1, label: 'forecast', low: 100, high: 110 }];
      const table = buildResultsTable(spec, aggregated, forecastRows);
      expect(table.rows).toHaveLength(2);
      expect(table.rows[0].type).toBe('observed');
      expect(table.rows[1].type).toBe('forecast');
    });
  });
});

describe('the forecast horizon the asker names', () => {
  it('counts the months from the last observed month to the end of the latest year the asker names', async () => {
    const { askedHorizon } = await import('../../src/research/forecast.mjs');
    expect(askedHorizon('trend for December 2026 and 2027', '2026-11')).toBe(13);
    expect(askedHorizon('no year here', '2026-11')).toBe(0);
    expect(askedHorizon('2026', '2026-12')).toBe(0);
  });
});
