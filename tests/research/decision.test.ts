import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CASE_SIMILARITY_FLOOR, CaseBank, DecisionModeler, REFERENCE_CASE, UNAPPROVED_EXAMPLES, UTILITY_PRIOR, aggregate, applyCalibration, applyModel, calibrationPrompt, caseSimilarity, decisionPrompt, modelText, normalizeSample, planByModel, quoteStates, rankCases, verifyKind, withModelRules } from '../../src/research/decision.mjs';
import { foundationOf, strategyFor } from '../../src/research/strategy.mjs';
import { pickLetter } from '../helpers/fakes';

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
  const checklistReply = { items: [{ clause: 'sea', question: 'Is sea nearby?', hard: true, numeric: { measure: 'coastKm', op: '<=', value: 20, unit: 'km' } }] };

  it('asks several times with sampling, keeps the agreed criteria and records the case', async () => {
    const calls: { temperature: number; purpose: string }[] = [];
    const answers = [reply([sea, heat]), reply([sea]), null];
    const checklistAnswers = [checklistReply, checklistReply, checklistReply];
    let decisionCalls = 0;
    let checklistCalls = 0;
    const router = { complete: async (req: { temperature: number; purpose: string; task?: string; avoid?: string[]; messages: { role: string; content: string }[] }) => {
      if (req.task === 'concept-frame') return null;
      if (req.task === 'example-kind') return { provider: req.avoid?.length ? 'e2' : 'e1', data: { same: pickLetter(req as never, (text) => text === 'the same kind of item as the new question') } };
      calls.push(req);
      if (req.purpose === 'checklist') {
        const next = checklistAnswers.shift();
        checklistCalls++;
        if (!next) throw new Error('quota');
        return { provider: 'p', data: next };
      }
      const next = answers.shift();
      decisionCalls++;
      if (!next) throw new Error('quota');
      return next;
    } };
    const recorded: string[] = [];
    const cases = { retrieve: async () => [REFERENCE_CASE], record: async (id: string) => { recorded.push(id); } };
    const project: Record<string, unknown> = { id: 'p9', question, guidance: '', acceptance: { expected: '20 plots' } };
    const model = await new DecisionModeler({ router, cases }).build(project);
    expect(decisionCalls).toBe(3);
    expect(checklistCalls).toBe(3);
    expect(calls.every((c) => (c.purpose === 'decision-model' || c.purpose === 'checklist') && c.temperature > 0)).toBe(true);
    expect(model.criteria.map((c: { measure: string }) => c.measure)).toEqual(['coastKm']);
    expect(model.checklist).toBeDefined();
    expect(model.caseIds).toEqual([REFERENCE_CASE.id]);
    expect(recorded).toEqual(['p9']);
    expect(await new DecisionModeler({ router: { complete: async () => { throw new Error('no call expected'); } } }).build(project)).toBe(model);
  });

  it('keeps no model when fewer than two proposals came back', async () => {
    const router = { complete: async () => { throw new Error('down'); } };
    expect(await new DecisionModeler({ router }).build({ id: 'x', question })).toBeNull();
  });

  it('a rebuild with an empty aggregate keeps the stored kind and criteria', async () => {
    const stored = {
      kind: { label: 'used car', terms: ['hatchback'], not: ['parts'], verified: { titles: 10, matched: 5, share: 0.5 } },
      criteria: [{ measure: 'priceEur', op: '<=', value: 50000, quote: 'under 50000', source: 'question' }],
      noLimit: [],
      agreement: { samples: 3, majority: 2, proposed: 5, kept: 1 },
    };
    const answers = [
      { provider: 'p', data: { concept: 'c', kind: { label: '', terms: [] }, criteria: [] } },
      { provider: 'p', data: { concept: 'c', kind: { label: '', terms: [] }, criteria: [] } },
      { provider: 'p', data: { concept: 'c', kind: { label: '', terms: [] }, criteria: [] } },
    ];
    const router = {
      complete: async (req: { purpose: string }) => {
        if (req.purpose === 'checklist') return { provider: 'p', data: { items: [{ clause: 'sea', question: 'Is sea nearby?', hard: true, numeric: { measure: 'coastKm', op: '<=', value: 20, unit: 'km' } }] } };
        return answers.shift()!;
      }
    };
    const project = { id: 'p-rebuild', question, guidance: '', acceptance: { expected: '20 cars' }, decisionModel: stored };
    const model = await new DecisionModeler({ router }).build(project, { force: true });
    expect(model.kind).toEqual(stored.kind);
    expect(model.criteria).toEqual(stored.criteria);
    expect(model.rebuildWeaker).toBe(true);
  });

  it('a rebuild with fewer kept criteria keeps the stored criteria', async () => {
    const stored = {
      kind: { label: 'used car', terms: ['hatchback'], not: ['parts'] },
      criteria: [
        { measure: 'priceEur', op: '<=', value: 50000, quote: 'under 50000', source: 'question' },
        { measure: 'coastKm', op: '<=', value: 100, quote: 'within 100 km', source: 'guidance' },
      ],
      noLimit: [],
      agreement: { samples: 3, majority: 2, proposed: 5, kept: 2 },
    };
    const answers = [
      { provider: 'p', data: { concept: 'c', kind: { label: 'used car', terms: ['hatchback'] }, criteria: [{ measure: 'priceEur', op: '<=', value: 50000, quote: 'under 50000' }] } },
      { provider: 'p', data: { concept: 'c', kind: { label: 'used car', terms: ['hatchback'] }, criteria: [{ measure: 'priceEur', op: '<=', value: 50000, quote: 'under 50000' }] } },
      { provider: 'p', data: { concept: 'c', kind: { label: 'used car', terms: ['hatchback'] }, criteria: [{ measure: 'priceEur', op: '<=', value: 50000, quote: 'under 50000' }] } },
    ];
    const router = {
      complete: async (req: { purpose: string }) => {
        if (req.purpose === 'checklist') return { provider: 'p', data: { items: [{ clause: 'sea', question: 'Is sea nearby?', hard: true, numeric: { measure: 'coastKm', op: '<=', value: 20, unit: 'km' } }] } };
        return answers.shift()!;
      }
    };
    const project = { id: 'p-rebuild-2', question, guidance: '', acceptance: { expected: '20 cars' }, decisionModel: stored };
    const model = await new DecisionModeler({ router }).build(project, { force: true });
    expect(model.criteria).toEqual(stored.criteria);
    expect(model.rebuildWeaker).toBe(true);
  });

  it('a degenerate model (no kind and no criteria) is not recorded as a case', async () => {
    const recorded: string[] = [];
    const answers = [
      { provider: 'p', data: { concept: 'c', kind: { label: '', terms: [] }, criteria: [] } },
      { provider: 'p', data: { concept: 'c', kind: { label: '', terms: [] }, criteria: [] } },
      { provider: 'p', data: { concept: 'c', kind: { label: '', terms: [] }, criteria: [] } },
    ];
    const cases = { retrieve: async () => [], record: async (id: string) => { recorded.push(id); } };
    const router = {
      complete: async (req: { purpose: string }) => {
        if (req.purpose === 'checklist') return { provider: 'p', data: { items: [{ clause: 'sea', question: 'Is sea nearby?', hard: true, numeric: { measure: 'coastKm', op: '<=', value: 20, unit: 'km' } }] } };
        return answers.shift()!;
      }
    };
    const project = { id: 'p-degenerate', question, guidance: '', acceptance: { expected: '20 cars' } };
    await new DecisionModeler({ router, cases }).build(project, { force: true });
    expect(recorded).toEqual([]);
  });
});

describe('examples shown to the decision model: a similar question about the same kind of item, labelled as it is', () => {
  const stag = 'Find 40 activity providers in Durres (Albania) that a stag party of 8 to 15 men could book directly';
  type Ask = { purpose: string; task?: string; avoid?: string[]; messages: { role: string; content: string }[] };
  const exampleRouter = (same: (earlier: string) => boolean, providers = ['p1', 'p2', 'p3']) => {
    const calls: Ask[] = [];
    return {
      calls,
      async complete(req: Ask) {
        calls.push(req);
        const avoided = new Set(req.avoid ?? []);
        const provider = providers.find((id) => !avoided.has(id)) ?? providers[0];
        const answer = (data: unknown) => ({ provider, model: `${provider}-model`, data });
        if (req.task === 'concept-frame') return null;
        if (req.task === 'example-kind') {
          const earlier = /Earlier question: (.+)/.exec(req.messages[1].content)?.[1] ?? '';
          const wanted = same(earlier) ? 'the same kind of item as the new question' : 'a different kind of item';
          return answer({ same: pickLetter(req as never, (text) => text === wanted) });
        }
        if (req.purpose === 'checklist') return answer({ items: [{ clause: 'sea', question: 'Is the sea within 15 km?', hard: true, numeric: null }] });
        return answer({ concept: 'c', kind: { label: 'plot of land', terms: ['plot'] }, criteria: [sea] });
      },
    };
  };
  const decisionPrompts = (router: { calls: Ask[] }) => router.calls.filter((c) => c.purpose === 'decision-model').map((c) => c.messages.map((m) => m.content).join('\n'));

  it('never shows a case that shares only common words with the question: the glamping case is no example for a stag question', async () => {
    const router = exampleRouter(() => true);
    const model = await new DecisionModeler({ router, cases: new CaseBank() } as never).build({ id: 'stag', question: stag, guidance: '', acceptance: { expected: '40 providers' } }, { force: true });
    expect(decisionPrompts(router).length).toBeGreaterThan(0);
    expect(decisionPrompts(router).filter((text) => text.includes(REFERENCE_CASE.question))).toEqual([]);
    expect(model.caseIds).toEqual([]);
    expect(router.calls.filter((c) => c.task === 'example-kind')).toHaveLength(0);
    expect(rankCases(stag, [REFERENCE_CASE])).toEqual([]);
    expect(caseSimilarity(stag, REFERENCE_CASE.question)).toBeLessThan(CASE_SIMILARITY_FLOOR);
    expect(caseSimilarity('glamping plots near the sea', 'glamping plots near the sea in Spain')).toBe(1);
  });

  it('shows a similar case only when two provider families agree it asks for the same kind of item', async () => {
    const sheds = { id: 'garden-sheds', question: 'Find garden sheds for a glamping site near the sea under 30000 EUR', concept: 'sheds', kind: { label: 'garden shed', terms: ['shed'] }, criteria: [], approved: true, utility: 0.5 };
    const cases = { retrieve: async () => [REFERENCE_CASE, sheds], record: async () => {} };
    const router = exampleRouter((earlier) => earlier === REFERENCE_CASE.question);
    const model = await new DecisionModeler({ router, cases } as never).build({ id: 'q', question, guidance: '', acceptance: { expected: '20 plots' } }, { force: true });
    expect(decisionPrompts(router).every((text) => text.includes(REFERENCE_CASE.question) && !text.includes(sheds.question))).toBe(true);
    expect(model.caseIds).toEqual([REFERENCE_CASE.id]);
    const lone = exampleRouter(() => true, ['p1']);
    const alone = await new DecisionModeler({ router: lone, cases } as never).build({ id: 'q', question, guidance: '', acceptance: { expected: '20 plots' } }, { force: true });
    expect(decisionPrompts(lone).some((text) => text.includes(REFERENCE_CASE.question))).toBe(false);
    expect(alone.caseIds).toEqual([]);
  });

  it('labels an example nobody approved as such, never as approved', () => {
    const earlier = { id: 'earlier', question: 'Find plots near the sea for glamping', concept: 'c', kind: { label: 'plot of land', terms: ['plot'] }, criteria: [], approved: false };
    const alone = decisionPrompt({ question, examples: [earlier] })[1].content;
    expect(alone).not.toContain('Approved examples:');
    expect(alone.startsWith('Models built earlier for other questions, which nobody approved, so they may be wrong:\nQuestion: Find plots near the sea for glamping')).toBe(true);
    const both = decisionPrompt({ question, examples: [REFERENCE_CASE, earlier] })[1].content;
    expect(both).toContain(`Approved examples:\nQuestion: ${REFERENCE_CASE.question}`);
    expect(both).toContain(`${UNAPPROVED_EXAMPLES}:\nQuestion: ${earlier.question}`);
    expect(both.indexOf(earlier.question)).toBeGreaterThan(both.indexOf(UNAPPROVED_EXAMPLES));
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
    expect(out.kind).toEqual({ label: 'used car', terms: ['hatchback'], not: ['parts', 'kola', 'svetlo', 'pneumatiky'], condition: [], upgrades: [] });
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
    const { DecisionModeler, DECISION_MODEL_VERSION, CHECKLIST_VERSION } = await import('../../src/research/decision.mjs');
    const modeler = new DecisionModeler({ router: { complete: async () => null } } as never);
    const project = { question: 'q', guidance: '', decisionModel: { question: 'q', guidance: '', agreement: { samples: 3 }, kind: { label: 'thing', terms: ['thing'] }, version: DECISION_MODEL_VERSION, checklistVersion: CHECKLIST_VERSION - 1, framing: { samples: 3 } } };
    expect(modeler.fresh(project)).toBe(false);
    expect(modeler.fresh({ ...project, decisionModel: { ...project.decisionModel, checklistVersion: CHECKLIST_VERSION } })).toBe(true);
  });

  it('treats a current model with no kind and no criteria as stale so the next run tries again', async () => {
    const { DecisionModeler, DECISION_MODEL_VERSION, CHECKLIST_VERSION } = await import('../../src/research/decision.mjs');
    const modeler = new DecisionModeler({ router: { complete: async () => null } } as never);
    const empty = { question: 'q', guidance: '', version: DECISION_MODEL_VERSION, checklistVersion: CHECKLIST_VERSION, agreement: { samples: 3 }, kind: { label: '', terms: [] }, criteria: [], noLimit: [], framing: { samples: 3 } };
    expect(modeler.fresh({ question: 'q', guidance: '', decisionModel: empty })).toBe(false);
    expect(modeler.fresh({ question: 'q', guidance: '', decisionModel: { ...empty, criteria: [{ measure: 'priceEur', op: '<=', value: 1 }] } })).toBe(true);
  });
});

describe('the concept feeds the decision model', () => {
  const proposal = { concept: 'c', kind: { label: 'seller', terms: ['seller'] }, criteria: [], needs: [], purpose: '', value: '', unmodelled: [] };
  const written = { items: [{ clause: 'graded a', question: 'Is it graded A?', hard: true, numeric: null }] };
  const frame = { population: { quote: 'sellers of coats', label: 'seller' }, concept: [{ quote: 'proven quality', text: 'quality is proven', examples: [] }] };
  const routerWith = (framed: unknown) => ({ complete: async (req: { purpose: string; task?: string }) => ({ provider: 'test', model: 'm', data: req.task === 'concept-frame' ? framed : req.purpose === 'checklist' ? written : proposal }) });
  const router = routerWith(frame);
  const question = 'Find sellers of coats, proven quality';

  it('frames again, and only frames, a current model whose framing failed, and keeps that model while the framing keeps failing', async () => {
    const { DecisionModeler } = await import('../../src/research/decision.mjs');
    const calls: string[] = [];
    let framed: unknown = { concept: [{ quote: 'not in the request', text: 'x' }] };
    const counting = { complete: async (req: { purpose: string; task?: string }) => { calls.push(req.task ?? req.purpose); return { provider: 'test', model: 'm', data: req.task === 'concept-frame' ? framed : req.purpose === 'checklist' ? written : proposal }; } };
    const modeler = new DecisionModeler({ router: counting } as never);
    const project: Record<string, any> = { id: 'p', question, guidance: '', acceptance: { itemCount: 20, expected: '20 links' } };
    await modeler.build(project);
    expect(project.decisionModel.framing).toBeNull();
    expect(project.decisionModel.checklist.map((c: { clause: string }) => c.clause)).toEqual(['graded a']);
    expect(modeler.fresh(project)).toBe(false);
    calls.length = 0;
    const kept = project.decisionModel;
    expect(await modeler.build(project)).toBe(kept);
    expect([...new Set(calls)]).toEqual(['concept-frame']);
    framed = frame;
    calls.length = 0;
    const model = await modeler.build(project);
    expect(calls).not.toContain('decision-model');
    expect(calls).not.toContain('checklist');
    expect(model.requirements.map((r: { quote: string }) => r.quote)).toEqual(['proven quality']);
    expect(model.checklist.map((c: { role: string; clause: string; items: Array<{ hard: boolean }> }) => [c.role, c.clause, c.items[0].hard])).toEqual([['eligibility', 'quality is proven', true], ['appraisal', 'graded a', false]]);
    expect(model.kind).toMatchObject({ label: 'seller', asked: 'sellers of coats' });
    expect(model.version).toBe(kept.version);
    expect(modeler.fresh(project)).toBe(true);
  });

  it('builds the hard checks from the requirements of the asker, asks the asker about a part no family placed, and keeps the model-written question as appraisal', async () => {
    const { DecisionModeler } = await import('../../src/research/decision.mjs');
    const project: Record<string, any> = { id: 'p', question, guidance: 'graded A', acceptance: { itemCount: 20, expected: '20 links' } };
    const model = await new DecisionModeler({ router } as never).build(project);
    expect(model.checklist.map((c: { role: string; clause: string; items: Array<{ hard: boolean }> }) => [c.role, c.clause, c.items[0].hard])).toEqual([['eligibility', 'quality is proven', true], ['appraisal', 'graded a', false]]);
    expect(model.requirements.map((r: { id: string; quote: string; unframed?: boolean }) => [r.id, r.quote, Boolean(r.unframed)])).toEqual([['E1', 'proven quality', false]]);
    expect(model.framing.open.map((r: { id: string; quote: string }) => `${r.id} ${r.quote}`)).toEqual(['Q1 20 links']);
    expect(modelText(model)).toContain('[Q1] to confirm with you: Is "20 links" a condition each result must meet?');
    expect(model.kind).toMatchObject({ label: 'seller', asked: 'sellers of coats', described: 'Find sellers of coats', examples: [] });
    expect(model.framing.population.quote).toBe('sellers of coats');
    expect(model.missing).toEqual(['Find sellers of coats']);
    expect(modelText(model)).toContain('[E1] must: quality is proven');
  });

  it('is stale when the expected result changes, and keeps the model-written checklist when no model frames the request', async () => {
    const { DecisionModeler } = await import('../../src/research/decision.mjs');
    const modeler = new DecisionModeler({ router } as never);
    const project: Record<string, any> = { id: 'p', question, guidance: '', acceptance: { itemCount: 20, expected: '' } };
    await modeler.build(project);
    expect(modeler.fresh(project)).toBe(true);
    expect(modeler.fresh({ ...project, acceptance: { itemCount: 20, expected: 'recently posted' } })).toBe(false);
    const plain: Record<string, any> = { id: 'q', question, guidance: '', acceptance: { itemCount: 20 } };
    const model = await new DecisionModeler({ router: routerWith({ concept: [{ quote: 'not in the request', text: 'x' }] }) } as never).build(plain);
    expect(model.requirements).toEqual([]);
    expect(model.framing).toBeNull();
    expect(model.checklist.map((c: { clause: string; items: Array<{ hard: boolean }> }) => [c.clause, c.items[0].hard])).toEqual([['graded a', true]]);
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

describe('condition words from real titles', () => {
  it('keeps condition words a majority names and the titles contain', async () => {
    const { applyCalibration, mergeCalibrations } = await import('../../src/research/decision.mjs');
    const titles = ['Honda Civic 1.6 na doježdění', 'Škoda Fabia havarovaná', 'Kia Rio 1.4 nová STK'];
    const reply = (condition: string[]) => ({ data: { not: [], condition, subtype: { label: 'hatchback', models: ['kia rio'], variants: [] } } });
    const merged = mergeCalibrations([reply(['na doježdění', 'havarovaná']), reply(['na doježdění', 'havarovaná', 'nepojízdné']), reply(['nepojízdné'])]);
    expect(applyCalibration({ label: 'used car', terms: [] }, merged, titles).kind.condition.sort()).toEqual(['havarovana', 'na dojezdeni']);
  });
});

describe('2026-11-12 engine audit: the stored car research 0c750f', () => {
  const carQuestion = 'Find accurate and verified car listings on available marketplaces for at least 20 cars as fit and up to 80 as a trade off to purchase within 300km from prague, hatchback, with highest price/value ratio, considering the engines informations, usage trends and empirical data and all important details of the particular car, considering the professional and car enthusiast trustful sources and communities, with all the crucial metrics considered, price up to 65000CZK or equivalent';
  const carModels = ['kia rio', 'citroen c3', 'honda civic', 'peugeot 207', 'hyundai i10', 'kia picanto', 'ford fiesta', 'prodam citroen c1', 'prodam citroen', 'honda jazz', 'dacia sandero', 'toyota yaris', 'seat ibiza', 'skoda fabia ii', 'skoda fabia', 'skoda felicia'];
  const storedCar = () => ({
    concept: 'Verified hatchback cars near Prague',
    kind: { label: 'used car', terms: ['hatchback'], not: ['parts', 'accessories', 'kola'], verified: { titles: 3277, matched: 8, share: 0 }, dropped: [] },
    criteria: [],
    noLimit: [],
    missing: [],
    agreement: { samples: 3, majority: 2, proposed: 1, kept: 0 },
    version: 2,
    question: carQuestion,
    guidance: '',
    subtype: { label: 'hatchback', models: [...carModels], variants: [], source: 'model proposal, matched to listing titles by code' },
    calibrated: '2026-11-03T13:21:54.199Z',
  });
  const proposal = { concept: 'Verified hatchback cars near Prague', purpose: '', value: '', needs: [], kind: { label: 'used car', terms: ['hatchback'], not: ['parts', 'accessories'] }, criteria: [], unmodelled: [] };
  const router = { complete: async () => ({ provider: 'groq', data: proposal }) };

  it('a rebuild after a hint keeps the calibrated sub-type', async () => {
    const project: Record<string, any> = { id: 'find-accurate-and-verified-car-l-0c750f', question: carQuestion, guidance: 'prefer petrol engines', acceptance: { itemCount: 20 }, decisionModel: storedCar() };
    const modeler = new DecisionModeler({ router } as never);
    expect(modeler.fresh(project)).toBe(false);
    await modeler.build(project);
    expect(project.decisionModel.guidance).toBe('prefer petrol engines');
    expect(project.decisionModel.subtype.models).toHaveLength(16);
    expect(project.decisionModel.calibrated).toBe('2026-11-03T13:21:54.199Z');
    expect(project.decisionModel.kind.not).toEqual(['parts', 'accessories', 'kola']);
    expect(project.decisionModel.kind.verified).toEqual({ titles: 3277, matched: 8, share: 0 });
  });

  it('a rebuild after a hint keeps the kind validated on pages, and drops it all when the kind changes', async () => {
    const supplierQuestion = 'Find the wholesale branded second hand clothing providers with certain similar to Ralph Lauren, Monclair, North face, Barbour with highest price/value ratio, proven good quality, assortiment for the appropriate retail second hand shop business in Czech Republic';
    const validated = { pages: 10, terms: ['wholesale used clothing', 'second hand clothes', 'used clothing wholesale'], at: '2026-11-05T02:04:03.161Z' };
    const kind = { label: 'wholesale clothing provider', terms: [...validated.terms], not: ['retail', 'maloobchod', 'donation', 'consignment'], verified: null, hubs: ['czech republic'], validated };
    const reply = { provider: 'groq', data: { ...proposal, concept: 'Wholesale branded second‑hand clothing providers for a Czech retail shop', kind: { label: 'wholesale clothing provider', terms: ['second hand clothes'], not: ['retail'] } } };
    const project: Record<string, any> = { id: 'find-the-wholesale-branded-secon-b2f5b7', question: supplierQuestion, guidance: 'NL, DE, UK, IT, PL, LT', acceptance: { itemCount: 20 }, decisionModel: { version: 2, question: supplierQuestion, guidance: '', agreement: { samples: 3 }, kind } };
    await new DecisionModeler({ router: { complete: async () => reply } } as never).build(project);
    expect(project.decisionModel.kind.validated).toEqual(validated);
    expect(project.decisionModel.kind.hubs).toEqual(['czech republic']);
    expect(project.decisionModel.kind.terms).toEqual(expect.arrayContaining(validated.terms));
    const other: Record<string, any> = { id: 'find-accurate-and-verified-car-l-0c750f', question: carQuestion, guidance: 'prefer petrol engines', acceptance: { itemCount: 20 }, decisionModel: storedCar() };
    await new DecisionModeler({ router: { complete: async () => ({ provider: 'groq', data: { ...proposal, kind: { label: 'car wheel', terms: ['kola'], not: [] } } }) } } as never).build(other);
    expect(other.decisionModel.subtype).toBeUndefined();
    expect(other.decisionModel.calibrated).toBeUndefined();
    expect(other.decisionModel.kind.not).toBeUndefined();
  });

  it('a limit is never taken from an unapproved case or another question', () => {
    const plots = {
      id: 'find-appropriate-plots-to-buy-fo-b7772e',
      question: 'Find appropriate plots to buy for glamping business, but also with the strong price increase trend, very low enterance investments, 20000EUR max, 10 month a year, mild climate to have Glampings so no air condition, nearby sea or the ocean accessible by ebike',
      approved: false,
      criteria: [{ id: 'priceEur', measure: 'priceEur', op: '<=', value: 20000, source: 'question', quote: '20000EUR max', clause: '20000EUR max', votes: 3 }],
    };
    const price = { clause: 'price up to 65000CZK or equivalent', measure: 'priceEur', op: '<=', value: null, quote: '' };
    const samples = [normalizeSample({ ...proposal, criteria: [price] }), normalizeSample({ ...proposal, criteria: [price] }), normalizeSample({ ...proposal, criteria: [price] })];
    const model = aggregate(samples, { question: carQuestion, cases: [plots] });
    expect(model.criteria).toEqual([]);
    expect(model.noLimit[0].measure).toBe('priceEur');
    expect(aggregate(samples, { question: carQuestion, cases: [{ ...plots, approved: true }] }).criteria).toEqual([]);
    expect(aggregate(samples, { question: carQuestion, cases: [REFERENCE_CASE] }).criteria).toEqual([]);
    const own = { id: 'find-accurate-and-verified-car-l-0c750f', question: carQuestion, approved: true, criteria: [{ id: 'priceEur', measure: 'priceEur', op: '<=', value: 2700, source: 'eurostat' }] };
    expect(aggregate(samples, { question: carQuestion, cases: [own], id: own.id }).criteria).toEqual([]);
    expect(aggregate(samples, { question: carQuestion, cases: [own], id: 'which-trendy-used-cars-priced-20-b4f648' }).criteria[0]).toMatchObject({ value: 2700, source: 'case find-accurate-and-verified-car-l-0c750f (eurostat)' });
  });

  it('a research is never its own example', async () => {
    const own = { id: 'find-accurate-and-verified-car-l-0c750f', question: carQuestion, criteria: [], utility: 0.5 };
    expect(rankCases(carQuestion, [own, REFERENCE_CASE], 2, own.id).map((c: { id: string }) => c.id)).not.toContain(own.id);
    expect(rankCases(carQuestion, [own], 2).map((c: { id: string }) => c.id)).toEqual([own.id]);
    const bank = new CaseBank();
    bank.cases = [own];
    const project: Record<string, any> = { id: own.id, question: carQuestion, guidance: '', acceptance: { itemCount: 20 } };
    await new DecisionModeler({ router, cases: bank } as never).build(project);
    expect(project.decisionModel.caseIds).not.toContain(own.id);
  });

  it('a title prefix is not a model', () => {
    const titles = ['Prodám Citroen Saxo 1,4 VTS', 'Prodám Citroen C4 1,4 + LPG', 'Prodam citroen c3', 'Prodám Citroen C1', 'Škoda Fabia 2, LPG', 'ŠKODA FABIA II COMFORT 2008', 'Škoda Felicia 1.3'];
    const out = applyCalibration({ label: 'used car', terms: ['hatchback'] }, { data: { not: [], subtype: { label: 'hatchback', models: ['citroen c3', 'prodam citroen c1', 'skoda fabia ii', 'skoda felicia'], variants: [] } } }, titles);
    expect(out.subtype?.models).not.toContain('prodam citroen');
    expect(out.subtype?.models).toEqual(['citroen c3', 'prodam citroen c1', 'skoda fabia ii', 'skoda fabia', 'skoda felicia']);
  });

  it('a word that titles of the asked model use is not an exclusion', () => {
    const cars = ['Kia Rio, 1.1 CRDI 55KW klima,2x kola', 'Honda Civic 2,2 CTDi"103kW"+ Al kola 17 l'];
    const wheels = ['Alu kola 16" Škoda Karoq', 'Letni kola + disky škoda oct 1', 'Prodám alu kola DEZENT 5x112r17', 'Alu kola XTREME 20'];
    const reply = { data: { not: ['kola', 'disky'], subtype: { label: 'hatchback', models: ['kia rio', 'honda civic'], variants: [] } } };
    const kind = { label: 'used car', terms: ['hatchback'], not: ['parts', 'accessories', 'kola'] };
    expect(applyCalibration(kind, reply, [...cars, ...wheels]).kind.not).toEqual(['parts', 'accessories', 'kola']);
    expect(applyCalibration(kind, reply, [...cars, ...wheels], { itemTitles: cars }).kind.not).toEqual(['parts', 'accessories']);
    expect(applyCalibration(kind, reply, [...cars, ...wheels], { itemTitles: wheels }).kind.not).toEqual(['parts', 'accessories', 'kola']);
  });
});
