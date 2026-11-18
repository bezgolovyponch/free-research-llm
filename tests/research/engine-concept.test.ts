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
