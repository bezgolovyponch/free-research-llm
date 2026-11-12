import { countsTowardResult } from './candidates.mjs';

const GROUPED = (sep) => new RegExp(`^\\d{1,3}(?:\\${sep}\\d{3})+$`);

export function localNumber(text) {
  const t = String(text ?? '').replace(/\s/g, '');
  if (!/^\d[\d.,]*$/.test(t)) return null;
  const dot = t.lastIndexOf('.');
  const comma = t.lastIndexOf(',');
  let normal = t;
  if (dot >= 0 && comma >= 0) normal = comma > dot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (comma >= 0) normal = GROUPED(',').test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  else if (dot >= 0 && GROUPED('.').test(t)) normal = t.replace(/\./g, '');
  const n = Number(normal);
  return Number.isFinite(n) ? n : null;
}

export const UNIT_CLASS = [
  ['eur', /^(?:eur|euros?|€)$/i],
  ['km', /^(?:km|kilomet(?:er|re)s?)$/i],
  ['pct', /^(?:%|percent|per cent)$/i],
  ['months', /^months?$/i],
  ['count', /^(?:plots?|parcels?|listings?|items?|sites?|properties|candidates?)$/i],
];

export function unitClass(unit) {
  const u = String(unit ?? '').trim().replace(/\.$/, '');
  return UNIT_CLASS.find(([, re]) => re.test(u))?.[0] ?? '';
}

const NUMBER = '(\\d[\\d.,]*\\d|\\d)';
const AFTER = new RegExp(`${NUMBER}\\s*(eur(?:os?)?\\b|€|km\\b|kilomet(?:er|re)s?\\b|%|percent\\b|months?\\b)`, 'gi');
const COUNTED = new RegExp(`${NUMBER}\\s+(?:[a-z-]+\\s+){0,2}?(plots?|parcels?|listings?|properties|candidates?)\\b`, 'gi');
const BEFORE = new RegExp(`€\\s?${NUMBER}`, 'g');
const QUALIFIER = /\b(?:of the|out of)\s*$/i;

export function textClaims(text, where) {
  const out = [];
  const s = String(text ?? '');
  for (const m of [...s.matchAll(COUNTED), ...s.matchAll(AFTER)].sort((a, b) => a.index - b.index)) {
    if (QUALIFIER.test(s.slice(Math.max(0, m.index - 12), m.index))) continue;
    const value = localNumber(m[1]);
    if (value !== null) out.push({ where, text: s.slice(Math.max(0, m.index - 40), m.index + m[0].length).trim(), value, kind: unitClass(m[2]) });
  }
  for (const m of s.matchAll(BEFORE)) {
    const value = localNumber(m[1]);
    if (value !== null) out.push({ where, text: s.slice(Math.max(0, m.index - 40), m.index + m[0].length).trim(), value, kind: 'eur' });
  }
  return out;
}

export function memoClaims(report) {
  if (!report) return [];
  const keyed = (report.keyNumbers ?? []).map((k) => ({ where: 'key numbers', text: `${k.label}: ${k.value} ${k.unit ?? ''}`.trim(), value: localNumber(String(k.value ?? '')), kind: unitClass(k.unit) || (/plots?|parcels?|listings?|found|count/i.test(k.label ?? '') ? 'count' : '') })).filter((c) => c.value !== null && c.kind);
  return [...keyed, ...textClaims(report.modelVerdict ?? '', 'model verdict'), ...textClaims(report.summary ?? '', 'summary')];
}

function counted(candidates) {
  return (candidates?.kept ?? []).filter((r) => countsTowardResult(r, candidates));
}

const finite = (values) => values.map(Number).filter((v) => Number.isFinite(v));
const ASKED_TRADE_OFFS = /(\d+)\s+(?:[a-z]+\s+){0,2}trade[\s‐‑-]?offs?\b/gi;

export function askedCounts(text) {
  return [...String(text ?? '').matchAll(ASKED_TRADE_OFFS)].map((m) => Number(m[1]));
}

export function verifiedFacts(candidates, { valueRange = null, rules = null, itemCount = null, asked = '' } = {}) {
  const rows = counted(candidates);
  const t = candidates?.tiers ?? {};
  const v = candidates?.verification ?? null;
  const tableCounts = candidates?.tiers ? [] : [candidates?.keptCount, candidates?.toCheckCount, candidates?.screenedCount];
  const prices = finite(rows.filter((r) => !r.unit || r.unit === 'EUR').map((r) => r.value));
  const entries = finite(rows.map((r) => r.plan?.entry?.total));
  const trends = candidates?.sites?.trends ?? {};
  const codes = new Set(rows.map((r) => r.countryCode));
  const ruleValues = (ids) => finite(ids.map((id) => rules?.[id]?.value));
  return {
    count: finite([rows.length, ...tableCounts, v?.confirmed, t.fits, t['trade-off'], t.unverified, t.weak, t.blocked, candidates?.found, itemCount, ...askedCounts(asked)]),
    eur: [...prices, ...entries, ...finite([valueRange?.[1]])],
    km: [...finite(rows.flatMap((r) => [r.site?.coastKm, r.site?.beachKm])), ...ruleValues(['ebikeKm'])],
    months: [...finite(rows.flatMap((r) => [r.site?.climate?.workable, r.site?.climate?.comfortable])), ...ruleValues(['minWorkableMonths'])],
    pct: finite([...Object.entries(trends).filter(([code]) => codes.has(code) || code === 'EU27_2020').flatMap(([, x]) => [x?.real, x?.change, x?.realCagr]), candidates?.sites?.euHpi]),
    rows: candidates?.tiers ? rows.length : candidates?.keptCount ?? rows.length,
  };
}

const decimals = (n) => (String(n).split('.')[1] ?? '').length;

export function matches(claim, facts) {
  const places = decimals(claim.value);
  return facts.some((f) => Math.round(f * 10 ** places) / 10 ** places === claim.value);
}

export function checkMemoClaims(report, candidates, context = {}) {
  if (!report || !candidates) return null;
  const facts = verifiedFacts(candidates, context);
  const seen = new Set();
  const results = [];
  for (const claim of memoClaims(report)) {
    const key = `${claim.kind}|${claim.value}|${claim.where}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pool = facts[claim.kind] ?? [];
    const status = !pool.length ? 'unverifiable' : matches(claim, pool) ? 'supported' : 'contradicted';
    results.push({ ...claim, status });
  }
  const by = (s) => results.filter((r) => r.status === s);
  return { at: new Date().toISOString(), checked: results.length, supported: by('supported').length, contradicted: by('contradicted'), unverifiable: by('unverifiable'), claims: results, basis: candidates.tiers ? `${facts.rows} listing(s) that fit every check${candidates.verification ? ' and were confirmed by the external verifier' : ''}` : `${facts.rows} listing(s) the table keeps` };
}

export function claimNote(check) {
  if (!check?.checked) return '';
  const wrong = check.contradicted.length;
  return ` · memo numbers checked against the verified record: ${check.supported} of ${check.checked} match${wrong ? `; ${wrong} contradict it (${check.contradicted.slice(0, 3).map((c) => `"${c.text}"`).join('; ')})` : ''}`;
}
