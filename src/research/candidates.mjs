import { currencyOf } from './acceptance.mjs';
import { countryByCode, isNewsPage, itemCountry, mentionsCoast } from './brief.mjs';
import { valueTable } from './valuation.mjs';
import { plain, screenItem } from './itemgate.mjs';
import { listingKey } from '../search/listings.mjs';
import { explorePoints } from './site.mjs';
import { pricePerM2Medians } from './strategy.mjs';

export const MAX_KEPT = 1000;
export const MAX_TO_CHECK = 100;
export const MAX_SCREENED_EXAMPLES = 30;
export const MAX_OUTSIDE = 150;
const OUTSIDE_REASON = /^in .*, outside the asked regions$/;
export const MIN_PLAUSIBLE_SHARE = 0.01;

const hasWord = (text, word) => {
  const term = plain(word).trim();
  return Boolean(term) && new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(text);
};

const YEAR_MARKED = /\b(?:r\s*\.?\s*v\s*\.?|r\s*\.|rok(?:u|em)?)\s*[.:]?\s*((?:19|20)\d{2})(?!\d)/;
const YEAR_PLAIN = /(?<!\d)((?:19|20)\d{2})(?!\d)/;
const KM_TEXT = /(\d{1,3}(?:[ .]\d{3})+|\d+)\s*(t|tis\.?|tis)?\s*km(?!\w)/;
const KW_TEXT = /(?<![\d.,])(\d{1,3}(?:[.,]\d+)?)\s*kw(?!\w)/;

function textYear(text) {
  const marked = text.match(YEAR_MARKED);
  if (marked) return Number(marked[1]);
  const standalone = text.match(YEAR_PLAIN);
  return standalone ? Number(standalone[1]) : null;
}

function textKm(text) {
  const m = text.match(KM_TEXT);
  if (!m) return null;
  const km = Number(m[1].replace(/[ .]/g, '')) * (m[2] ? 1000 : 1);
  return Number.isFinite(km) ? km : null;
}

function textKw(text) {
  const m = text.match(KW_TEXT);
  return m ? Number(m[1].replace(',', '.')) : null;
}

function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const m = value.match(/-?\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(',', '.')) : null;
}

function attrYear(value) {
  const n = numericValue(value);
  return n !== null && n >= 1900 && n <= 2099 ? Math.trunc(n) : null;
}

function attrKm(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const m = value.toLowerCase().match(KM_TEXT);
  if (m) return Number(m[1].replace(/[ .]/g, '')) * (m[2] ? 1000 : 1);
  return numericValue(value);
}

function attrNumber(attrs, pattern, read) {
  const entries = Object.entries(attrs && typeof attrs === 'object' ? attrs : {})
    .sort((a, b) => Number(/#n$/.test(b[0])) - Number(/#n$/.test(a[0])));
  for (const [key, value] of entries) {
    if (!pattern.test(key)) continue;
    const found = read(value);
    if (found !== null) return found;
  }
  return null;
}

export function rowFacts(row) {
  const text = plain(row?.title ?? '');
  const attrs = row?.attrs ?? {};
  return {
    year: textYear(text) ?? attrNumber(attrs, /year/i, attrYear),
    km: textKm(text) ?? attrNumber(attrs, /mileage|odometer|kilomet/i, attrKm),
    kw: textKw(text) ?? attrNumber(attrs, /power|kw/i, numericValue),
  };
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function peerGroup(row, models) {
  const title = plain(row?.title ?? '');
  for (const model of models ?? []) {
    const term = plain(model).trim();
    if (term && hasWord(title, term)) return term;
  }
  return title.split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
}

export const FAR_BELOW_PEERS = 0.5;

export function valueVsPeers(rows, models = []) {
  const list = rows ?? [];
  const groups = list.map((row) => peerGroup(row, models));
  return list.map((row, index) => {
    const facts = rowFacts(row);
    const peers = list.filter((other, i) => groups[i] === groups[index] && Number.isFinite(other?.value));
    let peerMedian = null;
    let valueIndex = null;
    if (Number.isFinite(row?.value) && peers.length >= 3) {
      const near = facts.year === null ? [] : peers.filter((other) => {
        const year = rowFacts(other).year;
        return year !== null && Math.abs(year - facts.year) <= 2;
      });
      const sample = near.length >= 3 ? near : peers;
      peerMedian = medianOf(sample.map((other) => other.value));
      valueIndex = peerMedian > 0 ? Math.round((row.value / peerMedian) * 100) / 100 : null;
    }
    return { ...row, group: groups[index], peerMedian, peers: peers.length, valueIndex, ...facts, ...(valueIndex !== null && valueIndex < FAR_BELOW_PEERS ? { peerNote: 'far below its peers: confirm the full price and condition' } : {}) };
  });
}

function rowsFrom(nodes) {
  const rows = [];
  for (const node of nodes ?? []) {
    for (const source of node.sources ?? []) {
      for (const listing of source.listings ?? []) rows.push({ ...listing, sourceUrl: listing.page || source.url, sourceId: source.id, nodeId: node.id, source });
    }
    for (const item of node.finding?.items ?? []) {
      const source = (node.sources ?? []).find((s) => s.id === item.sourceId) ?? null;
      rows.push({ ...item, sourceUrl: source?.url ?? '', sourceId: item.sourceId ?? '', nodeId: node.id, via: item.via ?? [item.harvested ? 'page links' : 'model'], source });
    }
  }
  return rows;
}

function inUnit(row, unit, convert) {
  if (row.value === null || row.value === undefined || row.value === '') return null;
  const wanted = currencyOf(unit);
  const from = currencyOf(row.unit) || wanted;
  const value = Number(row.value);
  if (!Number.isFinite(value)) return null;
  if (!wanted || !from || from === wanted) return value;
  const converted = convert(value, from, wanted);
  return converted === null || converted === undefined ? null : Math.round(converted);
}

export function screenCandidate(row, brief, options = {}) {
  const convert = options.convert ?? ((v) => v);
  const verdict = screenItem(row, { ...options, valueRange: brief?.valueRange ?? options.valueRange ?? null, unit: brief?.unit ?? options.unit ?? '', kind: brief?.kind ?? options.kind ?? null, kindKnown: Boolean(row.source?.kindPage) });
  const reasons = [...verdict.reasons];
  if (isNewsPage(row.url)) reasons.push('news, blog or guide page');
  const country = itemCountry(row, row.source);
  if (brief?.regions?.length && country.code && !brief.regions.includes(country.code)) reasons.push(`in ${countryByCode(country.code)?.name ?? country.code}, outside the asked regions`);
  const read = inUnit(row, brief?.unit ?? '', convert);
  const floor = brief?.valueRange ? brief.valueRange[1] * MIN_PLAUSIBLE_SHARE : 0;
  const value = read !== null && read < floor ? null : read;
  const missing = [];
  if (read !== null && value === null) missing.push(`price read as ${row.value} ${row.unit}, too low to be the asking price`);
  else if (value === null) missing.push('price not shown');
  if (brief?.regions?.length && !country.code) missing.push('country not shown');
  const subtype = brief?.subtype;
  if (subtype?.models?.length) {
    const offer = plain(`${row.title ?? ''} ${row.url ?? ''}`);
    if (!subtype.models.some((model) => hasWord(offer, model))) missing.push(`not shown to be a ${subtype.label}`);
    else if ((subtype.variants ?? []).some((word) => hasWord(offer, word))) missing.push(`a body variant that is not a ${subtype.label}`);
  }
  return { reasons, missing, country, value };
}

function publicRow(row, verdict, unit) {
  return {
    title: String(row.title ?? row.url).slice(0, 160),
    url: row.url,
    price: row.value ?? null,
    currency: currencyOf(row.unit) || row.unit || '',
    value: verdict.value,
    unit,
    area: row.area ?? null,
    areaUnit: row.areaUnit || (row.area ? 'm²' : ''),
    place: row.place ?? '',
    country: verdict.country.code ? countryByCode(verdict.country.code)?.name ?? verdict.country.code : '',
    countryCode: verdict.country.code ?? '',
    ...(Number.isFinite(row.lat) && Number.isFinite(row.lon) ? { lat: row.lat, lon: row.lon } : {}),
    ...(Number.isFinite(row.distanceKm) ? { distanceKm: row.distanceKm } : {}),
    ...(row.attrs && typeof row.attrs === 'object' ? { attrs: row.attrs } : {}),
    countryBy: verdict.country.by,
    coast: mentionsCoast(row),
    sourceUrl: row.sourceUrl ?? '',
    nodeId: row.nodeId,
    via: row.via ?? [],
    ...(verdict.missing.length ? { toCheck: verdict.missing.join('; ') } : {}),
  };
}

export const MIN_PRICE_SAMPLE = 20;
const MAD_SCALE = 1.4826;
const LOW_PRICE_MADS = 2.5;

export function implausiblyLow(rows) {
  const priced = rows.filter((r) => Number.isFinite(r.value) && r.value > 0);
  if (priced.length < MIN_PRICE_SAMPLE) return [];
  const logs = priced.map((r) => Math.log(r.value)).sort((a, b) => a - b);
  const middle = (list) => list[Math.floor(list.length / 2)];
  const median = middle(logs);
  const mad = middle(logs.map((v) => Math.abs(v - median)).sort((a, b) => a - b));
  if (!(mad > 0)) return [];
  const cut = Math.round(Math.exp(median - LOW_PRICE_MADS * MAD_SCALE * mad));
  return priced.filter((r) => r.value < cut).map((r) => Object.assign(r, { lowCut: cut }));
}

export function buildCandidates(nodes, brief, options = {}) {
  const unit = brief?.unit ?? '';
  let kept = [];
  const toCheck = [];
  const screened = {};
  const examples = [];
  const outside = [];
  const market = [];
  let found = 0;
  const unique = new Map();
  for (const row of rowsFrom(nodes)) {
    if (!row.url) continue;
    const key = listingKey(row.url);
    const known = unique.get(key);
    if (!known) unique.set(key, row);
    else if ((known.value === null || known.value === undefined) && row.value !== null && row.value !== undefined) unique.set(key, { ...known, ...row, title: known.title && known.title !== known.url ? known.title : row.title });
  }
  for (const row of unique.values()) {
    found++;
    const verdict = screenCandidate(row, brief, options);
    if (verdict.value !== null && verdict.country.code && verdict.reasons.every((r) => /^price .* is outside|outside the asked regions$/.test(r))) market.push({ countryCode: verdict.country.code, value: verdict.value, area: row.area ?? null, areaUnit: row.areaUnit ?? '', title: row.title ?? '', place: row.place ?? '' });
    if (verdict.reasons.length) {
      for (const reason of verdict.reasons) {
        const label = reason.replace(/^price .* is outside/, 'price outside').replace(/^in .*, outside the asked regions$/, 'outside the asked regions');
        screened[label] = (screened[label] ?? 0) + 1;
      }
      if (examples.length < MAX_SCREENED_EXAMPLES) examples.push({ title: String(row.title ?? '').slice(0, 100), url: row.url, reasons: verdict.reasons });
      if (verdict.reasons.every((r) => OUTSIDE_REASON.test(r)) && !verdict.missing.length) outside.push(publicRow(row, verdict, unit));
      continue;
    }
    (verdict.missing.length ? toCheck : kept).push(publicRow(row, verdict, unit));
  }
  for (const row of implausiblyLow(kept)) {
    kept.splice(kept.indexOf(row), 1);
    const { lowCut, ...rest } = row;
    toCheck.push({ ...rest, toCheck: [rest.toCheck, `price far below what most listings of this kind cost (under ${lowCut} ${unit}): likely a part, a deposit or an instalment`].filter(Boolean).join('; ') });
  }
  if (brief?.subtype?.models?.length) {
    const compared = valueVsPeers(kept, brief.subtype.models);
    kept = compared.filter((row) => !row.peerNote);
    for (const row of compared.filter((r) => r.peerNote)) toCheck.push({ ...row, toCheck: [row.toCheck, `price ${row.valueIndex} of its ${row.peers} peers' median: ${row.peerNote}`].filter(Boolean).join('; ') });
    kept = valueTable(kept, [...kept, ...toCheck, ...market.filter((m) => m.title)], { models: brief.subtype.models, groupFacts: brief.groupFacts ?? {}, condition: brief.kind?.condition ?? [], upgrades: brief.kind?.upgrades ?? [] });
  }
  if (kept.some((row) => Number.isFinite(row.underpriced))) kept.sort(() => 0);
  else if (kept.some((row) => row.valueIndex !== null && row.valueIndex !== undefined)) kept.sort((a, b) => (a.valueIndex ?? Infinity) - (b.valueIndex ?? Infinity) || (a.km ?? Infinity) - (b.km ?? Infinity) || (a.value ?? Infinity) - (b.value ?? Infinity));
  else kept.sort((a, b) => Number(b.coast) - Number(a.coast) || (a.value ?? Infinity) - (b.value ?? Infinity));
  return {
    found,
    kept: kept.slice(0, MAX_KEPT),
    keptCount: kept.length,
    toCheck: toCheck.slice(0, MAX_TO_CHECK),
    outside: outside.sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity)).slice(0, MAX_OUTSIDE),
    outsideCount: outside.length,
    priceMedians: pricePerM2Medians(market),
    marketRows: market.filter((r) => r.area).length,
    toCheckCount: toCheck.length,
    screened,
    screenedCount: found - kept.length - toCheck.length,
    examples,
    builtAt: new Date().toISOString(),
  };
}

export function countsTowardResult(row, candidates) {
  return !row.plan || (row.plan.tier === 'fits' && (row.verified?.verdict === 'confirmed' || !candidates?.verification));
}

export function candidateDeliverables(candidates) {
  return (candidates?.kept ?? []).filter((row) => countsTowardResult(row, candidates)).map((row) => ({ title: row.title, url: row.url, value: row.price, unit: row.currency, nodeId: row.nodeId, harvested: true, candidate: true }));
}

function siteText(row) {
  if (row.plan) return ` | ${row.plan.tier}: ${row.plan.verdict} | why: ${row.plan.why.join('; ')}${row.plan.risks.length ? ` | risks: ${row.plan.risks.join('; ')}` : ''}`;
  const site = row.site;
  if (!site) return row.siteNote ? ` | ${row.siteNote}` : '';
  const season = site.climate ? ` | ${site.climate.workable} workable months (${site.climate.comfortable} comfortable), hottest month max ${site.climate.hottest}°C` : '';
  return ` | sea ${site.coastKm ?? '?'} km, beach ${site.beachKm ?? '?'} km${season} | ${explorePoints(site)} beaches, viewpoints, sights, reserves and trails within 15 km | zoning ${row.fit.zoning}${row.fit.pitches !== null ? ` | about ${row.fit.pitches} pitches` : ''}`;
}

export function shortlistText(candidates, limit = 15) {
  if (!candidates) return '';
  const reasons = Object.entries(candidates.screened ?? {}).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ');
  const rows = (candidates.kept ?? []).slice(0, limit).map((r) => `- ${r.title} | ${r.value ?? r.price} ${r.unit || r.currency} | ${r.area ? `${r.area} ${r.areaUnit}` : 'area n/a'} | ${r.place || r.country || 'place n/a'}${r.coast ? ' | coast stated' : ''}${siteText(r)}`);
  const ranked = candidates.sites ? `, ranked by code-measured fit (sea distance, workable months, no-AC heat, things to explore, price trend, cost, zoning)` : '';
  const kept = candidates.keptCount ?? 0;
  return [`TABLE COUNTS (computed by code, final): found ${candidates.found}, kept ${kept} (the result list)${ranked}, to check ${candidates.toCheckCount}, screened out ${candidates.screenedCount}${reasons ? ` (${reasons})` : ''}`, `First ${Math.min(limit, kept)} of the ${kept} kept rows:`, ...rows].join('\n');
}

export function tableVerdict(candidates, itemCount = null) {
  const t = candidates?.tiers;
  if (!t) {
    if (!candidates || typeof candidates.keptCount !== 'number') return '';
    const kept = candidates.keptCount;
    const met = itemCount ? (kept >= itemCount ? ` — the ${itemCount} asked are met` : ` — ${itemCount - kept} short of the ${itemCount} asked`) : '';
    return `Table (computed by code): ${kept} result${kept === 1 ? '' : 's'} kept${met}; ${candidates.toCheckCount ?? 0} to check; ${candidates.screenedCount ?? 0} screened out of ${candidates.found ?? 0} found`;
  }
  const target = itemCount ? ` of the ${itemCount} asked` : '';
  const v = candidates.verification;
  const verified = v ? ` (externally verified: ${v.confirmed} confirmed, ${v.refuted} refuted, ${v.unconfirmed + v.pending} not yet confirmed; a plot counts only when it fits every check and is confirmed)` : '';
  const fits = t.fits ?? 0;
  const tradeOff = t['trade-off'] ?? 0;
  const unverified = t.unverified ?? 0;
  const weak = t.weak ?? 0;
  const blocked = t.blocked ?? 0;
  return `Decision model: ${fits} plot${fits === 1 ? '' : 's'}${target} fit every check${verified}; ${tradeOff} trade-off${tradeOff === 1 ? '' : 's'} with their potential; ${unverified} to confirm; ${weak} weak; ${blocked} blocked by law`;
}
