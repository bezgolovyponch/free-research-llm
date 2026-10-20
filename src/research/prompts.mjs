import { MAX_NODES, METHODS } from './tree.mjs';
import { resultModel } from './result.mjs';


const SYSTEM = 'You are a rigorous research analyst. You decompose questions MECE-style, use only evidence you are given, label every assumption, show calculations as formulas, and never invent sources, URLs or numbers. You reply with a single JSON object only.';

export const TASK_MARKERS = {
  decompose: 'TASK=DECOMPOSE',
  expand: 'TASK=EXPAND',
  research: 'TASK=RESEARCH',
  critique: 'TASK=CRITIQUE',
  rollup: 'TASK=ROLLUP',
  synthesize: 'TASK=SYNTHESIZE',
  variant: 'TASK=IMPROVE_NODE',
  chat: 'TASK=NODE_CHAT',
  suggest: 'TASK=SUGGEST_SUBISSUES',
  appChat: 'TASK=APP_CHAT',
  resultsChat: 'TASK=RESULTS_CHAT',
  readFile: 'TASK=READ_FILE',
};

function constraintsText(constraints = {}) {
  const lines = Object.entries(constraints).filter(([, v]) => String(v ?? '').trim()).map(([k, v]) => `- ${k}: ${v}`);
  return lines.length ? lines.join('\n') : '- none stated (choose sensible defaults and list them as assumptions)';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function decomposePrompt({ question, template, constraints, dataSummary, expected }) {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${TASK_MARKERS.decompose}
Today is ${today()}.

QUESTION (the decision to support):
${question}

CONSTRAINTS:
${constraintsText(constraints)}

EXPECTED RESULT (what the user wants delivered at the end):
${expected || 'not stated — a decision memo'}

DOMAIN PLAYBOOK (${template.label}) — use as a checklist, adapt to the question:
- typical drivers: ${template.drivers}
- typical metrics: ${template.metrics}
- typical sources: ${template.sources}
- decision rule: ${template.decisionRule}
${dataSummary ? `\nUSER DATA AVAILABLE (source id D1):\n${dataSummary}\n` : ''}
Build an issue tree that answers the QUESTION:
1. "decision": restate the decision in one sentence; "successCriteria": the measurable threshold that answers it.
1b. First think of 4-5 different PERSPECTIVES on the question (e.g. a customer who buys it, a competitor's product lead, an investor, a regulator, a domain scientist), as in Stanford's STORM. The drivers must cover different perspectives, not one checklist.
2. 3-6 top-level DRIVERS (parentId null): mutually exclusive, together exhaustive for the decision.
2b. Every leaf names concrete entities from the question (companies, products, places, models) and asks what public evidence can show: their own pages, papers, code, pricing pages, press releases, partnerships, job posts, customer case studies. Never make a leaf that asks for a private company's internal figures (revenue, cash burn, customer count, market share, break-even): put those in "assumptionsToConfirm" for the user.
3. Under each driver 2-4 LEAF sub-questions (parentId = driver id), each answerable by one lookup, calculation, comparison, estimate or data analysis. Max ${MAX_NODES} nodes total.
4. Every node: id (drivers "D1".."D6", leaves "D1.1" etc.), title (<=8 words), question (specific, with geography/time/units), why (how the answer moves the decision), hypothesis (your prior guess; research will not see it), metric, unit, method (one of ${METHODS.join('|')}), searchQueries (2-3 precise web queries that name the entities, never generic how-to queries; include country language terms when useful), dependsOn (ids of OTHER nodes whose answer this needs, e.g. a margin calculation depends on price leaves), impact 1-5 (effect on the decision), uncertainty 1-5 (how unknown it is today).
5. "assumptionsToConfirm": things the user must confirm.
5b. "acceptance": machine-checkable criteria taken ONLY from the EXPECTED RESULT: itemCount (number of items/links wanted, else null), urlsLive (true if links are wanted), valueRange ([min,max] if items must have a value such as a price in a range, else null), unit (e.g. EUR), mustMention (words every delivered page must contain, else []).

5c. "sourceUrls" per node (optional, max 2): exact public pages that answer it directly, e.g. an official statistics table, a company's pricing page or a search page with the filters in the URL. Only well-known real sites; never guess deep IDs.
6. Be brief: every text field at most 15 words, 1-2 searchQueries per node, compact JSON without indentation. List drivers first, then their leaves.

JSON shape:
{"decision":"","successCriteria":"","assumptionsToConfirm":[""],"acceptance":{"itemCount":null,"urlsLive":false,"valueRange":null,"unit":"","mustMention":[]},"nodes":[{"id":"D1","parentId":null,"title":"","question":"","why":"","hypothesis":"","metric":"","unit":"","method":"lookup","searchQueries":[""],"sourceUrls":[],"dependsOn":[],"impact":3,"uncertainty":3}]}`,
    },
  ];
}

export function expandPrompt({ question, node, hint }) {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${TASK_MARKERS.expand}
Overall question: ${question}
Node to break down further: ${node.id} — ${node.question}
${hint ? `User guidance: ${hint}\n` : ''}Return 2-4 sub-questions that together fully answer the node. Use ids "${node.id}.a", "${node.id}.b", ... and parentId "${node.id}".
JSON shape: {"nodes":[{"id":"","parentId":"${node.id}","title":"","question":"","why":"","hypothesis":"","metric":"","unit":"","method":"lookup","searchQueries":[""],"dependsOn":[],"impact":3,"uncertainty":3}]}`,
    },
  ];
}

const LINKS_PER_SOURCE = 15;

function linksBlock(links = []) {
  if (!links.length) return '';
  return `\nLINKS on this page:\n${links.slice(0, LINKS_PER_SOURCE).map((l) => `- ${l.text} <${l.url}>`).join('\n')}`;
}

function sourcesBlock(sources) {
  if (!sources.length) return 'NO SOURCES were retrieved. Use general knowledge only, mark every number as "assumption": true, and set confidence "low".';
  return sources.map((s) => `[${s.id}] ${s.title}${s.url ? ` <${s.url}>` : ''}\n${String(s.text || s.snippet || '').slice(0, 2200)}${linksBlock(s.links)}`).join('\n\n');
}

function upstreamBlock(upstream) {
  if (!upstream.length) return 'none';
  return upstream.map((u) => `${u.id} (${u.status}): ${u.answer}${u.keyNumbers ? ` | numbers: ${u.keyNumbers}` : ''}`).join('\n');
}

export function researchPrompt({ question, node, sources, upstream, previousFailures, hint, expected }) {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${TASK_MARKERS.research}
Today is ${today()}. Overall question: ${question}

SUB-QUESTION ${node.id}: ${node.question}
Metric: ${node.metric || 'n/a'} (${node.unit || 'unit n/a'}) · method: ${node.method}
${node.instructions ? `INSTRUCTIONS FOR THIS NODE (follow them): ${node.instructions}\n` : ''}${hint ? `User guidance: ${hint}\n` : ''}${expected ? `The user's expected final result: ${expected}\n` : ''}
ANSWERS ALREADY ESTABLISHED (use them, cite as their node id in text):
${upstreamBlock(upstream)}

EVIDENCE (cite by id in square brackets, e.g. S1; D1 is the user's data):
${sourcesBlock(sources)}
${previousFailures?.length ? `\nA PREVIOUS ATTEMPT FAILED THESE CHECKS — fix the cause:\n- ${previousFailures.join('\n- ')}\n` : ''}
RULES:
- Answer only from EVIDENCE and established answers. For legality or licensing queries, require official statutes or terms of service as sources. If evidence is missing, give your best estimate, set "assumption": true on that claim and say what data would settle it in "gaps".
- Every claim containing a number must list sourceIds from the EVIDENCE ids above, or be marked assumption.
- "sourceIds" may only contain ids shown above (${sources.map((s) => s.id).join(', ') || 'none'}). Never invent ids or URLs.
- If the method is calculation/comparison, provide "calculation": a formula using variable names (letters, digits, _), + - * / ^ ( ) and min/max/abs/round, the numeric value of each input, and the result. The result will be recomputed by machine.
- confidence "high" only with 2+ independent sources agreeing.
- Answer about the entities, places and products named in the question, using what the EVIDENCE says about them. Never answer with generic advice, definitions or how-to content ("typical cycles", "generic levers"). Open with the finding, not with what is missing; put what is missing in "gaps".
- Prefer primary evidence (the companies' own pages, papers, code repositories, official registers, press releases) over market-report summaries; when only market-report pages give a number, say so in the claim text.
- If the sub-question asks for concrete items (listings, offers, products, pages, links), return them in "items". An item "url" must be copied exactly from a LINKS list or a source URL above; any other URL is rejected by machine.

JSON shape:
{"answer":"one or two sentences that directly answer the sub-question, with the key number","claims":[{"text":"","value":null,"unit":"","sourceIds":["S1"],"assumption":false}],"calculation":{"formula":"","inputs":{"name":{"value":0,"unit":"","sourceId":"S1"}},"result":0,"unit":""},"items":[{"title":"","url":"","value":null,"unit":"","sourceId":"S1"}],"confidence":"low|medium|high","assumptions":[""],"gaps":[""]}
Omit "calculation" if no arithmetic is involved; omit "items" if no concrete items are asked for.`,
    },
  ];
}

export function critiquePrompt({ node, finding, sources }) {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${TASK_MARKERS.critique}
You are an independent reviewer. Check this finding against the evidence. Do not solve the task again; judge it.

SUB-QUESTION ${node.id}: ${node.question}
FINDING: ${JSON.stringify(finding).slice(0, 3000)}

EVIDENCE:
${sourcesBlock(sources)}

Look for: claims the evidence does not say, wrong units or currency, stale years, arithmetic or logic errors, missing major cost/factor, overconfidence.
JSON shape: {"agree":true,"severity":"none|minor|major","issues":[""],"betterAnswer":""}`,
    },
  ];
}

export function rollupPrompt({ question, node, children }) {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${TASK_MARKERS.rollup}
Overall question: ${question}
DRIVER ${node.id}: ${node.question}

SUB-FINDINGS:
${children.map((c) => `${c.id} [${c.status}] ${c.question}\n  -> ${c.finding?.answer ?? 'no answer'}`).join('\n')}

Combine the sub-findings into the driver's answer. Do not add new facts. Cite sub-finding ids in the text. If a sub-finding is weak or unsupported, say how that limits the conclusion.
JSON shape: {"answer":"","claims":[{"text":"","sourceIds":[],"assumption":false}],"confidence":"low|medium|high","assumptions":[""],"gaps":[""]}`,
    },
  ];
}

const KIND_RULE = {
  plan: 'This question asks for a PLAN. Return "actions": the concrete actions to take, best first. Each action names the piece ids whose findings support it in "nodeIds", an "impact" from 1 to 5, and a "horizon" (e.g. "0-3 months"). Use only actions the findings support; when support is weak, say so in "why". The verdict is one line that names the top action.',
  decision: 'This question asks for a DECISION. Return "options" (at least GO and NO-GO, plus GO-IF variants when relevant), each with "support" (piece ids consistent with it) and "against" (piece ids inconsistent with it), as in an Analysis of Competing Hypotheses. The verdict is the option the evidence contradicts least.',
  estimate: 'This question asks for a NUMBER. Put the computed value, its low and high range and the piece ids it rests on in "bestEstimate". The verdict states the number with its unit.',
  list: 'This question asks for a LIST. The verdict says how many items were found and verified; the item list is attached by machine.',
};

export function synthesizePrompt({ question, decision, successCriteria, template, constraints, nodes, expected, kind = 'decision' }) {
  const drivers = nodes.filter((n) => n.parentId === 'Q');
  const lines = nodes.map((n) => `${n.id} [${n.status}] ${n.question}\n  -> ${n.finding?.answer ?? 'not researched'}${n.finding?.calculation?.formula ? `\n  calc: ${n.finding.calculation.formula} = ${n.finding.calculation.recomputed ?? n.finding.calculation.result} ${n.finding.calculation.unit ?? ''}` : ''}`);
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${TASK_MARKERS.synthesize}
QUESTION: ${question}
DECISION: ${decision}
SUCCESS CRITERIA: ${successCriteria || 'not stated'}
EXPECTED RESULT: ${expected || 'a decision memo'}
CONSTRAINTS:
${constraintsText(constraints)}
DECISION RULE: ${template.decisionRule}

RESEARCH RESULTS (status in brackets: verified > supported > weak > unsupported):
${lines.join('\n')}

${KIND_RULE[kind] ?? KIND_RULE.decision}
Write the final memo. If the EXPECTED RESULT asks for items or links, the verdict says how many verified items were found; the item list itself is attached by machine. Always reach a result of the type asked above and always compute the best estimate of the answer, even when inputs are weak: use the weak findings as low–base–high ranges and state which node ids are assumptions. Never answer only "insufficient data": missing evidence is not evidence against, so say which weak inputs (node ids) would flip the verdict and at what value. Use only the results above; cite node ids like (D2.1). Weight verified findings over weak ones and say so. Give numbers with units. Be brief: compact JSON, at most 6 keyNumbers, 3 scenarios, 4 sensitivity items, 5 risks, 5 open questions, 5 next steps.
JSON shape:
{"verdict":"one line; never copy angle brackets or placeholders","confidence":"low|medium|high","actions":[{"action":"","why":"","nodeIds":["D1.1"],"impact":3,"horizon":""}],"options":[{"option":"GO","support":["D1"],"against":["D2"]}],"bestEstimate":{"value":"the computed answer","unit":"","low":"","high":"","basis":"node ids it rests on"},"summary":"3-5 sentences","keyNumbers":[{"label":"","value":"","unit":"","nodeId":""}],"scenarios":[{"name":"pessimistic|base|optimistic","assumptions":"","outcome":""}],"sensitivity":[{"variable":"","effect":"what change flips the decision"}],"risks":[""],"openQuestions":[""],"nextSteps":[{"step":"","why":"","how":""}]}
Drivers: ${drivers.map((d) => d.id).join(', ')}.`,
    },
  ];
}

function acceptanceBlock(result) {
  if (!result) return 'no machine check defined';
  const checks = result.checks.map((c) => `- ${c.label}: ${Math.round(c.value * 100)}% (${c.detail})`).join('\n');
  const bad = result.items.filter((i) => !i.live || i.inRange === false).slice(0, 5).map((i) => `- ${i.url} live=${i.live} inRange=${i.inRange}`).join('\n');
  return `${checks}${bad ? `\nfailing items:\n${bad}` : ''}`;
}

function specsText(specs = []) {
  if (!specs.length) return 'none';
  return specs.map((s) => `${s.id} want "${s.desired}"${s.last ? ` — ${s.last.passed ? 'passing' : `failing: ${s.last.checks.filter((c) => !c.passed).map((c) => c.label).join(', ')}`}` : ''}`).join(' | ');
}

const SPEC_RULE = `"spec": machine checks taken ONLY from the DESIRED OUTPUT: {"mustMention":[words the answer must contain],"needsNumber":true|false,"valueRange":[min,max] or null,"unit":"","itemCount":number of linked items wanted or null,"minGrade":"supported"|"verified"}. Code stores it as a regression test for this piece and re-checks it after every run and every loop change.`;

export function variantPrompt({ project, node, score, trials }) {
  const isRoot = node.id === 'Q';
  const drivers = project.nodes.filter((n) => n.parentId === 'Q').map((n) => `${n.id} [${n.status}] ${n.question}`).join('\n');
  const sources = (node.sources ?? []).filter((s) => s.url).slice(0, 8).map((s) => `${s.id} ${s.title} <${s.url}> (${(s.links ?? []).length} links)`).join('\n') || 'none';
  const tried = trials.slice(-6).map((t) => `- ${t.change} -> ${t.outcome} (${t.score})`).join('\n') || 'none';
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${TASK_MARKERS.variant}
You improve ONE piece of a research model so the whole model gets closer to the expected result. A machine will test your change and keep it only if the measured score rises.

QUESTION: ${project.question}
EXPECTED RESULT: ${project.acceptance?.expected || 'a well-supported decision memo'}
CURRENT SCORE: ${score.score} (share of verified/supported nodes${score.acceptance !== null ? ` and expected-result checks ${score.acceptance}` : ''})
EXPECTED-RESULT CHECKS:
${acceptanceBlock(project.acceptanceResult)}

${isRoot ? `TOP-LEVEL DECOMPOSITION:\n${drivers}\n\nPropose ONE structural change: add a missing top-level piece ("add") and/or remove a useless one ("remove").` : `PIECE ${node.id} [${node.status}]: ${node.question}
method: ${node.method} · metric: ${node.metric} ${node.unit} · queries: ${node.searchQueries.join(' | ')} · direct pages: ${(node.sourceUrls ?? []).join(' ') || 'none'}
instructions: ${node.instructions || 'none'}
answer: ${node.finding?.answer ?? 'none'}
failed checks: ${(node.verification?.failures ?? []).join(' | ') || 'none'}
reviewer: ${(node.critique?.issues ?? []).join(' | ') || 'none'}
desired outputs the user set (regression checks; a change that breaks a passing one is reverted): ${specsText(node.specs)}
sources it found:
${sources}

Propose ONE change to this piece: a sharper question, better search queries (local language helps), exact public pages to read directly (sourceUrls), a different method, extra instructions, or a split into 2-3 smaller pieces ("split").`}

ALREADY TRIED (do not repeat):
${tried}

Reply with only the fields you change. JSON shape:
{"change":"one sentence: what and why","question":"","searchQueries":[""],"sourceUrls":[""],"method":"lookup","instructions":"","split":[{"title":"","question":"","method":"lookup","searchQueries":[""],"sourceUrls":[""]}],"add":[{"title":"","question":"","method":"lookup","searchQueries":[""],"sourceUrls":[""]}],"remove":[""]}`,
    },
  ];
}

function nodeSummary(project, node) {
  if (!node) {
    const drivers = project.nodes.filter((n) => n.parentId === 'Q').map((n) => `${n.id} [${n.status}] ${n.question}`).join('\n');
    return `ROOT QUESTION: ${project.question}\nEXPECTED RESULT: ${project.acceptance?.expected || 'a decision memo'}\nPHASE: ${project.phase}\nVERDICT: ${project.report?.verdict ?? 'none yet'}\nTOP-LEVEL PIECES:\n${drivers || 'none yet'}`;
  }
  const children = project.nodes.filter((n) => n.parentId === node.id).map((n) => `${n.id} [${n.status}] ${n.question}`).join('\n');
  return `ROOT QUESTION: ${project.question}
NODE ${node.id} [${node.status}]: ${node.question}
method: ${node.method} · metric: ${node.metric} ${node.unit} · queries: ${node.searchQueries.join(' | ')} · direct pages: ${(node.sourceUrls ?? []).join(' ') || 'none'}
instructions: ${node.instructions || 'none'}
answer: ${node.finding?.answer ?? 'not researched yet'}
failed checks: ${(node.verification?.failures ?? []).join(' | ') || 'none'}
sources: ${(node.sources ?? []).filter((x) => x.url).slice(0, 6).map((x) => `${x.id} ${x.title} <${x.url}>`).join(' ; ') || 'none'}
children:
${children || 'none'}`;
}

function historyText(thread, limit = 1500, { auditedOnly = false } = {}) {
  return thread.filter((m) => !auditedOnly || m.role !== 'assistant' || m.audit).slice(-10).map((m) => `${m.role === 'app' ? 'APP REPORT' : m.role.toUpperCase()}: ${String(m.content).slice(0, limit)}${(m.files ?? []).length ? ` [files: ${m.files.map((f) => f.name).join(', ')}]` : ''}`).join('\n');
}

const SCOPE_RULE = 'If the message is about the app itself rather than this research (installing, keys, devices, links, Windows, cloud, terminal, git, updates, how the app works), return {"scope":"app","reply":"","actions":[]} and nothing else: the App chat answers it.';
const AUDIT_RULES = 'Never write a URL that is not written above. Never write keys or tokens. Never say a change happened: changes run only from the actions you return, and the app reports them.';

export function chatPrompt({ project, node, thread, message, desired = '', files = '', feedback = '' }) {
  const id = node?.id ?? 'Q';
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${TASK_MARKERS.chat}
You are the research assistant for ONE piece of a research tree. Talk with the user about this piece and, when they ask for a change, return actions. You cannot write findings or grades: those come only from research runs that pass machine checks. Never claim a fact is verified unless the node status says verified.

${nodeSummary(project, node)}

CONVERSATION SO FAR:
${historyText(thread) || 'none'}

${files}USER REQUEST (what they want): ${message}
DESIRED OUTPUT (the result they want to achieve): ${desired || 'not given'}
${specsText(id === 'Q' ? project.specs : node?.specs) !== 'none' ? `EARLIER DESIRED OUTPUTS ON THIS ${id === 'Q' ? 'RESEARCH' : 'PIECE'}: ${specsText(id === 'Q' ? project.specs : node?.specs)}
` : ''}
Allowed actions (use only when the user asks for a change or a re-check; choose the ones that move the answer toward the DESIRED OUTPUT):
- {"type":"edit","nodeId":"${id === 'Q' ? 'D1' : id}","fields":{"question":"","searchQueries":[""],"sourceUrls":[""],"instructions":"","method":"lookup|calculation|comparison|estimate|data"}}
- {"type":"add","parentId":"${id}","question":"","searchQueries":[""],"sourceUrls":[""],"method":"lookup"}
- {"type":"remove","nodeId":""}
- {"type":"expand","nodeId":"","hint":""}  (break into sub-issues)
- {"type":"suggest","nodeId":"${id}"}  (research a suggestion list of sub-issues)
- {"type":"rerun","nodeId":"","hint":""}  (re-research the piece; use last)
RULES: ${AUDIT_RULES} ${SCOPE_RULE}
${SPEC_RULE}
JSON shape: {"reply":"short answer to the user","actions":[],"spec":{}}${feedback ? `\n\n${feedback}` : ''}`,
    },
  ];
}

function computedText(m) {
  const pct = (p) => `${Math.round(p * 100)}%`;
  const lines = [`- type: ${m.kind} · overall evidence probability ${pct(m.probability)} · drivers: ${m.drivers.map((d) => `${d.id} ${pct(d.probability)}`).join(', ')}`];
  if (m.changedSince.length) lines.push(`- changed since the memo was written: ${m.changedSince.join(', ')}`);
  if (m.regraded.length) lines.push(`- graded lower because the answer says the evidence does not settle it: ${m.regraded.join(', ')}`);
  for (const a of m.actions ?? []) lines.push(`- action (${pct(a.probability)}, impact ${a.impact}/5): ${a.action} [${a.nodeIds.join(', ') || 'no piece cited'}]`);
  for (const o of m.options ?? []) lines.push(`- option ${o.option}: ${pct(o.probability)} (support ${o.support.join(', ') || 'none'}; against ${o.against.join(', ') || 'none'})`);
  if (m.estimate) lines.push(`- estimate ${m.estimate.value} ${m.estimate.unit} (${m.estimate.low}–${m.estimate.high}), ${pct(m.estimate.probability)}`);
  return lines.join('\n');
}

export function resultsSummary(project) {
  const ar = project.acceptanceResult;
  const good = project.nodes.filter((n) => ['verified', 'supported'].includes(n.status));
  const weak = project.nodes.filter((n) => !['verified', 'supported'].includes(n.status));
  const r = project.report;
  return `ROOT QUESTION: ${project.question}
EXPECTED RESULT: ${project.acceptance?.expected || 'a decision memo'}
EXPECTED-RESULT CHECKS: ${ar ? `${Math.round(ar.score * 100)}% met — ${ar.checks.map((c) => `${c.label} ${Math.round(c.value * 100)}%`).join(' · ')}` : 'not run'}
DELIVERED ITEMS (links seen on fetched pages):
${ar?.items?.length ? ar.items.slice(0, 15).map((i) => `- ${i.title || i.url} ${i.value ?? ''} ${i.unit ?? ''} <${i.url}>${i.live ? ' live' : ' not live'}${i.inRange ? ' in range' : ''}`).join('\n') : 'none'}
MEMO VERDICT: ${r?.verdict ?? 'no memo yet'}${r ? ` (${r.confidence} confidence, written ${String(r.generatedAt ?? '').slice(0, 16)}) — ${r.summary}` : ''}
COMPUTED RESULT (by code from the current pieces; trust this over the memo when they differ):
${computedText(resultModel(project))}
KEY NUMBERS: ${r?.keyNumbers?.map((k) => `${k.label} ${k.value} ${k.unit ?? ''} [${k.nodeId}]`).join(' · ') || 'none'}
PIECES THAT PASS THE CHECKS:
${good.map((n) => `${n.id} [${n.status}] ${n.title}: ${String(n.finding?.answer ?? '').slice(0, 300)}`).join('\n') || 'none'}
STILL WEAK, AND WHY:
${weak.map((n) => `${n.id} [${n.status}] ${n.title}: ${(n.verification?.failures ?? n.finding?.gaps ?? []).slice(0, 2).join('; ')}`).join('\n') || 'none'}`;
}

export function resultsChatPrompt({ project, thread, message, files = '', feedback = '' }) {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${TASK_MARKERS.resultsChat}
You explain the RESULTS of one research to the user: what was delivered, how sure it is, where the expected-result checks and the memo disagree, and what to do next. Use only the results below and the user's files. You cannot change findings or grades. When the user wants a weak piece fixed, return an action.

${resultsSummary(project)}

CONVERSATION SO FAR:
${historyText(thread) || 'none'}

${files}USER: ${message}

Allowed actions:
- {"type":"rerun","nodeId":"","hint":""}  (re-research a piece with a hint)
- {"type":"expand","nodeId":"","hint":""}  (split a weak piece)
- {"type":"suggest","nodeId":""}
RULES: ${AUDIT_RULES} Say which piece id each statement comes from. ${SCOPE_RULE}
JSON shape: {"reply":"short answer to the user","actions":[]}${feedback ? `\n\n${feedback}` : ''}`,
    },
  ];
}

export function suggestPrompt({ project, node, sources }) {
  const target = node ? `PIECE ${node.id}: ${node.question}` : `ROOT QUESTION: ${project.question}`;
  const existing = project.nodes.filter((n) => n.parentId === (node?.id ?? 'Q')).map((n) => `- ${n.question}`).join('\n') || 'none';
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${TASK_MARKERS.suggest}
Suggest 4-6 sub-issues that, answered together, settle the piece below. Base them on the EVIDENCE: each suggestion cites the source ids that show why it matters and quotes a short exact phrase (max 12 words) from that source. Do not repeat existing sub-issues.

${target}
EXPECTED RESULT: ${project.acceptance?.expected || 'a decision memo'}
EXISTING SUB-ISSUES:
${existing}

EVIDENCE:
${sourcesBlock(sources)}

JSON shape: {"suggestions":[{"title":"","question":"","why":"","method":"lookup|calculation|comparison|estimate|data","searchQueries":[""],"sourceIds":["S1"],"quote":""}]}`,
    },
  ];
}

export function appChatPrompt({ projects, status, facts = {}, docs = [], commands = [], thread, message, files = [], feedback = '' }) {
  const list = projects.slice(0, 25).map((p) => `${p.id} | ${p.phase} | ${p.good}/${p.nodes} ok | expected ${p.expectedScore === null || p.expectedScore === undefined ? 'n/a' : `${Math.round(p.expectedScore * 100)}%`} | ${p.question}`).join('\n') || 'none';
  const fileText = files.length ? `FILES THE USER ATTACHED:\n${files.map((f, i) => `[F${i + 1}] ${f.name} (${f.kind}${f.model ? `, read by ${f.model}` : ''}):\n${f.text}`).join('\n\n')}\n\n` : '';
  return [
    { role: 'system', content: 'You are the assistant of a local research app. You answer only from the facts and documents you are given, never invent links, commands, keys or capabilities, and reply with a single JSON object only.' },
    {
      role: 'user',
      content: `${TASK_MARKERS.appChat}
You are the App assistant of Free Research LLM, running on the user's computer. You answer questions about the app itself (how it works, installing, keys, other devices, Windows, cloud, terminal, updates) and about all researches together. You never write findings: research runs do, and machine checks grade them.

FACTS (checked by code just now):
- computer: ${facts.platform ?? 'unknown'} · app address: ${facts.local ?? 'http://127.0.0.1:4600'}
- remote access: ${facts.remote ? 'ON (other devices need the token link; never write the token)' : 'OFF (only this computer can open it)'}
- links for other devices (token left out on purpose): ${(facts.links ?? []).map((l) => `${l.label}: ${l.url}`).join(' · ') || 'none'}
- terminal in the app: ${facts.terminal ?? 'unknown'}
- how to get each key that is still missing (exact steps; copy them as they are):
${facts.keyGuides || 'every key is set'}
- models ready: ${status.models.join(', ') || 'none'} · search: ${status.search.join(', ') || 'none'} · loops running: ${status.improving.join(', ') || 'none'}
- app change tickets: ${(facts.changes ?? []).map((t) => `${t.id} ${t.state}${t.engine ? ` via ${t.engine}` : ''}${t.result ? ` (${t.result.passed ? 'gate passed' : 'gate failed'})` : ''}: ${t.title}`).join(' · ') || 'none yet'}
- implementers for app changes: ${(facts.coders ?? []).map((c) => `${c.id} (${c.label}) ${c.available ? 'available' : 'not installed'}`).join(' · ') || 'free models'}

RESEARCHES (id | phase | pieces passing | expected result met | question):
${list}

TERMINAL COMMANDS (the user runs these in the app's Terminal; propose one by id):
${commands.map((c) => `- ${c.id}: ${c.label} — ${c.what} (runs: ${c.run})`).join('\n')}

DOCUMENTS (excerpts from the app's own guides; name the file when you use one):
${docs.map((d) => `--- ${d.file} › ${d.heading}\n${d.text}`).join('\n') || 'none matched'}

CONVERSATION SO FAR:
${historyText(thread, 1000, { auditedOnly: true }) || 'none'}

${fileText}USER: ${message}

RULES:
1. Answer only from FACTS, DOCUMENTS, RESEARCHES and FILES. If they do not cover it, say so plainly; for changes to the app itself propose a "change" ticket.
2. Never write a URL that is not written above. Never write keys, tokens or passwords.
3. You run nothing yourself. Direct actions (open, stop, links) run when you return them. Everything else is a proposal shown as a button: tell the user to press it, never say it is done.
4. Propose a new research only when the user asks to research a question. Questions about the app itself are never researches.
4b. You are where the user asks for CHANGES TO THE APP ITSELF (a feature to add, something to change or improve, a bug, tests or checks). For those, propose ONE "change" ticket: restate the request precisely, write the desired output as something a person can check in the running app, list the tests or checks to add, and set "engine" to "claude" when Claude Code is available in FACTS, otherwise "free". Both implementers can change anything the app lets them edit: the UI (public/index.html), server code, tests and docs. Claude Code is more reliable for larger UI and feature work and uses the user's Claude plan; the free models cost nothing but depend on free quotas and often need several attempts. The user picks with the buttons "Implement with Claude Code" or "with free models". Never say only one of them can do it. Either way it edits a sandbox copy and reaches the app only when the quality gate passes. Never claim you changed the app.
4c. The user may talk to you in follow-ups: "make the button green instead", "that broke the export", "try again". Each such follow-up is a new "change" ticket that continues from the current app, so restate the delta precisely and mention the earlier ticket id in the request when the facts list one.
5. Commands: only the TERMINAL COMMANDS above (propose by id; in your text call them by their button label, e.g. **Links for other devices**) or commands written in DOCUMENTS, copied exactly. Never describe screens or dialogs that FACTS and DOCUMENTS do not describe.
6. Every suggestion must be ready to execute: numbered steps with the exact URL, the exact button or field name and the exact command, copied from FACTS (key steps), DOCUMENTS or TERMINAL COMMANDS. Never answer only "go to the website" or "open the marketplace". If the exact steps are not written above, say which guide or button to open instead of guessing.

Actions:
- {"type":"open","projectId":""}  (direct: open a research for the user)
- {"type":"stop","projectId":""}  (direct: stop a loop or run)
- {"type":"links"}  (direct: show the live links for other devices, with the token, on this screen only)
- {"type":"command","id":""}  (proposal: run a terminal command)
- {"type":"create","question":"","expected":""}  (proposal: new research)
- {"type":"improve","projectId":"","hours":2}  (proposal: start the improve loop)
- {"type":"delete","projectId":""}  (proposal: delete a research)
- {"type":"change","title":"","request":"","desired":"","tests":[""],"area":"","engine":"claude"}  (proposal: a change to the app itself, implemented by Claude Code or the free-model coder in a sandbox copy, decided by the quality gate)
JSON shape: {"reply":"answer to the user","actions":[]}${feedback ? `\n\n${feedback}` : ''}`,
    },
  ];
}
