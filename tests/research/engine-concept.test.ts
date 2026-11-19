import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResearchEngine } from '../../src/research/engine.mjs';
import { DecisionModeler } from '../../src/research/decision.mjs';
import { ProjectStore } from '../../src/store.mjs';

let dir = '';
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-concept-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const question = 'Find 20 sellers of coats like Alpha Coats, Betula, cheapest first';
const frame = { population: { quote: 'sellers of coats', label: 'seller' }, concept: [{ quote: 'coats like Alpha Coats, Betula', text: 'sells coats of makers like the named ones', examples: ['Alpha Coats', 'Betula'] }], limits: [{ quote: '20 sellers' }], ranks: [{ quote: 'cheapest first', text: 'lowest price' }] };
const proposal = { concept: 'c', kind: { label: 'seller', terms: ['seller'] }, criteria: [], needs: [], purpose: 'A shop wants sellers so that it can stock coats', value: 'a list', unmodelled: [] };
const written = { items: [{ clause: 'bulk', question: 'Does it sell in bulk?', hard: true, numeric: null }] };
const pages = [
  { url: 'https://one.example/a', title: 'One', text: 'A seller of coats is a shop that sells coats in bulk. Shops stock Alpha Coats, Betula and Cedar Wear on the same rail.' },
  { url: 'https://two.example/b', title: 'Two', text: 'A seller of coats is a store that sells coats in bulk. Collectors group Cedar Wear with Betula.' },
];
const findings = (id: string, quote: string) => [
  { aspect: 'object', statement: 'a seller of coats is a shop', quote: `A seller of coats is a ${id === 'D1' ? 'shop' : 'store'} that sells coats in bulk.`, sourceId: id },
  { aspect: 'terms', statement: 'sells coats in bulk', quote: `A seller of coats is a ${id === 'D1' ? 'shop' : 'store'} that sells coats in bulk.`, sourceId: id },
  { aspect: 'members', statement: 'Cedar Wear', quote, sourceId: id, member: 'Cedar Wear' },
  { aspect: 'evidence', statement: 'the page lists the makers it stocks', quote, sourceId: id, criterion: 'E1' },
];

function engineFor(framed: unknown, seen: string[] = []) {
  const counts: Record<string, number> = {};
  const router = {
    counts,
    complete: async (request: { task?: string; purpose?: string; messages: Array<{ content: string }> }) => {
      const text = request.messages.map((message) => message.content).join('\n');
      const key = request.task ?? request.purpose ?? '';
      counts[key] = (counts[key] ?? 0) + 1;
      if (request.task === 'concept-frame') return { provider: 'p1', model: 'm', data: framed };
      if (text.includes('TASK=DOMAIN_QUERIES')) {
        seen.push(text);
        return { provider: 'p1', data: { queries: ['Alpha Coats Betula sellers', 'coat sellers list'] } };
      }
      if (text.includes('TASK=DOMAIN_FINDINGS')) {
        seen.push(text);
        return { provider: 'p1', data: { findings: [...findings('D1', 'Shops stock Alpha Coats, Betula and Cedar Wear on the same rail.'), ...findings('D2', 'Collectors group Cedar Wear with Betula.')] } };
      }
      if (request.purpose === 'checklist') return { provider: 'p1', data: written };
      if (request.purpose === 'decision-model') return { provider: 'p1', data: proposal };
      return null;
    },
  };
  const engine = new ResearchEngine({ router: router as never, search: { search: async () => pages } as never, store: new ProjectStore({ dir }), modeler: new DecisionModeler({ router } as never) });
  return { engine, router };
}

const project = (extra: Record<string, unknown> = {}) => ({ id: 'find-twenty-sellers-a1b2c3', question, guidance: '', templateId: 'generic', acceptance: { itemCount: 20, expected: '' }, nodes: [], log: [], ...extra });

describe('the decision model holds every requirement of the request', () => {
  it('frames the request inside the decision model, once: the kind in the words of the asker, the class with its examples, what ranks apart', async () => {
    const { engine, router } = engineFor(frame);
    const p: Record<string, any> = project();
    await engine.ensureDecisionModel(p);
    expect(p.concept).toBeUndefined();
    expect(p.decisionModel.kind).toMatchObject({ label: 'seller', asked: 'sellers of coats' });
    expect(p.decisionModel.requirements.map((r: { id: string; quote: string }) => `${r.id} ${r.quote}`)).toEqual(['E1 coats like Alpha Coats, Betula']);
    expect(p.decisionModel.framing.ranks.map((r: { quote: string }) => r.quote)).toEqual(['cheapest first']);
    expect(p.decisionModel.checklist.map((c: { role: string; items: Array<{ hard: boolean }> }) => [c.role, c.items[0].hard])).toEqual([['eligibility', true], ['appraisal', false]]);
    expect(p.log.some((e: { message: string }) => e.message.startsWith('requirements judged by meaning, from your words: Each result is: sellers of coats · [E1] must: sells coats of makers like the named ones'))).toBe(true);
    expect(engine.briefOf(p).text).toContain("[E1] must: sells coats of makers like the named ones (the asker's examples of the class: Alpha Coats, Betula; a similar member counts)");
    const calls = router.counts['concept-frame'];
    await engine.ensureDecisionModel(p);
    expect(router.counts['concept-frame']).toBe(calls);
  });

  it('puts a part of the request no provider family could place among the questions for the asker, never among the page checks', async () => {
    const { engine } = engineFor(frame);
    const p: Record<string, any> = project({ question: 'Find 20 sellers of coats like Alpha Coats, Betula, cheapest first, open on sundays', assumptionsToConfirm: ['an earlier question'] });
    await engine.ensureDecisionModel(p);
    expect(p.decisionModel.framing.open.map((r: { quote: string }) => r.quote)).toEqual(['open on sundays']);
    expect(p.decisionModel.checklist.map((c: { clause: string }) => c.clause)).not.toContain('open on sundays');
    expect(p.assumptionsToConfirm).toEqual(['an earlier question', 'Is "open on sundays" a condition each result must meet? If it is, say in Hints how a result shows it.']);
  });

  it('says so and keeps the model-written checklist when no model frames the request in the words of the asker', async () => {
    const { engine } = engineFor({ concept: [{ quote: 'not in the request', text: 'x' }] });
    const p: Record<string, any> = project();
    await engine.ensureDecisionModel(p);
    expect(p.decisionModel.requirements).toEqual([]);
    expect(p.decisionModel.checklist.map((c: { clause: string; items: Array<{ hard: boolean }> }) => [c.clause, c.items[0].hard])).toEqual([['bulk', true]]);
    expect(p.log.some((e: { type: string; message: string }) => e.type === 'warn' && e.message.startsWith('no model framed the request in your own words'))).toBe(true);
  });
});

describe('the domain study starts from the examples in the decision model', () => {
  it('learns the other members of their class and what a page shows, gives both to the brief, and studies again only when the examples change', async () => {
    const seen: string[] = [];
    const { engine } = engineFor(frame, seen);
    const p: Record<string, any> = project({ domain: { ready: true, terms: ['old'] } });
    expect(await engine.studyDomain(p)).toBe(true);
    expect(seen[0]).toContain('EXAMPLES THE ASKER NAMED:\nAlpha Coats, Betula');
    expect(seen[0]).toContain('WHAT EACH RESULT IS:\nsellers of coats, seller');
    expect(seen[1]).toContain('Aspect "members"');
    expect(p.domain.members).toEqual([expect.objectContaining({ name: 'Cedar Wear', hosts: ['one.example', 'two.example'], supported: true })]);
    expect(p.domain.examples).toEqual(['Alpha Coats', 'Betula']);
    expect(Object.keys(p.domain.evidence)).toEqual(['E1']);
    expect(p.log.some((e: { message: string }) => e.message === 'class learned from your examples (Alpha Coats, Betula): Cedar Wear (2 sites)')).toBe(true);
    const text = engine.briefOf(p).text;
    expect(text).toContain('Learned from sources, members of the class your examples stand for: Cedar Wear');
    expect(text).toContain('Learned from sources, what the page of an eligible result states: [E1] "Shops stock Alpha Coats, Betula and Cedar Wear on the same rail."');
    const calls = seen.length;
    expect(await engine.studyDomain(p)).toBe(true);
    expect(seen).toHaveLength(calls);
  });
});
