import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CaseBank, DecisionModeler, REFERENCE_CASE, UTILITY_PRIOR, aggregate, applyCalibration, applyModel, calibrationPrompt, decisionPrompt, modelText, normalizeSample, planByModel, quoteStates, rankCases, verifyKind, withModelRules } from '../../src/research/decision.mjs';
import { foundationOf, strategyFor } from '../../src/research/strategy.mjs';

const question = 'Find plots for a glamping site under 30000 EUR, at most 15 km from the sea, hottest month under 29 °C, with a strong price trend';
const sample = (criteria: object[], terms = ['plot', 'terreno']) => normalizeSample({ concept: 'cheap coastal glamping land', kind: { label: 'plot of land', terms }, criteria });
const sea = { clause: 'at most 15 km from the sea', measure: 'coastKm', op: '<=', value: 15, quote: 'at most 15 km from the sea' };
const heat = { clause: 'hottest month under 29 °C', measure: 'hottestC', op: '<', value: 29, quote: 'under 29 °C' };
const trend = { clause: 'with a strong price trend', measure: 'realTrendVsEu', op: '>', value: null, quote: '' };
const site = (coastKm: number | null, hottest = 27) => ({ coastKm, climate: { workable: 11, comfortable: 8, hottest, coldest: 6, cci: { annual: 6, optimalDays: 100, hotDays: 0, optimalTrend: 0 } } });

describe('decision model per request: criteria kept by agreement, limits only from the user or a case', () => {
  it('keeps a criterion only when a majority of independent proposals make it (self-consistency)', () => {
    const model = aggregate([sample([sea, heat]), sample([sea]), sample([sea, { ...heat, measure: 'coldestC' }])], { question });
    expect(model.criteria.map((c: { measure: string }) => c.measure)).toEqual(['coastKm']);
    expect(model.agreement).toMatchObject({ samples: 3, majority: 2 });
  });

  it('takes a limit from the question only when its quote is on the question and states that number', () => {
    expect(quoteStates(question, 'at most 15 km from the sea', 15)).toBe(true);
    expect(quoteStates(question, 'at most 15 km from the sea', 12)).toBe(false);
    expect(quoteStates(question, 'within 15 km of a beach', 15)).toBe(false);
    const model = aggregate([sample([sea]), sample([{ ...sea, value: 12 }]), sample([sea])], { question });
    expect(model.criteria[0]).toMatchObject({ measure: 'coastKm', value: 15, source: 'question', quote: 'at most 15 km from the sea' });
  });

  it('never keeps an invented number: a clause with no stated limit borrows an approved case or stays unchecked', () => {
    const invented = { ...heat, value: 31, quote: 'mild climate' };
    const bare = aggregate([sample([invented, trend]), sample([invented, trend]), sample([trend])], { question });
    expect(bare.criteria.map((c: { measure: string }) => c.measure)).toEqual([]);
    expect(bare.noLimit.map((c: { measure: string }) => c.measure)).toEqual(['hottestC', 'realTrendVsEu']);
    const cased = aggregate([sample([trend]), sample([trend])], { question, cases: [REFERENCE_CASE] });
    expect(cased.criteria[0]).toMatchObject({ measure: 'realTrendVsEu', value: 0, source: 'case glamping-low-entry (eurostat)' });
  });

  it('drops proposals that name no measure code can take, and lists clauses nothing tests', () => {
    const model = aggregate([sample([sea, { measure: 'vibes', op: '>', value: 3 }]), sample([sea])], { question });
    expect(model.criteria).toHaveLength(1);
    expect(model.missing).toContain('Find plots for a glamping site under 30000 EUR');
  });

  it('keeps item-kind words a majority proposed, then only those that fetched listing titles use', () => {
    const model = aggregate([sample([sea], ['plot', 'terreno', 'lote']), sample([sea], ['plot', 'terreno']), sample([sea], ['terreno', 'arsa'])], { question });
    expect(model.kind.terms).toEqual(['plot', 'terreno']);
    const checked = verifyKind(model.kind, ['Terreno rústico em Nazaré', 'Moradia T3', 'Terrenos à venda Coimbra']);
    expect(checked.terms).toEqual(['terreno']);
    expect(checked.dropped).toEqual(['plot']);
    expect(checked.verified).toEqual({ titles: 3, matched: 2, share: 0.67 });
    expect(verifyKind(model.kind, []).verified).toBeNull();
  });

  it('keeps the words a majority proposed for things sold beside the item, and asks for them', () => {
    const withNot = (not: string[]) => normalizeSample({ concept: 'c', kind: { label: 'used car', terms: ['hatchback'], not }, criteria: [] });
    const model = aggregate([withNot(['kola', 'pneu', 'naraznik']), withNot(['kola', 'pneu', 'naraznik']), withNot(['svetlo'])], { question });
    expect(model.kind.not).toEqual(['kola', 'pneu', 'naraznik']);
    expect(aggregate([withNot(['kola']), withNot(['pneu']), withNot(['svetlo'])], { question }).kind.not).toBeUndefined();
    expect(decisionPrompt({ question })[0].content).toContain('"not"');
  });

  it('measures every listing by code: fits, to confirm when unmeasured, weak when a limit fails', () => {
    const model = aggregate([sample([sea, heat]), sample([sea, heat])], { question });
    expect(planByModel({ site: site(4) }, model).tier).toBe('fits');
    expect(planByModel({ site: null }, model).tier).toBe('unverified');
    const far = planByModel({ site: site(null) }, model);
    expect(far.tier).toBe('weak');
    expect(far.verdict).toContain('beyond the measured range');
    expect(planByModel({ site: site(4, 30) }, model).checks.find((c: { id: string }) => c.id === 'hottestC')).toMatchObject({ ok: false, detail: 'hottest month average daily high: 30 °C' });
  });

  it('counts only listings that fit every criterion and ranks them first', () => {
    const model = aggregate([sample([sea]), sample([sea])], { question });
    const out = applyModel({ kept: [{ url: 'far', site: site(40) }, { url: 'near', site: site(2), value: 9000 }, { url: 'open', site: null }] }, model);
    expect(out.kept.map((r: { url: string }) => r.url)).toEqual(['near', 'open', 'far']);
    expect(out.keptCount).toBe(1);
    expect(out.tiers).toMatchObject({ fits: 1, unverified: 1, weak: 1 });
  });

  it('replaces a hand-chosen glamping limit when the user states one, and never with a borrowed value', () => {
    const strategy = strategyFor('glamping-location')!;
    const base = foundationOf(strategy, { question, guidance: '' });
    expect(base.rules.maxHottest.source).toBe('ma2021');
    const model = aggregate([sample([sea, { ...heat, op: '<=' }]), sample([sea, { ...heat, op: '<=' }])], { question });
    const merged = withModelRules(base, model);
    expect(merged.rules.maxHottest).toMatchObject({ value: 29, source: 'question' });
    expect(merged.rules.ebikeKm).toMatchObject({ value: 15, source: 'question' });
    const borrowed = withModelRules(base, { ...model, criteria: [{ measure: 'hottestC', op: '<=', value: 25, source: 'case x' }] });
    expect(borrowed.rules.maxHottest.source).toBe('ma2021');
    expect(modelText(model)).toContain('distance to the sea <= 15 km (question)');
  });

  it('retrieves similar approved cases and ranks them by measured utility (MemRL two-phase)', () => {
    const cases = [
      { id: 'a', question: 'glamping plots near the sea in Portugal', utility: 0.1, criteria: [] },
      { id: 'b', question: 'glamping plots near the sea in Spain', utility: 0.9, criteria: [] },
      { id: 'c', question: 'tax regimes for freelancers', utility: 1, criteria: [] },
    ];
    expect(rankCases('glamping plots near the sea', cases).map((c: { id: string }) => c.id)).toEqual(['b', 'a']);
    expect(rankCases('payroll in Japan', cases.slice(0, 2))).toEqual([]);
  });

  it('stores every built model as a case and moves its utility toward the run score', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-cases-'));
    const file = path.join(dir, 'cases.json');
    const bank = new CaseBank({ file });
    const model = aggregate([sample([sea]), sample([sea])], { question });
    await bank.record('p1', question, model);
    await bank.reward(['p1'], 1);
    await bank.writing;
    const again = new CaseBank({ file });
    const [stored] = (await again.load()).cases;
    expect(stored).toMatchObject({ id: 'p1', approved: false, uses: 1 });
    expect(stored.utility).toBeCloseTo(UTILITY_PRIOR + 0.3 * (1 - UTILITY_PRIOR), 5);
    expect(again.all()[0].id).toBe(REFERENCE_CASE.id);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('stage 0: the purpose, its value and the needs it implies are chosen by code', () => {
  const ask = 'Find used hatchback cars within 300km from prague up to 65000CZK with highest price/value';
  const specific = {
    concept: 'used hatchbacks near Prague',
    purpose: 'A buyer wants a used hatchback near Prague under 65,000 CZK so that they buy the best value car',
    value: 'a shortlist of 20 hatchbacks within 300 km of Prague, each at or below 65,000 CZK and below the median price of its model and year',
    needs: [
      { need: 'live hatchback listings within 300 km of Prague', kind: 'listings', sources: ['sauto.cz', 'mobile.de'] },
      { need: 'reliability of common hatchback models', kind: 'knowledge', sources: ['adac.de', 'car buying guides'] },
      { need: 'price below the median for its model and year', kind: 'computed', sources: ['listings table'] },
    ],
    kind: { label: 'used hatchback', terms: ['hatchback'] },
    criteria: [],
  };
  const generic = { purpose: 'User wants information about cars', value: '', needs: [{ need: 'cars', kind: 'prices', sources: [] }] };
  const other = { purpose: 'Someone wants a cheap car so that they save money', value: 'the cheapest car', needs: [] };

  it('picks the purpose and value that share the most words with the question', () => {
    const model = aggregate([normalizeSample(generic), normalizeSample(specific), normalizeSample(other)], { question: ask });
    expect(model.purpose).toBe(specific.purpose);
    expect(model.value).toBe(specific.value);
    expect(model.needs).toEqual(specific.needs);
    expect(model.purposeGrounded).toBeGreaterThanOrEqual(2);
  });

  it('keeps no purpose when it is not grounded in the question or has no value', () => {
    const vague = aggregate([normalizeSample(generic), normalizeSample(generic)], { question: ask });
    expect(vague.purpose).toBeNull();
    expect(vague.purposeGrounded).toBeLessThan(2);
    const noValue = { ...specific, value: '' };
    expect(aggregate([normalizeSample(noValue), normalizeSample(noValue)], { question: ask }).purpose).toBeNull();
    const noSoThat = { ...specific, purpose: 'A buyer wants a used hatchback near Prague under 65,000 CZK' };
    expect(aggregate([normalizeSample(noSoThat), normalizeSample(noSoThat)], { question: ask }).purpose).toBeNull();
  });

  it('keeps only needs with a known kind and puts Why, Value and Needs first in the brief', () => {
    const model = aggregate([normalizeSample(specific), normalizeSample(specific)], { question: ask });
    expect(model.needs.map((n: { kind: string }) => n.kind)).toEqual(['listings', 'knowledge', 'computed']);
    const text = modelText(model);
    expect(text.startsWith(`Why: ${specific.purpose}`)).toBe(true);
    expect(text).toContain(`Value: ${specific.value}`);
    expect(text).toContain('Needs: live hatchback listings within 300 km of Prague (listings: sauto.cz, mobile.de);');
    expect(modelText(aggregate([normalizeSample(generic)], { question: ask }))).toContain('Why: not stated clearly — pieces must not be researched until it is');
  });
});

describe('DecisionModeler: several independent model calls, code decides', () => {
  const reply = (criteria: object[]) => ({ provider: 'p', data: { concept: 'c', kind: { label: 'plot', terms: ['plot'] }, criteria } });

  it('asks several times with sampling, keeps the agreed criteria and records the case', async () => {
    const calls: { temperature: number; purpose: string }[] = [];
    const answers = [reply([sea, heat]), reply([sea]), null];
    const router = { complete: async (req: { temperature: number; purpose: string }) => {
      calls.push(req);
      const next = answers.shift();
      if (!next) throw new Error('quota');
      return next;
    } };
    const recorded: string[] = [];
    const cases = { retrieve: async () => [REFERENCE_CASE], record: async (id: string) => { recorded.push(id); } };
    const project: Record<string, unknown> = { id: 'p9', question, guidance: '', acceptance: { expected: '20 plots' } };
    const model = await new DecisionModeler({ router, cases }).build(project);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.purpose === 'decision-model' && c.temperature > 0)).toBe(true);
    expect(model.criteria.map((c: { measure: string }) => c.measure)).toEqual(['coastKm']);
    expect(model.caseIds).toEqual([REFERENCE_CASE.id]);
    expect(recorded).toEqual(['p9']);
    expect(await new DecisionModeler({ router: { complete: async () => { throw new Error('no call expected'); } } }).build(project)).toBe(model);
  });

  it('keeps no model when fewer than two proposals came back', async () => {
    const router = { complete: async () => { throw new Error('down'); } };
    expect(await new DecisionModeler({ router }).build({ id: 'x', question })).toBeNull();
  });
});

describe('item kind calibrated on real listing titles', () => {
  const titles = [
    'Alu kola 215x65R16',
    'ALU KOLA 15" Škoda',
    'Levé zadní světlo Honda Accord 7g',
    'Zadní světlo Škoda Fabia',
    'Použité pneumatiky 205/55 R16',
    'Letní pneumatiky Michelin',
    'Matky hliníkové lehké',
    'Karburátor škoda',
    'ŠKODA FABIA II COMFORT 2008',
    'VW FOX 1,2 2009 BENZÍN',
    'Peugeot 208',
    'Opel Corsa',
    'Mazda 6',
    'Škoda Octavia',
  ];
  const kind = { label: 'used car', terms: ['hatchback'], not: ['parts'] };
  const proposal = { data: { not: ['kola', 'svetlo', 'pneumatiky', 'naraznik'], subtype: { label: 'hatchback', models: ['fabia', 'corsa', '208', 'polo'] } } };

  it('asks for the words that mark things which are not the item and for the models of the asked sub-type', () => {
    const messages = calibrationPrompt({ kind, question: 'Find used hatchbacks near Prague', titles });
    const system = messages[0].content;
    const user = messages[1].content;
    expect(system).toContain('"not"');
    expect(system).toContain('"subtype"');
    expect(system).toContain('"models"');
    expect(system).toContain('Copy words exactly as they appear in the titles');
    expect(user).toContain('Levé zadní světlo Honda Accord 7g');
    expect(user).toContain('ŠKODA FABIA II COMFORT 2008');
  });

  it('keeps a not word only when 2 or more titles use it, and a model only when 1 or more titles show it', () => {
    const out = applyCalibration(kind, proposal, titles);
    expect(out.kind).toEqual({ label: 'used car', terms: ['hatchback'], not: ['parts', 'kola', 'svetlo', 'pneumatiky'] });
    expect(out.subtype).toEqual({ label: 'hatchback', models: ['fabia', 'corsa', '208'], variants: [], source: 'model proposal, matched to listing titles by code' });
  });

  it('drops every proposal no title confirms and returns no sub-type without a confirmed model', () => {
    const out = applyCalibration(kind, { not: ['naraznik'], subtype: { label: 'hatchback', models: ['polo'] } }, titles);
    expect(out.kind.not).toEqual(['parts']);
    expect(out.subtype).toBeNull();
    const none = applyCalibration(kind, null, titles);
    expect(none.kind.not).toEqual(['parts']);
    expect(none.subtype).toBeNull();
  });
});

describe('decision model version', () => {
  it('treats a model built under an older logic version as stale so it is rebuilt', async () => {
    const { DecisionModeler, DECISION_MODEL_VERSION } = await import('../../src/research/decision.mjs');
    const modeler = new DecisionModeler({ router: { complete: async () => null } } as never);
    const project = { question: 'q', guidance: '', decisionModel: { question: 'q', guidance: '', agreement: { samples: 3 } } };
    expect(modeler.fresh(project)).toBe(false);
    expect(modeler.fresh({ ...project, decisionModel: { ...project.decisionModel, version: DECISION_MODEL_VERSION } })).toBe(true);
  });
});

describe('mergeCalibrations', () => {
  it('keeps a word or model only when a majority of the calibration proposals name it', async () => {
    const { mergeCalibrations } = await import('../../src/research/decision.mjs');
    const reply = (models: string[], not: string[]) => ({ data: { not, subtype: { label: 'hatchback', models, variants: [] } } });
    const merged = mergeCalibrations([reply(['Skoda Fabia', 'Peugeot 3008'], ['kola']), reply(['Škoda Fabia', 'Ford Fiesta'], ['kola', 'pneu']), reply(['Ford Fiesta'], ['pneu']), null]);
    expect(merged.samples).toBe(3);
    expect(merged.data.subtype.models.sort()).toEqual(['ford fiesta', 'skoda fabia']);
    expect(merged.data.not.sort()).toEqual(['kola', 'pneu']);
  });
});

describe('calibration model names', () => {
  it('matches a model by make and model when the proposal copied a generation suffix from one title', async () => {
    const { applyCalibration } = await import('../../src/research/decision.mjs');
    const titles = ['ŠKODA FABIA II COMFORT 2008', 'Škoda Fabia 1.4 MPI 50kw nová STK', 'Škoda Fabia 2, LPG'];
    const out = applyCalibration({ label: 'used car', terms: [] }, { data: { not: [], subtype: { label: 'hatchback', models: ['Skoda Fabia II'], variants: [] } } }, titles);
    expect(out.subtype?.models).toEqual(['skoda fabia ii', 'skoda fabia']);
  });
});
