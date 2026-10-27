import { describe, expect, it } from 'vitest';
import reference from '../fixtures/glamping-plots-reference.json';
import { buildBrief, describeBrief } from '../../src/research/brief.mjs';
import { buildCandidates } from '../../src/research/candidates.mjs';
import { isKind } from '../../src/research/itemgate.mjs';
import { applyStrategy, foundationOf, planFor, strategyFor } from '../../src/research/strategy.mjs';
import { templateById } from '../../src/research/templates.mjs';
import { narrowRegions } from '../../src/research/treeaudit.mjs';

const template = templateById(reference.templateId);
const brief = buildBrief({ question: reference.question, acceptance: reference.acceptance, constraints: reference.constraints, template });
const strategy = strategyFor(reference.templateId)!;
const foundation = foundationOf(strategy, reference);
const model = { ...strategy, rules: foundation.rules };
const toEur = (value: number, from: string) => (from === 'GBP' ? value * 1.2 : value);
const climate = (workable: number, hottest: number) => ({ workable, comfortable: workable - 3, hottest, coldest: 8, cci: { annual: 6.5, optimalDays: 120, hotDays: hottest > 34 ? 6 : 0, optimalTrend: 1.5, perYear: [], years: 5 } });
const site = (coastKm: number | null, more = {}) => ({ coastKm, beachKm: coastKm, beaches: 5, viewpoints: 10, attractions: 5, reserves: 1, protectedAreas: 1, hikingRoutes: 2, campsites: 3, lodging: 40, climate: climate(12, 24), ...more });
const trends = { PT: { change: 17.6, inflation: 2.2, real: 15.1, year: '2025', realCagr: 8, since: '2020' }, HR: { change: 13.9, inflation: 4, real: 9.5, year: '2025', realCagr: 6, since: '2020' }, EU27_2020: { real: 2.9, realCagr: 2 } };
const plot = { title: 'Terreno rústico 1,640 m² Nazaré', url: 'https://imo.example/anuncio/terreno-ID1a', countryCode: 'PT', country: 'Portugal', value: 20000, area: 1640, areaUnit: 'm²', site: site(2.7), fit: { score: 0.9 } };
const plan = (row: object) => planFor(row, model, { convert: toEur, euHpi: 2.9, trends });
const note = (id: string) => reference.notes.find((n) => n.id === id)!.said;

describe('reference case: low-entry glamping plots (every note the user gave on 2026-10-26)', () => {
  it(`N1 ${note('N1')}`, () => {
    expect(brief.regions).toEqual(['PT', 'ES', 'TR', 'VN']);
    expect(describeBrief(brief)).toContain('EU narrowed to Portugal, Spain');
  });

  it(`N2 ${note('N2')}`, () => {
    expect(isKind({ title: 'Ver foto 2016 Land Rover Range Rover Evoque', url: 'https://x.example/cars/1' }, template.itemKind)).toBe(false);
    expect(isKind({ title: 'Cemitério da Guia em Cascais- Terreno perpétuo', url: 'https://x.example/1' }, template.itemKind)).toBe(false);
  });

  it(`N3 ${note('N3')}`, () => {
    expect(strategy.sources.filter((s) => s.quotes.length).length).toBeGreaterThanOrEqual(10);
    const p = plan(plot);
    expect(p.path).toContain('Rural camping park');
    expect(p.entry?.total).toBeGreaterThan(20000);
  });

  it(`N4 ${note('N4')}`, () => {
    const why = plan(plot).why.join(' | ');
    for (const part of ['sea 2.7 km', '12 camping months a year by the Camping Climate Index', 'without air conditioning', 'holds 24 units', 'entry ≈', 'after inflation', 'path:']) expect(why).toContain(part);
  });

  it(`N6 ${note('N6')}`, () => {
    expect(plan({ ...plot, site: site(32, { lakeKm: 1.2, lakesNamed: true }) }).tier).toBe('trade-off');
    expect(plan({ ...plot, site: site(60, { beaches: 0, viewpoints: 1, attractions: 0, reserves: 0, protectedAreas: 0, hikingRoutes: 0, climate: climate(6, 30) }) }).tier).toBe('weak');
  });

  it(`N7 ${note('N7')}`, () => {
    expect(plan({ ...plot, site: site(0.3, { climate: climate(7, 29) }) }).verdict).toContain('a strong short-season location');
  });

  it(`N8 ${note('N8')}`, () => {
    expect(foundation.complete).toBe(true);
    expect(plan({ ...plot, site: null }).tier).toBe('unverified');
    const out = applyStrategy({ sites: { euHpi: 2.9, trends }, kept: [plot, { ...plot, url: 'b', site: null }], screened: {}, screenedCount: 0 }, strategy, { convert: toEur, foundation });
    expect(out.keptCount).toBe(1);
  });

  it(`N9 ${note('N9')}`, () => {
    const nodes = [{ id: 'Q', parentId: null, title: 'Q', question: 'q' }, { id: 'D1', parentId: 'Q', title: 'EU plots', question: 'Find plots in EU countries (Spain, Italy, Greece, Croatia) under 20,000 EUR' }];
    narrowRegions(nodes, brief.regions);
    expect(nodes[1].question).toBe('Find plots in Portugal and Spain under 20,000 EUR');
  });

  it(`N10 ${note('N10')}`, () => {
    const table = buildCandidates([{ id: 'D1', sources: [{ url: 'https://p.example/r', listings: [{ title: 'Zemljiste Vir', url: 'https://famalo.hr/zemljiste-1-14501', value: 12000, unit: 'EUR' }] }] }], brief, {});
    expect(table.kept).toEqual([]);
    expect(table.outside.map((r: { url: string }) => r.url)).toEqual(['https://famalo.hr/zemljiste-1-14501']);
  });

  it(`N11 ${note('N11')}`, () => {
    expect(plan(plot).checks.find((c: { id: string }) => c.id === 'trend')).toMatchObject({ ok: true, detail: 'Portugal +15.1% a year after inflation vs EU +2.9% (Eurostat, housing)' });
  });

  it(`N12 ${note('N12')} · N13 ${note('N13')}`, () => {
    expect(foundation.rules.minWorkableMonths).toEqual({ value: 10, source: 'question' });
    expect(foundation.rules.maxHottest).toEqual({ value: 32.2, source: 'ma2021' });
    expect(foundation.rules.ebikeKm).toEqual({ value: 20, source: 'guidance' });
  });

  it(`N14 ${note('N14')}`, () => {
    expect(plan({ ...plot, countryCode: 'VN', country: 'Vietnam' }).verdict).toMatch(/^blocked: a foreign individual cannot hold land in Vietnam/);
  });
});
