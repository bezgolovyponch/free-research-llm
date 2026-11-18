import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResearchEngine } from '../../src/research/engine.mjs';
import { ProjectStore } from '../../src/store.mjs';
import { fakeRouter } from '../helpers/fakes';

let dir = '';
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-concept-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const project = (extra: Record<string, unknown> = {}) => ({ id: 'find-twenty-things-a1b2c3', question: 'Find 20 things', guidance: 'a hint', acceptance: { itemCount: 20 }, log: [], ...extra });

describe('ensureConcept', () => {
  const frame = { population: { quote: 'red things', label: 'thing' }, concept: [{ quote: 'made of wood', text: 'is made of wood', examples: [] }], ranks: [{ quote: 'cheapest', text: 'lowest price' }] };
  const asked = () => project({ question: 'Find 20 red things made of wood, cheapest first', decisionModel: { kind: { label: 'object', terms: ['thing'] } } });

  it('frames the concept from the words of the asker before the decision model, once, and the kind is asked in those words', async () => {
    const router = fakeRouter({ 'concept-frame': frame });
    const engine = new ResearchEngine({ router: router as never, search: { search: async () => [] } as never, store: new ProjectStore({ dir }) });
    const p: Record<string, any> = asked();
    await engine.ensureDecisionModel(p);
    expect(p.concept.population.quote).toBe('red things');
    expect(p.concept.criteria.map((c: { quote: string }) => c.quote)).toEqual(['made of wood']);
    expect(p.concept.ranks.map((r: { quote: string }) => r.quote)).toEqual(['cheapest']);
    expect(p.decisionModel.kind).toMatchObject({ label: 'object', asked: 'red things' });
    expect(p.log.some((e: { message: string }) => e.message.startsWith('concept framed from your words (3 sample(s)): Each result is: red things · [E1] must: is made of wood'))).toBe(true);
    const calls = router.count('concept-frame');
    await engine.ensureDecisionModel(p);
    expect(router.count('concept-frame')).toBe(calls);
    expect(engine.briefOf(p).text).toContain('[E1] must: is made of wood');
  });

  it('says so and keeps going when no model frames the request', async () => {
    const engine = new ResearchEngine({ router: fakeRouter({}) as never, search: { search: async () => [] } as never, store: new ProjectStore({ dir }) });
    const p: Record<string, any> = asked();
    await engine.ensureDecisionModel(p);
    expect(p.concept).toBeUndefined();
    expect(p.decisionModel.kind.asked).toBeUndefined();
    expect(p.log.some((e: { type: string; message: string }) => e.type === 'warn' && e.message.startsWith('concept not framed'))).toBe(true);
  });

  it('frames nothing for a research that lists no items', async () => {
    const router = fakeRouter({ 'concept-frame': frame });
    const engine = new ResearchEngine({ router: router as never, search: { search: async () => [] } as never, store: new ProjectStore({ dir }) });
    await engine.ensureConcept(project({ acceptance: {} }));
    expect(router.count('concept-frame')).toBe(0);
  });
});

describe('studyDomain with a concept', () => {
  const frame = { population: { quote: 'sellers', label: 'seller' }, concept: [{ quote: 'coats like Alpha Coats, Betula', text: 'sells coats of makers like the named ones', examples: ['Alpha Coats', 'Betula'] }] };
  const pages = [
    { url: 'https://one.example/a', title: 'One', text: 'A seller of coats is a shop that sells coats in bulk. Shops stock Alpha Coats, Betula and Cedar Wear on the same rail.' },
    { url: 'https://two.example/b', title: 'Two', text: 'A seller of coats is a store that sells coats in bulk. Collectors group Cedar Wear with Betula.' },
  ];
  const findings = (id: string, member: string, quote: string) => [
    { aspect: 'object', statement: 'a seller of coats is a shop', quote: `A seller of coats is a ${id === 'D1' ? 'shop' : 'store'} that sells coats in bulk.`, sourceId: id },
    { aspect: 'terms', statement: 'sells coats in bulk', quote: `A seller of coats is a ${id === 'D1' ? 'shop' : 'store'} that sells coats in bulk.`, sourceId: id },
    { aspect: 'members', statement: member, quote, sourceId: id, member },
  ];

  function engineFor(seen: string[]) {
    const router = {
      complete: async (request: { task?: string; messages: Array<{ content: string }> }) => {
        const text = request.messages.map((message) => message.content).join('\n');
        if (request.task === 'concept-frame') return { provider: 'p1', model: 'm', data: frame };
        if (text.includes('TASK=DOMAIN_QUERIES')) {
          seen.push(text);
          return { provider: 'p1', data: { queries: ['Alpha Coats Betula sellers', 'coat sellers list'] } };
        }
        if (text.includes('TASK=DOMAIN_FINDINGS')) {
          seen.push(text);
          return { provider: 'p1', data: { findings: [...findings('D1', 'Cedar Wear', 'Shops stock Alpha Coats, Betula and Cedar Wear on the same rail.'), ...findings('D2', 'Cedar Wear', 'Collectors group Cedar Wear with Betula.')] } };
        }
        return null;
      },
    };
    return new ResearchEngine({ router: router as never, search: { search: async () => pages } as never, store: new ProjectStore({ dir }) });
  }

  it('starts the study from the examples, learns the other members of their class and studies again when the concept is new', async () => {
    const seen: string[] = [];
    const engine = engineFor(seen);
    const p: Record<string, any> = project({ question: 'Find 20 sellers of coats like Alpha Coats, Betula', nodes: [], domain: { ready: true, terms: ['old'] } });
    expect(await engine.studyDomain(p)).toBe(true);
    expect(seen[0]).toContain('EXAMPLES THE ASKER NAMED:\nAlpha Coats, Betula');
    expect(seen[1]).toContain('Aspect "members"');
    expect(p.domain.members).toEqual([expect.objectContaining({ name: 'Cedar Wear', hosts: ['one.example', 'two.example'], supported: true })]);
    expect(p.domain.conceptAt).toBe(p.concept.at);
    expect(p.log.some((e: { message: string }) => e.message === 'class learned from your examples (Alpha Coats, Betula): Cedar Wear (2 sites)')).toBe(true);
    const calls = seen.length;
    expect(await engine.studyDomain(p)).toBe(true);
    expect(seen).toHaveLength(calls);
  });
});
