import { MAX_NODES, METHODS } from './tree.mjs';

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
- typical sources: ${template.sources} (include official TOS, API docs, regulator sites, national statistical agencies, market research reports for price trends)
- decision rule: ${template.decisionRule}
${dataSummary ? `\nUSER DATA AVAILABLE (source id D1):\n${dataSummary}\n` : ''}
Build an issue tree that answers the QUESTION:
1. "decision": restate the decision in one sentence; "successCriteria": the measurable threshold that answers it.
2. 3-6 top-level DRIVERS (parentId null): mutually exclusive, together exhaustive for the decision.
3. Under each driver 2-4 LEAF sub-questions (parentId = driver id), each answerable by one lookup, calculation, comparison, estimate or data analysis. Max ${MAX_NODES} nodes total.
4. Every node: id (drivers "D1".."D6", leaves "D1.1" etc.), title (<=8 words), question (specific, with geography/time/units), why (how the answer moves the decision), hypothesis (your best guess to test), metric, unit, method (one of ${METHODS.join('|')}), searchQueries (2-3 precise web queries, include country language terms when useful), dependsOn (ids of OTHER nodes whose answer this needs, e.g. a margin calculation depends on price leaves), impact 1-5 (effect on the decision), uncertainty 1-5 (how unknown it is today).
5. "assumptionsToConfirm": things the user must confirm.
5b. "acceptance": machine-checkable criteria taken ONLY from the EXPECTED RESULT: itemCount (number of items/links wanted, else null), urlsLive (true if links are wanted), valueRange ([min,max] if items must have a value such as a price in a range, else null), unit (e.g. EUR), mustMention (words every delivered page must contain, else []).
5d. TOOL "listings" per node (use it for every node about car prices, listings, models or price gaps): {"countries":["DE"|"CZ"],"make":"","model":"","minEur":0,"maxEur":0}. Code then reads real marketplace listings (DE: kleinanzeigen.de; CZ: bazos.cz, aaaauto.cz), converts prices to EUR and computes median, range and the price trend. One make/model per node. For "which models" questions add ONE scan node instead: {"scan":true,"from":"DE","to":"CZ","minEur":0,"maxEur":0} — code then compares the median price of 12 common models in both countries and ranks the price gaps.
5c. "sourceUrls" per node (optional, max 2): exact public pages that answer it directly, e.g. a marketplace search page with the filters in the URL or an official statistics table. Only well-known real sites; never guess deep IDs.
6. Be brief: every text field at most 15 words, 1-2 searchQueries per node, compact JSON without indentation. List drivers first, then their leaves.

JSON shape:
{"decision":"","successCriteria":"","assumptionsToConfirm":[""],"acceptance":{"itemCount":null,"urlsLive":false,"valueRange":null,"unit":"","mustMention":[]},"nodes":[{"id":"D1","parentId":null,"title":"","question":"","why":"","hypothesis":"","metric":"","unit":"","method":"lookup","searchQueries":[""],"sourceUrls":[],"listings":null,"dependsOn":[],"impact":3,"uncertainty":3}]}`,
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
Metric: ${node.metric || 'n/a'} (${node.unit || 'unit n/a'}) · method: ${node.method} · hypothesis to test: ${node.hypothesis || 'n/a'}
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
- Marketplace sources list real listings as rows "title | price | year | km | url"; their median, range and trend were computed by code: cite them instead of guessing.
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

export function synthesizePrompt({ question, decision, successCriteria, template, constraints, nodes, expected }) {
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

Write the final memo. If the EXPECTED RESULT asks for items or links, the verdict says how many verified items were found; the item list itself is attached by machine. If the drivers that decide the success criteria are weak, unsupported or answered "unknown", the verdict MUST be "INSUFFICIENT DATA — <the missing inputs>", not NO-GO: missing evidence is not evidence against. Use only the results above; cite node ids like (D2.1). Weight verified findings over weak ones and say so. Give numbers with units. Be brief: compact JSON, at most 6 keyNumbers, 3 scenarios, 4 sensitivity items, 5 risks, 5 open questions, 5 next steps.
JSON shape:
{"verdict":"GO | NO-GO | GO-IF <condition> | INSUFFICIENT DATA — <what is missing> (one line)","confidence":"low|medium|high","summary":"3-5 sentences","keyNumbers":[{"label":"","value":"","unit":"","nodeId":""}],"scenarios":[{"name":"pessimistic|base|optimistic","assumptions":"","outcome":""}],"sensitivity":[{"variable":"","effect":"what change flips the decision"}],"risks":[""],"openQuestions":[""],"nextSteps":[{"step":"","why":"","how":""}]}
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
sources it found:
${sources}

Propose ONE change to this piece: a sharper question, better search queries (local language helps), the marketplace "listings" tool ({"countries":["DE"|"CZ"],"make":"","model":"","minEur":0,"maxEur":0}; code reads real listings), exact public pages to read directly (sourceUrls), a different method, extra instructions, or a split into 2-3 smaller pieces ("split", each may carry "listings").`}

ALREADY TRIED (do not repeat):
${tried}

Reply with only the fields you change. JSON shape:
{"change":"one sentence: what and why","question":"","searchQueries":[""],"sourceUrls":[""],"listings":null,"method":"lookup","instructions":"","split":[{"title":"","question":"","method":"lookup","searchQueries":[""],"sourceUrls":[""],"listings":null}],"add":[{"title":"","question":"","method":"lookup","searchQueries":[""],"sourceUrls":[""]}],"remove":[""]}`,
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

export function chatPrompt({ project, node, thread, message }) {
  const history = thread.slice(-10).map((m) => `${m.role === 'app' ? 'APP REPORT' : m.role.toUpperCase()}: ${String(m.content).slice(0, 1500)}`).join('\n');
  const id = node?.id ?? 'Q';
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${TASK_MARKERS.chat}
You are the research assistant for ONE piece of a research tree. Talk with the user about this piece and, when they ask for a change, return actions. You cannot write findings or grades: those come only from research runs that pass machine checks. Never claim a fact is verified unless the node status says verified.

${nodeSummary(project, node)}

CONVERSATION SO FAR:
${history || 'none'}

USER: ${message}

Allowed actions (use only when the user asks for a change or a re-check):
- {"type":"edit","nodeId":"${id === 'Q' ? 'D1' : id}","fields":{"question":"","searchQueries":[""],"sourceUrls":[""],"listings":{"countries":["DE"],"make":"","model":"","minEur":0,"maxEur":0},"instructions":"","method":"lookup|calculation|comparison|estimate|data"}}
- {"type":"add","parentId":"${id}","question":"","searchQueries":[""],"sourceUrls":[""],"listings":null,"method":"lookup"}
("listings" makes code read real car listings: DE kleinanzeigen.de, CZ bazos.cz + aaaauto.cz)
- {"type":"remove","nodeId":""}
- {"type":"expand","nodeId":"","hint":""}  (break into sub-issues)
- {"type":"suggest","nodeId":"${id}"}  (research a suggestion list of sub-issues)
- {"type":"rerun","nodeId":"","hint":""}  (re-research the piece; use last)
JSON shape: {"reply":"short answer to the user","actions":[]}`,
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
