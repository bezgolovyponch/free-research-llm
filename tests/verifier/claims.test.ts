import { describe, expect, it } from 'vitest';
import { claimsToCheck, judgeClaim, looksEnglish, normalize, numbers, terms } from '../../verifier/claims.mjs';

const permit = { text: 'A building permit costs €950', quote: 'The building permit costs €950 for small sites' };
const page = ['Fees: The building permit costs €950 for small sites. Book now.'];

describe('external verifier: reading claim text the way a person would', () => {
  it('flattens case and accents, joins thousands and keeps only money and digits', () => {
    expect(normalize('  Café  1 200 € ')).toBe('cafe 1200 €');
    expect(normalize('1,200 and 1.200 and 12,5')).toBe('1200 and 1200 and 12 5');
    expect(normalize('Prix: 1 200 € (TTC)')).toBe('prix 1200 € ttc');
  });

  it('reads amounts, drops four-digit years and turns a decimal comma into a dot', () => {
    expect(numbers('Costs 1 200 € in 2024 and 950 in 2025')).toEqual([1200, 950]);
    expect(numbers('12,5 and 1.200')).toEqual([12.5, 1200]);
    expect(numbers('1900 2099 2100')).toEqual([2100]);
  });

  it('does not read source and piece ids as numbers or terms', () => {
    expect(numbers('S4 states the distance is 1911 kilometers')).toEqual([1911]);
    expect(terms('The source S2 identifies a page').has('s2')).toBe(false);
  });

  it('compares the content words and ignores filler, plurals and prices', () => {
    expect([...terms('The building permit costs €950 for small sites')].sort()).toEqual(['building', 'permit', 'site', 'small']);
    expect([...terms('Prices of tents and years')]).toEqual(['tent']);
    expect(looksEnglish('The building permit is in the area')).toBe(true);
    expect(looksEnglish('Povolení stavby v malých lokalitách')).toBe(false);
  });
});

describe('external verifier: one claim at a time', () => {
  it('refutes a quote that is on the page but about something else', () => {
    const out = judgeClaim({ text: permit.text, quote: 'Bell tents cost from €950 in the area' }, ['Bell tents cost from €950 in the area. Book now.']);
    expect(out.status).toBe('refuted');
    expect(out.detail).toContain('something else');
  });

  it('confirms a quote that carries the claim\'s number and key terms', () => {
    expect(judgeClaim(permit, page)).toEqual({ status: 'confirmed', detail: 'quote, numbers and key terms found' });
  });

  it('refutes a quote that is not on the cited page', () => {
    expect(judgeClaim(permit, ['Something entirely different'])).toEqual({ status: 'refuted', detail: 'quote not on the cited page' });
  });

  it('refutes a claim whose number is missing from its own quote', () => {
    expect(judgeClaim({ text: 'A building permit costs €960', quote: permit.quote }, page)).toEqual({ status: 'refuted', detail: 'number 960 not in the quote' });
  });

  it('confirms a non-English quote on its numbers alone and says meaning was not compared', () => {
    const czech = { text: 'Povolení stavby stojí 950 €', quote: 'Povolení stavby stojí 950 € v malých lokalitách' };
    expect(judgeClaim(czech, ['Povolení stavby stojí 950 € v malých lokalitách.'])).toEqual({ status: 'confirmed', detail: 'quote and numbers found; meaning not compared (not English)' });
  });

  it('confirms a short quote when the page sentence around it names the claim\'s subject', () => {
    const claim = { text: 'Vietnam land auctions had bids around 100000 USD per sq m', quote: 'with bids reaching an average of around US$100,000 per sq m' };
    const text = 'Land auctions in the southern hub of Vietnam in late 2021 drew crowds, with bids reaching an average of around US$100,000 per sq m.';
    expect(judgeClaim(claim, [text])).toEqual({ status: 'confirmed', detail: 'quote, numbers and key terms found' });
  });

  it('keeps the bell-tent quote refuted for the permit claim', () => {
    expect(judgeClaim({ text: 'A building permit costs €950', quote: 'Bell tents cost from €950' }, ['Offer: Bell tents cost from €950 incl. delivery'])).toEqual({ status: 'refuted', detail: 'quote is about something else: missing building, permit' });
  });

  it('leaves a claim unconfirmed when the cited page could not be read', () => {
    expect(judgeClaim(permit, [])).toEqual({ status: 'unconfirmed', detail: 'cited page could not be read' });
    expect(judgeClaim(permit, [''])).toEqual({ status: 'unconfirmed', detail: 'cited page could not be read' });
  });
});

describe('external verifier: which claims need checking', () => {
  it('skips assumptions and number-less claims and maps source ids to the cited urls', () => {
    const project = {
      nodes: [{
        id: 'n1',
        method: 'desk research',
        finding: { claims: [
          { text: 'A building permit costs €950', quote: 'The building permit costs €950 for small sites', sourceIds: ['S1'] },
          { text: 'The same permit costs €950', quote: 'The building permit costs €950 for small sites', assumption: true, sourceIds: ['S1'] },
          { text: 'A building permit is needed', quote: 'A permit is needed', sourceIds: ['S1'] },
          { text: 'A second fee is 12', quote: 'The second fee is 12', assumption: false, sourceIds: ['S2', 'MISSING'] },
        ] },
        sources: [{ id: 'S1', url: 'https://www.mzcr.cz/x', title: 'Ministry' }, { id: 'S2', url: 'https://www.mzcr.cz/y', title: 'Other' }],
      }],
    };
    expect(claimsToCheck(project)).toEqual([
      { nodeId: 'n1', text: 'A building permit costs €950', quote: 'The building permit costs €950 for small sites', urls: ['https://www.mzcr.cz/x'] },
      { nodeId: 'n1', text: 'A second fee is 12', quote: 'The second fee is 12', urls: ['https://www.mzcr.cz/y'] },
    ]);
  });

  it('skips roll-up claims with no web page and claims whose only digit is a source id', () => {
    const project = {
      nodes: [{
        id: 'n2',
        method: 'roll-up',
        finding: { claims: [
          { text: 'The distance is 1911 kilometers', quote: 'The distance is 1911 kilometers', sourceIds: ['D1'] },
          { text: 'S1 identifies a land for sale page', quote: 'Land for sale', sourceIds: ['S1'] },
        ] },
        sources: [{ id: 'S1', url: 'https://www.mzcr.cz/z', title: 'Listings' }, { id: 'D1', title: 'Driver piece' }],
      }],
    };
    expect(claimsToCheck(project)).toEqual([]);
  });
});

describe('the permit example without English stopwords', () => {
  it('compares meaning even when the quote is a bare fragment', () => {
    expect(looksEnglish('Bell tents cost from €950')).toBe(true);
    expect(judgeClaim({ text: 'A building permit costs €950', quote: 'Bell tents cost from €950' }, ['Offer: Bell tents cost from €950 incl. delivery']).status).toBe('refuted');
  });
});
