import { describe, expect, it } from 'vitest';
import { RobotsPolicy, isAllowed, parseRobots } from '../../src/search/robots.mjs';
import { fakeFetch } from '../helpers/fake-fetch';

const KLEINANZEIGEN = 'User-agent: *\nDisallow: /*/preis:*\nDisallow: /s-suchanfrage.html\nAllow: /?utm_source=ekde$\n\nUser-agent: GPTBot\nDisallow: /';
const SAUTO = 'User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /';
const BAZOS = 'User-agent: *\nDisallow: /*cenaod=\nDisallow: /*hledat=';

describe('robots.txt', () => {
  it('applies the wildcard group with longest-match and wildcards', () => {
    const groups = parseRobots(KLEINANZEIGEN);
    expect(isAllowed(groups, 'free-research-llm', 'https://www.kleinanzeigen.de/s-autos/preis:2000:4000/golf/k0c216')).toBe(false);
    expect(isAllowed(groups, 'free-research-llm', 'https://www.kleinanzeigen.de/s-autos/golf/k0c216')).toBe(true);
    expect(isAllowed(parseRobots(SAUTO), 'free-research-llm', 'https://www.sauto.cz/inzerce/osobni')).toBe(false);
    expect(isAllowed(parseRobots(BAZOS), 'free-research-llm', 'https://auto.bazos.cz/?hledat=golf&cenaod=1')).toBe(false);
    expect(isAllowed(parseRobots(BAZOS), 'free-research-llm', 'https://auto.bazos.cz/skoda/20/')).toBe(true);
    expect(isAllowed([], 'free-research-llm', 'https://x.example/anything')).toBe(true);
  });

  it('allows everything on a 404 robots.txt, blocks on a server error, and caches per origin', async () => {
    const fetchImpl = fakeFetch([[/a\.example/, () => new Response('', { status: 404 })], [/b\.example/, () => new Response('', { status: 503 })]]);
    const policy = new RobotsPolicy({ fetchImpl });
    expect(await policy.allowed('https://a.example/x')).toBe(true);
    expect(await policy.allowed('https://a.example/y')).toBe(true);
    expect(await policy.allowed('https://b.example/x')).toBe(false);
    expect(fetchImpl.calls).toHaveLength(2);
  });
});
