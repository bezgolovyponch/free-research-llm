import { TASK_MARKERS } from '../research/prompts.mjs';

const DRIVERS = [
  ['Demand', 'How large and stable is demand for this?'],
  ['Costs', 'What does it cost end to end?'],
  ['Rules', 'Which legal or regulatory constraints apply?'],
  ['Risks', 'What can go wrong and how likely is it?'],
];

function lastUser(messages) {
  const content = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  return Array.isArray(content) ? content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : content;
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

function evidenceLines(prompt) {
  const evidence = between(prompt, 'EVIDENCE', 'RULES:');
  return [...evidence.matchAll(/^\[([A-Z]\d+(?:\.\d+)?)\][^\n]*\n([^\n]+)/gm)].map((m) => ({ id: m[1], quote: m[2].trim().split(/\s+/).slice(0, 12).join(' ') })).filter((e) => e.quote.split(' ').length >= 3);
}

function research(prompt) {
  const node = between(prompt, 'SUB-QUESTION ', ':');
  const isCalc = /method: calculation/.test(prompt);
  const quoted = evidenceLines(prompt).slice(0, 2);
  const claims = quoted.length
    ? quoted.map((e) => ({ text: `The source states: ${e.quote}`, value: null, unit: '', sourceIds: [e.id], quote: e.quote, assumption: false }))
    : [{ text: 'No evidence was retrieved for this piece', value: null, unit: '', sourceIds: [], quote: '', assumption: true }];
  return {
    answer: isCalc ? `DEMO answer for ${node}: margin 300 EUR from 1200 minus 900.` : `DEMO answer for ${node}: the cited sources state the baseline (see claims).`,
    claims,
    reasoning: 'C1 and C2 give the baseline; the calculation turns it into the margin.',
    ...(isCalc ? { calculation: { formula: 'price - cost', inputs: { price: { value: 1200, unit: 'EUR' }, cost: { value: 900, unit: 'EUR' } }, result: 300, unit: 'EUR' } } : {}),
    confidence: quoted.length >= 2 ? 'medium' : 'low',
    assumptions: ['DEMO data'],
    gaps: ['connect a real model'],
  };
}

function rollup(prompt) {
  const children = [...between(prompt, 'SUB-FINDINGS:', 'Combine').matchAll(/^(\S+) \[[^\]]*\][^\n]*\n\s*-> ([^\n]+)/gm)].map((m) => ({ id: m[1], answer: m[2].trim() }));
  const claims = children.slice(0, 3).map((c) => {
    const quote = c.answer.split(/\s+/).slice(0, 8).join(' ');
    return { text: `${c.id} says: ${quote}`, sourceIds: [c.id], quote, assumption: false };
  });
  return { answer: `DEMO roll-up of ${children.map((c) => c.id).join(', ')}: positive margin.`, claims, reasoning: 'Every sub-finding points the same way.', confidence: 'medium', assumptions: [], gaps: [] };
}

const RESPONDERS = {
  [TASK_MARKERS.decompose]: decompose,
  [TASK_MARKERS.expand]: (prompt) => {
    const id = between(prompt, 'Node to break down further: ', ' —');
    return { nodes: [{ id: `${id}.a`, parentId: id, title: 'Supplier prices', question: 'What do the main suppliers charge per unit?', method: 'lookup' }, { id: `${id}.b`, parentId: id, title: 'Demand growth', question: 'How fast is local demand growing per year?', method: 'lookup' }] };
  },
  [TASK_MARKERS.research]: research,
  [TASK_MARKERS.critique]: () => ({ agree: true, severity: 'none', issues: [], betterAnswer: '' }),
  [TASK_MARKERS.rollup]: rollup,
  [TASK_MARKERS.chat]: (prompt) => {
    const wantsRerun = /USER(?: REQUEST[^:]*)?: .*(re-?research|again)/i.test(prompt);
    const node = between(prompt, 'NODE ', ' [');
    return { reply: `DEMO assistant: noted.${wantsRerun && node ? ` Re-researching ${node}.` : ''}`, actions: wantsRerun && node ? [{ type: 'rerun', nodeId: node, hint: 'demo hint' }] : [] };
  },
  [TASK_MARKERS.resultsChat]: (prompt) => ({ reply: `DEMO results assistant: ${/MEMO VERDICT: (.*)/.exec(prompt)?.[1]?.slice(0, 60) ?? 'no memo yet'}.`, actions: [] }),
  [TASK_MARKERS.suggest]: (prompt) => {
    const ids = sourceIds(prompt.replace('EVIDENCE:', 'EVIDENCE\n').replace('JSON shape', 'RULES:'));
    return { suggestions: [
      { title: 'Demand check', question: 'How many buyers search for this each month?', why: 'sizes demand', method: 'lookup', searchQueries: ['monthly demand'], sourceIds: ids.slice(0, 1), quote: '' },
      { title: 'Cost check', question: 'What is the all-in cost per unit?', why: 'sets margin', method: 'calculation', searchQueries: ['unit cost'], sourceIds: [], quote: '' },
    ] };
  },
  [TASK_MARKERS.appChat]: (prompt) => {
    const wantsChange = /USER: .*(run button|change the|add a button|make the)/i.test(prompt);
    if (wantsChange) return { reply: 'DEMO app assistant: here is the change ticket; choose Claude Code or the free models below.', actions: [{ type: 'change', title: 'Green Run button', request: 'Make the Run button green in the header', desired: 'The Run button is green in the running app', tests: ['e2e/features.spec.ts'], area: 'UI', engine: 'claude' }] };
    const wantsNew = /USER: .*(start|new research)/i.test(prompt);
    return { reply: `DEMO app assistant: ${wantsNew ? 'press the button below to start this research.' : 'here is what I see.'}`, actions: wantsNew ? [{ type: 'create', question: 'Which e-bike rental size breaks even in Prague?', expected: 'break-even fleet size' }] : [] };
  },
  [TASK_MARKERS.variant]: () => ({ change: 'DEMO: sharper search queries', searchQueries: ['demo sharper query'] }),
  [TASK_MARKERS.synthesize]: () => ({
    verdict: 'GO-IF (DEMO) — margin stays above 0 after real costs are confirmed',
    confidence: 'low',
    bestEstimate: { value: '300', unit: 'EUR net margin per unit (DEMO)', low: '120', high: '450', basis: 'D2.2' },
    summary: 'This is DEMO output from a scripted model so you can see the full flow. Connect a free model (Setup tab) to get real research.',
    keyNumbers: [{ label: 'Net margin per unit', value: '300', unit: 'EUR', nodeId: 'D2.2' }],
    scenarios: [{ name: 'base', assumptions: 'demo numbers', outcome: '300 EUR margin' }],
    sensitivity: [{ variable: 'cost', effect: 'cost above 1200 EUR flips to NO-GO' }],
    risks: ['demo data is not real'],
    openQuestions: ['which model provider will you connect?'],
    nextSteps: [{ step: 'Connect a free model', why: 'real research needs a real model', how: 'Setup tab → paste a Groq or Gemini key' }],
    actions: [{ action: 'DEMO: confirm real costs before committing', why: 'margin rests on D2.2', nodeIds: ['D2.2'], impact: 4, horizon: '0-1 months' }, { action: 'DEMO: test demand with two listings', why: 'D1 is the weakest driver', nodeIds: ['D1'], impact: 3, horizon: '1-2 months' }],
    options: [{ option: 'GO', support: ['D2.2'], against: ['D1'] }, { option: 'NO-GO', support: ['D1'], against: ['D2.2'] }],
  }),
};

export class ScriptedProvider {
  constructor({ id = 'demo', failures = {} } = {}) {
    this.id = id;
    this.label = 'Demo (scripted, not a real model)';
    this.state = 'ready';
    this.selected = { fast: 'scripted-fast', deep: 'scripted-deep', vision: 'scripted-vision' };
    this.failures = failures;
    this.calls = [];
  }

  get ready() {
    return true;
  }

  canServe() {
    return true;
  }

  async chat({ messages, tier = 'fast' }) {
    const prompt = lastUser(messages);
    const marker = Object.keys(RESPONDERS).find((m) => prompt.includes(m));
    this.calls.push({ marker, tier });
    if (this.failures[marker]?.length) throw this.failures[marker].shift();
    if (marker === TASK_MARKERS.readFile) return { content: 'DEMO reading: a file with the total 2,345 EUR.', model: this.selected[tier], provider: this.id, usage: {} };
    const data = marker ? RESPONDERS[marker](prompt) : { answer: 'ok' };
    return { content: JSON.stringify(data), model: this.selected[tier], provider: this.id, usage: {} };
  }

  describe() {
    return { id: this.id, label: this.label, state: 'ready', detail: 'scripted demo responses', configured: true, fast: this.selected.fast, deep: this.selected.deep, local: true, keyEnv: null, signup: '', modelCount: 2 };
  }
}
