import { TASK_MARKERS } from '../research/prompts.mjs';

const DRIVERS = [
  ['Demand', 'How large and stable is demand for this?'],
  ['Costs', 'What does it cost end to end?'],
  ['Rules', 'Which legal or regulatory constraints apply?'],
  ['Risks', 'What can go wrong and how likely is it?'],
];

function lastUser(messages) {
  return [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
}

function between(textValue, start, end) {
  const i = textValue.indexOf(start);
  if (i < 0) return '';
  const rest = textValue.slice(i + start.length);
  const j = end ? rest.indexOf(end) : -1;
  return (j >= 0 ? rest.slice(0, j) : rest).trim();
}

function decompose(prompt) {
  const question = between(prompt, 'QUESTION (the decision to support):', 'CONSTRAINTS:').split('\n')[0] || 'the question';
  const nodes = [];
  DRIVERS.forEach(([title, q], i) => {
    const id = `D${i + 1}`;
    nodes.push({ id, parentId: null, title, question: `${q} (${question.slice(0, 80)})`, why: 'drives the decision', hypothesis: 'unknown', metric: title.toLowerCase(), unit: '', method: 'lookup', searchQueries: [`${title} ${question.slice(0, 60)}`], dependsOn: [], impact: 5 - i, uncertainty: 3 });
    nodes.push({ id: `${id}.1`, parentId: id, title: `${title}: baseline number`, question: `What is the baseline ${title.toLowerCase()} figure?`, why: 'anchors the estimate', hypothesis: '', metric: 'value', unit: 'EUR', method: 'lookup', searchQueries: [`${title} baseline`], dependsOn: [], impact: 4, uncertainty: 4 });
    nodes.push({ id: `${id}.2`, parentId: id, title: `${title}: margin check`, question: `What margin results from the ${title.toLowerCase()} baseline?`, why: 'turns facts into a decision number', hypothesis: '', metric: 'margin', unit: 'EUR', method: 'calculation', searchQueries: [`${title} margin`], dependsOn: [`${id}.1`], impact: 3, uncertainty: 3 });
  });
  return { decision: `Decide: ${question}`, successCriteria: 'net margin > 0 in the base case', assumptionsToConfirm: ['DEMO: replace with a real model to get real research'], nodes };
}

function sourceIds(prompt) {
  const evidence = between(prompt, 'EVIDENCE', 'RULES:');
  return [...new Set([...evidence.matchAll(/^\[([A-Z]\d+(?:\.\d+)?)\]/gm)].map((m) => m[1]))];
}

function research(prompt) {
  const ids = sourceIds(prompt);
  const node = between(prompt, 'SUB-QUESTION ', ':');
  const isCalc = /method: calculation/.test(prompt);
  const cite = ids.slice(0, 2);
  return {
    answer: `DEMO answer for ${node}: baseline 1200 EUR, margin 300 EUR.`,
    claims: [
      { text: 'Baseline value is 1200 EUR', value: 1200, unit: 'EUR', sourceIds: cite, assumption: cite.length === 0 },
      { text: 'Costs are 900 EUR', value: 900, unit: 'EUR', sourceIds: cite, assumption: cite.length === 0 },
    ],
    ...(isCalc ? { calculation: { formula: 'price - cost', inputs: { price: { value: 1200, unit: 'EUR' }, cost: { value: 900, unit: 'EUR' } }, result: 300, unit: 'EUR' } } : {}),
    confidence: cite.length >= 2 ? 'medium' : 'low',
    assumptions: ['DEMO data'],
    gaps: ['connect a real model'],
  };
}

const RESPONDERS = {
  [TASK_MARKERS.decompose]: decompose,
  [TASK_MARKERS.expand]: (prompt) => {
    const id = between(prompt, 'Node to break down further: ', ' —');
    return { nodes: [{ id: `${id}.a`, parentId: id, title: 'Sub-part A', question: 'What is sub-part A?', method: 'lookup' }, { id: `${id}.b`, parentId: id, title: 'Sub-part B', question: 'What is sub-part B?', method: 'lookup' }] };
  },
  [TASK_MARKERS.research]: research,
  [TASK_MARKERS.critique]: () => ({ agree: true, severity: 'none', issues: [], betterAnswer: '' }),
  [TASK_MARKERS.rollup]: (prompt) => {
    const ids = [...between(prompt, 'SUB-FINDINGS:', 'Combine').matchAll(/^(\S+) \[/gm)].map((m) => m[1]);
    return { answer: `DEMO roll-up of ${ids.join(', ')}: positive margin of 300 EUR.`, claims: [{ text: 'Margin 300 EUR per unit', sourceIds: ids, assumption: false }], confidence: 'medium', assumptions: [], gaps: [] };
  },
  [TASK_MARKERS.synthesize]: () => ({
    verdict: 'GO-IF (DEMO) — margin stays above 0 after real costs are confirmed',
    confidence: 'low',
    summary: 'This is DEMO output from a scripted model so you can see the full flow. Connect a free model (Setup tab) to get real research.',
    keyNumbers: [{ label: 'Net margin per unit', value: '300', unit: 'EUR', nodeId: 'D2.2' }],
    scenarios: [{ name: 'base', assumptions: 'demo numbers', outcome: '300 EUR margin' }],
    sensitivity: [{ variable: 'cost', effect: 'cost above 1200 EUR flips to NO-GO' }],
    risks: ['demo data is not real'],
    openQuestions: ['which model provider will you connect?'],
    nextSteps: [{ step: 'Connect a free model', why: 'real research needs a real model', how: 'Setup tab → paste a Groq or Gemini key' }],
  }),
};

export class ScriptedProvider {
  constructor({ id = 'demo', failures = {} } = {}) {
    this.id = id;
    this.label = 'Demo (scripted, not a real model)';
    this.state = 'ready';
    this.selected = { fast: 'scripted-fast', deep: 'scripted-deep' };
    this.failures = failures;
    this.calls = [];
  }

  get ready() {
    return true;
  }

  async chat({ messages, tier = 'fast' }) {
    const prompt = lastUser(messages);
    const marker = Object.keys(RESPONDERS).find((m) => prompt.includes(m));
    this.calls.push({ marker, tier });
    if (this.failures[marker]?.length) throw this.failures[marker].shift();
    const data = marker ? RESPONDERS[marker](prompt) : { answer: 'ok' };
    return { content: JSON.stringify(data), model: this.selected[tier], provider: this.id, usage: {} };
  }

  describe() {
    return { id: this.id, label: this.label, state: 'ready', detail: 'scripted demo responses', configured: true, fast: this.selected.fast, deep: this.selected.deep, local: true, paid: false, keyEnv: null, signup: '', modelCount: 2 };
  }
}
