import { plain } from './itemgate.mjs';
import { paretoLayers } from './proposal.mjs';

export const VALUE_FACT_TEXTS = 40;
export const VALUE_FACT_MIN_ADS = 2;
export const LOW_USE_SHARE = 0.25;
export const MIN_CASE_PEERS = 5;
export const MIN_EFFECT_SAMPLE = 10;
export const MIN_AGREEING_SITES = 2;
export const CASE_METHOD = 'a reason counts only when it is measured on the market (mileage for its age with the measured mileage effect; a stated fact whose price effect is measured on comparable ads) or agreed by at least two independent owner and expert sites with quotes (model and engine reputation; a known problem the ad says was fixed); cars are ordered by Pareto layers over these measures (Deb et al. 2002), no hand weights'

export function valueFactsPrompt({ question = '', texts = [] }) {
  const listed = (texts ?? []).map((text, i) => `[${i + 1}] ${String(text).slice(0, 600)}`).join('\n');
  return [
    { role: 'system', content: 'You read real used-item ads and list the phrases, copied exactly as written in the ads and in their language, that state a fact affecting the value of the item. Answer with JSON only: {"for": ["..."], "against": ["..."]}. "for" lists phrases that state documented history (service book, first owner, mileage proven by inspection records, origin), recent maintenance or replaced wear parts (timing belt, clutch, brakes, new inspection), no rust or no faults, and notable equipment. "against" lists phrases that state rust, faults, damage, an accident, missing documents, a non-working part, or a sale for parts. Copy short phrases of one to four words exactly as written; list every distinct one you see, typically 15 to 40.' },
    { role: 'user', content: `Question: ${question}\n\nAds:\n${listed}` },
  ];
}

export function mergeValueFacts(replies) {
  const datas = (replies ?? []).map((r) => (r?.data && typeof r.data === 'object' ? r.data : null)).filter(Boolean);
  const need = Math.max(1, Math.ceil(datas.length / 2));
  const voted = (side) => {
    const votes = new Map();
    for (const d of datas) for (const w of new Set((Array.isArray(d[side]) ? d[side] : []).map((x) => plain(String(x)).trim()).filter((x) => x.length >= 4))) votes.set(w, (votes.get(w) ?? 0) + 1);
    return [...votes].filter(([, n]) => n >= need).map(([w]) => w);
  };
  return { for: voted('for'), against: voted('against'), samples: datas.length };
}

export function applyValueFacts(merged, texts) {
  const ads = (texts ?? []).map((t) => plain(String(t ?? '')));
  const seen = (phrase) => ads.filter((t) => t.includes(phrase)).length >= VALUE_FACT_MIN_ADS;
  const forList = (merged?.for ?? []).filter(seen);
  const against = (merged?.against ?? []).filter((p) => seen(p) && !forList.includes(p));
  return { for: forList, against, calibratedOn: ads.length };
}

const stated = (text, phrases) => (phrases ?? []).filter((p) => text.includes(p));

export function factEffects(entries, phrases, slopeYear = 0) {
  const dated = (entries ?? []).filter((e) => e.facts.year !== null && e.text);
  return (phrases ?? []).map((phrase) => {
    const withIt = [];
    const without = [];
    for (const e of dated) {
      const peers = dated.filter((o) => o !== e && o.group === e.group && Math.abs(o.facts.year - e.facts.year) <= 1);
      if (peers.length < MIN_CASE_PEERS) continue;
      const ratios = peers.map((o) => o.value * Math.exp((slopeYear ?? 0) * (e.facts.year - o.facts.year))).sort((a, b) => a - b);
      const mid = ratios[Math.floor(ratios.length / 2)];
      (e.text.includes(phrase) ? withIt : without).push(Math.log(e.value / mid));
    }
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const measurable = withIt.length >= MIN_EFFECT_SAMPLE && without.length >= MIN_EFFECT_SAMPLE;
    return { phrase, with: withIt.length, without: without.length, effect: measurable ? Math.round((Math.exp(median(withIt) - median(without)) - 1) * 1000) / 1000 : null };
  });
}

const perYear = (facts) => (facts.km !== null && facts.year !== null ? facts.km / Math.max(1, new Date().getUTCFullYear() - facts.year) : null);

export function consensusOf(facts) {
  const by = new Map();
  for (const f of facts ?? []) {
    const key = `${plain(f.engine ?? '')}|${f.aspect ?? 'reliability'}|${f.verdict}`;
    const entry = by.get(key) ?? { engine: f.engine ?? '', aspect: f.aspect ?? 'reliability', verdict: f.verdict, hosts: [], quotes: [], fixedBy: new Set(), note: f.note };
    if (!entry.hosts.includes(f.host)) {
      entry.hosts.push(f.host);
      entry.quotes.push({ quote: f.quote, source: f.source });
    }
    for (const phrase of f.fixedBy ?? []) entry.fixedBy.add(phrase);
    by.set(key, entry);
  }
  return [...by.values()].map((e) => ({ ...e, fixedBy: [...e.fixedBy] })).sort((a, b) => b.hosts.length - a.hosts.length);
}

const cited = (c) => `${c.hosts.length} independent sites: "${c.quotes[0].quote}" (${c.quotes.map((q) => q.source).slice(0, 3).join(', ')})`;

export function valueCase(row, peers, { phrases = { for: [], against: [] }, effects = [], reputation = [], kmSlope = null } = {}) {
  const text = plain(`${row.title ?? ''} ${row.adText ?? ''}`);
  const own = { for: stated(text, phrases.for), against: stated(text, phrases.against) };
  const reasons = [];
  const cautions = [];
  const unproven = [];
  const kmYear = perYear(row);
  const peerKm = (peers ?? []).map((p) => perYear(p.facts)).filter((v) => v !== null);
  let kmRank = null;
  if (kmYear !== null && peerKm.length >= MIN_CASE_PEERS) {
    kmRank = peerKm.filter((v) => v < kmYear).length / peerKm.length;
    const mid = [...peerKm].sort((a, b) => a - b)[Math.floor(peerKm.length / 2)];
    const effect = kmSlope !== null ? Math.round((Math.exp(kmSlope * Math.log(kmYear / mid)) - 1) * 100) : null;
    const effectText = effect !== null ? `; by the mileage effect measured on this market that is worth about ${effect >= 0 ? '+' : ''}${effect}%` : '';
    if (kmRank < LOW_USE_SHARE) reasons.push(`low use: ${Math.round(kmYear).toLocaleString('en')} km a year against a median of ${Math.round(mid).toLocaleString('en')} for ${peerKm.length} comparable cars${effectText}`);
    else if (kmRank > 1 - LOW_USE_SHARE) cautions.push(`high use: ${Math.round(kmYear).toLocaleString('en')} km a year against a median of ${Math.round(mid).toLocaleString('en')} for ${peerKm.length} comparable cars${effectText}`);
  }
  const effectOf = new Map((effects ?? []).map((e) => [e.phrase, e]));
  let advantages = 0;
  for (const phrase of own.for) {
    const e = effectOf.get(phrase);
    if (e?.effect !== null && e?.effect !== undefined && e.effect > 0) {
      advantages++;
      reasons.push(`states "${phrase}": ads that state it ask ${Math.round(e.effect * 100)}% more than comparable ads of the same model and year (${e.with} with it, ${e.without} without)`);
    } else unproven.push(e?.effect !== null && e?.effect !== undefined ? `"${phrase}" (no price gain measured: ${Math.round(e.effect * 100)}% on ${e.with} ads)` : `"${phrase}" (effect not measurable: ${e?.with ?? 0} ads state it, ${MIN_EFFECT_SAMPLE} needed)`);
  }
  for (const phrase of own.against) cautions.push(`states "${phrase}"`);
  const agreed = consensusOf(reputation).filter((c) => c.hosts.length >= MIN_AGREEING_SITES);
  let standing = 0;
  for (const c of agreed) {
    const fixed = c.verdict === 'problematic' ? c.fixedBy.find((phrase) => text.includes(phrase)) : null;
    if (fixed) {
      advantages++;
      reasons.push(`a known ${c.engine || 'model'} problem (${c.note}) the ad says is fixed: "${fixed}"; the problem is reported by ${cited(c)}`);
    } else if (['reliable', 'cheap'].includes(c.verdict)) {
      standing++;
      reasons.push(`${c.verdict}${c.engine ? ` ${c.engine}` : ''}: ${c.note}; ${cited(c)}`);
    } else if (['problematic', 'expensive'].includes(c.verdict)) {
      standing--;
      cautions.push(`${c.verdict}${c.engine ? ` ${c.engine}` : ''}: ${c.note}; ${cited(c)}`);
    }
  }
  const priceRatio = Number.isFinite(row.marketValue) && row.value > 0 ? row.value / row.marketValue : null;
  return {
    reasons,
    cautions,
    unproven,
    ordinary: !reasons.length,
    summary: reasons.length ? `stands out: ${reasons.length} evidenced reason${reasons.length === 1 ? '' : 's'}` : 'nothing evidenced distinguishes it from comparable cars of its year',
    measures: { priceRatio, kmRank, advantages, against: own.against.length, reputation: standing },
  };
}

export const CASE_OBJECTIVES = [
  { id: 'priceRatio', label: 'asking price against the estimate', better: 'min', read: (r) => r.valueCase?.measures?.priceRatio ?? null },
  { id: 'kmRank', label: 'use for its age', better: 'min', read: (r) => r.valueCase?.measures?.kmRank ?? null },
  { id: 'advantages', label: 'documented advantages', better: 'max', read: (r) => r.valueCase?.measures?.advantages ?? null },
  { id: 'against', label: 'stated faults', better: 'min', read: (r) => r.valueCase?.measures?.against ?? null },
  { id: 'reputation', label: 'model and engine reputation', better: 'max', read: (r) => r.valueCase?.measures?.reputation ?? null },
];

export function rankCases(rows) {
  const cased = rows.filter((r) => r.valueCase);
  const layers = paretoLayers(cased, CASE_OBJECTIVES);
  return rows.map((r) => (layers.has(r) ? { ...r, caseLayer: layers.get(r) } : r));
}
