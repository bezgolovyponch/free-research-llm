import { describe, expect, it } from 'vitest';
import { followUpQueries, mergeSources } from '../../src/research/followup.mjs';

describe('followUpQueries', () => {
  const node = { title: 'RAV4 price Germany', metric: 'median asking price', searchQueries: ['RAV4 hybrid price Germany'] };

  it('turns gaps into short search queries and adds the metric', () => {
    const finding = { gaps: ['Need the median 2026 asking price for 2019 RAV4 hybrids on mobile.de, split by mileage band and trim level please'] };
    expect(followUpQueries(node, finding)).toEqual([
      'Need the median 2026 asking price for 2019 RAV4 hybrids on mobile.de',
      'median asking price RAV4 price Germany',
    ]);
  });

  it('skips queries already asked and caps the count at three', () => {
    const finding = { gaps: ['gap number one here', 'gap number two here', 'gap number three here', 'gap number four here'] };
    expect(followUpQueries(node, finding, ['GAP NUMBER ONE HERE'])).toEqual(['gap number two here', 'gap number three here', 'gap number four here']);
  });
});

describe('mergeSources', () => {
  it('numbers new web sources after existing ones and keeps user data last', () => {
    const existing = [{ id: 'S1', kind: 'web' }, { id: 'D1', kind: 'data' }];
    const { sources, added } = mergeSources(existing, [{ kind: 'web', url: 'https://n.example' }]);
    expect(sources.map((s) => s.id)).toEqual(['S1', 'S2', 'D1']);
    expect(added).toHaveLength(1);
  });
});
