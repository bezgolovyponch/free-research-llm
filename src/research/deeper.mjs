import { plain } from './itemgate.mjs';
import { JUDGE_VERSION } from './checklist.mjs';
import { hardIdsOf, itemTier } from './verdict.mjs';
import { ENTITY_PATH } from './entitypath.mjs';

function extractKeyWords(question) {
  return plain(question).split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
}

function sameHost(url1, url2) {
  try {
    const h1 = new URL(url1).hostname.replace(/^www\./, '');
    const h2 = new URL(url2).hostname.replace(/^www\./, '');
    return h1 === h2;
  } catch {
    return false;
  }
}

const COMPANY_PAGE = /\b(?:about|about-us|who-we-are|company-profile|contact|contact-us|impressum|imprint|kontakt|ueber-uns|uber-uns|over-ons|chi-siamo|contatti|o-nas|qui-sommes-nous|quienes-somos|legal-notice)\b/i;

function lastSegment(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    return '';
  }
}


function entityPrefix(url) {
  try {
    return new URL(url).pathname.match(ENTITY_PATH)?.[1] ?? '';
  } catch {
    return '';
  }
}

function insideEntity(url, prefix) {
  const path = new URL(url).pathname.replace(/\/+$/, '');
  return path === prefix || path.startsWith(`${prefix}/`);
}

export async function findRelevantLinks(links, itemUrl, keyWords, max = 3) {
  const prefix = entityPrefix(itemUrl);
  const matching = [];
  const companyPages = [];
  if (prefix) {
    const profile = `${new URL(itemUrl).origin}${prefix}`;
    if (profile !== itemUrl.replace(/\/+$/, '')) companyPages.push(profile);
  }
  for (const link of links ?? []) {
    const fullUrl = link.url.startsWith('http') ? link.url : new URL(link.url, itemUrl).href;
    if (!sameHost(fullUrl, itemUrl) || fullUrl === itemUrl) continue;
    if (prefix && !insideEntity(fullUrl, prefix)) continue;
    const combined = `${link.text} ${link.url}`.toLowerCase();
    if (keyWords.some((kw) => combined.includes(kw.toLowerCase()))) matching.push(fullUrl);
    else if (COMPANY_PAGE.test(`${link.text ?? ''} ${lastSegment(fullUrl)}`)) companyPages.push(fullUrl);
  }
  return [...new Set([...matching, ...companyPages])].slice(0, max);
}

export const LINK_CANDIDATES = 80;

function pathWords(url) {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/[/_\-.+]+/g, ' ').trim();
  } catch {
    return '';
  }
}

export async function linksByMeaning(links, itemUrl, question, embedder, max = 3) {
  const prefix = entityPrefix(itemUrl);
  const here = itemUrl.replace(/#.*$/, '').replace(/\/+$/, '');
  const profile = prefix ? `${new URL(itemUrl).origin}${prefix}` : '';
  const first = profile && profile !== here ? [profile] : [];
  const seen = new Set([here, ...first]);
  const candidates = [];
  for (const link of links ?? []) {
    let fullUrl;
    try {
      fullUrl = new URL(link.url, itemUrl).href.replace(/#.*$/, '');
    } catch {
      continue;
    }
    const key = fullUrl.replace(/\/+$/, '');
    if (seen.has(key) || !sameHost(fullUrl, itemUrl)) continue;
    if (prefix && !insideEntity(fullUrl, prefix)) continue;
    seen.add(key);
    candidates.push({ url: fullUrl, text: `${link.text ?? ''} ${pathWords(fullUrl)}`.trim() });
  }
  const shortlist = candidates.slice(0, LINK_CANDIDATES);
  if (!shortlist.length) return first;
  const ranked = await embedder.rank(question, shortlist.map((c) => c.text), max).catch(() => null);
  if (!ranked?.order?.length) return null;
  return [...first, ...ranked.order.map((index) => shortlist[index]?.url).filter(Boolean)].slice(0, max);
}

function onlyCheck(checklist, checkId) {
  return checklist
    .map((cluster) => ({ ...cluster, items: cluster.items.filter((ci) => `${cluster.clause}|${ci.question}` === checkId) }))
    .filter((cluster) => cluster.items.length > 0);
}

export const DEEPER_PAGE_BUDGET = 60;
export const DEEPER_PROGRESS_EVERY = 10;

export function deeperOrder(items, { checklist = null, kind = null, spec = null } = {}) {
  const hardIds = hardIdsOf(checklist, kind);
  const open = (item) => (item.checks ?? []).filter((c) => hardIds.includes(c.id) && c.answer !== 'yes').length;
  return items
    .filter((item) => itemTier(item, hardIds, spec) === 'to-confirm')
    .sort((a, b) => open(a) - open(b));
}

export class DeeperReader {
  constructor({ judge, readPage, embedder = null, budget = DEEPER_PAGE_BUDGET, onProgress = () => {} } = {}) {
    this.judge = judge;
    this.readPage = readPage;
    this.embedder = embedder;
    this.budget = budget;
    this.onProgress = onProgress;
    this.read = 0;
    this.answered = 0;
  }

  spent() {
    return this.read >= this.budget;
  }

  async readDeeperForUnknown(item, checklist, cache) {
    const checks = item.checks ?? [];
    const unknownHard = checks.filter((c) => c.hard === true && c.answer === 'unknown');
    if (unknownHard.length === 0) return item;
    const page = await this.readPage(item.url).catch(() => null);
    const links = page?.links ?? [];
    if (links.length === 0 && !entityPrefix(item.url)) return item;
    for (const check of unknownHard) {
      const question = check.id.split('|').pop();
      const byMeaning = process.env.FRL_LINKS_BY_MEANING && this.embedder?.ready ? await linksByMeaning(links, item.url, question, this.embedder) : null;
      const relevantUrls = byMeaning ?? await findRelevantLinks(links, item.url, extractKeyWords(check.clause + ' ' + question));
      for (const url of relevantUrls) {
        const cacheKey = `${url}::${check.id}::judge:${JUDGE_VERSION}`;
        let deeperChecks;
        if (cache[cacheKey]) {
          deeperChecks = cache[cacheKey];
        } else {
          if (this.spent()) return item;
          this.read += 1;
          const deeperPage = await this.readPage(url).catch(() => null);
          if (this.read % DEEPER_PROGRESS_EVERY === 0) this.onProgress(this);
          if (!deeperPage?.text) continue;
          deeperChecks = await this.judge.judge({ url }, deeperPage.text, onlyCheck(checklist, check.id));
          cache[cacheKey] = deeperChecks;
        }
        const deeperCheck = deeperChecks.find((c) => c.id === check.id);
        if (deeperCheck?.answer === 'yes') {
          this.answered += 1;
          check.answer = 'yes';
          check.quote = deeperCheck.quote ?? '';
          check.source = url;
          break;
        }
      }
    }
    return item;
  }
}