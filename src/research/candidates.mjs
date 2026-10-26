import { currencyOf } from './acceptance.mjs';
import { countryByCode, isNewsPage, itemCountry, mentionsCoast } from './brief.mjs';
import { screenItem } from './itemgate.mjs';
import { listingKey } from '../search/listings.mjs';
import { explorePoints } from './site.mjs';

export const MAX_KEPT = 200;
export const MAX_TO_CHECK = 100;
export const MAX_SCREENED_EXAMPLES = 30;
export const MAX_OUTSIDE = 150;
const OUTSIDE_REASON = /^in .*, outside the asked regions$/;
export const MIN_PLAUSIBLE_SHARE = 0.01;

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
  const verdict = screenItem(row, { ...options, valueRange: brief?.valueRange ?? options.valueRange ?? null, unit: brief?.unit ?? options.unit ?? '', kind: brief?.kind ?? options.kind ?? null });
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
    countryBy: verdict.country.by,
    coast: mentionsCoast(row),
    sourceUrl: row.sourceUrl ?? '',
    nodeId: row.nodeId,
    via: row.via ?? [],
    ...(verdict.missing.length ? { toCheck: verdict.missing.join('; ') } : {}),
  };
}

export function buildCandidates(nodes, brief, options = {}) {
  const unit = brief?.unit ?? '';
  const kept = [];
  const toCheck = [];
  const screened = {};
  const examples = [];
  const outside = [];
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
  kept.sort((a, b) => Number(b.coast) - Number(a.coast) || (a.value ?? Infinity) - (b.value ?? Infinity));
  return {
    found,
    kept: kept.slice(0, MAX_KEPT),
    keptCount: kept.length,
    toCheck: toCheck.slice(0, MAX_TO_CHECK),
    outside: outside.sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity)).slice(0, MAX_OUTSIDE),
    outsideCount: outside.length,
    toCheckCount: toCheck.length,
    screened,
    screenedCount: found - kept.length - toCheck.length,
    examples,
    builtAt: new Date().toISOString(),
  };
}

export function candidateDeliverables(candidates) {
  return (candidates?.kept ?? []).filter((row) => !row.plan || row.plan.tier === 'fits').map((row) => ({ title: row.title, url: row.url, value: row.price, unit: row.currency, nodeId: row.nodeId, harvested: true, candidate: true }));
}

function siteText(row) {
  if (row.plan) return ` | ${row.plan.tier}: ${row.plan.verdict} | why: ${row.plan.why.join('; ')}${row.plan.risks.length ? ` | risks: ${row.plan.risks.join('; ')}` : ''}`;
  const site = row.site;
  if (!site) return row.siteNote ? ` | ${row.siteNote}` : '';
  const season = site.climate ? ` | ${site.climate.workable} workable months (${site.climate.comfortable} comfortable), hottest month max ${site.climate.hottest}°C` : '';
  return ` | fit ${row.fit.score} | sea ${site.coastKm ?? '?'} km, beach ${site.beachKm ?? '?'} km${season} | ${explorePoints(site)} beaches, viewpoints, sights, reserves and trails within 15 km | zoning ${row.fit.zoning}${row.fit.pitches !== null ? ` | about ${row.fit.pitches} pitches` : ''}`;
}

export function shortlistText(candidates, limit = 15) {
  if (!candidates) return '';
  const reasons = Object.entries(candidates.screened ?? {}).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ');
  const rows = (candidates.kept ?? []).slice(0, limit).map((r) => `- ${r.title} | ${r.value ?? r.price} ${r.unit || r.currency} | ${r.area ? `${r.area} ${r.areaUnit}` : 'area n/a'} | ${r.place || r.country || 'place n/a'}${r.coast ? ' | coast stated' : ''}${siteText(r)}`);
  const ranked = candidates.sites ? `, ranked by code-measured fit (sea distance, workable months, no-AC heat, things to explore, price trend, cost, zoning)` : '';
  return [`found ${candidates.found}, kept ${candidates.keptCount}${ranked}, to check ${candidates.toCheckCount}, screened out ${candidates.screenedCount}${reasons ? ` (${reasons})` : ''}`, ...rows].join('\n');
}

export function tableVerdict(candidates, itemCount = null) {
  const t = candidates?.tiers;
  if (!t) return '';
  const target = itemCount ? ` of the ${itemCount} asked` : '';
  return `Decision model: ${t.fits} plot${t.fits === 1 ? '' : 's'}${target} fit every check; ${t['trade-off']} trade-off${t['trade-off'] === 1 ? '' : 's'} with their potential; ${t.unverified} to confirm; ${t.weak ?? 0} weak; ${t.blocked} blocked by law`;
}
