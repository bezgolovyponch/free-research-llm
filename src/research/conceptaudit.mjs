import { supportAudit } from './support.mjs';
import { TEMPLATES } from './templates.mjs';
import { listingWork } from './treeaudit.mjs';

const RESULT_WORD = /^(?:listings?|results?|items?|cars?|plots?|candidates?|offers?|properties|property|links?)$/i;

export function statedResultCounts(text) {
  const words = String(text ?? '').replace(/(\d)[ ,.](?=\d{3}\b)/g, '$1').split(/\s+/);
  const counts = [];
  words.forEach((word, i) => {
    const n = Number(word.replace(/[^\d]/g, ''));
    if (!/^\d+[,.;:]?$/.test(word) || !Number.isFinite(n)) return;
    if (words.slice(i + 1, i + 5).some((w) => RESULT_WORD.test(w.replace(/[^a-z]/gi, '')))) counts.push(n);
  });
  return counts;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DETAIL = 200;
const WEEK_MS = 7 * DAY_MS;

const clip = (value) => String(value ?? '').slice(0, MAX_DETAIL);
const time = (value) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};
const hoursBetween = (a, b) => Math.max(0, Math.round(Math.abs(a - b) / 3600000));
const daysBetween = (a, b) => Math.max(0, Math.round(Math.abs(a - b) / DAY_MS));
const fitsOf = (kept) => kept.filter((r) => r?.plan?.tier === 'fits');
const urlsOf = (rows) => rows.map((r) => r?.url || r?.id || '?').join(', ');
const codesOf = (rows) => [...new Set(rows.map((r) => r?.countryCode).filter(Boolean))].join(', ');

export function conceptAudit(project, { now = Date.now() } = {}) {
  const p = project ?? {};
  const findings = [];
  const add = (id, label, severity, ok, detail) => findings.push({ id, label, severity, ok: Boolean(ok), detail: clip(detail) });
  const c = p.candidates;
  const kept = Array.isArray(c?.kept) ? c.kept : null;
  const fits = kept ? fitsOf(kept) : [];

  if (c && kept && typeof c.keptCount === 'number') {
    const outside = Boolean(c.verification);
    const counted = outside ? fits.filter((r) => r?.verified?.verdict === 'confirmed').length : fits.length;
    const ok = c.keptCount === counted;
    const what = outside ? 'fit every check and are confirmed' : 'fit every check';
    add('C1', 'Only plots that fit every check and are confirmed count', 'error', ok, ok ? `${counted} kept plot(s) ${what}.` : `The table shows ${c.keptCount} kept, but ${counted} plot(s) ${what}.`);
  }

  if (c && kept) {
    const bad = fits.filter((r) => (r?.plan?.checks ?? []).some((check) => check?.ok !== true));
    add('C2', 'A fit has every asked check measured and met', 'error', !bad.length, bad.length ? `${bad.length} fit(s) have a check that is not met: ${urlsOf(bad)}` : `All ${fits.length} fit(s) have every asked check met.`);
  }

  if (c && kept) {
    const bad = fits.filter((r) => (r?.plan?.checks ?? []).some((check) => check?.id === 'legal' && check?.ok === false));
    add('C3', 'No plot is counted where the buyer cannot own it', 'error', !bad.length, bad.length ? `${bad.length} fit(s) fail the legal check: ${urlsOf(bad)}` : 'No fit fails the legal check.');
  }

  const regions = Array.isArray(p.brief?.regions) ? p.brief.regions.filter(Boolean) : [];
  if (regions.length && kept) {
    const bad = kept.filter((r) => r?.countryCode && !regions.includes(r.countryCode));
    add('C4', 'Kept plots are in the asked countries', 'error', !bad.length, bad.length ? `Kept plots outside ${regions.join(', ')}: ${codesOf(bad)}` : `Every kept plot is in ${regions.join(', ')}.`);
  }

  const max = p.brief?.valueRange?.[1];
  if (typeof max === 'number' && kept) {
    const bad = fits.filter((r) => typeof r?.value === 'number' && (!r.unit || !p.brief?.unit || r.unit === p.brief.unit) && r.value > max * 1.02);
    add('C5', 'Fits respect the price limit', 'error', !bad.length, bad.length ? `${bad.length} fit(s) are above ${max} EUR: ${urlsOf(bad)}` : `All ${fits.length} fit(s) are within ${max} EUR.`);
  }

  const verification = c?.verification;
  if (c && verification && typeof verification === 'object') {
    const at = time(verification.at);
    const built = time(c.builtAt);
    const pending = Number(verification.pending ?? 0);
    const reasons = [];
    if (at != null && built != null && at < built - DAY_MS) reasons.push(`the outside check is ${hoursBetween(at, built)} h older than the table`);
    if (pending > 0) {
      if (at == null) reasons.push(`${pending} plot(s) are still pending and the outside check never ran`);
      else if (at < now - DAY_MS) reasons.push(`${pending} plot(s) are still pending; the last outside check was ${daysBetween(at, now)} day(s) ago`);
    }
    add('C6', 'The outside check is current', 'warn', !reasons.length, reasons.length ? reasons.join('; ') : 'The outside check is current.');
  }

  if (kept) {
    const judged = fits.filter((r) => ['confirmed', 'refuted', 'unconfirmed', 'pending'].includes(r?.verified?.verdict));
    if (judged.length) {
      const refuted = judged.filter((r) => r.verified.verdict === 'refuted').length;
      const share = refuted / judged.length;
      add('C7', 'The outside check agrees with the app', 'warn', share <= 0.3, `${refuted} of ${judged.length} checked fit(s) are refuted by the outside check.`);
    }
  }

  if (p.improve && typeof p.improve === 'object') {
    const trials = (Array.isArray(p.improve.trials) ? p.improve.trials : []).slice(-30);
    const outages = trials.filter((t) => t?.outcome === 'provider-outage').length;
    const ok = !p.improve.active || outages <= trials.length / 2;
    add('C8', 'The loop is not starved by provider outages', 'warn', ok, p.improve.active ? `${outages} of ${trials.length} recent trial(s) were provider outages.` : 'The improvement loop is not active.');
  }

  const claimAudit = p.supportAudit && typeof p.supportAudit === 'object' ? p.supportAudit : Array.isArray(p.nodes) ? supportAudit(p.nodes) : null;
  if (claimAudit) {
    const stale = Number(claimAudit.stale ?? 0);
    add('C9', 'Claims are checked under the current logic', 'warn', !(stale > 0), stale > 0 ? `${stale} claim(s) were checked under older logic.` : 'Every claim is checked under the current logic.');
  }

  if (Array.isArray(p.nodes)) {
    const bad = p.nodes.filter((n) => n?.status === 'verified' && (n?.verification?.checks ?? []).some((check) => check?.id === 'meaning' && check?.passed === false));
    add('C10', 'No piece is verified with a claim to confirm', 'error', !bad.length, bad.length ? `${bad.length} verified piece(s) fail the meaning check: ${urlsOf(bad)}` : 'No verified piece has a failed meaning check.');
  }

  const sc = p.strategyCheck;
  if (sc && typeof sc === 'object') {
    const at = time(sc.at);
    const entries = Object.entries(sc).filter(([id, value]) => id !== 'at' && value && typeof value === 'object');
    const short = entries.filter(([, value]) => Number(value.quotes ?? 0) > 0 && Number(value.confirmed ?? 0) < Number(value.quotes ?? 0)).map(([id]) => id);
    const reasons = [];
    if (at != null && at < now - WEEK_MS) reasons.push(`strategy sources were last read ${daysBetween(at, now)} day(s) ago`);
    if (short.length) reasons.push(`quotes are not confirmed for: ${short.join(', ')}`);
    add('C11', 'Strategy sources were re-read within 7 days', 'warn', !reasons.length, reasons.length ? reasons.join('; ') : 'Strategy sources are fresh and confirmed.');
  }

  const claimCheck = p.report?.claimCheck;
  if (claimCheck && Array.isArray(claimCheck.contradicted)) {
    const contradicted = claimCheck.contradicted;
    add('C12', 'The memo does not contradict the verified record', 'warn', !contradicted.length, contradicted.length ? `${contradicted.length} memo claim(s) contradict the record; first: ${contradicted[0]?.text ?? ''}` : 'The memo does not contradict the record.');
  }

  if (regions.length && kept) {
    const present = new Set(kept.map((r) => r?.countryCode).filter(Boolean));
    const missing = regions.filter((code) => !present.has(code));
    add('C13', 'Every asked country reached the table', 'warn', !missing.length, missing.length ? `No kept plot from: ${missing.join(', ')}` : `Every asked country reached the table: ${regions.join(', ')}.`);
  }

  if (c && kept && typeof c.keptCount === 'number') {
    const ok = !(c.keptCount > 0 && kept.length === 0);
    add('C14', 'Nothing is counted while the table is empty', 'error', ok, ok ? 'The table and its count agree.' : `The table shows ${c.keptCount} kept while it holds no rows.`);
  }

  const itemCount = Number(p.acceptance?.itemCount);
  if (itemCount > 0 && Array.isArray(p.acceptanceResult?.checks)) {
    const countCheck = p.acceptanceResult.checks.find((entry) => entry?.id === 'count');
    const ok = countCheck?.passed === true;
    add('C15', 'A list research delivers the items it asked for', 'warn', ok, ok ? `${itemCount} item(s) delivered.` : `${Math.round((countCheck?.value ?? 0) * itemCount)} of ${itemCount} item(s) delivered`);
  }

  if (typeof p.templateId === 'string' && p.templateId) {
    const ok = TEMPLATES.some((template) => template.id === p.templateId);
    add('C16', 'The research uses a template the app still has', 'warn', ok, ok ? `template "${p.templateId}" is still available.` : `template "${p.templateId}" was removed; the research runs as a generic question`);
  }

  if (itemCount > 0 && p.phase !== 'created' && p.phase !== 'decomposing') {
    const label = p.brief?.kind?.label || p.decisionModel?.kind?.label;
    add('C17', 'A list research knows what item it lists', 'warn', Boolean(label), label ? `Item kind: ${label}.` : 'no item kind: the research prompts ask for a decision memo instead of listing pages');
  }

  if (Number(p.acceptance?.itemCount) > 0 && Array.isArray(p.nodes)) {
    const leaves = p.nodes.filter((n) => !p.nodes.some((m) => m.parentId === n.id));
    const ids = leaves.filter((n) => listingWork(n.question)).map((n) => n.id);
    add('C18', 'A list research leaves per-listing work to code', 'warn', !ids.length, ids.length ? `${ids.length} piece(s) do per-listing work code should do: ${ids.slice(0, 6).join(', ')}` : 'No piece does per-listing work.');
  }

  if (typeof c?.keptCount === 'number' && typeof p.report?.verdict === 'string') {
    const asked = Number(p.acceptance?.itemCount) || 0;
    const wrong = c.keptCount >= asked ? statedResultCounts(p.report.verdict).find((n) => n < c.keptCount) : undefined;
    add('C19', 'The memo states the table count', 'warn', wrong === undefined, wrong === undefined ? `memo agrees with the table (${c.keptCount} kept).` : `memo states ${wrong} results, the table keeps ${c.keptCount}`);
  }

  return {
    at: new Date(now).toISOString(),
    findings,
    errors: findings.filter((f) => !f.ok && f.severity === 'error').length,
    warnings: findings.filter((f) => !f.ok && f.severity === 'warn').length,
  };
}

export function auditAll(projects) {
  return (projects ?? []).map((p) => ({ id: p.id, question: String(p.question).slice(0, 80), ...conceptAudit(p) }));
}
