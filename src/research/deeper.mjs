import { plain } from './itemgate.mjs';
import { judgeItem } from './checklist.mjs';

const MIN_LIVE_TEXT = 200;

function text(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

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

async function findRelevantLinks(pageText, itemUrl, keyWords, max = 3) {
  const linkRegex = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi;
  const links = [];
  for (const m of pageText.matchAll(linkRegex)) {
    const href = m[1];
    const text = m[2];
    const fullUrl = href.startsWith('http') ? href : new URL(href, itemUrl).href;
    if (!sameHost(fullUrl, itemUrl)) continue;
    const combined = `${text} ${href}`.toLowerCase();
    if (keyWords.some((kw) => combined.includes(kw.toLowerCase()))) {
      links.push(fullUrl);
    }
  }
  return [...new Set(links)].slice(0, max);
}

export async function readDeeperForUnknown(item, readPage, checklist, cache) {
  const checks = item.checks ?? [];
  const unknownHard = checks.filter((c) => c.hard === true && (c.answer === 'unknown' || c.answer === 'no'));
  if (unknownHard.length === 0) return item;
  const pageText = item.pageText ?? '';
  if (!pageText) return item;
  for (const check of unknownHard) {
    const keyWords = extractKeyWords(check.clause + ' ' + check.id.split('|').pop());
    const relevantUrls = await findRelevantLinks(pageText, item.url, keyWords);
    let foundYes = false;
    for (const url of relevantUrls) {
      const cacheKey = `${url}::${check.id}`;
      let deeperChecks;
      if (cache[cacheKey]) {
        deeperChecks = cache[cacheKey];
      } else {
        const deeperPage = await readPage(url).catch(() => null);
        if (!deeperPage?.text) continue;
        deeperChecks = await judgeItem({ url }, deeperPage.text, checklist);
        cache[cacheKey] = deeperChecks;
      }
      const deeperCheck = deeperChecks.find((c) => c.id === check.id);
      if (deeperCheck?.answer === 'yes') {
        foundYes = true;
        break;
      }
    }
    if (foundYes) {
      check.answer = 'yes';
      check.quote = 'confirmed on linked page';
    }
  }
  return item;
}

export async function runChecksOnItems(items, readPage, checklist, checkCache) {
  for (const item of items) {
    if (item.checks) continue;
    const pageText = item.pageText ?? '';
    if (pageText) {
      item.checks = await judgeItem(item, pageText, checklist);
    }
  }
  for (const item of items) {
    if (item.checks) {
      await readDeeperForUnknown(item, readPage, checklist, checkCache);
    }
  }
}