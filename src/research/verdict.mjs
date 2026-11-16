export function itemTier(item, hardIds, spec) {
  const checks = item.checks ?? [];
  const hardChecks = checks.filter((c) => hardIds.includes(c.id));
  const qualifiesResult = item.qualifies ?? qualifies(item, spec);

  if (hardIds.length === 0) {
    return qualifiesResult ? "confirmed" : "rejected";
  }
  
  if (hardChecks.length === 0) {
    return "not-judged";
  }
  
  const hasHardNo = hardChecks.some((c) => c.answer === "no");
  if (hasHardNo || !qualifiesResult) {
    return "rejected";
  }
  
  const hasHardUnknown = hardChecks.some((c) => c.answer === "unknown" || c.answer === undefined || c.answer === "");
  if (hasHardUnknown) {
    return "to-confirm";
  }
  
  return "confirmed";
}

function qualifies(item, spec) {
  const entity = Boolean(item.evidence);
  return Boolean(item.live && (entity || item.listing) && (!spec?.valueRange || item.inRange) && (item.purpose ?? []).every((c) => c.passed));
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
  const unknownIds = hardChecks.filter((c) => c.answer === "unknown" || c.answer === undefined || c.answer === "").map((c) => c.id);
  
  const belief = yesCount / hardIds.length;
  const plausibility = 1 - noCount / hardIds.length;
  
  return { belief, plausibility, open: unknownIds };
}

export function verdict(items, spec, checklist) {
  const hardIds = [...new Set(checklist?.flatMap?.((cluster) => cluster.items?.filter((ci) => ci.hard).map((ci) => cluster.clause + "|" + ci.question) ?? []) ?? [])];
  const kindHardId = checklist?.some?.((cluster) => cluster.clause === "kind") ? "kind|Is this page one car listing offered as asked (not a part, accessory, wanted ad or list and not wanted, parts, accessories, retail)?" : null;
  if (kindHardId && !hardIds.includes(kindHardId)) {
    hardIds.push(kindHardId);
  }
  
  const itemsWithTier = items.map((item) => {
    const tier = itemTier(item, hardIds, spec);
    const evidence = itemEvidence(item, hardIds, spec);
    return { ...item, tier, evidence };
  });
  
  const tiers = {
    confirmed: itemsWithTier.filter((i) => i.tier === "confirmed"),
    "to-confirm": itemsWithTier.filter((i) => i.tier === "to-confirm"),
    rejected: itemsWithTier.filter((i) => i.tier === "rejected"),
    "not-judged": itemsWithTier.filter((i) => i.tier === "not-judged"),
  };
  
  const asked = spec.itemCount ?? Math.max(1, items.length);
  const confirmedCount = tiers.confirmed.length;
  const short = asked > 0 && confirmedCount < asked;
  
  const sortedItems = [...itemsWithTier].sort((a, b) => {
    const tierOrder = { confirmed: 0, "to-confirm": 1, rejected: 2, "not-judged": 3 };
    const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
    if (tierDiff !== 0) return tierDiff;
    const softYesB = (b.checks ?? []).filter((c) => c.hard !== true && c.answer === "yes").length;
    const softYesA = (a.checks ?? []).filter((c) => c.hard !== true && c.answer === "yes").length;
    if (softYesB !== softYesA) return softYesB - softYesA;
    return b.evidence.belief - a.evidence.belief;
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
  
  const openClauses = [...new Set(tiers["to-confirm"].flatMap((i) => i.evidence.open))];
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

export function verdictInvariants(project) {
  const reasons = [];
  const acceptanceResult = project.acceptanceResult;
  const checklist = project.checklist;
  
  if (!acceptanceResult || !checklist) return [];
  
  const hardIds = [...new Set(checklist.flatMap((cluster) => cluster.items.filter((ci) => ci.hard).map((ci) => cluster.clause + "|" + ci.question)))];
  const verdictResult = verdict(acceptanceResult.items, project.acceptance, checklist);
  
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
  
  return reasons;
}
