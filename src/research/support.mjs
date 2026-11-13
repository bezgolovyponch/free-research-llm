import { numbersIn } from './attribution.mjs';
import { TASK_MARKERS } from './prompts.mjs';
import { stem, words } from './treeaudit.mjs';
import { clip } from './blockers.mjs';

export const SUPPORT_LOGIC_VERSION = 2;
export const CAUSE_MAX_CHARS = 200;
export const MIN_TERM_SHARE = 0.5;
export const MAX_SUPPORT_CLAIMS = 6;
export const VERDICTS = ['supported', 'disagree', 'unsupported', 'unchecked'];
export const TO_CONFIRM = new Set(['disagree', 'unsupported', 'unchecked']);

const FILLER = new Set('cost costs price prices about around from more less than also only very per year years month months not but any does did has had have source sources cited evidence state states stated show shows describe describes identify identifies page provided found directly text'.split(' ').map(stem));
const SOURCE_REF = /\b[SDUQ]\d+(?:\.\d+)*\b/g;
const CONTEXT_CHARS = 240;
const ENGLISH = ['the', 'and', 'of', 'to', 'is', 'are', 'for', 'with', 'in', 'on'];
const FOREIGN = ['de', 'la', 'el', 'que', 'und', 'der', 'die', 'je', 'na', 'se', 've', 'pro', 'da', 'em', 'os', 'bir', 'ile', 'od', 'za', 'del', 'los', 'para'];
const NON_ENGLISH_LETTER = /[À-ɏ]/;
const DECIDING_METHODS = new Set(['calculation', 'comparison', 'data']);
const QUEUE_ORDER = { disagree: 0, unsupported: 1, unchecked: 2 };
const SENTENCE_CHARS = { min: 12, max: 300 };

export function keyTerms(text) {
  const plainText = String(text ?? '').replace(SOURCE_REF, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return new Set([...words(plainText)].filter((w) => !/^\d/.test(w) && !FILLER.has(w)));
}

export function looksEnglish(text) {
  const plain = String(text ?? '').toLowerCase();
  const tokens = new Set(plain.split(/[^a-z]+/));
  const english = ENGLISH.filter((w) => tokens.has(w)).length;
  const foreign = FOREIGN.filter((w) => tokens.has(w)).length;
  return english >= 2 || (foreign === 0 && !NON_ENGLISH_LETTER.test(plain));
}

export function termCheck(claimText, quote) {
  if (!looksEnglish(quote)) return { passed: true, missing: [], skipped: 'quote not in English: left to the model vote' };
  const claim = keyTerms(claimText);
  const held = keyTerms(quote);
  const missing = [...claim].filter((t) => !held.has(t));
  return { passed: !missing.length || (claim.size - missing.length) / claim.size >= MIN_TERM_SHARE, missing };
}

function calculationNumbers(finding) {
  return Object.values(finding?.calculation?.inputs ?? {}).map((v) => String(v && typeof v === 'object' ? v.value : v));
}

export function affectsResult(claim, finding = {}, node = {}) {
  if (!claim || claim.assumption === true) return false;
  if (typeof claim.value === 'number') return true;
  const text = String(claim.text ?? '').replace(SOURCE_REF, ' ');
  const resultNumbers = new Set([...numbersIn(finding?.answer), ...calculationNumbers(finding)]);
  if (numbersIn(text).some((n) => resultNumbers.has(n))) return true;
  return DECIDING_METHODS.has(node?.method) || node?.decides === true;
}

export function contextOf(quote, sources = [], ids = []) {
  const wanted = String(quote ?? '').trim().toLowerCase();
  if (!wanted) return '';
  for (const source of sources.filter((x) => !ids.length || ids.includes(x.id))) {
    const text = String(source.text ?? '');
    const at = text.toLowerCase().indexOf(wanted);
    if (at >= 0) return text.slice(Math.max(0, at - CONTEXT_CHARS), at + wanted.length + CONTEXT_CHARS);
  }
  return '';
}

export function supportPrompt({ claim, quote }) {
  return [
    { role: 'system', content: 'You check whether a quote supports a claim. Reply with JSON only.' },
    {
      role: 'user',
      content: `${TASK_MARKERS.support}\nCLAIM: ${claim}\nQUOTE: ${quote}\n\nDoes the quote state what the claim says? Answer "yes" only when the quote states the same subject, quantity and place as the claim; "partial" when it backs only part of it; "no" otherwise.\nReply as JSON: {"supports":"yes"|"no"|"partial","reason":"<at most 80 characters: what the quote is about if it differs>"}`,
    },
  ];
}

export function normalizeVote(data, { provider = null, model = null } = {}) {
  const said = String(data?.supports ?? '').trim().toLowerCase();
  return { provider, model, vote: ['yes', 'no', 'partial'].includes(said) ? said : null, reason: String(data?.reason ?? '').slice(0, 80) };
}

export function supportVerdict(votes = []) {
  const cast = votes.filter((v) => v?.vote);
  if (cast.length < 2) return 'unchecked';
  if (cast.every((v) => v.vote === 'yes')) return 'supported';
  if (cast.every((v) => v.vote === 'no')) return 'unsupported';
  return 'disagree';
}

const HEADLINE = {
  disagree: '• The two checking models disagree',
  unsupported: '• Both checking models say the quote does not back the claim',
  unchecked: '• Meaning not checked yet (no free model answered)',
};

export function causeOf({ verdict, votes = [], missing = [], blocker = null }) {
  if (!TO_CONFIRM.has(verdict)) return '';
  return clip([
    HEADLINE[verdict],
    missing.length ? `• Quote does not mention: ${missing.slice(0, 3).join(', ')}` : null,
    ...votes.filter((v) => v.vote && v.vote !== 'yes' && v.reason).slice(0, 2).map((v) => `• ${v.reason}`),
    blocker ? `• ${blocker}` : null,
  ], CAUSE_MAX_CHARS);
}

export function supportRecord({ votes = [], term = null, at = new Date().toISOString(), blocker = null }) {
  const voted = supportVerdict(votes);
  const verdict = voted === 'supported' && term && !term.passed ? 'disagree' : voted;
  const missing = term?.missing ?? [];
  return { version: SUPPORT_LOGIC_VERSION, verdict, votes, missing, cause: causeOf({ verdict, votes, missing, blocker }), at };
}

export function toConfirm(record) {
  return TO_CONFIRM.has(record?.verdict);
}

export function quotesOtherPieces(node) {
  return Boolean(node?.sources?.length) && node.sources.every((s) => s.kind === 'node');
}

function needsCheck(claim, finding, node) {
  return claim?.attributed === true && !quotesOtherPieces(node) && affectsResult(claim, finding, node);
}

export function claimsToCheck(finding, node) {
  return (finding?.claims ?? []).filter((c) => needsCheck(c, finding, node)).slice(0, MAX_SUPPORT_CLAIMS);
}

export function isStale(claim, finding, node) {
  return claim?.support?.version !== SUPPORT_LOGIC_VERSION && claimsToCheck(finding, node).includes(claim);
}

export function unanswered(claim, finding, node) {
  return claim?.support?.version === SUPPORT_LOGIC_VERSION && claim.support.verdict === 'unchecked' && claimsToCheck(finding, node).includes(claim);
}

export function needsRecheck(claim, finding, node) {
  return isStale(claim, finding, node) || unanswered(claim, finding, node);
}

export function sentencesOf(text) {
  return String(text ?? '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= SENTENCE_CHARS.min && s.length <= SENTENCE_CHARS.max);
}

export function resolveFromSources(claim, sources = []) {
  const wanted = numbersIn(claim.text);
  for (const source of sources) {
    for (const sentence of sentencesOf(source.text)) {
      if (sentence === claim.quote) continue;
      const held = new Set(numbersIn(sentence));
      if (!wanted.every((n) => held.has(n))) continue;
      const term = termCheck(claim.text, sentence);
      if (term.passed && !term.skipped) return { quote: sentence, sourceId: source.id };
    }
  }
  return null;
}

export function supportAudit(nodes = []) {
  const audit = { version: SUPPORT_LOGIC_VERSION, checked: 0, supported: 0, toConfirm: 0, disagree: 0, stale: 0, unanswered: 0, queue: [] };
  for (const node of nodes) {
    for (const claim of node.finding?.claims ?? []) {
      if (isStale(claim, node.finding, node)) audit.stale += 1;
      if (unanswered(claim, node.finding, node)) audit.unanswered += 1;
      if (!claim.support) continue;
      audit.checked += 1;
      if (claim.support.verdict === 'supported') audit.supported += 1;
      if (!toConfirm(claim.support)) continue;
      audit.toConfirm += 1;
      if (claim.support.verdict === 'disagree') audit.disagree += 1;
      audit.queue.push({ nodeId: node.id, claim: String(claim.text ?? '').slice(0, 120), verdict: claim.support.verdict, cause: claim.support.cause });
    }
  }
  audit.queue.sort((a, b) => QUEUE_ORDER[a.verdict] - QUEUE_ORDER[b.verdict]);
  return audit;
}
