import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HALF_LIFE_MS, OutcomeBook, betaSample, decayed, priorOf } from '../../src/llm/outcomes.mjs';
import { purposePlan, rankRole } from '../../src/llm/ranking.mjs';

function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

describe('outcome book: did the answer pass the gates', () => {
  it('halves old outcomes every half-life, so routing follows models that change', () => {
    expect(decayed(8, HALF_LIFE_MS)).toBe(4);
    expect(decayed(8, 0)).toBe(8);
  });

  it('starts from a weak prior that a few real outcomes override', () => {
    let now = 0;
    const book = new OutcomeBook({ now: () => now });
    expect(priorOf(5)).toEqual({ a: 3.8, b: expect.closeTo(0.2, 5) });
    expect(book.posterior('gemini', 'research', 5).mean).toBeCloseTo(0.95, 2);
    for (let i = 0; i < 10; i++) book.record({ provider: 'gemini', purposeClass: 'research', passed: false });
    for (let i = 0; i < 10; i++) book.record({ provider: 'pollinations', purposeClass: 'research', passed: true });
    expect(book.posterior('gemini', 'research', 5).mean).toBeLessThan(0.3);
    expect(book.posterior('pollinations', 'research', 2).mean).toBeGreaterThan(0.8);
    now = HALF_LIFE_MS;
    expect(book.posterior('gemini', 'research', 5).observed).toBeCloseTo(5, 5);
  });

  it('draws Beta samples that average to the posterior mean', () => {
    const rng = seeded(11);
    const draws = Array.from({ length: 4000 }, () => betaSample(3, 7, rng));
    expect(draws.reduce((s, x) => s + x, 0) / draws.length).toBeCloseTo(0.3, 1);
    expect(draws.every((x) => x > 0 && x < 1)).toBe(true);
  });

  it('keeps its counts on disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-outcomes-'));
    const file = path.join(dir, 'outcomes.json');
    const book = await new OutcomeBook({ file, now: () => 1000 }).load();
    book.record({ provider: 'groq', purposeClass: 'research', passed: true });
    await book.writing;
    const again = await new OutcomeBook({ file, now: () => 1000 }).load();
    expect(again.posterior('groq', 'research', 4).observed).toBeCloseTo(1, 3);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('routing by gate outcomes', () => {
  const providers = [
    { id: 'gemini', label: 'Gemini', state: 'ready', deep: 'g', fast: 'g' },
    { id: 'pollinations', label: 'Pollinations', state: 'ready', deep: 'p', fast: 'p' },
  ];
  const stats = { gemini: { calls: 20, ok: 19, failed: 1, rateLimited: 0, reliability: 0.9, medianMs: { deep: 3000, fast: 2000 } }, pollinations: { calls: 20, ok: 19, failed: 1, rateLimited: 0, reliability: 0.9, medianMs: { deep: 3000, fast: 2000 } } };

  it('puts the hand-rated strongest model first only until graded answers say otherwise', () => {
    const book = new OutcomeBook({ now: () => 1000 });
    const before = purposePlan({ providers, stats, enabled: ['gemini', 'pollinations'], outcomes: book, rng: seeded(3) });
    expect(before.reserved).toBe('gemini');
    for (let i = 0; i < 30; i++) book.record({ provider: 'gemini', purposeClass: 'top', passed: false });
    for (let i = 0; i < 30; i++) book.record({ provider: 'pollinations', purposeClass: 'top', passed: true });
    const after = purposePlan({ providers, stats, enabled: ['gemini', 'pollinations'], outcomes: book, rng: seeded(3) });
    expect(after.reserved).toBe('pollinations');
    expect(after.byPurpose.synthesize[0]).toBe('pollinations');
  });

  it('explains each place by the gate pass rate it has measured', () => {
    const book = new OutcomeBook({ now: () => 1000 });
    for (let i = 0; i < 4; i++) book.record({ provider: 'gemini', purposeClass: 'research', passed: i < 3 });
    const rows = rankRole({ role: 'deep', strategy: 'balanced', providers, stats, outcomes: book, rng: seeded(5) });
    expect(rows.find((r: { id: string }) => r.id === 'gemini').why).toContain('answers passed the gates');
    expect(rows.find((r: { id: string }) => r.id === 'pollinations').why).toContain('no graded answers yet: prior 2/5');
  });
});
