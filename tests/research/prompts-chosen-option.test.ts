import { describe, expect, it } from 'vitest';
import { synthesizePrompt } from '../../src/research/prompts.mjs';

describe('synthesizePrompt chosen option', () => {
  const baseNodes = [
    { id: 'D1', parentId: 'Q', status: 'verified', question: 'Driver 1', finding: { answer: 'Answer 1' } },
    { id: 'D2', parentId: 'Q', status: 'verified', question: 'Driver 2', finding: { answer: 'Answer 2' } },
  ];

  it('contains "chosen" in the JSON shape for decision kind', () => {
    const prompt = synthesizePrompt({
      question: 'Test question',
      decision: 'Test decision',
      successCriteria: 'Test criteria',
      template: { decisionRule: 'Test rule' },
      constraints: {},
      nodes: baseNodes,
      expected: 'a decision',
      kind: 'decision',
    });
    const userContent = prompt[1].content;
    expect(userContent).toContain('"chosen":"exact option text from options"');
    expect(userContent).toContain('Also return "chosen": the exact "option" text of that option.');
  });

  it('contains "chosen" in the JSON shape for plan kind (shared JSON shape)', () => {
    const prompt = synthesizePrompt({
      question: 'Test question',
      decision: 'Test decision',
      successCriteria: 'Test criteria',
      template: { decisionRule: 'Test rule' },
      constraints: {},
      nodes: baseNodes,
      expected: 'a plan',
      kind: 'plan',
    });
    const userContent = prompt[1].content;
    expect(userContent).toContain('"chosen":"exact option text from options"');
    expect(userContent).not.toContain('Also return "chosen": the exact "option" text of that option.');
  });

  it('contains "chosen" in the JSON shape for estimate kind (shared JSON shape)', () => {
    const prompt = synthesizePrompt({
      question: 'Test question',
      decision: 'Test decision',
      successCriteria: 'Test criteria',
      template: { decisionRule: 'Test rule' },
      constraints: {},
      nodes: baseNodes,
      expected: 'an estimate',
      kind: 'estimate',
    });
    const userContent = prompt[1].content;
    expect(userContent).toContain('"chosen":"exact option text from options"');
    expect(userContent).not.toContain('Also return "chosen": the exact "option" text of that option.');
  });

  it('contains "chosen" in the JSON shape for list kind (shared JSON shape)', () => {
    const prompt = synthesizePrompt({
      question: 'Test question',
      decision: 'Test decision',
      successCriteria: 'Test criteria',
      template: { decisionRule: 'Test rule' },
      constraints: {},
      nodes: baseNodes,
      expected: 'a list',
      kind: 'list',
    });
    const userContent = prompt[1].content;
    expect(userContent).toContain('"chosen":"exact option text from options"');
    expect(userContent).not.toContain('Also return "chosen": the exact "option" text of that option.');
  });
});