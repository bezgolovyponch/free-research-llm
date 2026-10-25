import { parseAmounts } from './acceptance.mjs';
import { screenItem } from './itemgate.mjs';

export const HARVEST_PER_PIECE = 25;
const IMAGE_TITLE = /^!\[|^image\b/i;

function urlKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
  } catch {
    return String(url ?? '').toLowerCase();
  }
}

function linkItem(link, source) {
  const url = String(link?.url ?? link ?? '');
  const title = String(link?.text ?? link?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const [price] = parseAmounts(title);
  return { title: title || url, url, value: price?.value ?? null, unit: price?.currency ?? '', sourceId: source.id, harvested: true };
}

function listingItem(listing, source) {
  return { title: String(listing.title ?? listing.url).slice(0, 160), url: listing.url, value: listing.value ?? null, unit: listing.unit ?? '', ...(listing.area ? { area: listing.area } : {}), ...(listing.place ? { place: listing.place } : {}), sourceId: source.id, harvested: true, via: listing.via ?? [] };
}

export function harvestItems(node, options = {}, limit = HARVEST_PER_PIECE) {
  const known = new Set((node.finding?.items ?? []).map((i) => urlKey(i.url)));
  const found = new Map();
  for (const source of node.sources ?? []) {
    if (!source.url) continue;
    for (const item of [...(source.listings ?? []).map((l) => listingItem(l, source)), ...(source.links ?? []).map((l) => linkItem(l, source))]) {
      const key = urlKey(item.url);
      if (!/^https?:\/\//.test(item.url) || IMAGE_TITLE.test(item.title) || known.has(key) || found.has(key)) continue;
      if (screenItem(item, options).ok) found.set(key, item);
    }
  }
  return [...found.values()].sort((a, b) => Number(b.value !== null) - Number(a.value !== null)).slice(0, limit);
}
