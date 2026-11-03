import { plain } from './itemgate.mjs';

export const COMPARABLES = 7;
export const MIN_COMPARABLES = 3;
export const UNDERPRICED_FROM = 1.25;
export const RELIABILITY_ADJUSTMENT = { reliable: 0.1, problematic: -0.15 };
export const ADJUSTMENT_NOTE = 'reliability adjustment of +10% (reliable) or −15% (problematic) is an assumption of this app, not a sourced figure';

const YEAR_MARKED = /(?:\br\s*\.?\s*v\s*\.?|\br\s*\.|\brok(?:u|em)?|\bv provozu od\s*\d{1,2}\s*\/|\bbaujahr|\brocznik|\bmodel(?:ový)? rok|\bez|\berstzulassung)\s*[.:]?\s*((?:19|20)\d{2})(?!\d)/;
const YEAR_PLAIN = /(?<![\d.,/])((?:19[89]|20[0-3])\d)(?![\d.,])/;
const KM_TEXT = /(\d{1,3}(?:[ . ]\d{3})+|\d+)\s*(tkm|t\.?\s*km|tis\.?\s*km|tisíc\s*km|km|kilometr\w*)(?![a-z])/;
const KW_TEXT = /(?<![\d.,])(\d{2,3}(?:[.,]\d)?)\s*kw(?![a-z])/;
const ENGINE_SIZE = /(?<![\d.,])([0-6])[.,](\d)(?![\d,.])/;
const ENGINE_TECH = /(?<![a-z])(tdi|tdci|hdi|crdi|cdti|dci|jtd|d-4d|mpi|htp|tsi|tfsi|fsi|vvt-?i|vtec|gdi|t-?jet|ecoboost|ecotec|puretech|lpg|cng)(?![a-z])/;
const DIESEL = /(?<![a-z])(tdi|tdci|hdi|crdi|cdti|dci|jtd|d-4d|diesel|nafta)(?![a-z])/;
const PETROL = /(?<![a-z])(mpi|htp|tsi|tfsi|fsi|vvt-?i|vtec|gdi|t-?jet|ecoboost|puretech|benz\w*|petrol|benzin\w*)(?![a-z])/;

function textOf(row) {
  const attrs = row?.attrs ?? {};
  const description = Object.entries(attrs).filter(([k, v]) => typeof v === 'string' && !/#n$/.test(k) && !NOT_FACT_FIELD.test(k)).map(([, v]) => v).join(' ');
  return { title: plain(row?.title ?? ''), all: plain(`${row?.title ?? ''} ${description}`) };
}

const NOT_FACT_FIELD = /date|time|posted|updated|views|seen|top/i;
const VALID_UNTIL = /(?:^|[^a-z])(?:stk|tk|technick\w*|platn\w*|valid|until|bis|do|to)\s*[.:]?\s*(?:\d{1,2}\s*[./]\s*)*$/;

function yearIn(text) {
  const marked = text.match(YEAR_MARKED);
  if (marked) return Number(marked[1]);
  for (const m of text.matchAll(new RegExp(YEAR_PLAIN.source, 'g'))) {
    if (VALID_UNTIL.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
    return Number(m[1]);
  }
  return null;
}

function kmIn(text) {
  for (const m of text.matchAll(new RegExp(KM_TEXT.source, 'g'))) {
    const n = Number(m[1].replace(/[ . ]/g, ''));
    if (!Number.isFinite(n)) continue;
    const km = /^(tkm|t\.?\s*km|tis|tisíc)/.test(m[2]) ? n * 1000 : n;
    if (km >= 1000 && km <= 900000) return km;
  }
  return null;
}

export function listingFacts(row) {
  const { title, all } = textOf(row);
  const described = yearIn(all);
  const year = yearIn(title) ?? (described !== null && described < new Date().getUTCFullYear() ? described : null);
  const kwMatch = title.match(KW_TEXT) ?? all.match(KW_TEXT);
  const size = title.match(ENGINE_SIZE) ?? all.match(ENGINE_SIZE);
  const tech = (title.match(ENGINE_TECH) ?? all.match(ENGINE_TECH))?.[1]?.replace('-', '') ?? null;
  const fuel = DIESEL.test(all) ? 'diesel' : PETROL.test(all) ? 'petrol' : null;
  return {
    year: year && year >= 1970 && year <= new Date().getUTCFullYear() + 1 ? year : null,
    km: kmIn(title) ?? kmIn(all),
    kw: kwMatch ? Number(kwMatch[1].replace(',', '.')) : null,
    engine: size ? `${size[1]}.${size[2]}${tech ? ` ${tech}` : ''}` : tech,
    fuel,
  };
}

export function groupOf(row, models = []) {
  const title = plain(row?.title ?? '');
  for (const model of models ?? []) {
    const key = plain(model).trim();
    if (key && new RegExp(`(?:^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(title)) return key;
  }
  return '';
}

const MISSING_FACT = 1.5;
const UNKNOWN_BOTH = 0.5;

function distance(a, b) {
  const part = (x, y, scale) => (x === null && y === null ? UNKNOWN_BOTH : x === null || y === null ? MISSING_FACT : Math.min(2, Math.abs(x - y) / scale));
  const km = a.km === null && b.km === null ? UNKNOWN_BOTH : a.km === null || b.km === null ? MISSING_FACT : Math.min(2, Math.abs(Math.log(a.km) - Math.log(b.km)) / 0.5);
  const engine = !a.engine || !b.engine ? 0.3 : a.engine === b.engine ? 0 : a.engine.split(' ')[0] === b.engine.split(' ')[0] ? 0.4 : 0.8;
  return part(a.year, b.year, 3) + km + part(a.kw, b.kw, 15) + engine + (a.fuel && b.fuel && a.fuel !== b.fuel ? 1 : 0);
}

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const MAX_PAIRS = 3000;
const MAX_ADJUSTMENT = 2;

export function theilSen(points) {
  const slopes = [];
  for (let i = 0; i < points.length && slopes.length < MAX_PAIRS; i++) {
    for (let j = i + 1; j < points.length && slopes.length < MAX_PAIRS; j++) {
      const dx = points[j][0] - points[i][0];
      if (dx !== 0) slopes.push((points[j][1] - points[i][1]) / dx);
    }
  }
  return slopes.length >= 3 ? median(slopes) : 0;
}

export function groupSlopes(list) {
  const byYear = list.filter((r) => r.facts.year !== null).map((r) => [r.facts.year, Math.log(r.value)]);
  const byKm = list.filter((r) => r.facts.km !== null).map((r) => [Math.log(r.facts.km), Math.log(r.value)]);
  return { year: Math.max(0, theilSen(byYear)), km: Math.min(0, theilSen(byKm)) };
}

function adjusted(peer, facts, slopes) {
  let factor = 0;
  if (facts.year !== null && peer.facts.year !== null) factor += slopes.year * (facts.year - peer.facts.year);
  if (facts.km !== null && peer.facts.km !== null) factor += slopes.km * (Math.log(facts.km) - Math.log(peer.facts.km));
  return peer.value * Math.min(MAX_ADJUSTMENT, Math.max(1 / MAX_ADJUSTMENT, Math.exp(factor)));
}

export function marketSample(rows, models = []) {
  const byGroup = new Map();
  for (const row of rows ?? []) {
    if (!Number.isFinite(row?.value) || row.value <= 0) continue;
    const group = groupOf(row, models);
    if (!group) continue;
    byGroup.set(group, [...(byGroup.get(group) ?? []), { url: row.url, value: row.value, facts: listingFacts(row) }]);
  }
  for (const [group, list] of byGroup) {
    const mid = median(list.map((r) => r.value));
    const kept = list.filter((r) => r.value >= 0.5 * mid);
    kept.slopes = groupSlopes(kept);
    byGroup.set(group, kept);
  }
  return byGroup;
}

export function factsFor(group, facts, groupFacts = {}) {
  const known = groupFacts?.[group]?.facts ?? [];
  return known.filter((f) => !f.engine || (facts.engine && plain(facts.engine).startsWith(plain(f.engine).split(' ')[0]) && (!plain(f.engine).split(' ')[1] || plain(facts.engine).includes(plain(f.engine).split(' ')[1]))));
}

export function conditionOf(row, words = []) {
  const { all } = textOf(row);
  return (words ?? []).map((w) => plain(w).trim()).filter((w) => w.length >= 4 && all.includes(w));
}

export function valueListing(row, sample, { models = [], groupFacts = {}, condition = [], k = COMPARABLES } = {}) {
  const facts = listingFacts(row);
  const group = groupOf(row, models);
  const pool = sample.get(group) ?? [];
  const peers = pool.filter((p) => p.url !== row.url);
  const flags = conditionOf(row, condition);
  const out = { ...row, ...facts, group, ...(flags.length ? { condition: flags } : {}) };
  if (!group || peers.length < MIN_COMPARABLES || !Number.isFinite(row.value) || row.value <= 0) return out;
  if (facts.year === null && facts.km === null) return { ...out, valueNotes: ['not enough facts stated to value: the listing gives neither the year nor the mileage'] };
  const stating = (list, key) => (facts[key] !== null && list.filter((p) => p.facts[key] !== null).length >= MIN_COMPARABLES ? list.filter((p) => p.facts[key] !== null) : list);
  const comparable = stating(stating(peers, 'year'), 'km');
  const nearest = comparable.map((p) => ({ ...p, d: distance(facts, p.facts) })).sort((a, b) => a.d - b.d).slice(0, k);
  const slopes = pool.slopes ?? { year: 0, km: 0 };
  let value = median(nearest.map((p) => adjusted(p, facts, slopes)));
  const yearPct = Math.round((Math.exp(slopes.year) - 1) * 100);
  const notes = [`market value from ${nearest.length} comparable ${group} listings, each adjusted to this listing's year and mileage (from the market: about ${yearPct}% per year of age; Theil–Sen robust slopes)`];
  if (flags.length) notes.push(`condition stated in the listing: ${flags.join(', ')} — the price reflects it, so it is not shown as underpriced`);
  const applied = factsFor(group, facts, groupFacts);
  const verdicts = new Set(applied.map((f) => f.verdict));
  const adjustment = verdicts.has('problematic') ? RELIABILITY_ADJUSTMENT.problematic : verdicts.has('reliable') ? RELIABILITY_ADJUSTMENT.reliable : 0;
  if (adjustment) {
    value *= 1 + adjustment;
    notes.push(`${adjustment > 0 ? '+' : '−'}${Math.round(Math.abs(adjustment) * 100)}%: ${ADJUSTMENT_NOTE}`);
  }
  for (const f of applied.slice(0, 3)) notes.push(`${f.verdict}${f.engine ? ` (${f.engine})` : ''}: ${f.note} — "${f.quote}" (${f.source})`);
  const marketValue = Math.round(value);
  const underpriced = Math.round((marketValue / row.value) * 100) / 100;
  const spread = median(nearest.map((p) => p.d));
  const complete = facts.year !== null && facts.km !== null && facts.engine !== null;
  const confidence = complete && spread <= 1 ? 'high' : spread <= 2.5 ? 'medium' : 'low';
  return { ...out, marketValue, underpriced, comparables: nearest.length, valueConfidence: confidence, valueNotes: notes, ...(underpriced >= UNDERPRICED_FROM && !flags.length && confidence !== 'low' ? { highlight: `underpriced: worth about ${marketValue.toLocaleString('en')} ${row.unit ?? ''}`.trim() } : {}) };
}

export function valueTable(kept, marketRows, { models = [], groupFacts = {}, condition = [] } = {}) {
  const sample = marketSample(marketRows, models);
  const valued = (kept ?? []).map((row) => valueListing(row, sample, { models, groupFacts, condition }));
  const rank = (r) => (r.condition ? 3 : !Number.isFinite(r.underpriced) ? 2 : r.valueConfidence === 'low' ? 1 : 0);
  return valued.sort((a, b) => rank(a) - rank(b) || (b.underpriced ?? -Infinity) - (a.underpriced ?? -Infinity) || (a.value ?? Infinity) - (b.value ?? Infinity));
}
