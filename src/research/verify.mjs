import { NO_ITEMS_DETAIL, asksForItems } from './deliverable.mjs';
import { attributeClaims, attributionSummary, ungroundedNumbers } from './attribution.mjs';
import { evaluate, sameNumber, toNumber } from './calc.mjs';
import { toConfirm } from './support.mjs';

export const GRADES = ['verified', 'supported', 'weak', 'unsupported'];

function hasNumber(textValue) {
  return /\d/.test(String(textValue ?? ''));
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function check(id, label, passed, detail, critical = false) {
  return { id, label, passed, detail, critical };
}

function checkAnswer(finding) {
  const answer = String(finding?.answer ?? '').trim();
  return check('answer', 'Answers the question', answer.length >= 3, answer ? 'answer present' : 'no answer given', true);
}

function checkCitations(finding, sourceIds) {
  const cited = (finding?.claims ?? []).flatMap((c) => c.sourceIds ?? []);
  const invented = [...new Set(cited.filter((id) => !sourceIds.has(id)))];
  return check(
    'citations',
    'Cites only sources that were actually retrieved',
    invented.length === 0,
    invented.length ? `cites unknown source id(s): ${invented.join(', ')}` : `${new Set(cited).size} distinct source id(s) cited`,
    true,
  );
}

function checkNumbersSourced(finding) {
  const numeric = (finding?.claims ?? []).filter((c) => hasNumber(c.text) || c.value !== undefined);
  const bare = numeric.filter((c) => !(c.sourceIds ?? []).length && !c.assumption);
  return check(
    'numbers-sourced',
    'Every number has a source or is labelled an assumption',
    bare.length === 0,
    bare.length ? `${bare.length} number(s) without source: ${bare.map((c) => c.text).join(' | ').slice(0, 200)}` : `${numeric.length} numeric claim(s) traced`,
  );
}

const NON_ANSWER = /(?:not possible|impossible|unable|cannot|can't|could not|couldn't) (?:to )?(?:be )?(?:determine|determined|say|calculate|calculated|establish|established|find|found|identify|verify|confirm|provide|assess|assessed|estimate|estimated)|(?:insufficient|no|missing|lack of) (?:available )?(?:verifiable |reliable |relevant |concrete |specific |explicit )?(?:data|evidence|information|listings|sources|figures|counts)|no verifiable|(?:not|isn't) (?:available|provided|present|found|given|stated|mentioned|included|contained)(?: in| from| within| among)? (?:the )?(?:provided |available |given |retrieved )?(?:evidence|sources|data)|(?:evidence|sources|data) (?:does|do|did) not (?:contain|provide|include|mention|give|state|show)|there (?:is|are) no (?:available )?(?:evidence|data|information|figures)/i;

function expectsNumber(node) {
  return Boolean(node && (node.unit || ['calculation', 'comparison', 'data'].includes(node.method)));
}

const EVIDENCE_GAP = /\bnot (?:directly )?(?:reported|established|determinable|validated|verifiable|available|known|found)\b|\bcannot be (?:definitively )?(?:determined|validated|verified|established|refuted|confirmed)\b|\bthere (?:is|are) no (?:direct|specific|verifiable|reliable)\b|\bis not possible\b|\bno verifiable\b|\bmust be treated as an assumption\b|\bunverified hypothesis\b|\bhypothesis is not validated\b/i;
const EVIDENCE_WORD = /\b(?:evidence|data|sources?|supplied|hypothes[ie]s|reported|corpus)\b/i;

export function firstSentence(text) {
  return String(text ?? '').split(/(?<=[.!?])\s+/)[0] ?? '';
}

export function isEvidenceGap(answer) {
  const lead = firstSentence(answer);
  return EVIDENCE_GAP.test(lead) && EVIDENCE_WORD.test(lead);
}

function checkConcrete(finding, node) {
  const answer = String(finding?.answer ?? '');
  if (NON_ANSWER.test(answer) || isEvidenceGap(answer)) return check('concrete', 'Gives a concrete answer, not "unknown"', false, 'answer says the evidence cannot settle it');
  if (!expectsNumber(node)) return null;
  const numeric = /\d/.test(answer) || (finding?.claims ?? []).some((c) => /\d/.test(c.text) || typeof c.value === 'number');
  return check('concrete', 'Gives a concrete answer, not "unknown"', numeric, numeric ? `numeric answer for ${node.metric || 'the metric'}` : `no number given for ${node.metric || 'the metric'} (${node.unit || node.method})`);
}

function checkDelivers(finding, node) {
  if (!asksForItems(node)) return null;
  const count = (finding?.items ?? []).filter((i) => i && i.url).length;
  return check('delivers', 'Delivers the listings it asks for', count > 0, count ? `${count} listing(s) with links` : NO_ITEMS_DETAIL);
}

function checkAttribution(finding) {
  if (!String(finding?.answer ?? '').trim()) return null;
  if (!(finding?.claims ?? []).length) return check('attribution', 'Each claim is backed by a verbatim quote found in its source', false, 'the answer has no claims behind it');
  const s = attributionSummary(finding.claims);
  const missing = finding.claims.filter((c) => c.attributed === false).map((c) => `"${String(c.text).slice(0, 70)}"${c.attributionNote ? ` (${c.attributionNote})` : ''}`);
  return check('attribution', 'Each claim is backed by a verbatim quote found in its source', s.passed, `${s.attributed} of ${s.factual} claim(s) carry a quote found in the cited source${missing.length ? `; not backed: ${missing.join('; ').slice(0, 240)}` : ''}`);
}

function checkGrounded(finding, node) {
  if (!finding?.answer) return null;
  const extra = ungroundedNumbers(finding, node ?? {});
  return check('grounded', 'The answer states only numbers its claims support', extra.length === 0, extra.length ? `answer states ${extra.join(', ')} that no claim or calculation supports` : 'every number in the answer comes from a claim');
}

function checkCalculation(finding) {
  const calc = finding?.calculation;
  if (!calc || !calc.formula) return null;
  try {
    const inputs = Object.fromEntries(Object.entries(calc.inputs ?? {}).map(([k, v]) => [k, v && typeof v === 'object' ? v.value : v]));
    const recomputed = evaluate(calc.formula, inputs);
    const stated = toNumber(calc.result);
    const ok = sameNumber(recomputed, stated);
    calc.recomputed = recomputed;
    return check('calculation', 'Calculation recomputes to the stated result', ok, `${calc.formula} = ${recomputed.toFixed(4)} (stated ${stated})`, true);
  } catch (error) {
    return check('calculation', 'Calculation recomputes to the stated result', false, `cannot recompute: ${error.message}`, true);
  }
}

export function sameUrl(a, b) {
  const norm = (u) => String(u ?? '').trim().replace(/#.*$/, '').replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '').toLowerCase();
  return Boolean(a) && norm(a) === norm(b);
}

function checkItemLinks(finding, sources) {
  const items = finding?.items ?? [];
  if (!items.length) return null;
  const known = sources.flatMap((s) => [s.url, ...(s.links ?? []).map((l) => l.url), ...(s.listings ?? []).map((l) => l.url)]).filter(Boolean);
  const invented = items.filter((item) => !known.some((url) => sameUrl(url, item.url)));
  return check(
    'item-links',
    'Every listed link was found on a fetched page',
    invented.length === 0,
    invented.length ? `${invented.length} of ${items.length} link(s) not seen on any fetched page: ${invented.map((i) => i.url).join(' ').slice(0, 200)}` : `${items.length} link(s) traced to fetched pages`,
    true,
  );
}

function checkConfidence(finding, sources) {
  const cited = new Set((finding?.claims ?? []).flatMap((c) => c.sourceIds ?? []));
  const domains = new Set(sources.filter((s) => cited.has(s.id)).map((s) => s.domain || domainOf(s.url) || s.id));
  const high = finding?.confidence === 'high';
  const codeRead = sources.some((s) => cited.has(s.id) && s.kind === 'data');
  return check(
    'independent-sources',
    'High confidence is backed by 2+ independent sources or by data read by code',
    !high || domains.size >= 2 || codeRead,
    `${domains.size} independent source domain(s) cited; stated confidence ${finding?.confidence ?? 'unknown'}`,
  );
}

function checkMeaning(finding) {
  const checked = (finding?.claims ?? []).filter((c) => c.support);
  if (!checked.length) return null;
  const open = checked.filter((c) => toConfirm(c.support));
  const result = check('meaning', 'Each claim that affects the result means what its quote says (two models agree, code enforces)', open.length === 0, open.length ? `${open.length} claim(s) to confirm: ${open.map((c) => `"${String(c.text).slice(0, 60)}"`).join('; ').slice(0, 240)}` : `${checked.length} claim(s) meaning-checked`);
  return { ...result, advisory: true };
}

function checkCritique(critique) {
  if (!critique) return null;
  const major = critique.severity === 'major' && !critique.agree;
  return check('critique', 'Independent reviewer found no major flaw', !major, critique.issues?.length ? critique.issues.join(' | ').slice(0, 300) : 'reviewer agrees');
}

export function verifyFinding({ finding: raw, sources = [], critique = null, node = null }) {
  const finding = raw?.claims ? Object.assign(raw, { claims: attributeClaims(raw.claims, sources) }) : raw;
  const sourceIds = new Set(sources.map((s) => s.id));
  const checks = [
    checkAnswer(finding),
    checkConcrete(finding, node),
    checkDelivers(finding, node),
    checkAttribution(finding),
    checkGrounded(finding, node),
    checkCitations(finding, sourceIds),
    checkNumbersSourced(finding),
    checkCalculation(finding),
    checkItemLinks(finding, sources),
    checkConfidence(finding, sources),
    checkCritique(critique),
    checkMeaning(finding),
  ].filter(Boolean);
  const criticalFail = checks.some((c) => c.critical && !c.passed);
  const anyFail = checks.some((c) => !c.passed && !c.advisory);
  const meaningOpen = checks.some((c) => c.advisory && !c.passed);
  const cited = new Set((finding?.claims ?? []).flatMap((c) => c.sourceIds ?? []));
  const webDomains = new Set(sources.filter((s) => cited.has(s.id) && s.url).map((s) => s.domain || domainOf(s.url)));
  let grade;
  if (criticalFail) grade = 'unsupported';
  else if (anyFail) grade = 'weak';
  else if (verifiedWithoutMeaning(webDomains, cited, sources)) grade = meaningOpen ? 'supported' : 'verified';
  else grade = 'supported';
  const passed = checks.filter((c) => c.passed).length;
  return { grade, score: Math.round((100 * passed) / checks.length), checks, failures: checks.filter((c) => !c.passed).map((c) => c.detail), ...(meaningOpen && grade === 'supported' && verifiedWithoutMeaning(webDomains, cited, sources) ? { meaningCapped: true } : {}) };
}

function verifiedWithoutMeaning(webDomains, cited, sources) {
  return webDomains.size >= 2 || (cited.size >= 1 && sources.some((s) => cited.has(s.id) && s.kind === 'data'));
}

export function withMeaning(verification, finding) {
  if (!verification) return verification;
  const meaning = checkMeaning(finding);
  const others = (verification.checks ?? []).filter((c) => c.id !== 'meaning');
  const checks = meaning ? [...others, meaning] : others;
  const base = verification.meaningCapped ? 'verified' : verification.grade;
  const open = Boolean(meaning && !meaning.passed);
  const grade = base === 'verified' && open ? 'supported' : base;
  const passed = checks.filter((c) => c.passed).length;
  const { meaningCapped, ...rest } = verification;
  return { ...rest, grade, score: checks.length ? Math.round((100 * passed) / checks.length) : verification.score, checks, failures: checks.filter((c) => !c.passed).map((c) => c.detail), ...(open && base === 'verified' ? { meaningCapped: true } : {}) };
}

export function needsEscalation(verification) {
  return verification.grade === 'weak' || verification.grade === 'unsupported';
}
