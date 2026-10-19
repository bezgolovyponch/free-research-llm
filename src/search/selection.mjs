export const LOW_TIER = /(^|\.)(marketresearchfuture|researchandmarkets|emergenresearch|cognitivemarketresearch|precedenceresearch|databridgemarketresearch|futuremarketinsights|polarismarketresearch|thebusinessresearchcompany|kbvresearch|kenresearch|openpr|coherentmarketinsights|6wresearch|qyresearch|industryarc|marketdataforecast|delveinsight|grandviewresearch|alliedmarketresearch|fortunebusinessinsights|verifiedmarketreports|mordorintelligence|imarcgroup|expertmarketresearch|globenewswire|einpresswire|investorshangout)\.(com|org|net|in|co)$|\.(netlify|vercel|herokuapp|blogspot|wordpress)\.(app|com)$|(^|\.)(change\.org|scribd\.com|slideshare\.net|pinterest\.com|quora\.com)$/i;
export const PRIMARY_TIER = /(^|\.)(github\.com|arxiv\.org|biorxiv\.org|medrxiv\.org|chemrxiv\.org|pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|nature\.com|science\.org|cell\.com|acs\.org|rsc\.org|sciencedirect\.com|springer\.com|wiley\.com|europa\.eu|gov\.uk|sec\.gov|fda\.gov|ema\.europa\.eu|prnewswire\.com|businesswire\.com|crunchbase\.com|companieshouse\.gov\.uk|find-and-update\.company-information\.service\.gov\.uk)$|\.gov$/i;
export const TIER_BONUS = { primary: 3, secondary: 1, low: -2 };
const MAX_LOW = 2;
const STOP = new Set('the a an and or of in on for to with by from at as is are was were be what which how many much does do vs per its their this that into over under 2024 2025 2026 2027'.split(' '));

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function entityDomains(text) {
  return [...new Set((String(text ?? '').match(/https?:\/\/[^\s"'<>)]+/g) ?? []).map(hostOf).filter(Boolean))];
}

export function entityNames(domains) {
  return domains.map((d) => d.split('.').slice(-2, -1)[0]).filter((n) => n && n.length > 2);
}

export function sourceTier(url, entities = []) {
  const host = hostOf(url);
  if (!host) return 'secondary';
  if (entities.some((d) => host === d || host.endsWith(`.${d}`))) return 'primary';
  if (LOW_TIER.test(host)) return 'low';
  if (PRIMARY_TIER.test(host)) return 'primary';
  return 'secondary';
}

export function terms(text) {
  return [...new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9äöüßáčďéěíňóřšťúůýž]+/i).filter((w) => w.length > 2 && !STOP.has(w)))];
}

export function relevance(candidate, wanted) {
  const have = new Set(terms(`${candidate.title ?? ''} ${candidate.snippet ?? ''} ${String(candidate.text ?? '').slice(0, 2000)}`));
  if (!wanted.length) return 0;
  return wanted.filter((w) => have.has(w)).length / wanted.length;
}

export function namesAny(candidate, names) {
  if (!names.length) return true;
  const text = `${candidate.url ?? ''} ${candidate.title ?? ''} ${candidate.snippet ?? ''} ${String(candidate.text ?? '').slice(0, 3000)}`.toLowerCase();
  return names.some((n) => text.includes(n.toLowerCase()));
}

export function selectDiverse(candidates, { max = 8, perDomain = 2, wanted = [], entities = [], usedDomains = {}, names = [] } = {}) {
  const pool = candidates.map((c, i) => {
    const tier = sourceTier(c.url, entities);
    const rel = relevance(c, wanted) * (tier === 'primary' || namesAny(c, names) ? 1 : 0.25);
    return { c, i, host: hostOf(c.url), tier, rel };
  });
  const picked = [];
  const perHost = new Map();
  const perQuery = new Map();
  let low = 0;
  while (picked.length < max && pool.length) {
    let best = -1;
    let bestScore = -Infinity;
    pool.forEach((x, k) => {
      if ((perHost.get(x.host) ?? 0) >= perDomain) return;
      if (x.tier === 'low' && low >= MAX_LOW) return;
      if (wanted.length && x.rel === 0 && x.tier !== 'primary') return;
      const score = 4 * x.rel + TIER_BONUS[x.tier] - 1.5 * (perHost.get(x.host) ?? 0) - 0.75 * (perQuery.get(x.c.query) ?? 0) - 0.5 * Math.min(4, usedDomains[x.host] ?? 0) - x.i * 0.01;
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    });
    if (best < 0) break;
    const [x] = pool.splice(best, 1);
    picked.push({ ...x.c, tier: x.tier });
    perHost.set(x.host, (perHost.get(x.host) ?? 0) + 1);
    perQuery.set(x.c.query, (perQuery.get(x.c.query) ?? 0) + 1);
    if (x.tier === 'low') low++;
  }
  return picked;
}

const OWNER_FIGURE = /\b(cash burn|burn rate|revenues?|financial statements?|profit|margin|customer count|number of customers|customers?|subscribers?|subscriptions? needed|break[- ]even|churn|cost structure|budget|headcount|salar(?:y|ies)|market share|deployments?)\b/i;

export function ownerOnly(node, subjectNames = []) {
  const text = `${node.title ?? ''} ${node.question ?? ''}`.toLowerCase();
  if (!OWNER_FIGURE.test(text)) return null;
  const subject = subjectNames.find((n) => text.includes(n.toLowerCase()));
  return subject ?? null;
}

export function mentionedNames(node, names) {
  const text = `${node.title ?? ''} ${node.question ?? ''}`.toLowerCase();
  return names.filter((n) => text.includes(n.toLowerCase()));
}

export function scopedQueries(node, names) {
  const named = mentionedNames(node, names);
  const plain = [node.title, ...(node.searchQueries ?? []), node.question].filter(Boolean);
  if (!named.length) return plain;
  return plain.map((q) => (named.some((n) => q.toLowerCase().includes(n.toLowerCase())) ? q : `${q} ${named.join(' ')}`));
}

export function entityQueries(node, domains) {
  const text = `${node.title ?? ''} ${node.question ?? ''}`.toLowerCase();
  const topic = terms(node.title || node.question).slice(0, 5).join(' ');
  return domains.filter((d) => text.includes(d.split('.').slice(-2, -1)[0])).map((d) => `site:${d} ${topic}`.trim());
}
