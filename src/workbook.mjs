import { ROOT_ID, childrenOf } from './research/tree.mjs';
import { actionPlan } from './research/gaps.mjs';
import { explorePoints } from './research/site.mjs';
import { workbook } from './xlsx.mjs';

export const ACTION_LABEL = { fix: 'Fix', research: 'Research further', clarify: 'Clarify' };
export const AREA_TOLERANCE = 0.05;

const yesNo = (ok) => (ok === true ? 'yes' : ok === false ? 'no' : 'not measured');
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '' : Number(v));

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

export function titleAreaM2(title) {
  const m = String(title ?? '').match(/(\d[\d.,\s]*\d|\d)\s*(m²|m2|mt2|metros|ha|hectares?|dönüm|donum)(?![a-z])/i);
  if (!m) return null;
  const n = localNumber(m[1]);
  if (n === null) return null;
  const unit = m[2].toLowerCase();
  if (unit.startsWith('ha') || unit.startsWith('hect')) return Math.round(n * 10000);
  if (unit.startsWith('d')) return Math.round(n * 1000);
  return Math.round(n);
}

const CHECK_ORDER = ['sea', 'season', 'noAc', 'units', 'trend', 'location', 'legal'];

function checkIds(rows) {
  const ids = [];
  for (const r of rows) for (const c of r.plan?.checks ?? []) if (!ids.includes(c.id)) ids.push(c.id);
  return ids.sort((a, b) => (CHECK_ORDER.indexOf(a) + 1 || 99) - (CHECK_ORDER.indexOf(b) + 1 || 99));
}

function checkLabels(rows, ids) {
  return ids.map((id) => rows.flatMap((r) => r.plan?.checks ?? []).find((c) => c.id === id)?.label ?? id);
}

export function plotRows(project) {
  const c = project.candidates ?? {};
  const listed = [...(c.kept ?? []).map((r) => ['your countries', r]), ...(c.toCheck ?? []).map((r) => ['to check (price or country not shown)', r]), ...(c.outside ?? []).map((r) => ['outside your countries', r])];
  const rows = listed.map(([, r]) => r);
  const ids = checkIds(rows);
  const header = ['list', 'counted in the result', 'tier', 'external check', 'external check notes', 'title', 'url', 'price', 'currency', `price in ${project.acceptance?.unit || 'EUR'}`, 'entry cost EUR', 'area', 'area unit', 'area m²', 'area in title m²', 'area matches title', 'glamping units', 'place', 'country', 'sea km', 'beach km', 'named lake km', 'workable months', 'comfortable months', 'hottest month avg high °C', 'things to explore within 15 km', 'lodging within 15 km', 'campsites within 15 km', 'zoning', 'checks met %', ...checkLabels(rows, ids), 'verdict', 'why', 'trade-offs', 'risks', 'legal path', 'found on', 'read by', 'latitude', 'longitude'];
  const body = listed.map(([list, r]) => {
    const plan = r.plan ?? {};
    const site = r.site ?? null;
    const m2 = num(plan.areaM2);
    const inTitle = titleAreaM2(r.title);
    const matches = inTitle === null || m2 === '' ? '' : Math.abs(inTitle - m2) / Math.max(inTitle, m2) <= AREA_TOLERANCE ? 'yes' : 'NO: check the listing';
    const counted = plan.tier === 'fits' && (!r.verified || r.verified.verdict === 'confirmed') && list === 'your countries';
    const byId = new Map((plan.checks ?? []).map((k) => [k.id, k]));
    return [
      list,
      counted ? 'yes' : 'no',
      plan.tier ?? '',
      r.verified?.verdict ?? (plan.tier === 'fits' ? 'pending' : ''),
      (r.verified?.failed ?? []).join(' | '),
      String(r.title ?? ''),
      r.url,
      num(r.price),
      r.currency ?? '',
      num(r.value),
      num(plan.entry?.total),
      num(r.area),
      r.areaUnit ?? '',
      m2,
      inTitle ?? '',
      matches,
      num(plan.units),
      r.place ?? '',
      r.country ?? '',
      site ? (site.coastKm === null || site.coastKm === undefined ? '>25' : num(site.coastKm)) : '',
      site ? num(site.beachKm) : '',
      site?.lakesNamed ? num(site.lakeKm) : '',
      num(site?.climate?.workable),
      num(site?.climate?.comfortable),
      num(site?.climate?.hottest),
      site ? explorePoints(site) : '',
      site ? num(site.lodging) : '',
      site ? num(site.campsites) : '',
      r.fit?.zoning ?? '',
      plan.share === undefined ? '' : Math.round(plan.share * 100),
      ...ids.map((id) => (byId.has(id) ? yesNo(byId.get(id).ok) : '')),
      plan.verdict ?? r.toCheck ?? r.siteNote ?? '',
      (plan.opportunity?.reasons ?? plan.why ?? []).join(' | '),
      (plan.tradeoffs ?? []).join(' | '),
      (plan.risks ?? []).join(' | '),
      plan.path ?? '',
      r.sourceUrl ?? '',
      (r.via ?? []).join(' '),
      num(r.lat),
      num(r.lon),
    ];
  });
  return [header, ...body];
}

export function checkRows(project) {
  const c = project.candidates ?? {};
  const rows = [['title', 'url', 'tier', 'check', 'met', 'measured']];
  for (const r of [...(c.kept ?? []), ...(c.outside ?? [])]) for (const k of r.plan?.checks ?? []) rows.push([String(r.title ?? ''), r.url, r.plan.tier, k.label, yesNo(k.ok), k.detail ?? '']);
  return rows;
}

export function summaryRows(project, exportedAt = new Date()) {
  const c = project.candidates ?? {};
  const v = c.verification ?? null;
  const t = c.tiers ?? {};
  const a = project.acceptanceResult ?? null;
  const rules = c.strategy?.rules ?? {};
  const rows = [
    ['field', 'value'],
    ['question', project.question ?? ''],
    ['expected result', project.acceptance?.expected ?? ''],
    ['exported at (UTC)', exportedAt.toISOString()],
    ['verdict', project.report?.verdict ?? ''],
    ['expected result score', a ? Math.round(a.score * 100) / 100 : ''],
    ...(a?.checks ?? []).map((k) => [`  ${k.label}`, Math.round(k.value * 100) / 100]),
    ['listings found', num(c.found)],
    ['fit every check (decision model)', num(t.fits)],
    ['confirmed by the external verifier', v ? v.confirmed : ''],
    ['refuted by the external verifier', v ? v.refuted : ''],
    ['unconfirmed by the external verifier', v ? v.unconfirmed : ''],
    ['external check at (UTC)', v?.at ?? ''],
    ['trade-offs with potential', num(t['trade-off'])],
    ['to confirm', num(t.unverified)],
    ['weak', num(t.weak)],
    ['blocked by law', num(t.blocked)],
    ['screened out', num(c.screenedCount)],
    ['decision model', c.strategy?.label ?? ''],
    ...Object.entries(rules).map(([k, r]) => [`  rule ${k}`, `${typeof r?.value === 'object' ? JSON.stringify(r.value) : r?.value}${r?.currency ? ` ${r.currency}` : ''} (source: ${r?.source ?? '?'})`]),
  ];
  return rows;
}

export function screenedRows(project) {
  const c = project.candidates ?? {};
  return [['reason', 'listings'], ...Object.entries(c.screened ?? {}).sort((x, y) => y[1] - x[1])];
}

export function exampleRows(project) {
  return [['title', 'url', 'why screened out'], ...(project.candidates?.examples ?? []).map((e) => [String(e.title ?? ''), e.url, (e.reasons ?? []).join(' | ')])];
}

export function sourceRows(project) {
  const rows = [['piece', 'piece title', 'source', 'title', 'url', 'site']];
  for (const n of project.nodes ?? []) for (const s of n.sources ?? []) if (s.url) rows.push([n.id, n.title ?? '', s.id ?? '', s.title ?? '', s.url, s.domain ?? '']);
  for (const s of project.sweep?.pages ?? []) rows.push(['sweep', 'portal pages read by code', s.id ?? '', s.title ?? '', s.url, s.domain ?? '']);
  return rows;
}

export function strategyRows(project) {
  const sources = project.candidates?.strategy?.sources ?? [];
  return [['id', 'title', 'url', 'quotes', 'quotes found when re-read', 'HTTP status'], ...sources.map((s) => [s.id, s.title, s.url, num(s.quotes), num(s.confirmed), num(s.status)])];
}

export function itemRows(project) {
  const items = project.acceptanceResult?.items ?? project.report?.deliverables ?? [];
  return [['title', 'value', 'currency', 'url', 'piece', 'link live', 'in range'], ...items.map((i) => [i.title ?? '', num(i.value), i.currency ?? '', i.url ?? '', i.nodeId ?? '', i.live ?? i.alive ?? '', i.inRange ?? ''])];
}

function roleOf(project, node) {
  if (node.parentId === ROOT_ID) return 'driver';
  return childrenOf(project.nodes, node.id).length ? 'sub-driver' : 'sub-question';
}

export function piecesRows(project) {
  const plan = new Map(actionPlan(project).map((a) => [a.nodeId, a]));
  const rows = [['piece', 'title', 'role', 'grade', 'answer', 'action', 'why', 'next step', 'priority', 'moves the verdict', 'sources', 'first source']];
  for (const n of project.nodes ?? []) {
    const a = plan.get(n.id);
    const web = (n.sources ?? []).filter((x) => x.url);
    rows.push([n.id, n.title, roleOf(project, n), n.status, n.finding?.answer ?? '', a ? ACTION_LABEL[a.action] : 'Done', a?.why ?? '', a?.next ?? '', a?.priority ?? '', a?.decisive ? 'yes' : '', web.length, web[0]?.url ?? '']);
  }
  return rows;
}

export function resultsSheets(project, exportedAt = new Date()) {
  const sheets = [
    { name: 'Summary', rows: summaryRows(project, exportedAt) },
    ...(project.candidates ? [
      { name: 'Listings', rows: plotRows(project) },
      { name: 'Decision checks', rows: checkRows(project) },
      { name: 'Screened out', rows: screenedRows(project) },
      { name: 'Screened examples', rows: exampleRows(project) },
    ] : []),
    { name: 'Pieces', rows: piecesRows(project) },
    { name: 'Sources', rows: sourceRows(project) },
    ...(project.candidates?.strategy?.sources?.length ? [{ name: 'Strategy sources', rows: strategyRows(project) }] : []),
    { name: 'Delivered items', rows: itemRows(project) },
  ];
  return sheets;
}

export function resultsWorkbook(project, exportedAt = new Date()) {
  return workbook(resultsSheets(project, exportedAt), exportedAt);
}
