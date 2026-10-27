import { explorePoints } from './site.mjs';

export const SECONDARY_SHOWN = 12;
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

export function withProposals(candidates) {
  const kept = candidates?.kept ?? [];
  if (!kept.some((r) => r.plan?.checks)) return candidates;
  const planned = kept.filter((r) => r.plan?.checks);
  const objectives = activeObjectives(planned);
  const primaryRows = planned.filter((r) => r.plan.tier === 'fits' && !refuted(r));
  const secondaryPool = planned.filter((r) => ['trade-off', 'unverified'].includes(r.plan.tier));
  const primary = rankWithin(primaryRows, objectives);
  const secondary = rankWithin(secondaryPool, objectives).slice(0, SECONDARY_SHOWN);
  const roles = new Map([...primary.map((x, i) => [x.row, { role: 'primary', rank: i + 1, layer: x.layer, group: primaryRows }]), ...secondary.map((x, i) => [x.row, { role: 'secondary', rank: i + 1, layer: x.layer, group: secondaryPool }])]);
  const rows = kept.map((row) => {
    if (!row.plan?.checks) return row;
    const role = roles.get(row);
    const confidence = confidenceOf(row);
    const proposal = {
      role: role?.role ?? null,
      rank: role?.rank ?? null,
      layer: role?.layer ?? null,
      headline: headlineOf(row),
      standsOut: role ? standsOut(row, role.group, objectives) : [],
      confirm: row.plan.checks.filter((c) => c.ok === null).map((c) => `${c.label}: ${c.detail}`),
      confidence: confidence.level,
      confidenceText: confidence.text,
    };
    return { ...row, plan: { ...row.plan, proposal } };
  });
  const urlOf = (x) => x.row.url;
  return { ...candidates, kept: rows, proposals: { method: PROPOSAL_METHOD, objectives: objectives.map((o) => ({ id: o.id, label: o.label, better: o.better })), primary: primary.map(urlOf), secondary: secondary.map(urlOf) } };
}
