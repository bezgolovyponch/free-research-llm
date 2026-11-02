import { describe, expect, it } from 'vitest';
import { horizonFromText, LEASE_LIST_MAX, leaseOptions, leaseStatus, WHY_MAX } from '../../src/research/lease.mjs';

const check = (id: string, label: string, ok: boolean | null) => ({ id, label, ok, detail: '' });

const legal = () => check('legal', 'a legal path for a buyer', false);

const otherChecks = () => [
  check('sea', 'sea within an e-bike ride', true),
  check('season', '10+ camping months a year', true),
  check('units', 'room for 3+ units', true),
];

const withoutOwning = (more: Record<string, unknown> = {}) => ({
  group: 'Value without ownership (lease or partnership)',
  path: 'lease land use rights from the state',
  sources: ['vn-lease'],
  units: 3,
  months: 8,
  setupEur: 6000,
  revenueEur: 12000,
  paybackMonths: 4,
  landShareMax: 0.5,
  paysBackInYear: true,
  missing: [],
  inputs: [],
  risks: [],
  ...more,
});

const makeRow = (options: { url?: string; country?: string; countryCode?: string; checks?: Array<ReturnType<typeof check>>; w?: Record<string, unknown> } = {}) => ({
  url: options.url ?? 'https://batdongsan.com.vn/ban-dat-xa-1',
  title: 'Đất nền Phú Quốc',
  place: 'Phú Quốc',
  country: options.country ?? 'Vietnam',
  countryCode: options.countryCode ?? 'VN',
  plan: {
    tier: 'blocked',
    verdict: 'blocked',
    checks: options.checks ?? [legal(), ...otherChecks()],
    withoutOwning: withoutOwning(options.w ?? {}),
  },
});

describe('lease status', () => {
  it('shows a plot that cannot be bought but leases and pays back inside the season', () => {
    const status = leaseStatus(makeRow());
    expect(status).toMatchObject({
      url: 'https://batdongsan.com.vn/ban-dat-xa-1',
      title: 'Đất nền Phú Quốc',
      place: 'Phú Quốc',
      country: 'Vietnam',
      countryCode: 'VN',
      status: 'feasible',
      paybackMonths: 4,
      landShareMax: 0.5,
      setupEur: 6000,
      revenueEur: 12000,
    });
    expect(status?.why).toContain('Cannot be bought: lease or partnership instead');
    expect(status?.why).toContain('pays back in 4 month(s)');
    expect(status?.why).toContain('50% of revenue');
  });

  it('puts a failed request check outside the request and ignores the legal blocker', () => {
    const row = makeRow({ checks: [legal(), check('sea', 'sea within 20 km by e-bike', false), check('season', '10+ camping months a year', true)] });
    const status = leaseStatus(row);
    expect(status?.status).toBe('outside-request');
    expect(status?.why).toBe('• Misses what the request asked: sea within 20 km by e-bike');
    expect(status?.why).not.toContain('legal path');
  });

  it('asks to confirm an unmeasured check or a missing input', () => {
    const unknown = makeRow({ checks: [legal(), check('season', 'camping months a year', null), check('sea', 'sea within an e-bike ride', true)] });
    expect(leaseStatus(unknown)?.status).toBe('to-confirm');
    expect(leaseStatus(unknown)?.why).toContain('Not measured yet: camping months a year');
    const missing = makeRow({ w: { missing: ['climate not measured yet'] } });
    expect(leaseStatus(missing)?.status).toBe('to-confirm');
    expect(leaseStatus(missing)?.why).toContain('climate not measured yet');
  });

  it('rejects a lease that pays back after the season or cannot compute payback', () => {
    const late = makeRow({ w: { paybackMonths: 14, paysBackInYear: false } });
    expect(leaseStatus(late)?.status).toBe('not-feasible');
    expect(leaseStatus(late)?.why).toBe('• Setup does not pay back within the 8-month season (needs 14 months)');
    const unknown = makeRow({ w: { paybackMonths: null, paysBackInYear: false, landShareMax: null } });
    expect(leaseStatus(unknown)?.status).toBe('not-feasible');
    expect(leaseStatus(unknown)?.why).toBe('• Payback cannot be computed');
  });

  it('returns null when a row has no lease option', () => {
    expect(leaseStatus({ url: 'https://batdongsan.com.vn/ban-dat-xa-2', plan: { checks: [] } })).toBeNull();
  });

  it('keeps every why within the limit and cuts a long one with an ellipsis', () => {
    const long = makeRow({ checks: [legal(), check('sea', 'x'.repeat(300), false), check('season', '10+ camping months a year', true)] });
    const status = leaseStatus(long);
    expect(status?.why.length).toBeLessThanOrEqual(WHY_MAX);
    expect(status?.why.endsWith('…')).toBe(true);
    for (const row of [makeRow(), makeRow({ w: { paybackMonths: 14, paysBackInYear: false } }), makeRow({ w: { missing: ['climate not measured yet'] } })]) {
      expect(leaseStatus(row)?.why.length).toBeLessThanOrEqual(WHY_MAX);
    }
  });
});

describe('lease options', () => {
  const rows = [
    makeRow({ url: 'https://batdongsan.com.vn/ban-dat-xa-1', w: { paybackMonths: 4, landShareMax: 0.5 } }),
    makeRow({ url: 'https://batdongsan.com.vn/ban-dat-xa-2', w: { paybackMonths: 2, landShareMax: 0.3 } }),
    makeRow({ url: 'https://batdongsan.com.vn/ban-dat-xa-3', country: 'Portugal', countryCode: 'PT', w: { paybackMonths: 4, landShareMax: 0.7 } }),
    makeRow({ url: 'https://batdongsan.com.vn/ban-dat-xa-4', checks: [legal(), check('season', 'camping months a year', null), check('sea', 'sea within an e-bike ride', true)] }),
    makeRow({ url: 'https://batdongsan.com.vn/ban-dat-xa-5', country: 'Portugal', countryCode: 'PT', checks: [legal(), check('sea', 'sea within an e-bike ride', false), check('season', '10+ camping months a year', true)] }),
    makeRow({ url: 'https://batdongsan.com.vn/ban-dat-xa-6', w: { paybackMonths: 14, paysBackInYear: false } }),
    { url: 'https://batdongsan.com.vn/ban-dat-xa-7', plan: { checks: [] } },
  ];

  it('sorts feasible leases, keeps the first to confirm and counts the rest', () => {
    const out = leaseOptions({ kept: rows });
    expect(out?.total).toBe(6);
    expect(out?.feasible.map((s) => s.url)).toEqual([
      'https://batdongsan.com.vn/ban-dat-xa-2',
      'https://batdongsan.com.vn/ban-dat-xa-3',
      'https://batdongsan.com.vn/ban-dat-xa-1',
    ]);
    expect(out?.feasibleCount).toBe(3);
    expect(out?.toConfirm.map((s) => s.url)).toEqual(['https://batdongsan.com.vn/ban-dat-xa-4']);
    expect(out?.toConfirmCount).toBe(1);
    expect(out?.notFeasible).toBe(1);
    expect(out?.outsideRequest).toBe(1);
    expect(out?.outsideReasons).toEqual([['sea within an e-bike ride', 1]]);
    expect(out?.countries).toEqual(['Vietnam', 'Portugal']);
    expect(out?.path).toBe('lease land use rights from the state');
    expect(out?.sources).toEqual(['vn-lease']);
    expect(out?.headline).toBe('3 plot(s) in Vietnam, Portugal cannot be bought by a foreign buyer but can be leased or run in partnership, fit everything else you asked and pay back within 12 months; 1 more to confirm.');
  });

  it('states the no-feasible headline with the counts and the chosen horizon', () => {
    const out = leaseOptions({ kept: rows }, { horizonMonths: 1 });
    expect(out?.horizonMonths).toBe(1);
    expect(out?.feasible).toEqual([]);
    expect(out?.feasibleCount).toBe(0);
    expect(out?.notFeasible).toBe(4);
    expect(out?.headline).toBe('No plot in Vietnam, Portugal is feasible to lease yet: 1 to confirm, 1 miss what you asked, 4 do not pay back within 1 months.');
  });

  it('limits both lists to the lease maximum while counting all of them', () => {
    const many = Array.from({ length: 12 }, (_, i) => makeRow({ url: `https://batdongsan.com.vn/ban-dat-xa-${i + 10}`, w: { paybackMonths: i + 1 } }));
    const feasible = leaseOptions({ kept: many });
    expect(feasible?.feasible).toHaveLength(LEASE_LIST_MAX);
    expect(feasible?.feasibleCount).toBe(12);
    const unknown = Array.from({ length: 12 }, (_, i) => makeRow({ url: `https://batdongsan.com.vn/ban-dat-xa-${i + 30}`, checks: [legal(), check('season', 'camping months a year', null), check('sea', 'sea within an e-bike ride', true)] }));
    const toConfirm = leaseOptions({ kept: unknown });
    expect(toConfirm?.toConfirm).toHaveLength(LEASE_LIST_MAX);
    expect(toConfirm?.toConfirmCount).toBe(12);
  });

  it('returns null when no row has a lease option', () => {
    expect(leaseOptions({ kept: [{ url: 'https://batdongsan.com.vn/ban-dat-xa-8', plan: { checks: [] } }] })).toBeNull();
    expect(leaseOptions({})).toBeNull();
    expect(leaseOptions(undefined)).toBeNull();
  });
});

describe('lease horizon from the request', () => {
  it('reads years, months and ignores a season length', () => {
    expect(horizonFromText('Find plots … 10 minth, 1 year')).toBe(12);
    expect(horizonFromText('within 18 months')).toBe(18);
    expect(horizonFromText('2 years')).toBe(24);
    expect(horizonFromText('a 10-month season')).toBeNull();
    expect(horizonFromText('WITHIN 18 MONTHS')).toBe(18);
    expect(horizonFromText('one year')).toBe(12);
    expect(horizonFromText('12 months')).toBe(12);
    expect(horizonFromText('a year')).toBe(12);
    expect(horizonFromText('no horizon here')).toBeNull();
    expect(horizonFromText('')).toBeNull();
  });
});

describe('lease alert when the request asks for a country but no listing arrived', () => {
  it('says so instead of staying silent', () => {
    const out = leaseOptions({ kept: [] }, { asked: [{ code: 'VN', name: 'Vietnam', path: 'operate without owning', sources: ['vn-lease'] }] });
    expect(out).toMatchObject({ total: 0, feasibleCount: 0, countries: ['Vietnam'], path: 'operate without owning' });
    expect(out?.headline).toMatch(/^You asked about Vietnam: a foreign buyer cannot own land there, and no listing from there has reached the candidate table yet/);
    expect(leaseOptions({ kept: [] })).toBeNull();
  });
});
