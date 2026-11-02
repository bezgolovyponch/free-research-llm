import { describe, expect, it } from 'vitest';
import { contextOf, quotesOtherPieces, isStale, CAUSE_MAX_CHARS, MAX_SUPPORT_CLAIMS, SUPPORT_LOGIC_VERSION, affectsResult, causeOf, claimsToCheck, keyTerms, looksEnglish, normalizeVote, resolveFromSources, supportAudit, supportPrompt, supportRecord, supportVerdict, termCheck, toConfirm } from '../../src/research/support.mjs';

const PERMIT = 'A building permit costs €950';
const yes = (provider = 'gemini') => ({ provider, model: 'm', vote: 'yes', reason: '' });
const no = (reason = 'quote is about bell tents', provider = 'groq') => ({ provider, model: 'm', vote: 'no', reason });

describe('termCheck', () => {
  it('fails a quote about another subject that only shares the number', () => {
    const term = termCheck(PERMIT, 'Bell tents cost from €950');
    expect(term.passed).toBe(false);
    expect(term.missing).toEqual(expect.arrayContaining(['permit']));
  });

  it('passes a quote about the same subject', () => {
    expect(termCheck(PERMIT, 'The building permit costs €950 in Czechia')).toEqual({ passed: true, missing: [] });
  });

  it('leaves non-English quotes to the model vote', () => {
    expect(termCheck(PERMIT, 'Stavební povolení stojí 950 eur')).toMatchObject({ passed: true, skipped: expect.any(String) });
    expect(looksEnglish('Precio de la parcela 950 euros')).toBe(false);
  });

  it('ignores numbers and filler words as key terms', () => {
    expect([...keyTerms('The price per year is 950 for a pitch')]).toEqual(['pitch']);
  });
});

describe('affectsResult', () => {
  it('counts claims with numbers, values, calculation inputs and deciding pieces', () => {
    expect(affectsResult({ text: 'Pitches cost €20 a night' })).toBe(true);
    expect(affectsResult({ text: 'Rent is cheap', value: 12 })).toBe(true);
    expect(affectsResult({ text: 'Camping needs municipal approval' }, {}, { method: 'analysis' })).toBe(false);
    expect(affectsResult({ text: 'Camping needs municipal approval' }, {}, { method: 'analysis', decides: true })).toBe(true);
    expect(affectsResult({ text: 'Camping needs municipal approval' }, {}, { method: 'calculation' })).toBe(true);
  });

  it('skips assumptions', () => {
    expect(affectsResult({ text: 'Occupancy 60%', assumption: true })).toBe(false);
  });
});

describe('votes and verdicts', () => {
  it('asks for the same subject, quantity and place', () => {
    const [system, user] = supportPrompt({ claim: PERMIT, quote: 'Bell tents cost from €950' });
    expect(system.content).toContain('JSON');
    expect(user.content).toContain(PERMIT);
    expect(user.content).toContain('same subject, quantity and place');
  });

  it('normalizes model replies', () => {
    expect(normalizeVote({ supports: ' YES ', reason: 'x'.repeat(100) }, { provider: 'gemini' })).toEqual({ provider: 'gemini', model: null, vote: 'yes', reason: 'x'.repeat(80) });
    expect(normalizeVote({ supports: 'maybe' }).vote).toBeNull();
  });

  it('needs both models to agree', () => {
    expect(supportVerdict([yes(), yes()])).toBe('supported');
    expect(supportVerdict([no(), no()])).toBe('unsupported');
    expect(supportVerdict([yes(), no()])).toBe('disagree');
    expect(supportVerdict([yes(), { ...yes(), vote: 'partial' }])).toBe('disagree');
    expect(supportVerdict([yes()])).toBe('unchecked');
    expect(supportVerdict([yes(), { vote: null }])).toBe('unchecked');
  });

  it('lets code overrule two yes votes when the quote shares too few terms', () => {
    const record = supportRecord({ votes: [yes(), yes()], term: termCheck(PERMIT, 'Bell tents cost from €950') });
    expect(record).toMatchObject({ version: SUPPORT_LOGIC_VERSION, verdict: 'disagree' });
    expect(record.cause).toContain('• Quote does not mention:');
    expect(toConfirm(record)).toBe(true);
  });

  it('keeps a supported record without a cause', () => {
    const record = supportRecord({ votes: [yes(), yes()], term: termCheck(PERMIT, 'The building permit costs €950 in Czechia') });
    expect(record.verdict).toBe('supported');
    expect(record.cause).toBe('');
    expect(toConfirm(record)).toBe(false);
  });
});

describe('causeOf', () => {
  it('writes short bullets within the limit', () => {
    const cause = causeOf({ verdict: 'disagree', votes: [yes(), no('y'.repeat(80)), no('z'.repeat(80))], missing: ['permit', 'build', 'czech', 'extra'], blocker: 'Zoning ended 6 of 8 plots' });
    expect(cause.startsWith('• The two checking models disagree')).toBe(true);
    expect(cause).toContain('• Quote does not mention: permit, build, czech');
    expect(cause.length).toBeLessThanOrEqual(CAUSE_MAX_CHARS);
  });

  it('is empty when the claim is supported', () => {
    expect(causeOf({ verdict: 'supported' })).toBe('');
  });
});

describe('claimsToCheck', () => {
  it('takes attributed claims that affect the result, at most the cap', () => {
    const claims = [
      { text: 'Not quoted €5', attributed: false },
      { text: 'Camping needs approval', attributed: true },
      ...Array.from({ length: 8 }, (_, i) => ({ text: `Fee ${i + 1} €`, attributed: true })),
    ];
    const picked = claimsToCheck({ claims }, { method: 'analysis' });
    expect(picked).toHaveLength(MAX_SUPPORT_CLAIMS);
    expect(picked[0].text).toBe('Fee 1 €');
  });
});

describe('roll-up pieces', () => {
  it('are not meaning-checked: they quote other pieces, not web pages', () => {
    const rollup = { id: 'D1', sources: [{ id: 'D1.1', kind: 'node' }, { id: 'D1.2', kind: 'node' }] };
    const claim = { text: 'D1.1 says: margin 300', attributed: true };
    expect(quotesOtherPieces(rollup)).toBe(true);
    expect(isStale(claim, { claims: [claim] }, rollup)).toBe(false);
    expect(claimsToCheck({ claims: [claim] }, rollup)).toEqual([]);
    expect(isStale(claim, { claims: [claim] }, { id: 'D2', sources: [{ id: 'S1', kind: 'web' }] })).toBe(true);
  });
});

describe('resolveFromSources', () => {
  const claim = { text: PERMIT, quote: 'Bell tents cost from €950' };

  it('finds a sentence in the fetched sources with the number and the subject', () => {
    const sources = [
      { id: 'S1', text: 'Bell tents cost from €950. Delivery is extra.' },
      { id: 'S2', text: 'Rules changed in 2024. The building permit for a small camp costs €950 in most districts. Apply early.' },
    ];
    expect(resolveFromSources(claim, sources)).toEqual({ quote: 'The building permit for a small camp costs €950 in most districts.', sourceId: 'S2' });
  });

  it('returns null when no sentence backs the claim', () => {
    expect(resolveFromSources(claim, [{ id: 'S1', text: 'Bell tents cost from €950. A permit is needed for a camp.' }])).toBeNull();
  });
});

describe('supportAudit', () => {
  it('queues disagreements first and counts claims checked under older logic', () => {
    const support = (verdict) => ({ version: SUPPORT_LOGIC_VERSION, verdict, votes: [], missing: [], cause: `• ${verdict}` });
    const nodes = [
      { id: 'D1', finding: { claims: [{ text: 'Fee €1', attributed: true, support: support('unchecked') }, { text: 'Fee €2', attributed: true, support: support('unsupported') }] } },
      { id: 'D2', finding: { claims: [{ text: 'Fee €3', attributed: true, support: support('disagree') }, { text: 'Fee €4', attributed: true, support: support('supported') }, { text: 'Fee €5', attributed: true }, { text: 'Fee €6', attributed: true, support: { ...support('supported'), version: 1 } }] } },
      { id: 'D3', finding: null },
    ];
    const audit = supportAudit(nodes);
    expect(audit).toMatchObject({ checked: 5, supported: 2, toConfirm: 3, disagree: 1, stale: 2 });
    expect(audit.queue.map((q) => q.verdict)).toEqual(['disagree', 'unsupported', 'unchecked']);
    expect(audit.queue[0]).toMatchObject({ nodeId: 'D2', claim: 'Fee €3' });
  });
});

describe('live-data fixes', () => {
  it('does not treat source ids as numbers or meta words as key terms', () => {
    expect(affectsResult({ text: 'S1 is about glamping tents, not land parcels for sale.' }, {}, { method: 'lookup' })).toBe(false);
    expect(affectsResult({ text: 'D1.2 shows the route' }, {}, { method: 'lookup' })).toBe(false);
    expect([...keyTerms('The source S2 identifies a land for sale page')]).toEqual(['land', 'sale']);
  });

  it('judges a short quote by its sentence in the source', () => {
    const quote = 'with bids reaching an average of around US$100,000 per sq m';
    const text = 'Land auctions in the southern hub of Vietnam in late 2021 drew crowds, with bids reaching an average of around US$100,000 per sq m.';
    const context = contextOf(quote, [{ id: 'S4', text }], ['S4']);
    expect(context).toContain('Vietnam');
    expect(termCheck('Vietnam southern hub land auctions had bids around US$100,000 per sq m', context).passed).toBe(true);
    expect(contextOf(quote, [{ id: 'S4', text }], ['S9'])).toBe('');
  });

  it('matches terms with and without accents', () => {
    expect(termCheck('Stavební pozemek Frenštát has a price', 'Stavebni pozemek 283 m2, Frenstat p. R., price on request').missing).toEqual([]);
  });

  it('counts only claims inside the per-piece cap as stale', () => {
    const claims = Array.from({ length: 9 }, (_, i) => ({ text: `Fee ${i + 1} €`, attributed: true }));
    expect(supportAudit([{ id: 'D1', finding: { claims } }]).stale).toBe(MAX_SUPPORT_CLAIMS);
  });
});
