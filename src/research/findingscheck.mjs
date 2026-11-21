import { agreed, closedVote, optionLines } from './semantic.mjs';
import { quoteFound } from './quote.mjs';
import { nodeIdsIn } from './result.mjs';

const READINGS = [
  { id: 'supports', text: 'The finding supports the answer' },
  { id: 'contradicts', text: 'The finding contradicts the answer: it gives another value, period, place or thing for what the answer states' },
  { id: 'unrelated', text: 'The finding does not bear on the answer' },
];

export function memoAnswer(report) {
  const said = String(report?.modelVerdict ?? report?.verdict ?? '').trim();
  const estimate = report?.bestEstimate;
  const value = String(estimate?.value ?? '').trim();
  if (!value) return said;
  const range = estimate.low || estimate.high ? ` (range ${estimate.low ?? '?'} to ${estimate.high ?? '?'})` : '';
  return `${said} Estimate: ${value} ${estimate.unit ?? ''}${range}.`.replace(/\s+/g, ' ').trim();
}

function claimsOf(node) {
  return (node?.finding?.claims ?? []).map((claim) => String(claim?.text ?? claim?.claim ?? '').trim()).filter(Boolean);
}

export function findingsToCheck(nodes, basisIds = []) {
  const basis = new Set(basisIds);
  return (nodes ?? [])
    .filter((node) => node.status === 'verified' || (node.status === 'supported' && basis.has(node.id)))
    .flatMap((node) => claimsOf(node).map((text) => ({ nodeId: node.id, grade: node.status, text })));
}

function digitsOnly(text) {
  return String(text ?? '').replace(/(\d)[,.   ](?=\d{3}(?!\d))/g, '$1');
}

export function estimateGrounded(estimate, nodes) {
  const value = digitsOnly(estimate?.value).replace(/[^0-9.]/g, '');
  if (!value) return true;
  return (nodes ?? []).some((node) => claimsOf(node).some((text) => new RegExp(`(^|[^0-9.])${value.replace('.', '\\.')}([^0-9]|$)`).test(digitsOnly(text))));
}

export function consistencyPrompt({ question, answer, finding, options }) {
  return [
    { role: 'system', content: 'You check a research memo against one finding of its own research. Pick the option that says how the finding relates to the memo answer. When it contradicts the answer, copy in "quote" the words of the finding that show it, character for character. Answer with JSON only: {"pick":"<letter>","quote":"..."}' },
    { role: 'user', content: `Question: ${question}\nMemo answer: ${answer}\nFinding (${finding.grade}): ${finding.text}\n\nOptions:\n${optionLines(options)}` },
  ];
}

export async function checkFindings({ question = '', report, nodes = [], router, votes = 3, quorum = 2 }) {
  const answer = memoAnswer(report);
  if (!answer || !router) return null;
  const toCheck = findingsToCheck(nodes, nodeIdsIn(report?.bestEstimate?.basis ?? ''));
  const conflicts = [];
  for (const finding of toCheck) {
    const result = await closedVote({
      router,
      task: 'memo-consistency',
      tier: 'fast',
      n: votes,
      quorum,
      options: READINGS,
      field: 'pick',
      seed: `${answer}|${finding.text}`,
      prompt: (shown) => consistencyPrompt({ question, answer, finding, options: shown }),
      extra: (data, hit) => {
        if (hit?.id !== 'contradicts') return { value: {} };
        const quote = String(data?.quote ?? '').trim();
        return quote && quoteFound(finding.text, quote) ? { value: { quote } } : { error: '"quote" must copy the words of the finding that show the contradiction' };
      },
      keyOf: (id) => String(id),
    }).catch(() => null);
    const settled = agreed(result);
    if (settled?.id === 'contradicts') conflicts.push({ nodeId: finding.nodeId, grade: finding.grade, claim: finding.text.slice(0, 300), quote: settled.extra?.quote ?? '' });
  }
  const ungrounded = Boolean(String(report?.bestEstimate?.value ?? '').trim()) && !estimateGrounded(report.bestEstimate, nodes);
  return { checked: toCheck.length, conflicts, ungrounded };
}

export function lowersConfidence(check) {
  return Boolean(check && (check.ungrounded || check.conflicts.some((conflict) => conflict.grade === 'verified')));
}

export function findingsNote(check) {
  if (!check) return '';
  const parts = [];
  const first = check.conflicts.find((conflict) => conflict.grade === 'verified') ?? check.conflicts[0];
  if (first) parts.push(`sources disagree: ${first.nodeId} says "${(first.quote || first.claim).slice(0, 140)}"`);
  if (check.ungrounded) parts.push('the estimate appears in no finding');
  return parts.length ? ` — ${parts.join('; ')}` : '';
}

export function conflictQuestions(check) {
  return (check?.conflicts ?? []).map((conflict) => `Which is right: the memo answer, or ${conflict.nodeId} ("${(conflict.quote || conflict.claim).slice(0, 160)}")?`);
}
