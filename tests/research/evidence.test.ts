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
