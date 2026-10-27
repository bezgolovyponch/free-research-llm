import { sourceCountry } from './brief.mjs';
import { buildCandidates } from './candidates.mjs';
import { isKind } from './itemgate.mjs';
import { looksLikeListing } from './acceptance.mjs';
import { listingKey } from '../search/listings.mjs';
import { roundRobin, seedPortals } from './portals.mjs';

export const PAGE_BUDGET = 90;
export const PAGES_PER_SITE = 6;
export const MIN_PORTAL_LISTINGS = 3;
const STORED_PAGE_TEXT = 1500;
const PRICE_MAX_PARAM = /(?:^|[_[:.-])(?:max_?price|price_?max|maxprice|pricemax|price_?to|to_?price|precio_?max(?:imo)?|preco_?max(?:imo)?|prezzo_?max|fiyat_?max|maximum[-_]?price|price_?lte)(?:$|[\]_.-])|filter_float_price:to|price\]\[to\]|price\[max\]/i;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function priceFilterUrl(links, base, max) {
  const host = hostOf(base);
  for (const link of links ?? []) {
    if (hostOf(link.url) !== host) continue;
    try {
      const u = new URL(link.url);
      for (const [key, value] of u.searchParams) {
        if (!PRICE_MAX_PARAM.test(key) || !/^\d+$/.test(value)) continue;
        u.searchParams.set(key, String(Math.round(max)));
        return u.toString();
      }
    } catch {
      continue;
    }
  }
  return '';
}

export function listingsShown(source, kind = null) {
  const host = hostOf(source.url);
  const fits = (item) => isKind(item, kind);
  const linked = (source.links ?? []).filter((l) => hostOf(l.url) === host && looksLikeListing(l.url) && fits({ title: l.text, url: l.url })).length;
  return Math.max((source.listings ?? []).filter(fits).length, linked);
}

export function portalPages(nodes, brief, extra = []) {
  const pages = new Map();
  for (const node of nodes ?? []) for (const source of node.sources ?? []) {
    if (!source.url || looksLikeListing(source.url)) continue;
    const shown = listingsShown(source, brief?.kind ?? null);
    if (shown < MIN_PORTAL_LISTINGS) continue;
    const country = sourceCountry(source);
    if (brief?.regions?.length && country && !brief.regions.includes(country)) continue;
    if (!pages.has(source.url)) pages.set(source.url, { url: source.url, listings: shown, country });
  }
  for (const page of extra) {
    if (pages.has(page.url)) continue;
    if (brief?.regions?.length && !brief.regions.includes(page.country)) continue;
    if (!isKind({ title: (page.sample ?? []).join(' '), url: page.url }, brief?.kind)) continue;
    pages.set(page.url, { url: page.url, listings: page.count ?? 0, country: page.country, seed: Boolean(page.seed) });
  }
  return [...pages.values()].sort((a, b) => b.listings - a.listings);
}

export class CandidateSweeper {
  constructor({ search, recipes = null, budget = PAGE_BUDGET, perSite = PAGES_PER_SITE, seeds = seedPortals, arms = null, rng = Math.random }) {
    this.search = search;
    this.arms = arms;
    this.rng = rng;
    this.seeds = seeds;
    this.recipes = recipes;
    this.budget = budget;
    this.perSite = perSite;
  }

  async sweep(project, brief, options = {}, onPage = () => {}) {
    if (!brief?.kind || !this.search?.readPage) return null;
    const target = Math.ceil((brief.itemCount ?? 20) * 1.5);
    await this.arms?.load?.();
    const found = portalPages(project.nodes, brief, [...this.seeds(brief), ...(this.recipes?.verifiedSearchPages?.() ?? [])]);
    const starts = roundRobin(this.arms ? this.arms.order(found, this.rng) : found, (p) => p.country);
    const yields = new Map();
    const visited = new Set();
    const pages = [];
    const read = new Set();
    const keys = new Set();
    let left = this.budget;
    const keptNow = () => buildCandidates([...project.nodes, { id: 'sweep', sources: pages }], brief, options).keptCount;
    const visit = async (url, from, arm) => {
      if (!url || read.has(url) || left <= 0) return null;
      read.add(url);
      left--;
      const page = await this.search.readPage(url);
      const fresh = (page.listings ?? []).filter((l) => !keys.has(listingKey(l.url)));
      fresh.forEach((l) => keys.add(listingKey(l.url)));
      const record = { id: `P${pages.length + 1}`, kind: 'web', url, from, title: `${hostOf(url)} listings`, domain: hostOf(url), locale: page.locale ?? '', text: String(page.text ?? '').slice(0, STORED_PAGE_TEXT), links: [], listings: fresh, status: page.status ?? 0 };
      pages.push(record);
      const kept = fresh.length ? buildCandidates([{ id: 'sweep', sources: [record] }], brief, options).keptCount : 0;
      const y = yields.get(arm) ?? { useful: 0, empty: 0, listings: 0 };
      yields.set(arm, kept > 0 ? { ...y, useful: y.useful + 1, listings: y.listings + kept } : { ...y, empty: y.empty + 1 });
      onPage(record);
      return page;
    };
    const skipped = (start) => !start.seed && keptNow() >= target && visited.has(start.country);
    for (const [index, start] of starts.entries()) {
      if (left <= 0) break;
      if (skipped(start)) continue;
      visited.add(start.country);
      const reserved = starts.slice(index + 1).filter((s) => s.seed || !visited.has(s.country)).length;
      const first = await visit(start.url, start.seed ? `seed portal for ${start.country}` : 'portal page already read', start.url);
      if (!first?.listings?.length) continue;
      const filtered = brief.valueRange ? priceFilterUrl(first.links, start.url, brief.valueRange[1]) : '';
      let page = filtered ? (await visit(filtered, `price filter found on ${hostOf(start.url)}`, start.url)) ?? first : first;
      if (!page?.listings?.length) page = first;
      for (let n = 1; n < this.perSite && page?.next && left > reserved && (start.seed || keptNow() < target); n++) page = await visit(page.next, 'next page link', start.url);
    }
    for (const [url, y] of yields) this.arms?.record(url, y);
    const arms = [...yields].map(([url, y]) => ({ url, ...y, draw: starts.find((s) => s.url === url)?.draw ?? null })).sort((a, b) => b.listings - a.listings);
    return { pages, pagesRead: pages.length, budget: this.budget, at: new Date().toISOString(), arms };
  }
}
