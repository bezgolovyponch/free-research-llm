export const MIN_RESOLVED = 5;
export const TOOLTIP_MAX = 200;
export const OFTEN_BLOCKS = 0.5;

const TERMINAL = new Set(['blocked', 'weak']);

export function clip(lines, max = TOOLTIP_MAX) {
  const text = lines.filter(Boolean).join('\n');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function blockerRates(rows = []) {
  const rates = new Map();
  for (const row of rows) {
    for (const c of row.plan?.checks ?? []) {
      if (c.ok === null || c.ok === undefined) continue;
      const entry = rates.get(c.id) ?? { id: c.id, label: c.label, resolved: 0, failed: 0, terminating: 0, rate: 0 };
      entry.resolved += 1;
      if (c.ok === false) {
        entry.failed += 1;
        if (TERMINAL.has(row.plan.tier)) entry.terminating += 1;
      }
      entry.rate = entry.terminating / entry.resolved;
      rates.set(c.id, entry);
    }
  }
  return rates;
}

function rateLine(check, rate) {
  if (!rate || rate.resolved < MIN_RESOLVED) return `• ${check.label}: too few measured plots (${rate?.resolved ?? 0}) to say how often it blocks`;
  if (!rate.terminating) return `• ${check.label} never ended a plot among ${rate.resolved} measured`;
  return `• ${check.label} ended ${rate.terminating} of ${rate.resolved} measured plots (${Math.round(rate.rate * 100)}%)${rate.rate >= OFTEN_BLOCKS ? ': often a complete blocker' : ''}`;
}

export function confirmRisk(row, rates) {
  if (row.plan?.tier !== 'unverified') return null;
  const unknown = (row.plan.checks ?? []).filter((c) => c.ok === null);
  if (!unknown.length) return { risk: null, cause: null, text: clip([`• ${String(row.plan.verdict ?? '').replace(/^to confirm:\s*/, '')}`]) };
  const measured = unknown.filter((c) => (rates.get(c.id)?.resolved ?? 0) >= MIN_RESOLVED);
  const worst = measured.reduce((a, c) => (rates.get(c.id).rate > (a ? rates.get(a.id).rate : -1) ? c : a), null);
  return {
    risk: worst ? rates.get(worst.id).rate : null,
    cause: { id: (worst ?? unknown[0]).id, label: (worst ?? unknown[0]).label },
    text: clip([`• Not measured yet: ${unknown.map((c) => c.label).join(', ')}`, ...unknown.map((c) => rateLine(c, rates.get(c.id)))]),
  };
}

const riskKey = (row) => row.plan.confirmRisk?.risk ?? Infinity;

export function withConfirmRisk(rows = []) {
  const rates = blockerRates(rows);
  const out = rows.map((row) => (row.plan?.tier === 'unverified' ? { ...row, plan: { ...row.plan, confirmRisk: confirmRisk(row, rates) } } : row));
  const slots = out.map((row, i) => (row.plan?.tier === 'unverified' ? i : -1)).filter((i) => i >= 0);
  const ordered = slots.map((i) => out[i]).sort((a, b) => riskKey(a) - riskKey(b));
  slots.forEach((slot, i) => { out[slot] = ordered[i]; });
  return out;
}

function hhmm(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(11, 16);
}

export function resultsNature(project = {}) {
  const c = project.candidates;
  const t = c?.tiers;
  const v = c?.verification;
  const s = project.supportAudit;
  const loopEnds = project.improve?.active ? hhmm(project.improve.deadline) : null;
  const lines = [
    'Fits are the current conclusion, not a final one: they change as listings appear or sell, sources are re-read and the checking logic improves.',
    t ? `${t.fits ?? 0} fit every criterion, ${t['trade-off'] ?? 0} trade-offs, ${t.unverified ?? 0} to confirm, ${t.weak ?? 0} weak, ${t.blocked ?? 0} blocked${c.found !== undefined ? `, from ${c.found} listings found` : ''}.` : null,
    v?.at ? `Checked outside the app ${String(v.at).slice(0, 10)}: ${v.confirmed ?? 0} confirmed, ${v.refuted ?? 0} refuted, ${v.unconfirmed ?? 0} unconfirmed${v.pending ? `, ${v.pending} not checked yet` : ''}.` : null,
    s ? `${s.toConfirm ?? 0} claim(s) to confirm${s.disagree ? ` (${s.disagree} where the two checking models disagree)` : ''}${s.stale ? `; ${s.stale} claim(s) were checked under older logic` : ''}.` : null,
    loopEnds ? `The self-improving loop is running until ${loopEnds}Z, so numbers can still move.` : null,
    !project.improve?.active && t?.unverified ? `The self-improving loop is stopped: the ${t.unverified} plot(s) to confirm stay open until it runs again or they are measured.` : null,
  ].filter(Boolean);
  return { asOf: c?.builtAt ?? v?.at ?? null, lines };
}
