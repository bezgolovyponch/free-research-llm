import { describe, expect, it } from 'vitest';
import { entityDomains, entityNames, entityQueries, ownerOnly, relevance, scopedQueries, selectDiverse, sourceTier, terms } from '../../src/search/selection.mjs';

const q = 'Create an action plan for DeepMedChem https://www.deepmedchem.com/#team against https://www.isomorphiclabs.com/ and https://boltz.com/';

describe('diverse, primary-first source selection', () => {
  it('finds the companies named in the question and treats their sites, papers and code as primary', () => {
    const domains = entityDomains(q);
    expect(domains).toEqual(['deepmedchem.com', 'isomorphiclabs.com', 'boltz.com']);
    expect(entityNames(domains)).toEqual(['deepmedchem', 'isomorphiclabs', 'boltz']);
    expect(sourceTier('https://www.deepmedchem.com/features', domains)).toBe('primary');
    expect(sourceTier('https://github.com/jwohlwend/boltz', domains)).toBe('primary');
    expect(sourceTier('https://www.biorxiv.org/content/10.1101/x', domains)).toBe('primary');
    expect(sourceTier('https://www.marketresearchfuture.com/reports/ai', domains)).toBe('low');
    expect(sourceTier('https://dioptionermblqg.netlify.app/x', domains)).toBe('low');
    expect(sourceTier('https://www.reuters.com/x', domains)).toBe('secondary');
  });

  it('picks relevant sources from every query, at most two per site and two low-quality ones, preferring primary', () => {
    const c = (url: string, title: string, query: string) => ({ url, title, snippet: '', text: '', query });
    const candidates = [
      c('https://www.marketresearchfuture.com/a', 'AI drug discovery market size', 'q1'),
      c('https://www.marketresearchfuture.com/b', 'AI drug discovery market', 'q1'),
      c('https://www.marketresearchfuture.com/c', 'AI drug discovery market Europe', 'q1'),
      c('https://www.researchandmarkets.com/d', 'AI drug discovery market', 'q1'),
      c('https://www.emergenresearch.com/e', 'AI drug discovery market', 'q1'),
      c('https://www.isomorphiclabs.com/news', 'Isomorphic Labs drug discovery partnerships', 'q2'),
      c('https://github.com/jwohlwend/boltz', 'Boltz drug discovery model', 'q3'),
      c('https://grafana.com/docs/x', 'Grafana dashboards', 'q3'),
    ];
    const picked = selectDiverse(candidates, { max: 5, wanted: terms('AI drug discovery partnerships Isomorphic Boltz'), entities: entityDomains(q) });
    const hosts = picked.map((p) => new URL(p.url).hostname.replace('www.', ''));
    expect(hosts.slice(0, 2).sort()).toEqual(['github.com', 'isomorphiclabs.com']);
    expect(picked.filter((p) => p.tier === 'low')).toHaveLength(2);
    expect(hosts.filter((h) => h === 'marketresearchfuture.com').length).toBeLessThanOrEqual(2);
    expect(hosts).not.toContain('grafana.com');
  });

  it('spreads sources across the research by penalising sites other pieces already use', () => {
    const c = (url: string) => ({ url, title: 'Boltz model benchmarks', snippet: '', text: '', query: 'q' });
    const picked = selectDiverse([c('https://news.example-a.com/1'), c('https://news.example-b.com/1')], { max: 1, wanted: terms('Boltz benchmarks'), usedDomains: { 'news.example-a.com': 4 } });
    expect(picked[0].url).toBe('https://news.example-b.com/1');
    expect(relevance({ title: 'Boltz benchmarks' }, [])).toBe(0);
  });

  it('does not search for a private company\'s own figures, and scopes queries to the named companies', () => {
    expect(ownerOnly({ title: 'Monthly cash burn', question: 'Monthly cash burn of DeepMedChem (EUR) Q2-2026' }, ['deepmedchem'])).toBe('deepmedchem');
    expect(ownerOnly({ title: 'Feature gap', question: 'Which features does DeepMedChem lack versus Boltz?' }, ['deepmedchem'])).toBeNull();
    expect(ownerOnly({ title: 'Isomorphic revenue', question: 'Isomorphic Labs revenue 2025' }, ['deepmedchem'])).toBeNull();
    expect(entityQueries({ title: 'Boltz pricing plans', question: 'What does Boltz charge per seat?' }, entityDomains(q))).toEqual(['site:boltz.com boltz pricing plans']);
  });

  it('adds the company names to queries that leave them out, and ranks pages that never mention them lower', () => {
    const node = { title: 'Pricing gap', question: 'Price difference DeepMedChem vs Boltz (EUR/month)', searchQueries: ['DeepMedChem pricing'] };
    expect(scopedQueries(node, ['deepmedchem', 'isomorphiclabs', 'boltz'])).toEqual(['Pricing gap deepmedchem boltz', 'DeepMedChem pricing', 'Price difference DeepMedChem vs Boltz (EUR/month)']);
    expect(scopedQueries({ title: 'Golf price', question: 'Golf price in DE' }, [])).toEqual(['Golf price', 'Golf price in DE']);
    const c = (url: string, title: string) => ({ url, title, snippet: '', text: '', query: 'q' });
    const picked = selectDiverse([c('https://finance.yahoo.com/gap', 'Is Gap (GPS) pricing right'), c('https://www.chemistryworld.com/x', 'Boltz pricing for academic labs')], { max: 1, wanted: terms('pricing gap boltz'), names: ['boltz'] });
    expect(picked[0].url).toBe('https://www.chemistryworld.com/x');
  });
});
