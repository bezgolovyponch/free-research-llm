import { describe, expect, it } from 'vitest';
import { describeProfile, parseCsv, profileTable } from '../../src/data/csv.mjs';

describe('csv', () => {
  it('parses quoted fields, embedded delimiters and semicolon files', () => {
    const t = parseCsv('make,model,price\n"Toyota","RAV4, hybrid",18000\nBMW,X3,"21000"\n');
    expect(t.columns).toEqual(['make', 'model', 'price']);
    expect(t.rows[0].model).toBe('RAV4, hybrid');
    expect(parseCsv('a;b\n1;2').rows[0]).toEqual({ a: '1', b: '2' });
  });

  it('profiles numeric and text columns', () => {
    const p = profileTable(parseCsv('make,price\nToyota,10\nToyota,20\nBMW,30\nBMW,\n'));
    expect(p.rowCount).toBe(4);
    const price = p.columns.find((c) => c.name === 'price');
    expect(price).toMatchObject({ type: 'number', count: 3, median: 20, min: 10, max: 30, missing: 1 });
    const make = p.columns.find((c) => c.name === 'make');
    expect(make).toMatchObject({ type: 'text', distinct: 2 });
    expect(describeProfile(p, 'cars.csv')).toMatch(/cars\.csv: 4 rows/);
  });
});
