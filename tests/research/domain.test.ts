import { describe, expect, it } from 'vitest';
import {
  DOMAIN_ASPECTS,
  domainFindingsPrompt,
  domainQueryPrompt,
  domainUnderstanding,
  hintCandidates,
  hubQueryPrompt,
  hubsFrom,
  mergeFindings,
  mentionsTerm,
  supportedHintTerms,
  verifiedFindings,
} from '../../src/research/domain.mjs';

const pages = [
  {
    id: 'D1',
    url: 'https://www.vintagehub.com/guide/vintage-clothing-grades',
    text: [
      'Grade A vintage clothing is the highest grade of sorted branded clothing, with the fewest defects.',
      'Wholesalers sell grade A clothing in bales of about 45 kilograms.',
      'Buyers in Europe and Japan pay a premium per kilogram for grade A bales.',
      'Wiping rags and textile waste are sold alongside clothing bales but are not wearable clothing.',
      'The biggest sorting plants for vintage clothing stand in the Netherlands and Germany.',
    ].join(' '),
  },
  {
    id: 'D2',
    url: 'https://threadandsupply.com/blog/what-is-grade-a',
    text: [
      'Grade A branded clothing is the best grade of sorted clothing, with the highest quality and the fewest defects.',
      'Stock in the vintage clothing trade is usually priced per kilogram.',
      'Second hand traders buy grade A bales to resell to vintage shops.',
      'Wiping rags are not vintage clothing, they are a by-product of sorting.',
      'Vintage clothing is concentrated in the Netherlands, Germany and the United Kingdom.',
    ].join(' '),
  },
  {
    id: 'D3',
    url: 'https://selvedge.io/markets/vintage-clothing-wholesale',
    text: [
      'The largest trade hubs for vintage clothing wholesale are in the Netherlands and Germany.',
      'Grade A clothing bales are sold per kilogram by the tonne in Europe.',
      'Vintage clothing is used by upcycling brands and by resale shops in the United States.',
    ].join(' '),
  },
];

const reply1 = {
  data: {
    findings: [
      { aspect: 'object', statement: 'Branded vintage clothing is sold wholesale in bales', quote: 'Wholesalers sell grade A clothing in bales of about 45 kilograms.', sourceId: 'D1' },
      { aspect: 'terms', statement: 'Grade A is the highest grade of branded vintage clothing', quote: 'Grade A vintage clothing is the highest grade of sorted branded clothing, with the fewest defects.', sourceId: 'D1' },
      { aspect: 'quality', statement: 'Grade A has the fewest defects', quote: 'Grade A vintage clothing is the highest grade of sorted branded clothing, with the fewest defects.', sourceId: 'D1' },
      { aspect: 'process', statement: 'Wholesalers sort clothing into grades and sell bales', quote: 'Wholesalers sell grade A clothing in bales of about 45 kilograms.', sourceId: 'D1' },
      { aspect: 'actors', statement: 'Wholesalers sell grade A clothing in bales', quote: 'Wholesalers sell grade A clothing in bales of about 45 kilograms.', sourceId: 'D1' },
      { aspect: 'use', statement: 'Buyers in Europe and Japan buy grade A bales at a premium per kilogram', quote: 'Buyers in Europe and Japan pay a premium per kilogram for grade A bales.', sourceId: 'D1' },
      { aspect: 'where', statement: 'The biggest sorting plants stand in the Netherlands and Germany', quote: 'The biggest sorting plants for vintage clothing stand in the Netherlands and Germany.', sourceId: 'D1' },
      { aspect: 'not', statement: 'Wiping rags are sold alongside clothing bales but are not wearable clothing', quote: 'Wiping rags and textile waste are sold alongside clothing bales but are not wearable clothing.', sourceId: 'D1' },
      { aspect: 'price', statement: 'invalid aspect', quote: 'Wholesalers sell grade A clothing in bales of about 45 kilograms.', sourceId: 'D1' },
      { aspect: 'quality', statement: 'paraphrased quote is not on the page', quote: 'Grade A clothing is sold at a very good price in Europe.', sourceId: 'D1' },
    ],
  },
};

const reply2 = {
  data: {
    findings: [
      { aspect: 'terms', statement: 'Grade A is the best grade of sorted branded clothing with the highest quality', quote: 'Grade A branded clothing is the best grade of sorted clothing, with the highest quality and the fewest defects.', sourceId: 'D2' },
      { aspect: 'quality', statement: 'Grade A has the highest quality and the fewest defects', quote: 'Grade A branded clothing is the best grade of sorted clothing, with the highest quality and the fewest defects.', sourceId: 'D2' },
      { aspect: 'process', statement: 'Second hand traders buy grade A bales to resell them', quote: 'Second hand traders buy grade A bales to resell to vintage shops.', sourceId: 'D2' },
      { aspect: 'actors', statement: 'Second hand traders buy and resell grade A bales', quote: 'Second hand traders buy grade A bales to resell to vintage shops.', sourceId: 'D2' },
      { aspect: 'where', statement: 'Vintage clothing is concentrated in the Netherlands, Germany and the United Kingdom', quote: 'Vintage clothing is concentrated in the Netherlands, Germany and the United Kingdom.', sourceId: 'D2' },
      { aspect: 'not', statement: 'Wiping rags are not vintage clothing but a by-product of sorting', quote: 'Wiping rags are not vintage clothing, they are a by-product of sorting.', sourceId: 'D2' },
    ],
  },
};

const reply3 = {
  data: {
    findings: [
      { aspect: 'object', statement: 'Vintage clothing is traded by the tonne in wholesale hubs', quote: 'The largest trade hubs for vintage clothing wholesale are in the Netherlands and Germany.', sourceId: 'D3' },
      { aspect: 'terms', statement: 'Grade A clothing bales are sold per kilogram by the tonne', quote: 'Grade A clothing bales are sold per kilogram by the tonne in Europe.', sourceId: 'D3' },
      { aspect: 'use', statement: 'Upcycling brands and resale shops use vintage clothing in the United States', quote: 'Vintage clothing is used by upcycling brands and by resale shops in the United States.', sourceId: 'D3' },
    ],
  },
};

describe('domain prompts', () => {
  it('asks for 6 to 8 queries in the given languages', () => {
    const messages = domainQueryPrompt({ question: 'Where can I buy branded vintage clothing by the kilo?', purpose: 'reselling to shops', languages: ['English', 'Dutch'] });
    expect(messages[0].role).toBe('system');
    expect(messages[1].content).toContain('6 to 8 web search queries');
    expect(messages[1].content).toContain('English, Dutch');
    expect(messages[1].content).toContain('{"queries"');
    expect(messages[1].content).toContain('vintage clothing');
  });

  it('names the object to study and the user hint, and asks for the trade, not brand history', () => {
    const messages = domainQueryPrompt({
      question: 'Who sells Barbour jackets in second hand?',
      purpose: 'buying stock',
      languages: ['English', 'German'],
      object: 'branded second-hand clothing, vintage clothing, grade A',
      hint: 'branded vintage clothing wholesale: graded A/cream, sold per kg in bales',
    });
    expect(messages[1].content).toContain('OBJECT TO STUDY');
    expect(messages[1].content).toContain('branded second-hand clothing, vintage clothing, grade A');
    expect(messages[1].content).toContain('USER HINT');
    expect(messages[1].content).toContain('graded A/cream');
    expect(messages[1].content).toContain('TRADE');
    expect(messages[1].content).toMatch(/history of the brands/);
  });

  it('asks for findings from the given pages only and cuts page text at 3000 chars', () => {
    const messages = domainFindingsPrompt({ question: 'What is grade A?', purpose: 'buying', sources: [{ id: 'D1', url: 'https://a.example/x', text: 'X'.repeat(3000) + 'TAILMARKER' }] });
    expect(messages[1].content).toContain('PAGE D1');
    expect(messages[1].content).toContain('https://a.example/x');
    expect(messages[1].content).toContain('X'.repeat(3000));
    expect(messages[1].content).not.toContain('TAILMARKER');
    expect(messages[1].content).toContain('"findings"');
  });
});

describe('hint vocabulary', () => {
  const hint = 'branded vintage clothing wholesale: graded A/cream, sold per kg in bales or curated bundles, suppliers in NL, DE, UK';

  it('splits a hint into candidate phrases', () => {
    const candidates = hintCandidates(hint);
    expect(candidates).toContain('graded A');
    expect(candidates).toContain('cream');
    expect(candidates).toContain('sold per kg in bales');
    expect(candidates).toContain('curated bundles');
  });

  it('matches a term on a page even when the page says it differently', () => {
    expect(mentionsTerm('Wholesalers sell grade A clothing in bales of about 45 kilograms.', 'graded A')).toBe(true);
    expect(mentionsTerm('Wiping rags and textile waste are sold alongside clothing bales.', 'graded A')).toBe(false);
  });

  it('keeps a hint phrase only when two hosts say it', () => {
    const terms = supportedHintTerms(hint, pages);
    expect(terms).toContain('graded A');
    expect(terms).not.toContain('curated bundles');
    expect(supportedHintTerms(hint, [pages[0]])).not.toContain('graded A');
  });
});

describe('trade hubs', () => {
  it('keeps the places of a hint out of the words of the trade', () => {
    expect(hintCandidates('branded vintage clothing wholesale: graded A/cream, sold per kg in bales, suppliers in NL, DE, UK, IT')).toEqual(['branded vintage clothing wholesale', 'graded A', 'cream', 'sold per kg in bales']);
  });

  it('reads the countries of a hint as the hubs where the sellers live', () => {
    expect(hubsFrom(null, 'suppliers in NL, DE, UK')).toEqual(['Netherlands', 'Germany', 'United Kingdom']);
    expect(hubsFrom({ where: ['the biggest sorting plants stand in the Netherlands and Germany'] }, 'suppliers in NL, DE, UK')).toEqual(['Germany', 'Netherlands', 'United Kingdom']);
    expect(hubsFrom(null, 'no country named here')).toEqual([]);
  });

  it('asks for four queries per hub, including the wholesale signal words of the hub language', () => {
    const prompt = hubQueryPrompt({ object: 'vintage clothing', terms: ['grade A'], hubs: ['Netherlands', 'Germany', 'United Kingdom'] });
    const content = prompt[1].content;
    expect(content).toContain('Netherlands');
    expect(content).toContain('Germany');
    expect(content).toContain('United Kingdom');
    expect(content).toContain('Dutch');
    expect(content).toContain('German');
    expect(content).toContain('grade A');
    expect(content).toContain('vintage clothing');
    expect(content).toContain('4 search queries');
    expect(content).toMatch(/bales|per kg|B2B|export/i);
  });
});

describe('domain findings verification', () => {
  it('keeps only findings whose quote is on the page and adds the host', () => {
    const kept = verifiedFindings(reply1.data.findings, pages);
    expect(kept).toHaveLength(8);
    expect(kept.every((finding) => DOMAIN_ASPECTS.includes(finding.aspect))).toBe(true);
    expect(kept[0]).toMatchObject({ aspect: 'object', sourceId: 'D1', host: 'vintagehub.com' });
    expect(kept.map((finding) => finding.host)).not.toContain('www.vintagehub.com');
  });

  it('merges replies and dedupes by aspect and quote', () => {
    const merged = mergeFindings([reply1, reply2, reply3, reply2], pages);
    expect(merged).toHaveLength(17);
    const keys = merged.map((finding) => finding.aspect + '::' + finding.quote);
    expect(new Set(keys).size).toBe(keys.length);
    expect(merged.map((finding) => finding.host)).toContain('selvedge.io');
  });
});

describe('domain understanding', () => {
  it('builds a ready understanding from three hosts', () => {
    const understanding = domainUnderstanding(mergeFindings([reply1, reply2, reply3], pages));
    expect(understanding.ready).toBe(true);
    expect(understanding.hosts).toEqual(['vintagehub.com', 'threadandsupply.com', 'selvedge.io']);
    expect(understanding.terms).toHaveLength(1);
    expect(understanding.terms[0]).toMatch(/grade a/i);
    expect(understanding.not).toHaveLength(1);
    expect(understanding.not[0]).toMatch(/wiping rags/i);
    expect(understanding.where).toHaveLength(1);
    expect(understanding.where[0]).toMatch(/netherlands/i);
    expect(understanding.object).toHaveLength(2);
    expect(understanding.process).toHaveLength(2);
    expect(understanding.quality).toHaveLength(2);
    expect(understanding.actors).toHaveLength(2);
    expect(understanding.use).toHaveLength(2);
  });

  it('is not ready when only one host supports the terms', () => {
    const one = [pages[0]];
    const understanding = domainUnderstanding(mergeFindings([reply1], one));
    expect(understanding.ready).toBe(false);
    expect(understanding.terms).toEqual([]);
    expect(understanding.not).toEqual([]);
    expect(understanding.where).toEqual([]);
    expect(understanding.object).toHaveLength(1);
    expect(understanding.hosts).toEqual(['vintagehub.com']);
  });
});
