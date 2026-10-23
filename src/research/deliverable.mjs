const ASKS_FOR_ITEMS = /\b(?:listed (?:for sale|on)|for sale|on sale|direct (?:urls?|links?)|(?:plot|land|property|parcel|real estate) listings?|specific (?:land |coastal |rural )?(?:parcels?|plots?|properties|listings?|offers?))\b/i;

export const NO_ITEMS_DETAIL = 'asked for specific listings but returned none';

export function asksForItems(node) {
  if (!node) return false;
  if (typeof node.deliverable === 'boolean') return node.deliverable;
  return ASKS_FOR_ITEMS.test(`${node.title ?? ''} ${node.question ?? ''}`);
}

export function deliversItems(node) {
  return (node?.finding?.items ?? []).some((item) => item && item.url);
}

export function missingItems(node) {
  return asksForItems(node) && !deliversItems(node);
}
