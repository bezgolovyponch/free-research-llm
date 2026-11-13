import { plain } from './itemgate.mjs';

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

async function findRelevantLinks(links, itemUrl, keyWords, max = 3) {
  const relevant = [];
  for (const link of links ?? []) {
    const fullUrl = link.url.startsWith('http') ? link.url : new URL(link.url, itemUrl).href;
    if (!sameHost(fullUrl, itemUrl)) continue;
    const combined = `${link.text} ${link.url}`.toLowerCase();
    if (keyWords.some((kw) => combined.includes(kw.toLowerCase()))) {
      relevant.push(fullUrl);
    }
  }
  return [...new Set(relevant)].slice(0, max);
}

export class DeeperReader {
  constructor({ judge, readPage } = {}) {
    this.judge = judge;
    this.readPage = readPage;
  }

  async readDeeperForUnknown(item, checklist, cache) {
    const checks = item.checks ?? [];
    const unknownHard = checks.filter((c) => c.hard === true && c.answer === 'unknown');
    if (unknownHard.length === 0) return item;
    const pageText = item.pageText ?? '';
    if (!pageText) return item;
    const links = item.links ?? [];
    for (const check of unknownHard) {
      const keyWords = extractKeyWords(check.clause + ' ' + check.id.split('|').pop());
      const relevantUrls = await findRelevantLinks(links, item.url, keyWords);
      let foundYes = false;
      for (const url of relevantUrls) {
        const cacheKey = `${url}::${check.id}`;
        let deeperChecks;
        if (cache[cacheKey]) {
          deeperChecks = cache[cacheKey];
        } else {
          const deeperPage = await this.readPage(url).catch(() => null);
          if (!deeperPage?.text) continue;
          deeperChecks = await this.judge.judge({ url }, deeperPage.text, checklist);
          cache[cacheKey] = deeperChecks;
        }
        const deeperCheck = deeperChecks.find((c) => c.id === check.id);
        if (deeperCheck?.answer === 'yes') {
          check.answer = 'yes';
          check.quote = deeperCheck.quote ?? '';
          check.source = url;
          foundYes = true;
          break;
        }
      }
    }
    return item;
  }
}