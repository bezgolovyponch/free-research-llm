import { listingKey } from '../search/listings.mjs';
import { plain } from './itemgate.mjs';

export const COMPARABLES = 7;
export const MIN_COMPARABLES = 5;
export const YEAR_WINDOW = 2;
export const MIN_SLOPE_POINTS = 30;
export const VALUE_ROUNDING = 1000;
const MAD_CUT = 2.5;
const MAD_CONSISTENCY = 1.4826;

const YEAR_MARK = String.raw`(?:r\s*\.?\s*v\s*\.?|rv|r\.|rok(?:u|em)?(?:\s+vyroby)?(?:\s*\/\s*prvni registrace)?|z roku|v roce|vyroben\w*(?:\s+v roce)?|uvedeni do provozu|v provozu od|prvni registrace|baujahr|erstzulassung|ez|rocznik|rok produkcji|model(?:ovy)?(?:\s*rok)?)`;
const YEAR_MARKED = new RegExp(String.raw`(?<![a-z])${YEAR_MARK}\s*[.:]?\s*(?:\d{1,2}\s*[./-]\s*){0,2}((?:19|20)\d{2})(?!\d)`);
const YEAR_MODEL_CODE = /(?<![a-z0-9])m\.?\s?((?:19|20)\d{2})(?!\d)/;
const YEAR_SHORT = /(?<![a-z])(?:r\s*\.?\s*v\s*\.?|rv|rok vyroby)\s*[.:]?\s*(?:\d{1,2}\s*[./-]\s*)?(\d{2})(?![\d./-])/;
const YEAR_PLAIN = /(?<![\d.,/])((?:19[89]|20[0-3])\d)(?![\d.,])/;
const KM_TEXT = /(\d{1,3}(?:[ . ]\d{3})+|\d+)\s*(xxx\s*km|tkm|t\.?\s*km|tis\.?\s*km|tisic\s*km|km|kilometr\w*)(?![a-z])/;
const KM_SAID = /(?:naj\w*|najezd\w*|tachometr\w*|przebieg|kilometerstand)\s*[:.]?\s*(?:cca|ca\.?|skoro|jen|pouze|realnych|skutecnych|overenych)?\s*(\d{1,3}(?:[ . ]\d{3})+|\d+)[\s-]*(tis\w*|xxx|t\b)?/;
const KM_PER_YEAR_FLOOR = 1000;
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

function shortYear(two) {
  const n = Number(two);
  return n <= 29 ? 2000 + n : n >= 70 ? 1900 + n : null;
}

function yearIn(text) {
  const marked = text.match(YEAR_MARKED);
  if (marked) return Number(marked[1]);
  const code = text.match(YEAR_MODEL_CODE);
  if (code) return Number(code[1]);
  const short = text.match(YEAR_SHORT);
  if (short && shortYear(short[1])) return shortYear(short[1]);
  for (const m of text.matchAll(new RegExp(YEAR_PLAIN.source, 'g'))) {
    if (VALID_UNTIL.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
    return Number(m[1]);
  }
  return null;
}

const inRange = (km) => (km >= 1000 && km <= 900000 ? km : null);

function kmIn(text) {
  for (const m of text.matchAll(new RegExp(KM_TEXT.source, 'g'))) {
    const n = Number(m[1].replace(/[ . ]/g, ''));
    if (!Number.isFinite(n)) continue;
    const km = inRange(/^(xxx|tkm|t\.?\s*km|tis|tisic)/.test(m[2]) ? n * 1000 : n);
    if (km) return km;
  }
  const said = text.match(KM_SAID);
  if (!said) return null;
  const n = Number(said[1].replace(/[ . ]/g, ''));
  return said[2] ? inRange(n * 1000) : n >= 1000 ? inRange(n) : null;
}

function plausibleKm(km, year) {
  if (km === null || !year) return km;
  const age = Math.max(1, new Date().getUTCFullYear() - year);
  return km / age < KM_PER_YEAR_FLOOR ? null : km;
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
    km: plausibleKm(kmIn(title) ?? kmIn(all), year),
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
  return part(a.year, b.year, 3) + km + part(a.kw, b.kw, 15) + engine;
}

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const MAX_PAIRS = 20000;
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

function withinGroupSlope(groups, x, y) {
  const slopes = [];
  let points = 0;
  for (const list of groups) {
    const usable = list.filter((r) => x(r) !== null && y(r) !== null);
    points += usable.length;
    for (let i = 0; i < usable.length && slopes.length < MAX_PAIRS; i++) {
      for (let j = i + 1; j < usable.length && slopes.length < MAX_PAIRS; j++) {
        const dx = x(usable[j]) - x(usable[i]);
        if (dx !== 0) slopes.push((y(usable[j]) - y(usable[i])) / dx);
      }
    }
  }
  return { slope: points >= MIN_SLOPE_POINTS && slopes.length >= 3 ? median(slopes) : null, points };
}

export function pooledSlopes(groups) {
  const lists = [...groups];
  const age = withinGroupSlope(lists, (r) => r.facts.year, (r) => Math.log(r.value));
  const year = age.slope !== null && age.slope > 0 ? age.slope : null;
  const wear = year === null ? { slope: null, points: 0 } : withinGroupSlope(lists, (r) => (r.facts.year !== null && r.facts.km !== null ? Math.log(r.facts.km) : null), (r) => Math.log(r.value) - year * r.facts.year);
  const km = wear.slope !== null && wear.slope < 0 ? wear.slope : null;
  return { year, km, datedPoints: age.points, kmPoints: wear.points };
}

function adjusted(peer, facts, slopes) {
  let factor = 0;
  if (slopes.year !== null && facts.year !== null && peer.facts.year !== null) factor += slopes.year * (facts.year - peer.facts.year);
  if (slopes.km !== null && facts.km !== null && peer.facts.km !== null) factor += slopes.km * (Math.log(facts.km) - Math.log(peer.facts.km));
  return peer.value * Math.min(MAX_ADJUSTMENT, Math.max(1 / MAX_ADJUSTMENT, Math.exp(factor)));
}

const keyOf = (row) => (row?.url ? listingKey(row.url) : null);

export function factsOf(row, pageFacts = null) {
  const own = listingFacts(row);
  const page = pageFacts?.get?.(keyOf(row)) ?? null;
  if (!page) return own;
  return Object.fromEntries(Object.entries(own).map(([k, v]) => [k, v ?? page[k] ?? null]));
}

function robustCut(list) {
  if (list.length < 4) return list;
  const logs = list.map((r) => Math.log(r.value));
  const mid = median(logs);
  const mad = median(logs.map((v) => Math.abs(v - mid))) * MAD_CONSISTENCY;
  return mad > 0 ? list.filter((r) => Math.abs(Math.log(r.value) - mid) <= MAD_CUT * mad) : list;
}

export function marketSample(rows, models = [], { pageFacts = null, condition = [] } = {}) {
  const byGroup = new Map();
  const seen = new Set();
  for (const row of rows ?? []) {
    if (!Number.isFinite(row?.value) || row.value <= 0) continue;
    const key = keyOf(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const group = groupOf(row, models);
    if (!group) continue;
    byGroup.set(group, [...(byGroup.get(group) ?? []), { url: row.url, key, value: row.value, facts: factsOf(row, pageFacts), flagged: conditionOf(row, condition).length > 0 }]);
  }
  for (const [group, list] of byGroup) byGroup.set(group, robustCut(list));
  byGroup.slopes = pooledSlopes(byGroup.values());
  return byGroup;
}

export function factsFor(group, facts, groupFacts = {}) {
  const known = (groupFacts?.[group]?.facts ?? []).filter((f) => (f.aspect ?? 'reliability') === 'reliability');
  return known.filter((f) => !f.engine || (facts.engine && plain(facts.engine).startsWith(plain(f.engine).split(' ')[0]) && (!plain(f.engine).split(' ')[1] || plain(facts.engine).includes(plain(f.engine).split(' ')[1]))));
}

export function conditionOf(row, words = []) {
  const { all } = textOf(row);
  return (words ?? []).map((w) => plain(w).trim()).filter((w) => w.length >= 4 && all.includes(w));
}

export const AD_TEXT_CHARS = 2000;
const TITLE_ANCHOR_CHARS = 30;

export function adText(text, title, value = null) {
  const page = plain(text ?? '');
  const anchor = plain(title ?? '').trim().slice(0, TITLE_ANCHOR_CHARS);
  if (anchor.length < 8) return '';
  const at = page.lastIndexOf(anchor);
  if (at < 0) return '';
  const body = page.slice(at, at + AD_TEXT_CHARS);
  const digits = Number.isFinite(value) ? String(Math.round(value)) : '';
  const price = digits.length >= 4 ? new RegExp(`${digits.slice(0, -3)}[\\s.,]?${digits.slice(-3)}(?!\\d)`).exec(body.slice(anchor.length)) : null;
  return price ? body.slice(0, anchor.length + price.index) : body;
}

export const pageFactsFrom = (text, row) => {
  const own = adText(text, row?.title, row?.value);
  return own ? listingFacts({ title: '', attrs: { description: own } }) : null;
};

const rounded = (v) => Math.round(v / VALUE_ROUNDING) * VALUE_ROUNDING;
const pct = (slope) => Math.round((Math.exp(slope) - 1) * 1000) / 10;

function adjustmentNote(slopes, facts) {
  const age = slopes.year !== null ? `adjusted to ${facts.year} by ${pct(slopes.year)}% per year of age` : `not adjusted for age: ${slopes.datedPoints} dated listings, ${MIN_SLOPE_POINTS} needed to measure it, so comparables are limited to ±1 year`;
  const wear = slopes.km === null ? 'not adjusted for mileage (not measurable on this market)' : facts.km === null ? 'not adjusted for mileage (this listing does not state it)' : `adjusted for mileage by ${pct(slopes.km * Math.log(1.1))}% per 10% more km`;
  return `${age}; ${wear}; slopes measured within each model on ${slopes.datedPoints} dated listings (Theil–Sen)`;
}

function estimateFor(facts, key, group, sample, k = COMPARABLES) {
  const slopes = sample.slopes ?? { year: null, km: null, datedPoints: 0, kmPoints: 0 };
  const window = slopes.year === null ? 1 : YEAR_WINDOW;
  const peers = (sample.get(group) ?? []).filter((p) => p.key !== key && !p.flagged && p.facts.year !== null && Math.abs(p.facts.year - facts.year) <= window && !(facts.fuel && p.facts.fuel && p.facts.fuel !== facts.fuel));
  if (peers.length < MIN_COMPARABLES) return { window, peers: peers.length };
  const nearest = peers.map((p) => ({ ...p, d: distance(facts, p.facts) })).sort((a, b) => a.d - b.d).slice(0, k);
  const values = nearest.map((p) => adjusted(p, facts, slopes));
  return { window, peers: peers.length, nearest, values, estimate: median(values), slopes };
}

export const MISCOVERAGE = 0.2;
export const MIN_CALIBRATION = 30;
export const JACKKNIFE_SOURCE = 'jackknife prediction interval: Barber, Candès, Ramdas, Tibshirani, Annals of Statistics 49(1), 2021';
export const LEMONS_NOTE = 'asking prices, not sale prices; a low asking price can reflect hidden quality the ad does not state (lemons penalty about 12% of the price: Blundell et al., Quantitative Economics 17(1), 2026); inspect before buying';

export function calibrate(sample) {
  const residuals = [];
  for (const [group, list] of sample) {
    for (const r of list) {
      if (r.flagged || r.facts.year === null) continue;
      const fit = estimateFor(r.facts, r.key, group, sample);
      if (fit.estimate) residuals.push(Math.log(r.value / fit.estimate));
    }
  }
  const n = residuals.length;
  if (n < MIN_CALIBRATION) return { n, low: null, high: null };
  const sorted = residuals.sort((a, b) => a - b);
  const lowRank = Math.floor((MISCOVERAGE / 2) * (n + 1));
  const highRank = Math.ceil((1 - MISCOVERAGE / 2) * (n + 1));
  if (lowRank < 1 || highRank > n) return { n, low: null, high: null };
  return { n, low: sorted[lowRank - 1], high: sorted[highRank - 1] };
}

export function valueListing(row, sample, { models = [], groupFacts = {}, condition = [], k = COMPARABLES, pageFacts = null, calibration = null } = {}) {
  const facts = factsOf(row, pageFacts);
  const group = groupOf(row, models);
  const key = keyOf(row);
  const flags = conditionOf(row, condition);
  const out = { ...row, ...facts, group, ...(flags.length ? { condition: flags } : {}) };
  if (!group || !Number.isFinite(row.value) || row.value <= 0) return out;
  if (facts.year === null) return { ...out, valueNotes: ['no value: the listing does not state its year, and age drives the price'] };
  const fit = estimateFor(facts, key, group, sample, k);
  if (!fit.estimate) return { ...out, valueNotes: [`no value: ${fit.peers} other ${group} listing(s) state a year within ±${fit.window} of ${facts.year}; ${MIN_COMPARABLES} are needed`] };
  const { nearest, estimate, slopes } = fit;
  const years = nearest.map((p) => p.facts.year);
  const unit = row.unit ?? '';
  const calibrated = calibration && calibration.low !== null && calibration.high !== null;
  const low = calibrated ? estimate * Math.exp(calibration.low) : null;
  const high = calibrated ? estimate * Math.exp(calibration.high) : null;
  const notes = [`asking prices of ${nearest.length} other ${group} listings from ${Math.min(...years)}–${Math.max(...years)}: ${rounded(Math.min(...nearest.map((p) => p.value))).toLocaleString('en')}–${rounded(Math.max(...nearest.map((p) => p.value))).toLocaleString('en')} ${unit}`.trim(), adjustmentNote(slopes, facts)];
  notes.push(calibrated ? `${Math.round((1 - MISCOVERAGE) * 100)}% interval from this method's own errors on ${calibration.n} listings of this market, each valued without itself (${JACKKNIFE_SOURCE})` : `no calibrated interval: only ${calibration?.n ?? 0} listings could be valued without themselves, ${MIN_CALIBRATION} are needed; nothing is flagged`);
  notes.push(LEMONS_NOTE);
  if (flags.length) notes.push(`condition stated in the listing: ${flags.join(', ')} — the price reflects it, so it is not flagged`);
  for (const f of factsFor(group, facts, groupFacts).slice(0, 3)) notes.push(`${f.verdict}${f.engine ? ` (${f.engine})` : ''}: ${f.note} — "${f.quote}" (${f.source}); a quoted fact, not used in the value`);
  const kmCompared = facts.km !== null && nearest.filter((p) => p.facts.km !== null).length >= MIN_COMPARABLES;
  const confidence = calibrated && nearest.length >= COMPARABLES && kmCompared && slopes.year !== null ? 'high' : 'medium';
  const marketValue = rounded(estimate);
  const marketRange = calibrated ? [rounded(low), rounded(high)] : null;
  const below = calibrated && row.value < low && !flags.length;
  return { ...out, marketValue, ...(marketRange ? { marketRange } : {}), underpriced: Math.round((estimate / row.value) * 100) / 100, comparables: nearest.length, valueConfidence: confidence, valueNotes: notes, ...(below ? { highlight: `asks below the ${Math.round((1 - MISCOVERAGE) * 100)}% interval of comparable asking prices: ${row.value.toLocaleString('en')} ${unit} against ${marketRange.map((v) => v.toLocaleString('en')).join('–')} ${unit}; check for hidden faults`.replace(/\s+/g, ' ').trim() } : {}) };
}

export const LIQUID_FROM = 20;
export const RARE_UNDER = 6;
export const MIN_STEP_SAMPLE = 10;

export function stepEffects(sample, marketRows, words = []) {
  const textByUrl = new Map((marketRows ?? []).map((r) => [r.url, textOf(r).all]));
  return (words ?? []).map((w) => plain(w).trim()).filter((w) => w.length >= 3).map((word) => {
    const withIt = [];
    const without = [];
    for (const [, list] of sample) {
      const dated = list.filter((r) => r.facts.year !== null);
      for (const r of dated) {
        const peers = dated.filter((o) => o !== r && Math.abs(o.facts.year - r.facts.year) <= 1);
        if (peers.length < MIN_COMPARABLES) continue;
        const peerMedian = median(peers.map((o) => o.value * Math.exp((sample.slopes?.year ?? 0) * (r.facts.year - o.facts.year))));
        (String(textByUrl.get(r.url) ?? '').includes(word) ? withIt : without).push(r.value / peerMedian);
      }
    }
    const measurable = withIt.length >= MIN_STEP_SAMPLE && without.length >= MIN_STEP_SAMPLE;
    return { word, with: withIt.length, without: without.length, uplift: measurable ? Math.round((median(withIt) / median(without) - 1) * 1000) / 1000 : null };
  });
}

export function resaleOf(row, depth, effects = [], groupFacts = {}) {
  const { all } = textOf(row);
  const steps = effects.filter((e) => !all.includes(e.word)).map((e) => ({ step: e.word, uplift: e.uplift, measuredOn: e.uplift === null ? `not measurable on this market (${e.with} with, ${e.without} without; ${MIN_STEP_SAMPLE} each needed)` : `${e.with} with, ${e.without} without` }));
  const gain = steps.reduce((n, s) => n + (s.uplift && s.uplift > 0 ? s.uplift : 0), 0);
  const repair = (groupFacts?.[row.group]?.facts ?? []).filter((f) => ['cheap', 'expensive'].includes(f.verdict) && (!f.engine || !row.engine || plain(row.engine).startsWith(plain(f.engine).split(' ')[0])));
  const tags = [...(depth >= LIQUID_FROM ? [`easy to resell: ${depth} comparable listings on the market`] : []), ...(depth > 0 && depth < RARE_UNDER ? [`rare: only ${depth} comparable listings — may sell slowly`] : []), ...repair.slice(0, 2).map((f) => `${f.verdict} to repair${f.engine ? ` (${f.engine})` : ''}: ${f.note} — ${f.source}`)];
  if (!Number.isFinite(row.marketValue)) return { marketDepth: depth, resaleTags: tags, valueSteps: steps };
  const resaleValue = Math.round(row.marketValue * (1 + gain));
  const resaleGain = resaleValue - row.value;
  return { marketDepth: depth, resaleTags: tags, valueSteps: steps, resaleValue, resaleGain, resaleScore: Math.round(resaleGain * (depth / (depth + 10))) };
}

export function valueTable(kept, marketRows, { models = [], groupFacts = {}, condition = [], upgrades = [], pageFacts = null } = {}) {
  const facts = pageFacts instanceof Map ? pageFacts : new Map(Object.entries(pageFacts ?? {}));
  const sample = marketSample(marketRows, models, { pageFacts: facts, condition });
  const effects = stepEffects(sample, marketRows, upgrades);
  const calibration = calibrate(sample);
  const valued = (kept ?? []).map((row) => valueListing(row, sample, { models, groupFacts, condition, pageFacts: facts, calibration })).map((row) => ({ ...row, ...resaleOf(row, (sample.get(row.group) ?? []).length, effects, groupFacts) }));
  const rank = (r) => (r.condition ? 3 : !Number.isFinite(r.underpriced) ? 2 : r.valueConfidence === 'low' ? 1 : 0);
  return valued.sort((a, b) => rank(a) - rank(b) || (b.underpriced ?? -Infinity) - (a.underpriced ?? -Infinity) || (a.value ?? Infinity) - (b.value ?? Infinity));
}
