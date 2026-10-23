import { describe, expect, it } from 'vitest';
import { TEMPLATES, suggestTemplate, templateById } from '../../src/research/templates.mjs';

describe('templates', () => {
  it.each([
    ['Create an action plan to beat our two main competitors in the EU', 'competitive-strategy'],
    ['Is it profitable to buy used RAV4 hybrids in Germany and sell them in Poland?', 'generic'],
    ['Where should I build a glamping site with 6 tents?', 'glamping-location'],
    ['Flat-rate tax or s.r.o. for a freelancer in Czechia?', 'taxes'],
    ['How big is the market for e-bike rentals in Prague?', 'market-sizing'],
    ['Should I open a bakery?', 'generic'],
  ])('routes "%s" to %s', (question, expected) => {
    expect(suggestTemplate(question)).toBe(expected);
  });

  it('falls back to generic for unknown ids and gives every template fields and a decision rule', () => {
    expect(templateById('nope').id).toBe('generic');
    for (const t of TEMPLATES) {
      expect(t.fields.length).toBeGreaterThan(0);
      expect(t.decisionRule).toBeTruthy();
    }
  });
});

describe('glamping template investment logic', () => {
  it('keeps cheap raw land in scope and judges plots by purchase plus preparation cost', () => {
    const t = templateById('glamping-location');
    expect(t.drivers).toMatch(/cheap raw land that needs work \(it is in scope/);
    expect(t.drivers).toMatch(/site preparation .*clearing, levelling/);
    expect(t.metrics).toMatch(/all-in cost \(purchase \+ preparation\)/);
    expect(t.decisionRule).toMatch(/all-in cost .* suitability after that work/);
  });
});

