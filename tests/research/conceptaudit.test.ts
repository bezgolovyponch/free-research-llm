import { describe, expect, it } from 'vitest';
import { auditAll, conceptAudit } from '../../src/research/conceptaudit.mjs';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const check = (id: string, ok = true) => ({ id, label: id, ok });
const fit = (url: string, extra: Record<string, unknown> = {}) => ({
  url,
  countryCode: 'PT',
  value: 10000,
  plan: { tier: 'fits', checks: [check('legal'), check('price'), check('sea')] },
  verified: { verdict: 'confirmed' },
  ...extra,
});

function passingProject(extra: Record<string, unknown> = {}) {
  const kept = [fit('https://example.test/a'), fit('https://example.test/b')];
  return {
    id: 'ok',
    question: 'Where should I buy a plot?',
    candidates: {
      kept,
      keptCount: 2,
      tiers: { fits: 2 },
      verification: { at: '2026-11-01T06:00:00Z', confirmed: 2, refuted: 0, unconfirmed: 0, pending: 0 },
      builtAt: '2026-10-30T06:00:00Z',
      strategy: { id: 's' },
    },
    brief: { regions: ['PT'], valueRange: [5000, 20000], unit: 'EUR' },
    improve: { active: true, trials: [{ outcome: 'kept' }, { outcome: 'improved' }] },
    report: { claimCheck: { checked: 2, supported: 2, contradicted: [] } },
    strategyCheck: { at: '2026-10-31T00:00:00Z', 'src-1': { status: 'ok', confirmed: 2, quotes: 2 } },
    nodes: [
      {
        id: 'D1',
        status: 'verified',
        verification: { checks: [{ id: 'meaning', passed: true }, { id: 'sources', passed: true }] },
        finding: { claims: [{ attributed: true, support: { version: 2, verdict: 'supported' } }] },
      },
    ],
    supportAudit: { stale: 0, disagree: 0 },
    ...extra,
  };
}

const finding = (audit: { findings: { id: string }[] }, id: string) => audit.findings.find((f) => f.id === id);
const withCandidates = (project: ReturnType<typeof passingProject>, patch: Record<string, unknown>) => ({ ...project, candidates: { ...project.candidates, ...patch } });

describe('concept audit', () => {
  it('passes a project where every check holds', () => {
    const audit = conceptAudit(passingProject(), { now: NOW });
    expect(audit.at).toBe('2026-11-01T12:00:00.000Z');
    expect(audit.findings).toHaveLength(14);
    expect(audit.findings.every((f: { ok: boolean }) => f.ok)).toBe(true);
    expect(audit.errors).toBe(0);
    expect(audit.warnings).toBe(0);
  });

  it('C1: fails when the kept count is not the number of confirmed fits', () => {
    const audit = conceptAudit(withCandidates(passingProject(), { keptCount: 3 }), { now: NOW });
    expect(finding(audit, 'C1')).toMatchObject({ severity: 'error', ok: false });
    expect(audit.errors).toBe(1);
  });

  it('C2: fails when a fit has a check that is not met', () => {
    const rows = [fit('https://example.test/a', { plan: { tier: 'fits', checks: [check('legal'), check('price', false)] } }), fit('https://example.test/b')];
    const audit = conceptAudit(withCandidates(passingProject(), { kept: rows, keptCount: 2 }), { now: NOW });
    expect(finding(audit, 'C2')).toMatchObject({ severity: 'error', ok: false });
  });

  it('C3: fails when a fit cannot be owned', () => {
    const rows = [fit('https://example.test/a', { plan: { tier: 'fits', checks: [check('legal', false), check('price')] } }), fit('https://example.test/b')];
    const audit = conceptAudit(withCandidates(passingProject(), { kept: rows, keptCount: 2 }), { now: NOW });
    expect(finding(audit, 'C3')).toMatchObject({ severity: 'error', ok: false });
  });

  it('C4: fails when a kept plot is outside the asked countries', () => {
    const rows = [fit('https://example.test/a'), fit('https://example.test/b'), fit('https://example.test/vn', { countryCode: 'VN' })];
    const audit = conceptAudit(withCandidates(passingProject(), { kept: rows, keptCount: 3 }), { now: NOW });
    expect(finding(audit, 'C4')).toMatchObject({ severity: 'error', ok: false });
    expect(finding(audit, 'C4').detail).toContain('VN');
  });

  it('C5: fails when a fit is above the price limit', () => {
    const rows = [fit('https://example.test/a', { value: 25000 }), fit('https://example.test/b')];
    const audit = conceptAudit(withCandidates(passingProject(), { kept: rows, keptCount: 2 }), { now: NOW });
    expect(finding(audit, 'C5')).toMatchObject({ severity: 'error', ok: false });
  });

  it('C10: fails when a verified piece has a failed meaning check', () => {
    const nodes = [{ id: 'D1', status: 'verified', verification: { checks: [{ id: 'meaning', passed: false }] }, finding: { claims: [] } }];
    const audit = conceptAudit(passingProject({ nodes }), { now: NOW });
    expect(finding(audit, 'C10')).toMatchObject({ severity: 'error', ok: false });
  });

  it('C14: fails when plots are counted while the table is empty', () => {
    const audit = conceptAudit(withCandidates(passingProject(), { kept: [], keptCount: 2 }), { now: NOW });
    expect(finding(audit, 'C14')).toMatchObject({ severity: 'error', ok: false });
  });

  it('C15: passes when the count check passed', () => {
    const project = passingProject({ acceptance: { itemCount: 10 }, acceptanceResult: { checks: [{ id: 'count', label: 'At least 10 valid items', value: 1, passed: true }] } });
    const audit = conceptAudit(project, { now: NOW });
    expect(finding(audit, 'C15')).toMatchObject({ severity: 'warn', ok: true, detail: '10 item(s) delivered.' });
  });

  it('C15: warns when a list research delivered nothing', () => {
    const project = passingProject({ acceptance: { itemCount: 10 }, acceptanceResult: { checks: [{ id: 'count', label: 'At least 10 valid items', value: 0, passed: false }] } });
    const audit = conceptAudit(project, { now: NOW });
    expect(finding(audit, 'C15')).toMatchObject({ severity: 'warn', ok: false, detail: '0 of 10 item(s) delivered' });
  });

  it('C15: reads the count check value as the delivered share of the asked items', () => {
    const project = passingProject({ acceptance: { itemCount: 50 }, acceptanceResult: { checks: [{ id: 'count', label: 'At least 50 valid items', value: 0.38, passed: false }] } });
    const audit = conceptAudit(project, { now: NOW });
    expect(finding(audit, 'C15')).toMatchObject({ ok: false, detail: '19 of 50 item(s) delivered' });
  });

  it('C16: passes when the template still exists', () => {
    const audit = conceptAudit(passingProject({ templateId: 'generic' }), { now: NOW });
    expect(finding(audit, 'C16')).toMatchObject({ severity: 'warn', ok: true });
  });

  it('C16: warns when the research kept a removed template', () => {
    const audit = conceptAudit(passingProject({ templateId: 'car-arbitrage' }), { now: NOW });
    expect(finding(audit, 'C16')).toMatchObject({
      severity: 'warn',
      ok: false,
      detail: 'template "car-arbitrage" was removed; the research runs as a generic question',
    });
  });

  it('C17: passes when a list research names its item kind', () => {
    const project = passingProject({ acceptance: { itemCount: 10 }, phase: 'researching', brief: { regions: ['PT'], kind: { label: 'car listing' } } });
    const audit = conceptAudit(project, { now: NOW });
    expect(finding(audit, 'C17')).toMatchObject({ severity: 'warn', ok: true });
  });

  it('C17: warns when a list research has no item kind', () => {
    const project = passingProject({ acceptance: { itemCount: 10 }, phase: 'researching', brief: { regions: ['PT'] } });
    const audit = conceptAudit(project, { now: NOW });
    expect(finding(audit, 'C17')).toMatchObject({
      severity: 'warn',
      ok: false,
      detail: 'no item kind: the research prompts ask for a decision memo instead of listing pages',
    });
  });

  it('keeps C1-C14 unchanged for a plot project with a full candidates table', () => {
    const audit = conceptAudit(passingProject(), { now: NOW });
    const before = audit.findings.filter((f: { id: string }) => /^C(?:[1-9]|1[0-4])$/.test(f.id)).map((f: { id: string; severity: string; ok: boolean; detail: string }) => [f.id, f.severity, f.ok, f.detail]);
    expect(before).toEqual([
      ['C1', 'error', true, '2 kept plot(s) fit every check and are confirmed.'],
      ['C2', 'error', true, 'All 2 fit(s) have every asked check met.'],
      ['C3', 'error', true, 'No fit fails the legal check.'],
      ['C4', 'error', true, 'Every kept plot is in PT.'],
      ['C5', 'error', true, 'All 2 fit(s) are within 20000 EUR.'],
      ['C6', 'warn', true, 'The outside check is current.'],
      ['C7', 'warn', true, '0 of 2 checked fit(s) are refuted by the outside check.'],
      ['C8', 'warn', true, '0 of 2 recent trial(s) were provider outages.'],
      ['C9', 'warn', true, 'Every claim is checked under the current logic.'],
      ['C10', 'error', true, 'No verified piece has a failed meaning check.'],
      ['C11', 'warn', true, 'Strategy sources are fresh and confirmed.'],
      ['C12', 'warn', true, 'The memo does not contradict the record.'],
      ['C13', 'warn', true, 'Every asked country reached the table: PT.'],
      ['C14', 'error', true, 'The table and its count agree.'],
    ]);
  });

  it('C8: warns when most recent trials were provider outages', () => {
    const trials = Array.from({ length: 30 }, (_, i) => ({ outcome: i < 20 ? 'provider-outage' : 'kept' }));
    const audit = conceptAudit(passingProject({ improve: { active: true, trials } }), { now: NOW });
    expect(finding(audit, 'C8')).toMatchObject({ severity: 'warn', ok: false });
    expect(finding(audit, 'C8').detail).toContain('20');
    expect(audit.warnings).toBe(1);
  });

  it('C13: warns when an asked country never reached the table', () => {
    const project = passingProject({ brief: { regions: ['PT', 'VN'], valueRange: [5000, 20000], unit: 'EUR' } });
    const audit = conceptAudit(project, { now: NOW });
    expect(finding(audit, 'C13')).toMatchObject({ severity: 'warn', ok: false });
    expect(finding(audit, 'C13').detail).toContain('VN');
  });

  it('skips checks whose data is absent', () => {
    const empty = conceptAudit({}, { now: NOW });
    expect(empty.findings).toEqual([]);
    expect(empty.errors).toBe(0);
    expect(empty.warnings).toBe(0);
    const partial = conceptAudit({ candidates: { kept: [], keptCount: 0 } }, { now: NOW });
    expect(partial.findings.map((f: { id: string }) => f.id)).toEqual(['C1', 'C2', 'C3', 'C14']);
  });

  it('keeps every detail at most 200 characters', () => {
    const long = `https://example.test/${'x'.repeat(300)}`;
    const rows = [fit(long, { countryCode: 'VN', value: 25000, plan: { tier: 'fits', checks: [check('legal', false), check('price', false)] } })];
    const project = passingProject({
      candidates: { kept: rows, keptCount: 9, verification: { at: '2020-01-01T00:00:00Z', confirmed: 1, refuted: 1, unconfirmed: 0, pending: 4 }, builtAt: '2026-10-30T06:00:00Z' },
      report: { claimCheck: { checked: 1, supported: 0, contradicted: [{ text: 'y'.repeat(300) }] } },
      strategyCheck: { at: '2020-01-01T00:00:00Z', 'very-long-source-id': { status: 'ok', confirmed: 0, quotes: 5 } },
      improve: { active: true, trials: Array.from({ length: 30 }, () => ({ outcome: 'provider-outage' })) },
      supportAudit: { stale: 7, disagree: 0 },
      nodes: [{ id: 'D1', status: 'verified', verification: { checks: [{ id: 'meaning', passed: false }] }, finding: { claims: [] } }],
    });
    const audit = conceptAudit(project, { now: NOW });
    expect(audit.findings.length).toBeGreaterThan(5);
    for (const f of audit.findings as { detail: string }[]) expect(f.detail.length).toBeLessThanOrEqual(200);
  });

  it('audits a list of projects with their identity', () => {
    const list = auditAll([passingProject(), { id: 'x', question: 'q'.repeat(120) }]);
    expect(list[0]).toMatchObject({ id: 'ok', question: 'Where should I buy a plot?' });
    expect(list[0].findings).toHaveLength(14);
    expect(list[1].id).toBe('x');
    expect(list[1].question).toHaveLength(80);
  });
});

describe('claim logic check without a stored summary', () => {
  it('computes the same stale count the app shows, ignoring roll-ups and non-result claims', () => {
    const nodes = [
      { id: 'D1', sources: [{ id: 'D1.1', kind: 'node' }], finding: { claims: [{ text: 'D1.1 says: margin 300', attributed: true }] } },
      { id: 'D1.1', method: 'lookup', sources: [{ id: 'S1', kind: 'web' }], finding: { answer: 'A permit costs €950.', claims: [{ text: 'A permit costs €950', attributed: true }, { text: 'Camping needs approval', attributed: true }] } },
    ];
    const c9 = conceptAudit({ nodes }).findings.find((f) => f.id === 'C9');
    expect(c9).toMatchObject({ ok: false, detail: '1 claim(s) were checked under older logic.' });
  });
});

describe('universal list-research rules on stored researches', () => {
  it('C18 flags a list research whose tree does per-listing work and passes a knowledge-only tree', () => {
    const base = { acceptance: { itemCount: 20 } };
    const bad = conceptAudit({ ...base, nodes: [{ id: 'D2', parentId: null, question: 'Checks' }, { id: 'D2.2', parentId: 'D2', question: 'Verify each listing is explicitly classified as a hatchback.' }] });
    expect(bad.findings.find((f: { id: string }) => f.id === 'C18')).toMatchObject({ ok: false, detail: '1 piece(s) do per-listing work code should do: D2.2' });
    const good = conceptAudit({ ...base, nodes: [{ id: 'D3', parentId: null, question: 'Reliability' }, { id: 'D3.1', parentId: 'D3', question: 'What are known failure modes for candidate engines?' }] });
    expect(good.findings.find((f: { id: string }) => f.id === 'C18')).toMatchObject({ ok: true });
  });

  it('C19 flags a memo that states fewer results than the table keeps', () => {
    const table = { candidates: { keptCount: 70, kept: [] }, acceptance: { itemCount: 20 } };
    const bad = conceptAudit({ ...table, report: { verdict: 'GO-IF: 15 verified hatchback listings under 65,000 CZK were found' } });
    expect(bad.findings.find((f: { id: string }) => f.id === 'C19')).toMatchObject({ ok: false, detail: 'memo states 15 results, the table keeps 70' });
    const good = conceptAudit({ ...table, report: { verdict: 'Table (computed by code): 70 results kept — the 20 asked are met' } });
    expect(good.findings.find((f: { id: string }) => f.id === 'C19')).toMatchObject({ ok: true });
  });
});
