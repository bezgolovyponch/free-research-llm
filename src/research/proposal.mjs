import { explorePoints } from './site.mjs';
import { STRONG_EXPLORE } from './strategy.mjs';

export const NEAR_LAKE_KM = 5;
export const LOW_ENTRY_SHARE = 0.25;
export const TOP_QUARTER = 0.25;
export const PROPOSAL_METHOD = 'Pareto layers over the measured values (non-dominated sorting, Deb et al. 2002): a result ranks higher only when no other result is at least as good on every measure and better on one; no hand-set weights';

const finite = (v) => (Number.isFinite(v) ? v : null);

export const OBJECTIVES = [
  { id: 'share', label: 'criteria met', better: 'max', read: (r) => finite(r.plan?.share), best: 'meets the most criteria' },
  { id: 'entry', label: 'entry cost', better: 'min', read: (r) => finite(r.plan?.entry?.total ?? r.value), best: 'lowest entry cost' },
  { id: 'sea', label: 'distance to the sea', better: 'min', read: (r) => finite(r.site?.coastKm), best: 'closest to the sea' },
  { id: 'months', label: 'camping months', better: 'max', read: (r) => finite(r.site?.climate?.workable), best: 'longest camping season' },
  { id: 'optimalDays', label: 'optimal climate days', better: 'max', read: (r) => finite(r.site?.climate?.cci?.optimalDays), best: 'most optimal climate days' },
  { id: 'explore', label: 'things to explore', better: 'max', read: (r) => (r.site ? explorePoints(r.site) : null), best: 'most to explore nearby' },
];

function oriented(objective, row) {
  const v = objective.read(row);
  if (v === null) return -Infinity;
  return objective.better === 'max' ? v : -v;
}

export function activeObjectives(rows) {
  return OBJECTIVES.filter((o) => rows.filter((r) => o.read(r) !== null).length >= 2);
}

export function dominates(a, b, objectives) {
  let better = false;
  for (const o of objectives) {
    const x = oriented(o, a);
    const y = oriented(o, b);
    if (x < y) return false;
    if (x > y) better = true;
  }
  return better;
}

export function paretoLayers(rows, objectives = activeObjectives(rows)) {
  const layer = new Map();
  let rest = [...rows];
  for (let depth = 1; rest.length; depth++) {
    const front = rest.filter((r) => !rest.some((o) => o !== r && dominates(o, r, objectives)));
    for (const r of front) layer.set(r, depth);
    rest = rest.filter((r) => !layer.has(r));
  }
  return layer;
}

export function standsOut(row, group, objectives) {
  const out = [];
  for (const o of objectives) {
    const own = o.read(row);
    const values = group.map((r) => o.read(r)).filter((v) => v !== null);
    if (own === null || values.length < 2) continue;
    const better = values.filter((v) => (o.better === 'max' ? v > own : v < own)).length;
    if (better === 0) out.push(`${o.best} of the ${values.length}`);
    else if (better / values.length < TOP_QUARTER) out.push(`${o.label} in the best quarter of the ${values.length}`);
  }
  return out;
}

const refuted = (r) => r.verified?.verdict === 'refuted';
const confirmed = (r) => r.verified?.verdict === 'confirmed';

function confidenceOf(row) {
  if (confirmed(row)) return { level: 'confirmed', text: 'confirmed by the external verifier, which re-read the listing and re-measured it with its own code' };
  if (refuted(row)) return { level: 'refuted', text: `refuted by the external verifier: ${(row.verified.failed ?? []).join('; ') || 'a check did not hold'}` };
  if (row.plan?.tier === 'fits') return { level: 'measured', text: 'every criterion measured by the app; not yet confirmed outside it' };
  return { level: 'partial', text: 'some criteria are not met or not measured yet' };
}

function headlineOf(row) {
  const plan = row.plan;
  const met = plan.checks.filter((c) => c.ok === true).length;
  if (refuted(row)) return `Measured as a fit, but the external verifier refuted it`;
  if (plan.tier === 'fits') return `Fits all ${plan.checks.length} criteria you set${confirmed(row) ? ', confirmed outside the app' : ''}`;
  const misses = plan.checks.filter((c) => c.ok === false).map((c) => c.label);
  const open = plan.checks.filter((c) => c.ok === null).map((c) => c.label);
  if (plan.tier === 'trade-off') return `Meets ${met} of ${plan.checks.length}; misses ${misses.join(', ')}, made up for by ${plan.potential.join('; ') || 'what is nearby'}`;
  if (plan.tier === 'unverified') return `Meets ${met} of ${plan.checks.length}; still to confirm: ${open.join(', ') || 'the listing data'}`;
  return `Meets ${met} of ${plan.checks.length}`;
}

function rankWithin(rows, objectives) {
  const layers = paretoLayers(rows, objectives);
  const entry = OBJECTIVES.find((o) => o.id === 'entry');
  return [...rows].sort((a, b) => Number(confirmed(b)) - Number(confirmed(a)) || layers.get(a) - layers.get(b) || (b.plan.share ?? 0) - (a.plan.share ?? 0) || (entry.read(a) ?? Infinity) - (entry.read(b) ?? Infinity)).map((r) => ({ row: r, layer: layers.get(r) }));
}

const checkOk = (row, id) => row.plan.checks.find((c) => c.id === id)?.ok;

export const OPPORTUNITIES = [
  { id: 'fits', label: 'Fits every criterion', why: 'every criterion you set is measured and met; these count toward your result', whyVerified: 'every criterion you set is measured and met; the ones the external verifier confirmed count toward your result', test: (r) => r.plan.tier === 'fits' && !refuted(r) },
  { id: 'short-season-sea', label: 'Short-season sea site', why: 'the sea is within your e-bike ride but the camping season is shorter than you asked: a summer-only site that can still earn in the season', test: (r) => r.plan.tier === 'trade-off' && checkOk(r, 'season') === false && checkOk(r, 'sea') === true },
  { id: 'nature-draw', label: 'Nature or lake draw', why: `a named lake within ${NEAR_LAKE_KM} km or ${STRONG_EXPLORE}+ beaches, viewpoints, sights, reserves and trails within 15 km draw guests and make up for a missed criterion`, test: (r) => r.plan.tier === 'trade-off' && Boolean(r.site) && ((r.site.lakesNamed && Number.isFinite(r.site.lakeKm) && r.site.lakeKm <= NEAR_LAKE_KM) || explorePoints(r.site) >= STRONG_EXPLORE) },
  { id: 'low-entry', label: 'Lowest entry to start', why: 'among the cheapest quarter to start (price, transfer tax and first units) with room for the first units; a test site before a bigger one', test: (r, ctx) => ['trade-off', 'unverified'].includes(r.plan.tier) && !refuted(r) && checkOk(r, 'units') !== false && entryOf(r) !== null && entryOf(r) <= ctx.lowEntry },
  { id: 'to-confirm', label: 'Could fit once confirmed', why: 'nothing measured fails; one or more criteria could not be measured yet', test: (r) => r.plan.tier === 'unverified' && !r.plan.checks.some((c) => c.ok === false) },
  { id: 'other-trade-off', label: 'Other trade-offs', why: 'a criterion is missed, with something nearby that makes up for it', test: (r) => r.plan.tier === 'trade-off' },
];

function entryOf(row) {
  return finite(row.plan?.entry?.total ?? row.value);
}

function quantile(values, q) {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
}

export function opportunityOf(row, ctx) {
  return OPPORTUNITIES.find((o) => o.test(row, ctx)) ?? null;
}

function proposalOf(row, role, objectives) {
  const confidence = confidenceOf(row);
  return {
    role: role?.role ?? null,
    opportunity: role?.opportunity ?? null,
    rank: role?.rank ?? null,
    layer: role?.layer ?? null,
    headline: headlineOf(row),
    standsOut: role ? standsOut(row, role.group, objectives) : [],
    confirm: row.plan.checks.filter((c) => c.ok === null).map((c) => `${c.label}: ${c.detail}`),
    confidence: confidence.level,
    confidenceText: confidence.text,
  };
}

const OUTSIDE = { id: 'outside', label: 'Outside your countries', why: 'passes every limit except the country; ranked by opportunity (site checks met, real price trend, scenic places with few campsites, entry cost); never counts toward your result' };

export function withProposals(candidates) {
  const kept = candidates?.kept ?? [];
  if (!kept.some((r) => r.plan?.checks)) return candidates;
  const planned = kept.filter((r) => r.plan?.checks);
  const objectives = activeObjectives(planned);
  const ctx = { lowEntry: quantile(planned.filter((r) => !['weak', 'blocked'].includes(r.plan.tier)).map(entryOf), LOW_ENTRY_SHARE) };
  const groups = new Map(OPPORTUNITIES.map((o) => [o.id, []]));
  for (const row of planned) {
    const o = opportunityOf(row, ctx);
    if (o) groups.get(o.id).push(row);
  }
  const outsideChecked = Boolean(candidates.verification);
  const counts = (row) => !outsideChecked || confirmed(row);
  const roles = new Map();
  const sections = [];
  for (const o of OPPORTUNITIES) {
    const rows = groups.get(o.id);
    if (!rows.length) continue;
    const ranked = rankWithin(rows, objectives);
    ranked.forEach((x, i) => roles.set(x.row, { role: o.id === 'fits' && counts(x.row) ? 'primary' : 'secondary', opportunity: o.id, rank: i + 1, layer: x.layer, group: rows }));
    sections.push({ id: o.id, label: o.label, why: outsideChecked && o.whyVerified ? o.whyVerified : o.why, urls: ranked.map((x) => x.row.url) });
  }
  const rows = kept.map((row) => (row.plan?.checks ? { ...row, plan: { ...row.plan, proposal: proposalOf(row, roles.get(row), objectives) } } : row));
  const outsideRows = (candidates.outside ?? []).filter((r) => r.plan?.checks);
  const outsideRoles = new Map(outsideRows.map((r, i) => [r, { role: 'secondary', opportunity: OUTSIDE.id, rank: i + 1, layer: null, group: outsideRows }]));
  const outside = (candidates.outside ?? []).map((row) => (outsideRoles.has(row) ? { ...row, plan: { ...row.plan, proposal: proposalOf(row, outsideRoles.get(row), objectives) } } : row));
  if (outsideRows.length) sections.push({ id: OUTSIDE.id, label: OUTSIDE.label, why: OUTSIDE.why, urls: outsideRows.map((r) => r.url) });
  const urlsOf = (id) => sections.find((x) => x.id === id)?.urls ?? [];
  const countedUrls = new Set((groups.get('fits') ?? []).filter(counts).map((r) => r.url));
  return { ...candidates, kept: rows, ...(candidates.outside ? { outside } : {}), proposals: { method: PROPOSAL_METHOD, objectives: objectives.map((o) => ({ id: o.id, label: o.label, better: o.better })), sections, primary: urlsOf('fits').filter((url) => countedUrls.has(url)), secondary: sections.filter((x) => x.id !== 'fits').flatMap((x) => x.urls) } };
}
