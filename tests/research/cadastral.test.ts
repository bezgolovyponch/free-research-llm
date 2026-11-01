import { describe, expect, it } from 'vitest';
import { CADASTRAL_GATES } from '../../src/search/cadastral.mjs';
import { cadastralGateVerdict, cadastralExplain, cadastralResearchPlan } from '../../src/research/cadastral.mjs';

describe('cadastralResearchPlan', () => {
  it('decomposes a cadastral deep research into a driver plus verified sub-questions', () => {
    const plan = cadastralResearchPlan('TR', '33/1234');
    expect(plan.root).toBe('Q');
    expect(plan.driver.title).toContain('Cadastral record exists');
    expect(plan.subQuestions.length).toBeGreaterThan(0);
    expect(plan.subQuestions.some((s) => /zoning|permitted/i.test(s.question))).toBe(true);
    expect(plan.subQuestions.some((s) => /ownership|title/i.test(s.question))).toBe(true);
    expect(plan.subQuestions.some((s) => /surface|price per m/i.test(s.question))).toBe(true);
    plan.subQuestions.forEach((s) => {
      expect(s.parentId).toBeTruthy();
      expect(Array.isArray(s.searchQueries)).toBe(true);
    });
  });

  it('wires each sub-question under its driver', () => {
    const plan = cadastralResearchPlan('PT', '999/1');
    const driverId = plan.driver.id;
    for (const s of plan.subQuestions) expect(s.dependsOn).toContain(driverId);
  });
});

describe('cadastralGateVerdict', () => {
  const row = (finding: Record<string, unknown>) => ({ finding });

  it('stays to confirm on a full set of claims plus a registry record, because the title and zoning are never read from a free source', () => {
    const row1 = { ...row({ parcelRef: '33/1234', boundaryCount: 4, surfaceM2: 5000, pricePerM2: 47.5, zoning: 'agricultural' }), cadastre: { registry: 'TKGM', place: 'Tekke', ada: '217', parsel: '2', areaM2: 17091.59, landUse: 'Tarla' } };
    const verdict = cadastralGateVerdict(row1);
    expect(verdict.tier).toBe('unverified');
    expect(verdict.pending.length).toBe(2);
  });

  it('weak when any gate fails', () => {
    const row1 = row({ parcelRef: '33/1234', boundaryCount: 4, surfaceM2: 5000, pricePerM2: 47.5, sharedTitle: true });
    expect(cadastralGateVerdict(row1).tier).toBe('weak');
    expect(cadastralGateVerdict(row1).failed.length).toBeGreaterThan(0);
  });

  it('unverified when gates are pending', () => {
    const v = cadastralGateVerdict(row({}));
    expect(v.tier).toBe('unverified');
    expect(v.pending.length).toBe(CADASTRAL_GATES.length);
  });

  it('reports pending gates by label', () => {
    const v = cadastralGateVerdict(row({}));
    expect(v.pending).toContain('a cadastral parcel record exists for this reference');
  });
});

describe('cadastralExplain', () => {
  const row = (finding: Record<string, unknown>) => ({ finding });

  it('summarises what is on record', () => {
    const e = cadastralExplain(row({ parcelRef: '33/1234', boundaryCount: 4, surfaceM2: 5000, pricePerM2: 47.5, zoning: 'agricultural' }));
    expect(e.why.join(' ')).toContain('cadastral reference 33/1234');
    expect(e.why.join(' ')).toContain('surface 5000 m²');
    expect(e.why.join(' ')).toContain('€47.50/m²');
    expect(e.trade.length).toBe(0);
  });

  it('lists trade-offs when gates are missing', () => {
    const e = cadastralExplain(row({ sharedTitle: true, encumbrance: true }));
    expect(e.trade.join(' ')).toContain('shared title');
    expect(e.trade.join(' ')).toContain('encumbrance');
  });
});

describe('cadastral strategy adds no rows of its own', () => {
  it('leaves kept rows and counts untouched when no listing was read', async () => {
    const { applyStrategy, CADASTRAL_STRATEGY } = await import('../../src/research/strategy.mjs');
    const out = applyStrategy({ kept: [], found: 0, keptCount: 0 }, CADASTRAL_STRATEGY);
    expect(out.kept).toEqual([]);
    expect(out.found).toBe(0);
    expect(out.keptCount).toBe(0);
  });

  it('never returns a counted row without a listing link', async () => {
    const { applyStrategy, CADASTRAL_STRATEGY } = await import('../../src/research/strategy.mjs');
    const out = applyStrategy({ kept: [{ id: 'x', url: 'https://example.test/parcel', title: 'p', price: 1 }], found: 1, keptCount: 1 }, CADASTRAL_STRATEGY);
    expect(out.kept.every((r) => typeof r.url === 'string' && r.url.length > 0)).toBe(true);
  });
});
