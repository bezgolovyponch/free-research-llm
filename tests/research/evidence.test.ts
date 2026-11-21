import { describe, expect, it } from 'vitest';
import { EVIDENCE_CHARS, bm25, diverseOrder, evidenceQuery, passages, retrievalVerdict, selectEvidence, topicCoverage } from '../../src/research/evidence.mjs';

const boilerplate = Array.from({ length: 40 }, (_, i) => `Menu item ${i}. Login. Cookie settings.`).join('\n');
const page = `${boilerplate}\nThe glamping season in the Algarve runs from March to November.\n${boilerplate}\nAverage July highs in the Algarve reach 28 °C.`;

describe('evidence selection (BM25, as GPT Researcher and PaperQA2 rank context)', () => {
  it('splits page text into short passages and scores them by the question terms', () => {
    expect(passages('Short. Bits join until forty characters are reached.\nA line long enough to stand alone as a passage.')).toEqual(['Short. Bits join until forty characters are reached.', 'A line long enough to stand alone as a passage.']);
    expect(passages('x'.repeat(700))).toEqual(['x'.repeat(320), 'x'.repeat(320), 'x'.repeat(60)]);
    const [hit, miss] = bm25(['glamping season algarve', 'cookie settings login'], 'Algarve glamping season');
    expect(hit).toBeGreaterThan(0);
    expect(miss).toBe(0);
  });

  it('sends the model the passages that answer the question, in page order, not the first characters of the page', () => {
    const [ranked] = selectEvidence([{ id: 'S1', kind: 'web', url: 'https://a.example', text: page }], 'Algarve glamping season months');
    expect(ranked.evidence).toBe('The glamping season in the Algarve runs from March to November. … Average July highs in the Algarve reach 28 °C.');
    expect(ranked.evidence).toContain('Average July highs in the Algarve reach 28 °C.');
    expect(ranked.evidence.length).toBeLessThanOrEqual(EVIDENCE_CHARS);
    expect(ranked.relevance).toBeGreaterThan(0);
    expect(page.includes(ranked.evidence.split(' … ')[0])).toBe(true);
  });

  it('grades retrieval before any model call, as CRAG does: correct, ambiguous or incorrect', () => {
    const web = (id: string, text: string) => ({ id, kind: 'web', url: `https://${id}.example`, domain: `${id}.example`, text });
    const q = 'Algarve glamping season';
    expect(retrievalVerdict(selectEvidence([web('a', 'Algarve season'), web('b', 'glamping Algarve')], q))).toBe('correct');
    expect(retrievalVerdict(selectEvidence([web('a', 'Algarve season'), web('b', 'e-bike range')], q))).toBe('ambiguous');
    expect(retrievalVerdict(selectEvidence([web('a', 'e-bike range'), web('b', 'battery')], q))).toBe('incorrect');
    expect(retrievalVerdict(selectEvidence([{ id: 'D1', kind: 'data', url: '', text: 'x' }], q))).toBe('none');
  });

  it('counts how many distinct content terms of the query a page actually covers', () => {
    const query = 'What Czech car sites list hatchbacks? used car hatchback';
    expect(topicCoverage({ title: 'UNESCO World Heritage Centre', snippet: 'World Heritage List', text: 'World Heritage sites in the Czech Republic: Prague historic centre, Cesky Krumlov and the Holašovice village.' }, query)).toBeLessThan(2);
    expect(topicCoverage({ title: 'Ojeté vozy', snippet: 'Inzerce', text: 'Ojeté hatchbacky Škoda Fabia, used car hatchback listings Czech' }, query)).toBeGreaterThanOrEqual(2);
    expect(topicCoverage({ title: 'hatchback used', snippet: 'czech', text: 'hatchback used czech' }, query)).toBe(3);
    expect(topicCoverage({ title: 'used', snippet: '', text: 'used' }, query)).toBe(1);
  });

  it('orders sources by relevance but takes the best page of each site first, user data on top', () => {
    const s = (id: string, domain: string, relevance: number) => ({ id, kind: 'web', domain, relevance });
    expect(diverseOrder([s('S1', 'a', 1), s('S2', 'a', 3), s('S3', 'b', 2), { id: 'U1', kind: 'data', relevance: 0 }]).map((x: { id: string }) => x.id)).toEqual(['U1', 'S2', 'S3', 'S1']);
    expect(evidenceQuery({ title: 'Season', question: 'How long?', metric: 'months' }, { kind: { terms: ['land', 'plot'] } })).toBe('Season How long? months land plot');
  });
});

describe('a source that fits the evidence budget is shown whole (FRL_EVIDENCE_WHOLE)', () => {
  const survey = 'Dodávka tepelných čerpadel na trh v České republice v roce 2024 Výsledek statistického šetření za rok 2024 Statistické šetření v oblasti tepelných čerpadel je prováděno oddělením analýz a datové podpory koncepcí Ministerstva průmyslu a obchodu (MPO) od roku 2004. Šetření je zaměřeno na strukturu dodávek tepelných čerpadel na český trh za předcházející rok. Jak bylo očekáváno v roce 2024 došlo k výraznému poklesu prodeje tepelných čerpadel (o téměř 60 %). Odhad roční dodávky tepelných čerpadel na český trh (ks) Rok Vzduch-voda Vzduch-voda odvětrávací Země-voda Voda-voda Celkem 2010 4 199 0 1 707 53 5 959 2011 4 908 0 1 951 50 6 909 2012 5 323 21 1 808 44 7 196 2013 5 752 23 1 679 49 7 503 2014 6 267 45 1 512 46 7 870 2015 7 304 31 1 463 107 8 905 2016 10 827 40 1 435 83 12 385 2017 13 718 65 1 438 120 15 341 2018 16 977 70 1 568 80 18 695 2019 21 603 67 1 333 84 23 087 2020 22 680 69 1 371 69 24 189 2021 29 737 162 1 566 57 31 522 2022 57 966 120 2 269 85 60 439 2023 52 898 26 2 603 93 55 620 2024 23 094 80 1 634 107 24 918 Pozn.: Tepelná čerpadla vzduch-vzduch nebyla bilancována. 2 3 Zdroj dat: MPO';
  const query = 'Official government statistics What is the 2024 installation figure from MPO or CZ Statistical Office? installation count';
  const sources = () => [{ id: 'S1', url: 'https://stats.example/survey.pdf', text: survey }, { id: 'S2', url: 'https://news.example', text: `${'Heat pumps installed in 2024: official statistics. '.repeat(60)}\n\nEnd of the article.` }];
  const withFlag = <T,>(flag: boolean, body: () => T): T => {
    const before = process.env.FRL_EVIDENCE_WHOLE;
    if (flag) process.env.FRL_EVIDENCE_WHOLE = '1';
    else delete process.env.FRL_EVIDENCE_WHOLE;
    try {
      return body();
    } finally {
      if (before === undefined) delete process.env.FRL_EVIDENCE_WHOLE;
      else process.env.FRL_EVIDENCE_WHOLE = before;
    }
  };

  it('shows a short survey with its table whole, where the passage ranking showed only the lines naming the query words', () => {
    const before = withFlag(false, () => selectEvidence(sources(), query));
    expect(before[0].evidence).not.toContain('2024 23 094 80 1 634 107 24 918');
    const after = withFlag(true, () => selectEvidence(sources(), query));
    expect(after[0].evidence).toBe(survey);
    expect(after[0].relevance).toBe(before[0].relevance);
  });

  it('keeps ranked passages for a source longer than the budget, and the same relevance order', () => {
    const before = withFlag(false, () => selectEvidence(sources(), query));
    const after = withFlag(true, () => selectEvidence(sources(), query));
    expect(sources()[1].text.length).toBeGreaterThan(EVIDENCE_CHARS);
    expect(after[1].evidence).toBe(before[1].evidence);
    expect(diverseOrder(after).map((s: { id: string }) => s.id)).toEqual(diverseOrder(before).map((s: { id: string }) => s.id));
  });
});
