import { describe, expect, it } from 'vitest';
import { FAIL, fakeRouter } from '../helpers/fakes';
import { OWN_SITE_NONE, externalCandidates, mergeChecks, ownSitePrompt, ownSiteOptions, resolveOwnSites } from '../../src/research/ownsite.mjs';

const PRICE = 'adult monthly membership price in eur|Does this gym state its adult monthly membership price in EUR?';
const SITE = 'each with its own website url|Does this gym have its own website URL?';
const hardIds = [PRICE, SITE];
const spec = { itemCount: 5, mustMention: [] };
const check = (id: string, answer: string, quote = '') => ({ id, answer, quote, hard: true, clause: id.split('|')[0] });
const directory = (overrides: Record<string, unknown> = {}) => ({
  title: 'KOSMOS Boulderhalle — Climbing Gym in Leipzig, Germany | Climbing Place',
  url: 'https://climbing.place/climbing-gym/detail/leipzig/kosmos-boulderhalle',
  live: true,
  listing: true,
  purpose: [],
  pageText: 'KOSMOS Boulderhalle — Climbing Gym in Leipzig. Monthly Membership Adults 55.00 EUR. Website.',
  links: [
    { url: '/climbing-gym/area/leipzig', text: 'Leipzig' },
    { url: 'https://hike.place/', text: 'Hike' },
    { url: 'https://kosmos-bouldern.de/', text: 'Website' },
    { url: 'https://kosmos-bouldern.de/kontakt', text: 'Kontakt' },
    { url: 'mailto:info@kosmos.example', text: 'Mail' },
  ],
  checks: [check(PRICE, 'yes', 'Monthly Membership Adults 55.00 EUR.'), check(SITE, 'unknown')],
  ...overrides,
});

describe('externalCandidates', () => {
  it('keeps one link per other site, skips the page\'s own site and non-web links, and caps the list', () => {
    const item = directory();
    expect(externalCandidates(item.links, item.url).map((c) => c.id)).toEqual(['https://hike.place/', 'https://kosmos-bouldern.de/']);
    expect(externalCandidates(item.links, item.url)[1].text).toBe('https://kosmos-bouldern.de/ (Website)');
    expect(externalCandidates(item.links, item.url, 1)).toHaveLength(1);
  });
});

describe('mergeChecks', () => {
  it('keeps the own site\'s yes and no, and fills its unknowns with the yes of the page that led to it', () => {
    const own = [check(PRICE, 'unknown'), check(SITE, 'yes', 'Page address: https://kosmos-bouldern.de/')];
    const via = [check(PRICE, 'yes', 'Monthly Membership Adults 55.00 EUR.'), check(SITE, 'no', 'x')];
    expect(mergeChecks(own, via, 'https://climbing.place/x')).toEqual([{ ...check(PRICE, 'yes', 'Monthly Membership Adults 55.00 EUR.'), source: 'https://climbing.place/x' }, own[1]]);
    expect(mergeChecks([check(PRICE, 'no', 'only for kids')], via, 'https://climbing.place/x')[0].answer).toBe('no');
    expect(mergeChecks([], via, 'https://climbing.place/x')).toEqual([{ ...via[0], source: 'https://climbing.place/x' }, via[1]]);
  });
});

describe('the own-site vote', () => {
  it('asks for the own website among the links, with a last option for none or several items', () => {
    const options = ownSiteOptions([{ id: 'https://kosmos-bouldern.de/', text: 'https://kosmos-bouldern.de/ (Website)' }]);
    expect(options.at(-1)?.id).toBe(OWN_SITE_NONE);
    const prompt = ownSitePrompt({ title: 'KOSMOS | Climbing Place', opening: 'KOSMOS Boulderhalle', options: options.map((o, i) => ({ ...o, letter: 'AB'[i] })) });
    expect(prompt[0].content).toContain('not a directory, map, booking portal, social network or review site');
    expect(prompt[1].content).toContain('A) https://kosmos-bouldern.de/ (Website)');
  });
});

describe('resolveOwnSites', () => {
  const ownPage = { status: 200, text: 'Preise – KOSMOS. Monatliche Zahlung: Normal 55 Euro.', links: [] };
  const judgeAnswering = (checks: unknown[]) => ({ calls: [] as unknown[], async judge(item: unknown) { this.calls.push(item); return checks; } });
  const run = async (items: Array<Record<string, unknown>>, pick: unknown, judge = judgeAnswering([check(PRICE, 'unknown'), check(SITE, 'yes', 'Page address: https://kosmos-bouldern.de/')]), budget?: number) => {
    const router = fakeRouter({ 'own-site': pick });
    const read: string[] = [];
    const out = await resolveOwnSites({ items, hardIds, spec, router: router as never, judge, readPage: async (url: string) => (read.push(url), ownPage), judgeArgs: ['checklist'], ...(budget === undefined ? {} : { budget }) });
    return { out, read, router, judge };
  };

  it('moves a directory item to the own website the vote agrees on, judged there, with the directory kept as its source', async () => {
    const { out, read, judge } = await run([directory()], { pick: 'https://kosmos-bouldern.de/' });
    expect(out).toMatchObject({ asked: 1, moved: 1, merged: 0 });
    expect(read).toEqual(['https://kosmos-bouldern.de/']);
    expect(judge.calls[0]).toMatchObject({ url: 'https://kosmos-bouldern.de/', via: 'https://climbing.place/climbing-gym/detail/leipzig/kosmos-boulderhalle' });
    expect(out.items[0]).toMatchObject({ url: 'https://kosmos-bouldern.de/', pageUrl: 'https://kosmos-bouldern.de/', via: 'https://climbing.place/climbing-gym/detail/leipzig/kosmos-boulderhalle' });
    expect(out.items[0].checks).toEqual([{ ...check(PRICE, 'yes', 'Monthly Membership Adults 55.00 EUR.'), source: 'https://climbing.place/climbing-gym/detail/leipzig/kosmos-boulderhalle' }, check(SITE, 'yes', 'Page address: https://kosmos-bouldern.de/')]);
  });

  it('merges a directory item into the listed item on its own website, so one entity is counted once', async () => {
    const listed = { title: 'Preise – KOSMOS', url: 'https://kosmos-bouldern.de/angebot/preise/', live: true, listing: true, purpose: [], links: [], checks: [check(PRICE, 'unknown'), check(SITE, 'yes', 'Page address: x')] };
    const { out, read } = await run([listed, directory()], { pick: 'https://kosmos-bouldern.de/' });
    expect(out).toMatchObject({ asked: 1, moved: 0, merged: 1 });
    expect(read).toEqual([]);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ url: listed.url, alsoOn: ['https://climbing.place/climbing-gym/detail/leipzig/kosmos-boulderhalle'] });
    expect(out.items[0].checks[0]).toMatchObject({ answer: 'yes', source: 'https://climbing.place/climbing-gym/detail/leipzig/kosmos-boulderhalle' });
  });

  it('keeps the item as it is when the vote picks none, no model answers, or the item is not to confirm', async () => {
    expect((await run([directory()], { pick: OWN_SITE_NONE })).out).toMatchObject({ asked: 1, moved: 0, merged: 0 });
    expect((await run([directory()], FAIL)).out.items[0].url).toBe(directory().url);
    const confirmed = directory({ checks: [check(PRICE, 'yes', 'a'), check(SITE, 'yes', 'b')] });
    const rejected = directory({ checks: [check(PRICE, 'no', 'a'), check(SITE, 'unknown')] });
    const { out, router } = await run([confirmed, rejected], { pick: 'https://kosmos-bouldern.de/' });
    expect(out.asked).toBe(0);
    expect(router.count('own-site')).toBe(0);
  });

  it('asks at most its budget of pages', async () => {
    const { out } = await run([directory(), directory({ url: 'https://chalkrebels.com/gyms/kosmos/' })], { pick: OWN_SITE_NONE }, undefined, 1);
    expect(out.asked).toBe(1);
    expect(out.items).toHaveLength(2);
  });
});
