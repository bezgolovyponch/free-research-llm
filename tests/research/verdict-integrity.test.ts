import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcceptanceChecker } from '../../src/research/acceptance.mjs';
import { verdict, verdictInvariants, acceptanceSummaryOf } from '../../src/research/verdict.mjs';
import { ResearchEngine, ResearchCancelled } from '../../src/research/engine.mjs';
import fixture from '../fixtures/verdict-0c750f.json';

describe('verdict integrity fixes', () => {
  describe('evaluate with checklist and no checks: items not-judged, never confirmed', () => {
    it('evaluate returns not-judged for items without checks when checklist exists', async () => {
      const checker = new AcceptanceChecker({
        readPage: async () => ({ text: 'page text', status: 200, links: [] }),
      });
      const spec = { itemCount: 5, urlsLive: true, valueRange: null, unit: '', mustMention: [] };
      const checklist = [
        { clause: 'c', items: [{ id: 'check1', hard: true, question: 'q1' }] }
      ];
      const items = [
        { url: 'https://example.com/1', live: true, listing: true, inRange: null, purpose: [] },
        { url: 'https://example.com/2', live: true, listing: true, inRange: null, purpose: [] },
      ];

      const result = await checker.evaluate(spec, items, { checklist, purpose: [] });

      expect(result).not.toBeNull();
      expect(result!.validCount).toBe(0);
      expect(result!.items.every(i => i.tier === 'not-judged')).toBe(true);
      expect(result!.verdict.tiers.notJudged).toBe(2);
    });
  });

  describe('invariants flag mismatches', () => {
    it('flags count check of 1.0 with validCount 0', () => {
      const project = {
        acceptance: { itemCount: 20 },
        checklist: [{ clause: 'c', items: [{ id: 'check1', hard: true, question: 'q1' }] }],
        acceptanceResult: {
          items: [
            { url: '1', checks: [{ id: 'c|q1', answer: 'unknown', hard: true }], qualifies: true },
          ],
          validCount: 0,
          checks: [
            { id: 'count', label: 'At least 20 valid items', value: 1.0, passed: true },
            { id: 'checklist-c|q1', label: 'Checklist: c', value: 0, passed: false },
          ],
          score: 0.5,
        },
      };
      const reasons = verdictInvariants(project);
      expect(reasons.some(r => r.includes('count check value mismatch'))).toBe(true);
    });

    it('flags memo/summary mismatch', () => {
      const project = {
        acceptance: { itemCount: 20 },
        checklist: [{ clause: 'c', items: [{ id: 'check1', hard: true, question: 'q1' }] }],
        acceptanceResult: {
          items: [
            { url: '1', checks: [{ id: 'c|q1', answer: 'yes', hard: true }], qualifies: true },
          ],
          validCount: 1,
          checks: [
            { id: 'count', label: 'At least 20 valid items', value: 0.05, passed: false },
            { id: 'checklist-c|q1', label: 'Checklist: c', value: 1, passed: true },
          ],
          score: 0.525,
        },
        acceptanceSummary: '1 of 20 confirmed',
        report: {
          verdict: 'PROVISIONAL (acceptance: 0 of 20 confirmed · 19 to confirm) — some memo text',
        },
      };
      const reasons = verdictInvariants(project);
      expect(reasons.some(r => r.includes('memo acceptance text mismatch'))).toBe(true);
    });

    it('flags score mismatch', () => {
      const project = {
        acceptance: { itemCount: 20 },
        checklist: [{ clause: 'c', items: [{ id: 'check1', hard: true, question: 'q1' }] }],
        acceptanceResult: {
          items: [
            { url: '1', checks: [{ id: 'c|q1', answer: 'yes', hard: true }], qualifies: true },
          ],
          validCount: 1,
          checks: [
            { id: 'count', label: 'At least 20 valid items', value: 0.05, passed: false },
            { id: 'checklist-c|q1', label: 'Checklist: c', value: 1, passed: true },
          ],
          score: 1.0,
        },
      };
      const reasons = verdictInvariants(project);
      expect(reasons.some(r => r.includes('score mismatch'))).toBe(true);
    });
  });

  describe('replay on real cars fixture', () => {
    it('verdict from fixture gives correct validCount and summary', () => {
      const { acceptance, checklist, acceptanceResult } = fixture;
      const result = verdict(acceptanceResult.items, acceptance, checklist);

      expect(result.validCount).toBe(1);
      expect(result.summary).toContain('1 of 20 confirmed');
      expect(result.tiers.confirmed).toBe(1);
    });

    it('acceptanceSummaryOf matches verdict summary', () => {
      const project = {
        acceptance: fixture.acceptance,
        checklist: fixture.checklist,
        acceptanceResult: fixture.acceptanceResult,
        decisionModel: { kind: { label: 'used car', terms: ['hatchback'] } },
      };
      const summary = acceptanceSummaryOf(project);
      expect(summary).toContain('1 of 20 confirmed');
    });
  });

  describe('cancellation', () => {
    it('throwIfCancelled throws ResearchCancelled when project is cancelled', () => {
      const engine = new ResearchEngine({
        router: null,
        search: null,
        store: {
          get: vi.fn().mockResolvedValue({
            id: 'test-1',
            question: 'test question',
            templateId: 'default',
            acceptance: { itemCount: 5, urlsLive: true, valueRange: null, unit: '', mustMention: [] },
            nodes: [],
            log: [],
          }),
          save: vi.fn().mockResolvedValue({}),
          newId: () => 'test-1',
          cache: new Map(),
        },
        onEvent: vi.fn(),
        onStop: vi.fn(),
      });

      engine.quiet.add('test-1');
      const project = { id: 'test-1' };
      engine.cancel('test-1');
      expect(() => engine.throwIfCancelled(project)).toThrow(ResearchCancelled);
    });
  });

  describe('start() with error', () => {
    it('sets phase failed, emits log line with error message', async () => {
      const engine = new ResearchEngine({
        router: null,
        search: null,
        store: {
          get: vi.fn().mockResolvedValue({
            id: 'test-2',
            question: 'test question',
            templateId: 'default',
            acceptance: { itemCount: 5, urlsLive: true, valueRange: null, unit: '', mustMention: [] },
            nodes: [],
            log: [],
          }),
          save: vi.fn().mockResolvedValue({}),
          newId: () => 'test-2',
          cache: new Map(),
        },
        onEvent: vi.fn(),
        onStop: vi.fn(),
      });

      const runSpy = vi.spyOn(engine, 'run').mockRejectedValue(new Error('boom'));

      engine.start('test-2', {});

      await new Promise(resolve => setTimeout(resolve, 50));

      const project = await engine.load('test-2');
      expect(project.phase).toBe('failed');
      expect(project.error).toBe('boom');
      expect(engine.onEvent).toHaveBeenCalledWith(
        'test-2',
        expect.objectContaining({
          type: 'phase',
          message: expect.stringContaining('research failed: boom'),
        }),
        expect.any(Object)
      );
    });
  });

  describe('progress logging during judging', () => {
    it('emits acceptance log every 10 judged pages', async () => {
      const engine = new ResearchEngine({
        router: null,
        search: { readPage: vi.fn() },
        store: {
          get: vi.fn().mockResolvedValue({
            id: 'test-3',
            question: 'test question',
            templateId: 'default',
            acceptance: { itemCount: 30, urlsLive: true, valueRange: null, unit: '', mustMention: [] },
            decisionModel: { kind: { label: 'used car', terms: ['hatchback'] }, checklist: [{ clause: 'c', items: [{ id: 'check1', hard: true, question: 'q1' }] }] },
            checklist: [{ clause: 'c', items: [{ id: 'check1', hard: true, question: 'q1' }] }],
            nodes: [],
            log: [],
          }),
          save: vi.fn().mockResolvedValue({}),
          newId: () => 'test-3',
          cache: new Map(),
        },
        onEvent: vi.fn(),
        onStop: vi.fn(),
      });

      const project = await engine.load('test-3');
      project.report = { deliverables: [] };
      project.candidates = {
        found: 30,
        keptCount: 30,
        toCheckCount: 0,
        screenedCount: 0,
        kept: (() => { const arr = []; for (let i = 0; i < 30; i++) arr.push({ url: 'https://example.com/' + i, title: 'Item ' + i, value: 1000, unit: 'EUR' }); return arr; })(),
        toCheck: [],
        screened: {},
        tiers: { fits: 0, 'trade-off': 0, unverified: 0, weak: 0, blocked: 0 },
        verification: null,
        sites: { trends: {} }
      };
      project.checklist = [{ clause: 'c', items: [{ id: 'check1', hard: true, question: 'q1' }] }];
      project.decisionModel = { kind: { label: 'used car', terms: ['hatchback'] }, checklist: [{ clause: 'c', items: [{ id: 'check1', hard: true, question: 'q1' }] }] };

      engine.search.readPage.mockResolvedValue({ text: 'page text', status: 200, links: [] });

      engine.checklistJudge.judge = vi.fn().mockResolvedValue([
        { id: 'c|q1', answer: 'yes', hard: true, clause: 'c' }
      ]);

      await engine.checkAcceptance(project, null);

      const acceptanceLogs = engine.onEvent.mock.calls
        .filter(([_, event]) => event.type === 'acceptance')
        .map(([_, event]) => event.message);

      expect(acceptanceLogs.some(msg => msg.includes('judging pages: 10 judged'))).toBe(true);
      expect(acceptanceLogs.some(msg => msg.includes('judging pages: 20 judged'))).toBe(true);
      expect(acceptanceLogs.some(msg => msg.includes('judging pages: 30 judged'))).toBe(true);
    });

    it('a cancel during judging stops the loop before the remaining pages are judged', async () => {
      const engine = new ResearchEngine({
        router: null,
        search: { readPage: vi.fn() },
        store: {
          get: vi.fn().mockResolvedValue({
            id: 'test-3',
            question: 'test question',
            templateId: 'default',
            acceptance: { itemCount: 30, urlsLive: true, valueRange: null, unit: '', mustMention: [] },
            decisionModel: { kind: { label: 'used car', terms: ['hatchback'] }, checklist: [{ clause: 'c', items: [{ id: 'check1', hard: true, question: 'q1' }] }] },
            checklist: [{ clause: 'c', items: [{ id: 'check1', hard: true, question: 'q1' }] }],
            nodes: [],
            log: [],
          }),
          save: vi.fn().mockResolvedValue({}),
          newId: () => 'test-3',
          cache: new Map(),
        },
        onEvent: vi.fn(),
        onStop: vi.fn(),
      });

      const project = await engine.load('test-3');
      project.report = { deliverables: [] };
      project.candidates = {
        found: 30,
        keptCount: 30,
        toCheckCount: 0,
        screenedCount: 0,
        kept: (() => { const arr = []; for (let i = 0; i < 30; i++) arr.push({ url: 'https://example.com/' + i, title: 'Item ' + i, value: 1000, unit: 'EUR' }); return arr; })(),
        toCheck: [],
        screened: {},
        tiers: { fits: 0, 'trade-off': 0, unverified: 0, weak: 0, blocked: 0 },
        verification: null,
        sites: { trends: {} }
      };
      project.checklist = [{ clause: 'c', items: [{ id: 'check1', hard: true, question: 'q1' }] }];
      project.decisionModel = { kind: { label: 'used car', terms: ['hatchback'] }, checklist: [{ clause: 'c', items: [{ id: 'check1', hard: true, question: 'q1' }] }] };

      engine.search.readPage.mockResolvedValue({ text: 'page text', status: 200, links: [] });

      let calls = 0;
      engine.checklistJudge.judge = vi.fn().mockImplementation(async () => {
        calls += 1;
        if (calls === 5) engine.cancel(project.id);
        return [{ id: 'c|q1', answer: 'yes', hard: true, clause: 'c' }];
      });
      engine.quiet.add(project.id);

      await expect(engine.checkAcceptance(project, null)).rejects.toBeInstanceOf(ResearchCancelled);
      expect(calls).toBe(5);
    });
  });
});