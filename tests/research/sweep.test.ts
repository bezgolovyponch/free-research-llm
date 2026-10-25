import { describe, expect, it } from 'vitest';
import { buildBrief } from '../../src/research/brief.mjs';
import { CandidateSweeper, listingsShown, portalPages, priceFilterUrl } from '../../src/research/sweep.mjs';

const kind = { label: 'plot of land', terms: ['land', 'terreno'] };
const brief = buildBrief({ question: 'Plots near the sea, 20000EUR max', acceptance: { expected: '4 plots in Portugal', itemCount: 4, valueRange: [0, 20000], unit: 'EUR' }, template: { itemKind: kind } });

function listing(n: number, value: number) {
  return { title: `Terreno ${n}`, url: `https://imo.example/pt/anuncio/terreno-${n}-ID1x${n}yz`, value, unit: 'EUR' };
}

describe('portal sweep', () => {
  it('starts only from pages that showed several single listings of the asked kind, in the asked regions', () => {
    const links = (host: string, word: string) => [1, 2, 3].map((n) => ({ url: `https://${host}/anuncio/${word}-${n}-ID1q${n}rs`, text: `${word} ${n}` }));
    const nodes = [{ id: 'D1', sources: [
      { url: 'https://imo.example/pt/resultados', locale: 'pt', links: links('imo.example', 'terreno') },
      { url: 'https://weather.example/countries/pt', links: links('weather.example', 'humidity') },
      { url: 'https://land.example.uy/terrenos', links: links('land.example.uy', 'terreno') },
      { url: 'https://imo.example/pt/anuncio/terreno-1-ID1q1rs', links: links('imo.example', 'terreno') },
    ] }];
    expect(listingsShown(nodes[0].sources[0], kind)).toBe(3);
    expect(portalPages(nodes, brief)).toEqual([{ url: 'https://imo.example/pt/resultados', listings: 3 }]);
    const remembered = [{ url: 'https://cars.example.pt/search', count: 30, country: 'PT', sample: ['VW Golf 2012'] }, { url: 'https://plots.example.pt/search', count: 20, country: 'PT', sample: ['Terreno rústico'] }];
    expect(portalPages([], brief, remembered)).toEqual([{ url: 'https://plots.example.pt/search', listings: 20 }]);
  });

  it("uses the site's own price filter link, with the brief's maximum, and never invents a parameter", () => {
    const links = [{ url: 'https://imo.example/pt/resultados?priceMax=500000&page=1' }, { url: 'https://other.example/?priceMax=1' }];
    expect(priceFilterUrl(links, 'https://imo.example/pt/resultados', 20000)).toBe('https://imo.example/pt/resultados?priceMax=20000&page=1');
    expect(priceFilterUrl([{ url: 'https://imo.example/pt/resultados?sort=asc' }], 'https://imo.example/pt/resultados', 20000)).toBe('');
  });

  it('reads the start page, its price filter and next pages until enough listings pass, within the page budget', async () => {
    const pages: Record<string, { listings: unknown[]; next: string; links: unknown[] }> = {
      'https://imo.example/pt/resultados': { listings: [listing(1, 9000), listing(2, 90000)], next: 'https://imo.example/pt/resultados?page=2', links: [{ url: 'https://imo.example/pt/resultados?price_max=1000000' }] },
      'https://imo.example/pt/resultados?price_max=20000': { listings: [listing(3, 12000), listing(1, 9000)], next: 'https://imo.example/pt/resultados?price_max=20000&page=2', links: [] },
      'https://imo.example/pt/resultados?price_max=20000&page=2': { listings: [listing(4, 15000), listing(5, 19000)], next: 'https://imo.example/pt/resultados?price_max=20000&page=3', links: [] },
      'https://imo.example/pt/resultados?price_max=20000&page=3': { listings: [listing(6, 1000), listing(7, 2000), listing(8, 3000)], next: '', links: [] },
    };
    const read: string[] = [];
    const search = { readPage: async (url: string) => { read.push(url); return { status: 200, locale: 'pt', text: '', ...(pages[url] ?? { listings: [], next: '', links: [] }) }; } };
    const project = { nodes: [{ id: 'D1', sources: [{ url: 'https://imo.example/pt/resultados', locale: 'pt', listings: [listing(1, 9000), listing(2, 90000), listing(9, 1)] }] }] };
    const result = await new CandidateSweeper({ search, budget: 3 }).sweep(project, brief, {});
    expect(read).toEqual(['https://imo.example/pt/resultados', 'https://imo.example/pt/resultados?price_max=20000', 'https://imo.example/pt/resultados?price_max=20000&page=2']);
    expect(result?.pages.map((p: { from: string; listings: unknown[] }) => [p.from, p.listings.length])).toEqual([['portal page already read', 2], ['price filter found on imo.example', 1], ['next page link', 2]]);
    expect(await new CandidateSweeper({ search }).sweep(project, { ...brief, kind: null }, {})).toBeNull();
  });
});
