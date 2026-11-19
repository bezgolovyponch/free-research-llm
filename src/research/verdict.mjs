import { kindCluster } from './checklist.mjs';

const KIND_PURPOSE_ID = 'purpose-kind';

const isKindCheck = (check) => check?.clause === 'kind' && String(check.id ?? '').startsWith('kind|');

export const KIND_OPEN_REASON = 'the page does not use the asked words and the kind judge has not answered with a quote: to confirm';

function purposeState(item, criterion) {
  if (criterion.passed) return 'yes';
  if (criterion.id !== KIND_PURPOSE_ID) return 'no';
  const judged = (item.checks ?? []).filter(isKindCheck);
  if (judged.some((c) => c.answer === 'yes' && c.quote)) return 'yes';
  if (judged.some((c) => c.answer === 'no' && c.quote)) return 'no';
  return judged.length ? 'unknown' : 'no';
}

function opens(item, spec) {
  const entity = Boolean(item.evidence);
  return Boolean(item.live && (entity || item.listing) && (!spec?.valueRange || item.inRange));
}

export function qualifies(item, spec) {
  return opens(item, spec) && (item.purpose ?? []).every((c) => purposeState(item, c) === 'yes');
}

export function refused(item, spec) {
  return !opens(item, spec) || (item.purpose ?? []).some((c) => purposeState(item, c) === 'no');
}

export function itemTier(item, hardIds, spec) {
  const checks = item.checks ?? [];
  const hardChecks = checks.filter((c) => hardIds.includes(c.id));
  const qualified = qualifies(item, spec);

  if (hardIds.length === 0) {
    return qualified ? "confirmed" : "rejected";
  }

  if (hardChecks.length === 0) {
    return "not-judged";
  }

  if (refused(item, spec) || hardChecks.some((c) => c.answer === "no")) {
    return "rejected";
  }

  const hasHardUnknown = new Set(hardChecks.map((c) => c.id)).size < hardIds.length || hardChecks.some((c) => c.answer === "unknown" || c.answer === undefined || c.answer === "" || c.pending);
  if (!qualified || hasHardUnknown) {
    return "to-confirm";
  }

  return "confirmed";
}

export function awaitsSecondFamily(item, hardIds) {
  const checks = item.checks ?? [];
  return hardIds.length > 0 && hardIds.every((id) => checks.some((c) => c.id === id && c.answer === 'yes')) && checks.some((c) => hardIds.includes(c.id) && c.pending);
}

export function hardIdsOf(checklist, kind = null) {
  const ids = [...new Set(checklist?.flatMap?.((cluster) => cluster.items?.filter((ci) => ci.hard).map((ci) => cluster.clause + "|" + ci.question) ?? []) ?? [])];
  if (checklist && kind?.label) {
    const kindId = kindCluster(kind).items[0].question;
    const id = 'kind|' + kindId;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function itemEvidence(item, hardIds, spec) {
  const checks = item.checks ?? [];
  const hardChecks = checks.filter((c) => hardIds.includes(c.id));

  if (hardIds.length === 0) {
    return { belief: qualifies(item, spec) ? 1 : 0, plausibility: qualifies(item, spec) ? 1 : 0, open: [] };
  }
  
  if (hardChecks.length === 0) {
    return { belief: 0, plausibility: 1, open: hardIds };
  }
  
  const yesCount = hardChecks.filter((c) => c.answer === "yes").length;
  const noCount = hardChecks.filter((c) => c.answer === "no").length;
  const unknownIds = hardChecks.filter((c) => c.answer === "unknown" || c.answer === undefined || c.answer === "" || c.pending).map((c) => c.id);
  
  const belief = yesCount / hardIds.length;
  const plausibility = 1 - noCount / hardIds.length;
  
  const missing = hardIds.filter((id) => !hardChecks.some((c) => c.id === id));

  return { belief, plausibility, open: [...unknownIds, ...missing] };
}

export function verdict(items, spec, checklist, kind = null) {
  const hardIds = hardIdsOf(checklist, kind);

  const itemsWithTier = items.map((item) => {
    const tier = itemTier(item, hardIds, spec);
    const support = itemEvidence(item, hardIds, spec);
    return { ...item, tier, support };
  });
  
  const tiers = {
    confirmed: itemsWithTier.filter((i) => i.tier === "confirmed"),
    "to-confirm": itemsWithTier.filter((i) => i.tier === "to-confirm"),
    rejected: itemsWithTier.filter((i) => i.tier === "rejected"),
    "not-judged": itemsWithTier.filter((i) => i.tier === "not-judged"),
  };
  
  const asked = spec?.itemCount ?? Math.max(1, items.length);
  const confirmedCount = tiers.confirmed.length;
  const short = asked > 0 && confirmedCount < asked;
  
  const sortedItems = [...itemsWithTier].sort((a, b) => {
    const tierOrder = { confirmed: 0, "to-confirm": 1, rejected: 2, "not-judged": 3 };
    const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
    if (tierDiff !== 0) return tierDiff;
    const softYesB = (b.checks ?? []).filter((c) => c.hard !== true && c.answer === "yes").length;
    const softYesA = (a.checks ?? []).filter((c) => c.hard !== true && c.answer === "yes").length;
    if (softYesB !== softYesA) return softYesB - softYesA;
    return b.support.belief - a.support.belief;
  });
  
  const perCheck = hardIds.map((id) => {
    const clause = items[0]?.checks?.find((c) => c.id === id)?.clause ?? id;
    const relevant = items.filter((i) => (i.checks ?? []).some((c) => c.id === id));
    const yes = relevant.filter((i) => (i.checks ?? []).some((c) => c.id === id && c.answer === "yes")).length;
    const no = relevant.filter((i) => (i.checks ?? []).some((c) => c.id === id && c.answer === "no")).length;
    const unknown = relevant.filter((i) => (i.checks ?? []).some((c) => c.id === id && (c.answer === "unknown" || c.answer === undefined || c.answer === ""))).length;
    return { id, clause, yes, no, unknown };
  });
  
  const judgedItems = items.filter((i) => (i.checks ?? []).some((c) => hardIds.includes(c.id)));
  const vague = perCheck
    .filter((c) => judgedItems.length >= 5 && c.unknown / judgedItems.length >= 0.5)
    .map((c) => c.id);
  
  const openClauses = [...new Set(tiers["to-confirm"].flatMap((i) => i.support.open))];
  const openClauseText = openClauses.length ? openClauses.map((id) => {
    const check = perCheck.find((c) => c.id === id);
    return check?.clause ?? id;
  }).join(", ") : "";
  
  let summary = confirmedCount + " of " + asked + " confirmed";
  if (tiers["to-confirm"].length) {
    summary += " \u00b7 " + tiers["to-confirm"].length + " to confirm";
    if (openClauseText) summary += " (open: " + openClauseText + ")";
  }
  if (tiers.rejected.length) summary += " \u00b7 " + tiers.rejected.length + " rejected";
  if (tiers["not-judged"].length) summary += " \u00b7 " + tiers["not-judged"].length + " not read";
  
  return {
    tiers: {
      confirmed: tiers.confirmed.length,
      toConfirm: tiers["to-confirm"].length,
      rejected: tiers.rejected.length,
      notJudged: tiers["not-judged"].length,
    },
    validCount: confirmedCount,
    asked,
    short,
    perCheck,
    vague,
    summary,
    items: sortedItems,
  };
}

export function acceptanceSummaryOf(project) {
  const result = project.acceptanceResult;
  if (result?.verdict?.summary) return result.verdict.summary;
  const asked = result?.totalAsked || project.acceptance?.itemCount;
  const spec = { ...(project.acceptance ?? {}), ...(asked ? { itemCount: asked } : {}) };
  return verdict(result?.items ?? [], spec, project.checklist, project.decisionModel?.kind ?? null).summary;
}

export function scoreOf(checks) {
  return checks.length ? checks.reduce((s, c) => s + Math.min(1, c.value), 0) / checks.length : 0;
}

const PRECONDITION_IDS = new Set(['count', 'live', 'range', 'mentions']);
const CHECKLIST_PREFIX = 'checklist-';
const NOT_READ = 'the page was not read';

export function headlineOf(verdictResult) {
  const { asked } = verdictResult;
  const confirmed = verdictResult.tiers.confirmed;
  const toConfirm = verdictResult.tiers.toConfirm;
  const reachable = Math.min(asked, confirmed + toConfirm);
  const upTo = confirmed >= asked ? '' : `up to ${reachable} of ${asked} could meet every must-have (${confirmed} confirmed + ${toConfirm} to confirm)`;
  return { headline: `${confirmed} of ${asked} meet every must-have`, upTo, confirmed, toConfirm, asked };
}

function checksHeadline(checks) {
  const passed = checks.filter((c) => c.passed).length;
  return { headline: `${passed} of ${checks.length} expected-result checks pass`, upTo: '', confirmed: 0, toConfirm: 0, asked: 0 };
}

function requirementRows(checks, perCheck) {
  return checks.filter((c) => !PRECONDITION_IDS.has(c.id)).map((c) => {
    const counted = perCheck.find((pc) => `${CHECKLIST_PREFIX}${pc.id}` === c.id);
    const row = { id: c.id, label: counted?.clause ?? c.label, share: c.value, detail: c.detail ?? '' };
    return counted ? { ...row, yes: counted.yes, no: counted.no, unknown: counted.unknown, judged: counted.yes + counted.no + counted.unknown } : row;
  });
}

function itemReasons(item, hardIds, spec) {
  const reasons = [];
  if (!item.live) reasons.push({ requirement: 'the link opens a page', answer: 'no', quote: '', reason: 'the page did not open' });
  if (spec?.valueRange && item.live && !item.inRange) reasons.push({ requirement: `value within ${spec.valueRange.join('–')} ${spec.unit ?? ''}`.trim(), answer: 'no', quote: '', reason: item.value === undefined || item.value === null ? 'no value read on the page' : `the page shows ${item.value} ${item.unit ?? ''}`.trim() });
  for (const criterion of item.purpose ?? []) {
    const state = purposeState(item, criterion);
    if (state !== 'yes') reasons.push({ requirement: criterion.label ?? criterion.id, answer: state, quote: '', reason: state === 'unknown' ? KIND_OPEN_REASON : criterion.detail ?? '' });
  }
  for (const id of hardIds) {
    const check = (item.checks ?? []).find((c) => c.id === id);
    const requirement = check?.clause ?? id;
    if (!check || check.notJudged) reasons.push({ requirement, answer: 'not judged', quote: '', reason: check?.reason ?? NOT_READ });
    else reasons.push({ requirement, answer: check.answer || 'unknown', quote: check.quote ?? '', reason: check.reason ?? '' });
  }
  return reasons;
}

export function verdictReport(project) {
  const result = project?.acceptanceResult;
  if (!result) return null;
  const kind = project.decisionModel?.kind ?? null;
  const spec = project.acceptance ?? {};
  const computed = result.verdict ?? verdict(result.items ?? [], { ...spec, ...(result.totalAsked ? { itemCount: result.totalAsked } : {}) }, project.checklist, kind);
  const checks = result.checks ?? [];
  const hardIds = hardIdsOf(project.checklist, kind);
  const listAsked = Boolean(result.totalAsked || spec.itemCount);
  return {
    ...(listAsked ? headlineOf(computed) : checksHeadline(checks)),
    summary: computed.summary,
    recheckCancelled: project.acceptanceRecheck?.cancelled ? `a later re-check was cancelled at ${project.acceptanceRecheck.at}; this is the last complete result` : '',
    requirements: requirementRows(checks, computed.perCheck ?? []),
    preconditions: checks.filter((c) => PRECONDITION_IDS.has(c.id)).map((c) => ({ id: c.id, label: c.label, value: c.value, passed: Boolean(c.passed), detail: c.detail ?? '' })),
    items: (computed.items ?? result.items ?? []).map((item) => ({ url: item.url, title: item.title ?? '', tier: item.tier ?? itemTier(item, hardIds, spec), reasons: itemReasons(item, hardIds, spec) })),
  };
}

export function verdictLines(report) {
  if (!report) return [];
  const lines = [report.upTo ? `${report.headline}; ${report.upTo}` : report.headline];
  for (const r of report.requirements) lines.push(`requirement: ${r.label} — ${r.judged === undefined ? `${Math.round(r.share * 100)}% of items` : `${r.yes} of ${r.judged} judged items meet it, ${r.no} do not, ${r.unknown} unknown`}`);
  for (const c of report.preconditions) lines.push(`precondition: ${c.label} — ${c.passed ? 'passes' : 'fails'} (${c.detail})`);
  return lines;
}

export function verdictInvariants(project, { memo = true } = {}) {
  const reasons = [];
  const acceptanceResult = project.acceptanceResult;
  const checklist = project.checklist;
  const kind = project.decisionModel?.kind ?? null;

  if (!acceptanceResult || !checklist) return [];

  const hardIds = hardIdsOf(checklist, kind);
  const verdictResult = verdict(acceptanceResult.items, project.acceptance, checklist, kind);

  if (acceptanceResult.validCount !== verdictResult.validCount) {
    reasons.push("validCount mismatch: acceptanceResult=" + acceptanceResult.validCount + " verdict=" + verdictResult.validCount);
  }

  for (const item of verdictResult.items.filter((i) => i.tier === "confirmed")) {
    for (const hardId of hardIds) {
      const check = item.checks?.find((c) => c.id === hardId);
      if (!check || check.answer !== "yes") {
        reasons.push("confirmed item " + item.url + " missing yes on hard check " + hardId);
        break;
      }
    }
  }

  if (project.acceptance?.itemCount && !checklist?.length) {
    reasons.push("acceptance.itemCount set but decisionModel has no checklist items");
  }

  const countCheck = acceptanceResult.checks?.find((c) => c.id === 'count');
  if (countCheck) {
    const itemCount = project.acceptance?.itemCount ?? Math.max(1, acceptanceResult.items.length);
    const expectedValue = Math.min(1, verdictResult.validCount / itemCount);
    if (Math.abs(countCheck.value - expectedValue) > 0.001) {
      reasons.push("count check value mismatch: got " + countCheck.value + " expected " + expectedValue);
    }
  }

  const newChecks = acceptanceResult.checks?.filter((c) => !c.id.startsWith('checklist-')) ?? [];
  for (const pc of verdictResult.perCheck) {
    const total = pc.yes + pc.no + pc.unknown;
    const rate = total ? pc.yes / total : 0;
    newChecks.push({ id: `checklist-${pc.id}`, label: `Checklist: ${pc.clause}`, value: Math.round(Math.min(1, rate) * 1000) / 1000 });
  }
  const expectedScore = scoreOf(newChecks);
  if (Math.abs((acceptanceResult.score ?? 0) - expectedScore) > 0.001) {
    reasons.push("score mismatch: got " + acceptanceResult.score + " expected " + Math.round(expectedScore * 1000) / 1000);
  }

  const status = project.report?.status;
  if (memo && status?.acceptanceContradictionKind === 'short') {
    const summary = acceptanceSummaryOf(project);
    if (status.acceptanceContradiction !== summary) {
      reasons.push("memo acceptance text mismatch: memo says '" + status.acceptanceContradiction + "' but the verdict summary is '" + summary + "'");
    }
  }

  return reasons;
}

export function runOutcome(project) {
  const asked = project?.acceptanceResult?.totalAsked ?? 0;
  const confirmed = project?.acceptanceResult?.validCount ?? 0;
  if (project?.phase !== 'done') return { state: project?.phase, confirmed, asked };
  return { state: asked > 0 && confirmed < asked ? 'short' : 'met', confirmed, asked };
}
