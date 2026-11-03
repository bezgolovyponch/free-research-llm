import { describe, expect, it } from 'vitest';
import { buildBrief } from '../../src/research/brief.mjs';
import { buildCandidates } from '../../src/research/candidates.mjs';
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
    expect(portalPages(nodes, brief)).toEqual([{ url: 'https://imo.example/pt/resultados', listings: 3, country: 'PT' }]);
    const remembered = [{ url: 'https://cars.example.pt/search', count: 30, country: 'PT', sample: ['VW Golf 2012'] }, { url: 'https://plots.example.pt/search', count: 20, country: 'PT', sample: ['Terreno rústico'] }];
    expect(portalPages([], brief, remembered)).toEqual([{ url: 'https://plots.example.pt/search', listings: 20, country: 'PT', seed: false }]);
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
    const result = await new CandidateSweeper({ search, budget: 3, seeds: () => [] }).sweep(project, brief, {});
    expect(read).toEqual(['https://imo.example/pt/resultados', 'https://imo.example/pt/resultados?price_max=20000', 'https://imo.example/pt/resultados?price_max=20000&page=2']);
    expect(result?.pages.map((p: { from: string; listings: unknown[] }) => [p.from, p.listings.length])).toEqual([['portal page already read', 2], ['price filter found on imo.example', 1], ['next page link', 2]]);
    expect(await new CandidateSweeper({ search }).sweep(project, { ...brief, kind: null }, {})).toBeNull();
  });

  it('gives every page of a seed start that country, so a .com portal keeps its listings instead of leaving them to check', async () => {
    const spanish = buildBrief({ question: 'Plots near the sea in Spain, 20000EUR max', acceptance: { expected: '3 plots in Spain', itemCount: 3, valueRange: [0, 20000], unit: 'EUR' }, template: { itemKind: kind } });
    const spanishListing = (n: number) => ({ title: `Terreno rustico en Galicia ${n}`, url: `https://www.pisos.com/comprar/terreno-en-galicia-${1000000 + n}`, value: 15000, unit: 'EUR' });
    const pages: Record<string, { listings: unknown[]; next: string; links: unknown[] }> = {
      'https://www.pisos.com/venta/terrenos-galicia/hasta-20000/': { listings: [spanishListing(1)], next: 'https://www.pisos.com/venta/terrenos-galicia/hasta-20000/?page=2', links: [{ url: 'https://www.pisos.com/venta/terrenos-galicia/hasta-20000/?price_max=1000000' }] },
      'https://www.pisos.com/venta/terrenos-galicia/hasta-20000/?price_max=20000': { listings: [spanishListing(2)], next: 'https://www.pisos.com/venta/terrenos-galicia/hasta-20000/?price_max=20000&page=2', links: [] },
      'https://www.pisos.com/venta/terrenos-galicia/hasta-20000/?price_max=20000&page=2': { listings: [spanishListing(3)], next: '', links: [] },
    };
    const search = { readPage: async (url: string) => ({ status: 200, locale: 'es', text: '', ...(pages[url] ?? { listings: [], next: '', links: [] }) }) };
    const seeds = () => [{ url: 'https://www.pisos.com/venta/terrenos-galicia/hasta-20000/', country: 'ES', sample: ['terreno'], count: 1, seed: true }];
    const result = await new CandidateSweeper({ search, seeds }).sweep({ nodes: [] }, spanish, {});
    expect(result?.pages.map((p: { country: string }) => p.country)).toEqual(['ES', 'ES', 'ES']);
    const candidates = buildCandidates([{ id: 'sweep', sources: result?.pages ?? [] }], spanish, {});
    expect(candidates.toCheckCount).toBe(0);
    expect(candidates.kept.map((r: { country: string }) => r.country)).toEqual(['Spain', 'Spain', 'Spain']);
  });

  it('reads a seed portal of every named country before the count target can stop the sweep, one country at a time', async () => {
    const twoCountries = buildBrief({ question: 'Plots near the sea, 20000EUR max', acceptance: { expected: '1 plot in Portugal or Spain', itemCount: 1, valueRange: [0, 20000], unit: 'EUR' }, template: { itemKind: kind } });
    const read: string[] = [];
    const search = { readPage: async (url: string) => { read.push(url); return { status: 200, locale: 'pt', text: '', listings: url.includes('pt') ? [listing(read.length, 5000)] : [], next: '', links: [] }; } };
    const seeds = () => [{ url: 'https://seed.example/pt/1', country: 'PT', sample: ['terreno'], count: 1, seed: true }, { url: 'https://seed.example/pt/2', country: 'PT', sample: ['terreno'], count: 1, seed: true }, { url: 'https://seed.example/es/1', country: 'ES', sample: ['terreno'], count: 1, seed: true }];
    await new CandidateSweeper({ search, seeds }).sweep({ nodes: [] }, twoCountries, {});
    expect(read).toEqual(['https://seed.example/pt/1', 'https://seed.example/es/1', 'https://seed.example/pt/2']);
  });

  it('hands the item gate converter to the seed portals, and null when the options carry none', async () => {
    const calls: unknown[][] = [];
    const seeds = (...args: unknown[]) => { calls.push(args); return []; };
    const search = { readPage: async () => ({ status: 200, locale: 'pt', text: '', listings: [], next: '', links: [] }) };
    const convert = (value: number) => value;
    await new CandidateSweeper({ search, seeds }).sweep({ nodes: [] }, brief, { convert });
    await new CandidateSweeper({ search, seeds }).sweep({ nodes: [] }, brief, {});
    expect(calls).toEqual([[brief, convert], [brief, null]]);
  });

  it('pages through every seed portal even when other pages already met the count, keeping one page for each start still to come', async () => {
    const one = buildBrief({ question: 'Plots near the sea, 20000EUR max', acceptance: { expected: '1 plot in Portugal or Spain', itemCount: 1, valueRange: [0, 20000], unit: 'EUR' }, template: { itemKind: kind } });
    const read: string[] = [];
    const search = { readPage: async (url: string) => { read.push(url); const next = url.endsWith('p=3') ? '' : url.includes('?p=') ? url.replace(/p=(\d)/, (_m, d) => `p=${Number(d) + 1}`) : `${url}?p=2`; return { status: 200, locale: 'pt', text: '', links: [], listings: [listing(read.length, 5000), listing(read.length + 100, 6000)], next }; } };
    const seeds = () => [{ url: 'https://seed.example/pt/1', country: 'PT', sample: ['terreno'], count: 1, seed: true }, { url: 'https://seed.example/pt/2', country: 'PT', sample: ['terreno'], count: 1, seed: true }, { url: 'https://seed.example/es/1', country: 'ES', sample: ['terreno'], count: 1, seed: true }];
    await new CandidateSweeper({ search, seeds, budget: 6 }).sweep({ nodes: [] }, one, {});
    expect(read).toEqual(['https://seed.example/pt/1', 'https://seed.example/pt/1?p=2', 'https://seed.example/pt/1?p=3', 'https://seed.example/es/1', 'https://seed.example/es/1?p=2', 'https://seed.example/pt/2']);
  });
});
