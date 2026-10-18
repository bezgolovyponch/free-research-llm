import { evaluate, sameNumber, toNumber } from './calc.mjs';

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

const NON_ANSWER = /not possible to (determine|say|calculate)|cannot be (determined|calculated|established)|unable to (determine|find|calculate)|(insufficient|no|missing) (data|evidence|information)|not (available|provided) in the (evidence|sources)/i;

function expectsNumber(node) {
  return Boolean(node && (node.unit || ['calculation', 'comparison', 'data'].includes(node.method)));
}

function checkConcrete(finding, node) {
  const answer = String(finding?.answer ?? '');
  if (NON_ANSWER.test(answer)) return check('concrete', 'Gives a concrete answer, not "unknown"', false, 'answer says the evidence cannot settle it');
  if (!expectsNumber(node)) return null;
  const numeric = /\d/.test(answer) || (finding?.claims ?? []).some((c) => /\d/.test(c.text) || typeof c.value === 'number');
  return check('concrete', 'Gives a concrete answer, not "unknown"', numeric, numeric ? `numeric answer for ${node.metric || 'the metric'}` : `no number given for ${node.metric || 'the metric'} (${node.unit || node.method})`);
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
  const known = sources.flatMap((s) => [s.url, ...(s.links ?? []).map((l) => l.url)]).filter(Boolean);
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
  return check(
    'independent-sources',
    'High confidence is backed by 2+ independent sources',
    !high || domains.size >= 2,
    `${domains.size} independent source domain(s) cited; stated confidence ${finding?.confidence ?? 'unknown'}`,
  );
}

function checkCritique(critique) {
  if (!critique) return null;
  const major = critique.severity === 'major' && !critique.agree;
  return check('critique', 'Independent reviewer found no major flaw', !major, critique.issues?.length ? critique.issues.join(' | ').slice(0, 300) : 'reviewer agrees');
}

export function verifyFinding({ finding, sources = [], critique = null, node = null }) {
  const sourceIds = new Set(sources.map((s) => s.id));
  const checks = [
    checkAnswer(finding),
    checkConcrete(finding, node),
    checkCitations(finding, sourceIds),
    checkNumbersSourced(finding),
    checkCalculation(finding),
    checkItemLinks(finding, sources),
    checkConfidence(finding, sources),
    checkCritique(critique),
  ].filter(Boolean);
  const criticalFail = checks.some((c) => c.critical && !c.passed);
  const anyFail = checks.some((c) => !c.passed);
  const cited = new Set((finding?.claims ?? []).flatMap((c) => c.sourceIds ?? []));
  const webDomains = new Set(sources.filter((s) => cited.has(s.id) && s.url).map((s) => s.domain || domainOf(s.url)));
  let grade;
  if (criticalFail) grade = 'unsupported';
  else if (anyFail) grade = 'weak';
  else if (webDomains.size >= 2 || (cited.size >= 1 && sources.some((s) => cited.has(s.id) && s.kind === 'data'))) grade = 'verified';
  else grade = 'supported';
  const passed = checks.filter((c) => c.passed).length;
  return { grade, score: Math.round((100 * passed) / checks.length), checks, failures: checks.filter((c) => !c.passed).map((c) => c.detail) };
}

export function needsEscalation(verification) {
  return verification.grade === 'weak' || verification.grade === 'unsupported';
}
