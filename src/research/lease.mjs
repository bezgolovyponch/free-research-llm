export const LEASE_LIST_MAX = 10;
export const WHY_MAX = 200;

function clip(lines) {
  const text = lines.filter(Boolean).join('\n');
  return text.length > WHY_MAX ? `${text.slice(0, WHY_MAX - 1)}…` : text;
}

export function leaseStatus(row, { horizonMonths = 12 } = {}) {
  const w = row?.plan?.withoutOwning;
  if (!w) return null;
  const other = (row.plan.checks ?? []).filter((c) => c.id !== 'legal');
  const failed = other.filter((c) => c.ok === false);
  const unknown = other.filter((c) => c.ok === null);
  const missing = w.missing ?? [];
  let status;
  let lines;
  if (failed.length) {
    status = 'outside-request';
    lines = [`• Misses what the request asked: ${failed.map((c) => c.label).join(', ')}`];
  } else if (unknown.length || missing.length) {
    status = 'to-confirm';
    lines = [`• Not measured yet: ${[...unknown.map((c) => c.label), ...missing].join(', ')}`];
  } else if (w.paysBackInYear && w.paybackMonths !== null && w.paybackMonths !== undefined && w.paybackMonths <= horizonMonths) {
    status = 'feasible';
    lines = [
      '• Cannot be bought: lease or partnership instead',
      `• Setup ≈ €${w.setupEur} pays back in ${w.paybackMonths} month(s) of a ${w.months}-month season`,
      `• The landholder can get up to ${Math.round(w.landShareMax * 100)}% of revenue`,
    ];
  } else {
    status = 'not-feasible';
    lines = [w.paybackMonths === null || w.paybackMonths === undefined ? '• Payback cannot be computed' : `• Setup does not pay back within the ${w.months}-month season (needs ${w.paybackMonths} months)`];
  }
  return {
    url: row.url,
    title: row.title,
    place: row.place,
    country: row.country,
    countryCode: row.countryCode,
    status,
    why: clip(lines),
    paybackMonths: w.paybackMonths,
    landShareMax: w.landShareMax,
    setupEur: w.setupEur,
    revenueEur: w.revenueEur,
  };
}

function noneFound(asked, horizonMonths) {
  const names = asked.map((c) => c.name);
  return { horizonMonths, total: 0, feasible: [], feasibleCount: 0, toConfirm: [], toConfirmCount: 0, notFeasible: 0, outsideRequest: 0, outsideReasons: [], countries: names, path: asked[0].path ?? null, sources: asked[0].sources ?? [], headline: `You asked about ${names.join(', ')}: a foreign buyer cannot own land there, and no listing from there has reached the candidate table yet, so no lease option can be shown.` };
}

export function leaseOptions(candidates, { horizonMonths = 12, asked = [] } = {}) {
  const rows = (candidates?.kept ?? []).filter((row) => row?.plan?.withoutOwning);
  if (!rows.length) return asked.length ? noneFound(asked, horizonMonths) : null;
  const statuses = rows.map((row) => leaseStatus(row, { horizonMonths }));
  const feasible = statuses.filter((s) => s.status === 'feasible');
  const toConfirm = statuses.filter((s) => s.status === 'to-confirm');
  const outsideRequest = statuses.filter((s) => s.status === 'outside-request').length;
  const notFeasible = statuses.filter((s) => s.status === 'not-feasible').length;
  const counts = new Map();
  for (const row of rows) {
    for (const check of row.plan.checks ?? []) {
      if (check.id === 'legal' || check.ok !== false) continue;
      counts.set(check.label, (counts.get(check.label) ?? 0) + 1);
    }
  }
  const outsideReasons = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const countries = [...new Set(rows.map((row) => row.country))];
  const first = rows[0].plan.withoutOwning;
  const sorted = [...feasible].sort((a, b) => (a.paybackMonths ?? Infinity) - (b.paybackMonths ?? Infinity) || (b.landShareMax ?? -1) - (a.landShareMax ?? -1));
  const feasibleCount = feasible.length;
  const toConfirmCount = toConfirm.length;
  const headline = feasibleCount
    ? `${feasibleCount} plot(s) in ${countries.join(', ')} cannot be bought by a foreign buyer but can be leased or run in partnership, fit everything else you asked and pay back within ${horizonMonths} months${toConfirmCount ? `; ${toConfirmCount} more to confirm` : ''}.`
    : `No plot in ${countries.join(', ')} is feasible to lease yet: ${toConfirmCount} to confirm, ${outsideRequest} miss what you asked, ${notFeasible} do not pay back within ${horizonMonths} months.`;
  return {
    horizonMonths,
    total: rows.length,
    feasible: sorted.slice(0, LEASE_LIST_MAX),
    feasibleCount,
    toConfirm: toConfirm.slice(0, LEASE_LIST_MAX),
    toConfirmCount,
    notFeasible,
    outsideRequest,
    outsideReasons,
    countries,
    path: first.path,
    sources: first.sources,
    headline,
  };
}

export function horizonFromText(text) {
  const source = String(text ?? '');
  const years = source.match(/(\d+)\s*[\s-]*years?\b/i);
  if (years) return 12 * Number(years[1]);
  if (/\b(?:one|a)\s+years?\b/i.test(source)) return 12;
  for (const match of source.matchAll(/(\d+)\s*[\s-]*months?\b/gi)) {
    const rest = source.slice(match.index + match[0].length);
    if (/^[\s,-]*season\b/i.test(rest)) continue;
    return Number(match[1]);
  }
  return null;
}

