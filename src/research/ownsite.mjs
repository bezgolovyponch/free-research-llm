import { agreed, closedVote, optionLines } from './semantic.mjs';
import { sentenceSpans } from './spans.mjs';
import { itemTier } from './verdict.mjs';

export const OWN_SITE_BUDGET = 15;
export const OWN_SITE_CANDIDATES = 8;
export const OWN_SITE_VOTES = 3;
export const OWN_SITE_NONE = 'none';

export function hostOf(url, base) {
  try {
    return new URL(url, base).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function externalCandidates(links, pageUrl, max = OWN_SITE_CANDIDATES) {
  const own = hostOf(pageUrl);
  const seen = new Set();
  const out = [];
  for (const link of links ?? []) {
    let url;
    try {
      url = new URL(link.url, pageUrl).href.replace(/#.*$/, '');
    } catch {
      continue;
    }
    if (!/^https?:/i.test(url)) continue;
    const host = hostOf(url);
    if (!host || host === own || seen.has(host)) continue;
    seen.add(host);
    out.push({ id: url, text: `${url}${link.text ? ` (${String(link.text).replace(/\s+/g, ' ').trim().slice(0, 60)})` : ''}` });
    if (out.length >= max) break;
  }
  return out;
}

export function ownSiteOptions(candidates) {
  return [...candidates, { id: OWN_SITE_NONE, text: 'None of these is the own website of the item this page is about, or the page is about several items' }];
}

export function ownSitePrompt({ title, opening, options }) {
  return [
    { role: 'system', content: 'You read the opening of a web page about one item and the links found on it. Pick the link that is the own website of that item (the site run by the business, venue or maker itself, not a directory, map, booking portal, social network or review site), or the last option when no link is, or when the page is about several items. Answer with JSON only: {"pick":"<letter>"}' },
    { role: 'user', content: `Page title: ${title}\nOpening sentences:\n${opening}\n\nLinks:\n${optionLines(options)}` },
  ];
}

export async function pickOwnSite({ router, item, candidates }) {
  const pageUrl = item.pageUrl ?? item.url;
  const opening = sentenceSpans(item.pageText ?? '', { limit: 3000 }).slice(0, 3).map((span) => span.text).join('\n');
  const options = ownSiteOptions(candidates);
  const result = await closedVote({ router, task: 'own-site', tier: 'fast', n: OWN_SITE_VOTES, quorum: 2, options, field: 'pick', seed: pageUrl, prompt: (shown) => ownSitePrompt({ title: String(item.title ?? ''), opening, options: shown }), keyOf: (id) => String(id) }).catch(() => null);
  const pick = agreed(result)?.id;
  return pick && pick !== OWN_SITE_NONE ? pick : null;
}

export async function resolveOwnSites({ items, hardIds, spec, router, judge, readPage, judgeArgs = [], budget = OWN_SITE_BUDGET }) {
  const byHost = new Map(items.map((item) => [hostOf(item.pageUrl ?? item.url), item]));
  const kept = [];
  let asked = 0;
  let moved = 0;
  let merged = 0;
  for (const item of items) {
    const pageUrl = item.pageUrl ?? item.url;
    const candidates = asked < budget && itemTier(item, hardIds, spec) === 'to-confirm' ? externalCandidates(item.links, pageUrl) : [];
    if (!candidates.length) {
      kept.push(item);
      continue;
    }
    asked++;
    const pick = await pickOwnSite({ router, item, candidates });
    const twin = pick ? byHost.get(hostOf(pick)) : null;
    if (twin && twin !== item) {
      twin.checks = mergeChecks(twin.checks, item.checks, pageUrl);
      twin.alsoOn = [...(twin.alsoOn ?? []), pageUrl];
      merged++;
      continue;
    }
    const page = pick ? await readPage(pick).catch(() => null) : null;
    if (!page?.text) {
      kept.push(item);
      continue;
    }
    const own = { ...item, url: pick, pageUrl: pick, via: pageUrl, pageText: page.text, links: page.links ?? [] };
    const checks = await judge.judge(own, page.text, ...judgeArgs).catch(() => null);
    if (!checks) {
      kept.push(item);
      continue;
    }
    own.checks = mergeChecks(checks, item.checks, pageUrl);
    byHost.set(hostOf(pick), own);
    kept.push(own);
    moved++;
  }
  return { items: kept, asked, moved, merged };
}

export function mergeChecks(ownChecks, viaChecks, viaUrl) {
  if (!(ownChecks ?? []).length) return (viaChecks ?? []).map((check) => (check.answer === 'yes' ? { ...check, source: check.source ?? viaUrl } : check));
  const byId = new Map((viaChecks ?? []).map((check) => [check.id, check]));
  return (ownChecks ?? []).map((check) => {
    if (check.answer === 'yes' || check.answer === 'no') return check;
    const via = byId.get(check.id);
    return via?.answer === 'yes' ? { ...via, source: via.source ?? viaUrl } : check;
  });
}
