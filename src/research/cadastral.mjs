import { cadastralTree, cadastralCheck, CADASTRAL_GATES, cadastralFinding } from '../search/cadastral.mjs';
export { cadastralTree, cadastralCheck, CADASTRAL_GATES, cadastralFinding } from '../search/cadastral.mjs';

export const NEXT_NODE_ID = (parentId, n) => `${parentId}.${n}`;

export function cadastralResearchPlan(countryCode, parcelRef) {
  const root = 'Q';
  const nodes = cadastralTree(root, countryCode, parcelRef);
  const driver = nodes.find((n) => n.id === `${root}.1`) ?? nodes[0];
  const subQuestions = nodes
    .filter((n) => n.id !== driver.id)
    .map((n, i) => ({
      id: `${root}.2.${i + 1}`,
      parentId: driver.id,
      title: `Verify ${n.title.toLowerCase()} on the record`,
      question: `For ${parcelRef ?? 'the parcel'} in ${countryCode}: ${n.question}`,
      method: n.method,
      searchQueries: n.searchQueries ?? [],
      sourceUrls: n.sourceUrls ?? [],
      impact: n.impact,
      uncertainty: n.uncertainty,
      dependsOn: [driver.id],
    }));
  return { root, driver, subQuestions };
}

export function cadastralGateVerdict(row) {
  const checks = CADASTRAL_GATES.map((g) => ({ ...cadastralCheck(row, g.id), label: g.label }));
  const failed = checks.filter((c) => c.ok === false);
  const unknown = checks.filter((c) => c.ok === null);
  const tier = failed.length ? 'weak' : unknown.length ? 'unverified' : 'fits';
  return { tier, checks, failed: failed.map((c) => c.label), pending: unknown.map((c) => c.label) };
}

export function cadastralExplain(row) {
  const finding = row.finding ?? {};
  const why = [];
  if (finding.parcelRef) why.push(`cadastral reference ${finding.parcelRef} on record`);
  if (finding.boundaryCount) why.push(`${finding.boundaryCount} boundary elements mapped`);
  if (finding.surfaceM2) why.push(`surface ${finding.surfaceM2} m²`);
  if (finding.pricePerM2) why.push(`comparable €${finding.pricePerM2.toFixed(2)}/m²`);
  if (finding.zoning) why.push(`zoning: ${finding.zoning}`);
  const trade = [];
  if (!finding.parcelRef) trade.push('no cadastral reference found — start from the parcel address or map point');
  if (!finding.boundaryCount) trade.push('boundaries not mapped — exact surface is uncertain');
  if (finding.sharedTitle) trade.push('shared title — buyer gets a share, not a whole parcel');
  if (finding.encumbrance) trade.push('encumbrance on title — may block or delay the purchase');
  return { why, trade };
}

export function cadastralPlan(row) {
  const fields = cadastralFinding(row.finding ?? {});
  const checks = CADASTRAL_GATES.map((g) => ({ ...cadastralCheck({ finding: fields }, g.id), label: g.label }));
  const failed = checks.filter((c) => c.ok === false);
  const unknown = checks.filter((c) => c.ok === null);
  const tier = failed.length ? 'weak' : unknown.length ? 'unverified' : 'fits';
  const { why, trade } = cadastralExplain({ finding: fields });
  const verdict = tier === 'fits'
    ? 'fits every cadastral gate'
    : tier === 'weak'
      ? `does not fit: ${failed.map((c) => c.label).join('; ')}`
      : `to confirm: ${unknown.map((c) => c.label).join('; ')}`;
  const measured = checks.filter((c) => c.ok !== null);
  const share = measured.length ? Math.round((measured.filter((c) => c.ok).length / checks.length) * 100) / 100 : 0;
  return { tier, verdict, checks, why, tradeoffs: trade, risks: [], share, sources: [] };
}