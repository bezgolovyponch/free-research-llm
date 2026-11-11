const ITEMS = [
  {
    id: 'F1',
    rule: 'Purpose before sources',
    why: 'Why the user asks, what value the answer creates and what it needs are decided before any search',
    source: 'Keeney value-focused thinking; Cochrane MECIR C5-C13',
    enforcedBy: [
      ['src/research/decision.mjs', 'DecisionModeler'],
      ['src/research/decision.mjs', 'decisionPrompt'],
    ],
  },
  {
    id: 'F2',
    rule: 'A model proposes, code decides',
    why: 'Every result passes a mechanical gate; a model never grades its own output',
    source: 'ALCE citation checking; self-preference bias arXiv 2404.13076',
    enforcedBy: [
      ['src/research/verify.mjs', 'verifyFinding'],
      ['src/llm/ranking.mjs', 'familyOf'],
    ],
  },
  {
    id: 'F3',
    rule: "Criteria and counts come from the user's words",
    why: 'Checks and item counts the user did not ask for are not invented',
    source: 'PRISMA eligibility criteria',
    enforcedBy: [
      ['src/research/grounding.mjs', 'groundAcceptance'],
      ['src/research/strategy.mjs', 'askedCriteria'],
      ['src/research/acceptance.mjs', 'itemCountFromWords'],
    ],
  },
  {
    id: 'F4',
    rule: 'Listings first, tree pieces only for what listings cannot show',
    why: 'Identify and screen items by reading marketplaces in code when a portal lists the kind; for a kind no portal lists (suppliers, companies) the pieces find the items and the asked place is where the result is used',
    source: 'Systematic review flow: identification, screening, appraisal',
    enforcedBy: [
      ['src/research/sweep.mjs', 'CandidateSweeper'],
      ['src/research/treeaudit.mjs', 'markListingWork'],
      ['src/research/portals.mjs', 'listedKind'],
    ],
  },
  {
    id: 'F5',
    rule: 'Generic readers first, a learned schema only when proven',
    why: 'JSON-LD, embedded JSON and cards before a site schema; a schema is kept only when it reads the priced listings',
    source: 'crawl4ai schema method; extruct',
    enforcedBy: [
      ['src/research/sweep.mjs', 'needsSchema'],
      ['src/search/schema.mjs', 'verifySchema'],
    ],
  },
  {
    id: 'F6',
    rule: 'What counts as an item is calibrated on real titles',
    why: "The kind's exclusion words come from a 3-sample majority over fetched titles",
    source: 'Self-consistency arXiv 2203.11171',
    enforcedBy: [
      ['src/research/decision.mjs', 'mergeCalibrations'],
      ['src/research/decision.mjs', 'applyCalibration'],
    ],
  },
  {
    id: 'F7',
    rule: 'Outliers by robust statistics',
    why: 'Too-cheap rows are found by median - 2.5 x 1.4826 x MAD on log price',
    source: 'Leys et al. 2013, J. Exp. Soc. Psychol. 49(4)',
    enforcedBy: [
      ['src/research/candidates.mjs', 'implausiblyLow'],
      ['src/research/strategy.mjs', 'implausiblyCheap'],
    ],
  },
  {
    id: 'F8',
    rule: 'Value from adjusted comparables, never from thin facts',
    why: 'A value is the median of at least 5 adjusted comparables of the same model within ±2 years, with an 80% interval from the method\'s own leave-one-out errors; facts come from each ad page; asking prices, and a low price can reflect hidden quality',
    source: 'Ohta & Griliches 1976; Engers, Hartmann & Stern 2009; Lessmann & Voß 2017; Barber et al., Annals of Statistics 2021; Blundell et al., Quantitative Economics 2026',
    enforcedBy: [
      ['src/research/valuation.mjs', 'valueListing'],
      ['src/research/valuation.mjs', 'theilSen'],
      ['src/research/valuation.mjs', 'pooledSlopes'],
      ['src/research/valuation.mjs', 'calibrate'],
    ],
  },
  {
    id: 'F9',
    rule: 'Owner and expert facts only when quoted',
    why: 'A community claim counts only when its quote is found on the cited page',
    source: 'Chain-of-Verification arXiv 2309.11495',
    enforcedBy: [
      ['src/research/engine.mjs', 'verifiedGroupFacts'],
    ],
  },
  {
    id: 'F10',
    rule: 'Evidence must be on topic',
    why: 'A page enters only when it covers the asked topic',
    source: 'Corrective RAG arXiv 2401.15884',
    enforcedBy: [
      ['src/research/evidence.mjs', 'topicCoverage'],
      ['src/research/evidence.mjs', 'retrievalVerdict'],
    ],
  },
  {
    id: 'F11',
    rule: 'The table is the result; the memo cannot overrule it',
    why: "Counts are computed by code and the memo's numbers are checked against them",
    source: 'DeLLMa arXiv 2402.02392',
    enforcedBy: [
      ['src/research/candidates.mjs', 'shortlistText'],
      ['src/research/candidates.mjs', 'tableVerdict'],
      ['src/research/memocheck.mjs', 'checkMemoClaims'],
    ],
  },
  {
    id: 'F12',
    rule: 'Ranking without hand weights',
    why: 'Proposals are ordered by non-dominated sorting over measured values',
    source: 'NSGA-II, Deb et al. 2002',
    enforcedBy: [
      ['src/research/proposal.mjs', 'paretoLayers'],
    ],
  },
  {
    id: 'F13',
    rule: 'Models are routed by measured outcomes',
    why: 'Gate pass rates per provider and purpose (decayed Beta, Thompson sampling), time per useful answer and rests on limits',
    source: 'Thompson sampling arXiv 1111.1797; FrugalGPT arXiv 2305.05176',
    enforcedBy: [
      ['src/llm/outcomes.mjs', 'OutcomeBook'],
      ['src/llm/ranking.mjs', 'purposePlan'],
    ],
  },
  {
    id: 'F14',
    rule: 'Results are audited on live data',
    why: 'Concept checks run on every research and show in Notifications',
    source: 'Chain-of-Verification arXiv 2309.11495',
    enforcedBy: [
      ['src/research/conceptaudit.mjs', 'conceptAudit'],
    ],
  },
];

export const FUNDAMENTALS = Object.freeze(ITEMS.map((item) => Object.freeze({
  ...item,
  enforcedBy: Object.freeze(item.enforcedBy.map((pair) => Object.freeze([...pair]))),
})));
