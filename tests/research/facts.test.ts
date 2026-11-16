import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostBook, MIN_HOST_HISTORY, clusterClaims, credibilityOf, extractFacts, gatherEvidence, gradeFacts, identify, matchSubject, reliabilityOf, sourceMethod, subjectKey, subjectLadder } from '../../src/research/facts.mjs';
import { fakeEmbedder, fakeRouter, seq } from '../helpers/fakes';

const page = 'The rear axle beam rusts at the mount. One car failed its inspection last year. The average price abroad is 1800 euros. Owners praise the low fuel use.';
const questions = [{ id: 'Q1', q: 'Is the type reliable?' }, { id: 'Q2', q: 'Is it cheap to run?' }];
const fact = (host: string, quote: string, extra = {}) => ({ host, url: `https://${host}/page`, quote, for: 'Q1', direction: '-', scope: 'A', ...extra });

describe('facts are sentences picked by id and tagged to a question', () => {
  it('keeps a fact only with real sentence ids, a known question, a direction and a scope', async () => {
    const router = fakeRouter({ facts: { facts: [
      { spans: ['S1'], for: 'Q1', direction: '-', scope: 'A' },
      { spans: ['S2'], for: 'Q1', direction: '-', scope: 'B' },
      { spans: ['S3'], for: 'Q2', direction: '0', scope: 'C' },
      { spans: ['S9'], for: 'Q1', direction: '-', scope: 'A' },
      { spans: ['S4'], for: 'Q7', direction: '+', scope: 'A' },
      { spans: ['S4'], for: 'Q2', direction: 'good', scope: 'A' },
    ] } });
    const facts = await extractFacts({ router }, { questions, source: { url: 'https://www.forum.example.org/t/1', title: 'Thread', text: page } });
    expect(facts).toEqual([
      { quote: 'The rear axle beam rusts at the mount.', for: 'Q1', direction: '-', scope: 'A', url: 'https://www.forum.example.org/t/1', host: 'forum.example.org' },
      { quote: 'One car failed its inspection last year.', for: 'Q1', direction: '-', scope: 'B', url: 'https://www.forum.example.org/t/1', host: 'forum.example.org' },
      { quote: 'The average price abroad is 1800 euros.', for: 'Q2', direction: '0', scope: 'C', url: 'https://www.forum.example.org/t/1', host: 'forum.example.org' },
    ]);
    expect(router.userText('facts')).not.toMatch(/"grade"|"sourceType"|reliab.*label/);
  });

  it('reads the identity of an item per level with a sentence id, and a field without one is null', async () => {
    const router = fakeRouter({ identity: { fields: { L1: { value: 'Alpha', span: 'S1' }, L2: { value: '1.2', span: 'S9' }, L3: null } } });
    const identity = await identify({ router }, { levels: ['make', 'engine', 'year'], text: 'Alpha hatchback for sale. Runs well every day.' });
    expect(identity.fields).toEqual({ L1: { level: 'make', value: 'Alpha', quote: 'Alpha hatchback for sale.' }, L2: null, L3: null });
    expect(subjectKey(identity, ['make', 'engine', 'year'])).toEqual(['Alpha', '', '']);
  });
});

describe('a fact counts only for the same subject, by a voted selection', () => {
  const subject = ['Alpha', 'Beta', '1.2'];

  it('offers the subject ladder as closed options', () => {
    expect(subjectLadder(subject, 'car').map((o: { letter: string; text: string }) => `${o.letter} ${o.text}`)).toEqual([
      'A exactly this variant: Alpha Beta 1.2',
      'B Alpha Beta in every variant',
      'C the wider class: car',
      'D a different variant or a different model',
      'E one single unit, not the type',
    ]);
  });

  it('applies on a majority of A, B or C and stores the level; D, E, U or a split is not applicable', async () => {
    const run = (reply: unknown) => matchSubject({ router: fakeRouter({ 'subject-match': reply }) }, fact('a.example', 'q'), { subject, kind: 'car' });
    expect(await run({ applies: 'B' })).toMatchObject({ applies: true, level: 'B' });
    expect(await run({ applies: 'D' })).toMatchObject({ applies: false, level: 'D' });
    expect(await run({ applies: 'E' })).toMatchObject({ applies: false, level: 'E' });
    expect(await run({ applies: 'U' })).toMatchObject({ applies: false, level: 'U' });
    expect(await run(seq({ applies: 'A' }, { applies: 'D' }, { applies: 'C' }))).toMatchObject({ applies: false, level: null });
  });

  it('caches the verdict per fact and subject key', async () => {
    const router = fakeRouter({ 'subject-match': { applies: 'A' } });
    const cache = new Map();
    await matchSubject({ router }, fact('a.example', 'q'), { subject, kind: 'car', cache });
    await matchSubject({ router }, fact('a.example', 'q'), { subject, kind: 'car', cache });
    expect(router.calls).toHaveLength(2);
    await matchSubject({ router }, fact('a.example', 'q'), { subject: ['Alpha', 'Beta', '1.4'], kind: 'car', cache });
    expect(router.calls).toHaveLength(4);
  });
});

describe('source grades come from corroboration and a per-host record, never from a model label', () => {
  it('gives the credibility table row by row', () => {
    expect([credibilityOf(2, 0, false), credibilityOf(3, 0, false)]).toEqual([1, 1]);
    expect(credibilityOf(1, 0, false)).toBe(2);
    expect([credibilityOf(1, 1, false), credibilityOf(2, 3, false)]).toEqual([3, 3]);
    expect(credibilityOf(0, 1, false)).toBe(4);
    expect([credibilityOf(0, 2, false), credibilityOf(0, 5, false)]).toEqual([5, 5]);
    expect(credibilityOf(0, 0, true)).toBe(6);
  });

  it('clusters same claims across hosts by voted pairs and counts independent hosts', async () => {
    const facts = [
      fact('a.example', 'the rear axle beam rusts through'),
      fact('b.example', 'zadní náprava rezaví u uchycení'),
      fact('c.example', 'rear beam corrosion is common'),
      fact('d.example', 'the rear beam never rusts', { direction: '+' }),
      fact('e.example', 'the timing chain stretches early'),
    ];
    const relation = (request: { messages: { content: string }[] }) => {
      const text = request.messages[1].content;
      if (text.includes('timing chain')) return { relation: 'C' };
      return { relation: text.includes('never rusts') ? 'B' : 'A' };
    };
    const clusters = await clusterClaims({ router: fakeRouter({ 'claim-pair': relation }), embedder: fakeEmbedder() }, facts);
    expect(new Set(clusters.clusterOf.slice(0, 4)).size).toBe(1);
    expect(clusters.clusterOf[4]).not.toBe(clusters.clusterOf[0]);
    const { graded, hostBook } = gradeFacts(facts, clusters);
    expect(graded.map((g: { admiralty: string }) => g.admiralty)).toEqual(['F3', 'F3', 'F3', 'F5', 'F6']);
    expect(graded[0]).toMatchObject({ agreeingHosts: ['b.example', 'c.example'], contradictingHosts: ['d.example'] });
    expect(hostBook['d.example']).toEqual({ confirmed: 0, contradicted: 1, total: 1 });
    expect(hostBook['e.example']).toBeUndefined();
  });

  it('counts the same string on two hosts as one source', async () => {
    const facts = [fact('a.example', 'the rear axle beam rusts'), fact('copy.example', 'the rear axle beam rusts'), fact('b.example', 'rear beam corrosion')];
    const router = fakeRouter({ 'claim-pair': { relation: 'A' } });
    const clusters = await clusterClaims({ router, embedder: fakeEmbedder() }, facts);
    expect(router.userText('claim-pair', 0)).not.toContain('Statement 2: the rear axle beam rusts');
    const { graded } = gradeFacts(facts, clusters);
    expect(graded.map((g: { credibility: number }) => g.credibility)).toEqual([2, 2, 2]);
    expect(graded[2].agreeingHosts).toHaveLength(1);
  });

  it('never lets a seller statement corroborate', () => {
    const facts = [fact('a.example', 'x one'), fact('seller.example', 'x two')];
    const clusters = { clusterOf: [0, 0], edges: [{ a: 0, b: 1, agree: true }] };
    expect(gradeFacts(facts, clusters, { 'seller.example': { method: 'E', confirmed: 0, contradicted: 0, total: 0 } }).graded[0].credibility).toBe(6);
    expect(gradeFacts(facts, clusters, { 'seller.example': { method: 'D', confirmed: 0, contradicted: 0, total: 0 } }).graded[0].credibility).toBe(2);
  });

  it('judges reliability F below 3 facts, then by the share confirmed, whatever the fact says about itself', () => {
    expect(MIN_HOST_HISTORY).toBe(3);
    expect(reliabilityOf(undefined)).toBe('F');
    expect(reliabilityOf({ confirmed: 2, total: 2 })).toBe('F');
    expect([reliabilityOf({ confirmed: 9, total: 10 }), reliabilityOf({ confirmed: 3, total: 4 }), reliabilityOf({ confirmed: 6, total: 10 }), reliabilityOf({ confirmed: 4, total: 10 }), reliabilityOf({ confirmed: 1, total: 4 })]).toEqual(['A', 'B', 'C', 'D', 'E']);
    const labelled = fact('a.example', 'x', { sourceType: 'statistic', grade: 'A', reliability: 'A' });
    const { graded } = gradeFacts([labelled], { clusterOf: [0], edges: [] }, { 'a.example': { confirmed: 8, contradicted: 0, total: 10 } });
    expect(graded[0].admiralty).toBe('B6');
    expect(gradeFacts([labelled], { clusterOf: [0], edges: [] }).graded[0].admiralty).toBe('F6');
  });

  it('classifies the method of a host once, with a quote, and keeps the book on disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-hosts-'));
    const file = path.join(dir, 'hosts.json');
    const book = new HostBook({ file });
    await book.load();
    const router = fakeRouter({ 'source-method': seq({ method: 'D', span: 'S4' }, { method: 'A', span: 'S99' }) });
    book.setMethod('forum.example.org', await sourceMethod({ router, embedder: fakeEmbedder() }, { title: 'Thread', text: page }));
    expect(book.records['forum.example.org']).toEqual({ confirmed: 0, contradicted: 0, total: 0, method: 'D', quote: 'Owners praise the low fuel use.' });
    expect(await sourceMethod({ router, embedder: fakeEmbedder() }, { title: 'Thread', text: page })).toEqual({ method: 'F', quote: '' });
    book.absorb({ 'forum.example.org': { confirmed: 1, contradicted: 0, total: 1 } });
    await book.save();
    const again = new HostBook({ file });
    expect((await again.load())['forum.example.org']).toEqual({ confirmed: 1, contradicted: 0, total: 1, method: 'D', quote: 'Owners praise the low fuel use.' });
    expect(again.has('forum.example.org')).toBe(true);
  });
});

describe('gatherEvidence', () => {
  it('keeps single-unit facts, market figures and other variants out of the applied facts and lists them', async () => {
    const sources = [
      { url: 'https://forum.example.org/t/1', title: 'Thread', text: page },
      { url: 'https://test.example.net/report', title: 'Report', text: 'Corrosion of the rear axle mount is frequent. The diesel variant has injector faults.' },
    ];
    const router = fakeRouter({
      'source-method': { method: 'D', span: 'S1' },
      facts: (request: { messages: { content: string }[] }) => (request.messages[1].content.includes('Source: Thread')
        ? { facts: [{ spans: ['S1'], for: 'Q1', direction: '-', scope: 'A' }, { spans: ['S2'], for: 'Q1', direction: '-', scope: 'B' }, { spans: ['S3'], for: 'Q2', direction: '0', scope: 'C' }] }
        : { facts: [{ spans: ['S1'], for: 'Q1', direction: '-', scope: 'A' }, { spans: ['S2'], for: 'Q1', direction: '-', scope: 'A' }] }),
      'subject-match': (request: { messages: { content: string }[] }) => ({ applies: request.messages[1].content.includes('diesel') ? 'D' : 'B' }),
      'claim-pair': { relation: 'A' },
    });
    const hosts = new HostBook();
    const evidence = await gatherEvidence({ router, embedder: fakeEmbedder() }, { questions, sources, subject: ['Alpha', '1.2'], kind: 'car', hosts });
    expect(evidence.facts.map((f: { id: string; quote: string; credibility: number; level: string }) => [f.id, f.quote, f.credibility, f.level])).toEqual([
      ['F1', 'The rear axle beam rusts at the mount.', 2, 'B'],
      ['F2', 'Corrosion of the rear axle mount is frequent.', 2, 'B'],
    ]);
    expect(evidence.notApplicable.map((f: { quote: string; reason: string }) => [f.quote, f.reason])).toEqual([
      ['One car failed its inspection last year.', 'scope B: one single unit'],
      ['The average price abroad is 1800 euros.', 'scope C: a market figure such as a price or a trend'],
      ['The diesel variant has injector faults.', 'subject D'],
    ]);
    expect(hosts.records['forum.example.org']).toMatchObject({ method: 'D', confirmed: 1, total: 1 });
    expect(router.count('source-method')).toBe(2);
  });
});
