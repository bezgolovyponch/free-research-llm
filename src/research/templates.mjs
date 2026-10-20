export const TEMPLATES = [
  {
    id: 'generic',
    label: 'Any analytical question',
    example: 'Should I open a specialty coffee kiosk in a mid-size European city, and which city gives the best payback?',
    fields: [
      { key: 'location', label: 'Where (country / region)', placeholder: 'e.g. Czech Republic' },
      { key: 'budget', label: 'Budget / capital', placeholder: 'e.g. €40,000' },
      { key: 'horizon', label: 'Time horizon', placeholder: 'e.g. 24 months' },
      { key: 'success', label: 'What counts as success', placeholder: 'e.g. payback < 18 months' },
    ],
    drivers: 'Demand / market size; supply & competition; unit economics (revenue, costs, margin); regulation & legal constraints; risks & failure modes; timing / trend.',
    metrics: 'market size, price, volume, margin, payback period, ROI, risk-adjusted outcome',
    sources: 'official statistics offices, industry reports, company pages, regulators, reputable news',
    decisionRule: 'State the decision as GO / NO-GO / GO-IF with the threshold that flips it.',
  },
  {
    id: 'competitive-strategy',
    label: 'Competitive strategy / action plan',
    example: 'Create an action plan to grow https://example-startup.com against its main competitors in the EU and US within 6 months',
    fields: [
      { key: 'market', label: 'Market / field', placeholder: 'e.g. AI drug discovery' },
      { key: 'geo', label: 'Where', placeholder: 'e.g. EU, US, UK' },
      { key: 'horizon', label: 'Time horizon', placeholder: 'e.g. 6 months' },
      { key: 'success', label: 'What counts as success', placeholder: 'e.g. 3 new pharma pilots' },
    ],
    drivers: 'Each competitor\'s capabilities and recent moves (products, models, papers, code, launches); customer segments and what triggers a purchase (case studies, job posts, conference talks); pricing and business models (pricing pages, licences); partnerships and channels (press releases, alliances); differentiation gaps and opportunities; execution constraints (regulation, talent, data access).',
    metrics: 'features present/absent per competitor, public customers and partners, announced deals, prices per plan, publications and repository activity, hiring signals',
    sources: 'the companies\' own websites and pricing pages, GitHub repositories, papers (arXiv, bioRxiv, PubMed), press releases, official registers, conference talks, job boards, reputable trade press; avoid market-report teaser pages',
    decisionRule: 'Rank concrete actions by the evidence behind them and their impact; name the piece ids each action rests on.',
  },
  {
    id: 'glamping-location',
    label: 'Glamping / hospitality location',
    example: 'Where in Czech Republic should I build a 6-unit glamping site to reach >60% annual occupancy and pay back within 4 years?',
    fields: [
      { key: 'region', label: 'Country / candidate regions', placeholder: 'e.g. Czech Republic: Šumava, Krkonoše, České Švýcarsko' },
      { key: 'units', label: 'Units & type', placeholder: 'e.g. 6 safari tents + sauna' },
      { key: 'budget', label: 'Capex budget', placeholder: 'e.g. €250,000' },
      { key: 'success', label: 'Target', placeholder: 'e.g. 60% occupancy, payback 4 years' },
    ],
    drivers: 'Demand (tourist nights, drive-time from big cities, seasonality, events); competition & achievable ADR (nightly rate) from comparable listings; land availability & price / lease; zoning, building permits, protected-area rules; access & utilities (water, power, road, internet); capex per unit and opex; climate & season length; payback and sensitivity to occupancy.',
    metrics: 'tourist overnight stays per region, ADR, occupancy %, RevPAR, land price per m², capex per unit, annual opex, payback years, IRR',
    sources: 'national statistics (tourism overnight stays), booking/Airbnb comparable listings, land listings, municipal zoning plans, protected-area authorities, weather normals',
    decisionRule: 'Rank candidate locations by risk-adjusted payback; GO for top location only if base case beats the target and the permit path is realistic.',
  },
  {
    id: 'taxes',
    label: 'Taxes (structure, liability, optimisation)',
    example: 'As an IT freelancer in Czech Republic earning €70,000/year, is the flat-rate tax (paušální daň), lump-sum expenses or an s.r.o. company cheaper in 2026, including social and health insurance?',
    fields: [
      { key: 'jurisdiction', label: 'Country (and region)', placeholder: 'e.g. Czech Republic' },
      { key: 'year', label: 'Tax year', placeholder: 'e.g. 2026' },
      { key: 'income', label: 'Income & type', placeholder: 'e.g. €70,000 freelance IT invoices' },
      { key: 'situation', label: 'Situation', placeholder: 'e.g. resident, no employees, no dependants' },
    ],
    drivers: 'Applicable regimes and eligibility conditions; tax base computation per regime (rates, brackets, allowances, deductible expenses); social and health contributions per regime; VAT registration thresholds and obligations; admin/compliance costs and deadlines; risks (reclassification, dependent activity rules, audits); total effective burden per regime at the stated income.',
    metrics: 'tax base, income tax, social contribution, health contribution, VAT impact, admin cost, total burden, effective rate %, net take-home',
    sources: 'official tax authority pages and current-year acts, official calculators, government gazette, Big-4 country tax summaries',
    decisionRule: 'Compute total burden per eligible regime with formulas; recommend the cheapest compliant option and list the eligibility conditions that must hold. Not legal advice — confirm with a licensed tax advisor before filing.',
  },
  {
    id: 'market-sizing',
    label: 'Market size / opportunity',
    example: 'How big is the market for e-bike rentals for tourists in Prague, and how many bikes would a new entrant need to break even?',
    fields: [
      { key: 'market', label: 'Product / market', placeholder: 'e.g. tourist e-bike rentals' },
      { key: 'geo', label: 'Geography', placeholder: 'e.g. Prague' },
      { key: 'horizon', label: 'Horizon', placeholder: 'e.g. 3 years' },
    ],
    drivers: 'Top-down size (population/visitors × adoption × spend); bottom-up size (competitors × capacity × utilisation × price); growth trend; competitive density and share capture; unit economics and break-even volume.',
    metrics: 'TAM/SAM/SOM, price, utilisation, competitors count, share, break-even units',
    sources: 'statistics offices, tourism boards, competitor sites and listings, industry reports',
    decisionRule: 'Triangulate top-down and bottom-up; if they disagree by >2x, flag it and explain which to trust.',
  },
];

export function templateById(id) {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}

export function suggestTemplate(question) {
  const q = String(question ?? '').toLowerCase();
  if (/glamp|camp|cabin|hotel|guesthouse|airbnb|occupancy|hospitality|holiday (home|rental)/.test(q)) return 'glamping-location';
  if (/\btax|vat|dph|deduct|s\.r\.o|llc|self-employ|freelanc|social (insurance|security)|payroll/.test(q)) return 'taxes';
  if (/compet|rival|\bvs\.?\b|versus|strateg|action plan|go[- ]to[- ]market|positioning|differentiat|outperform|beat\b/.test(q)) return 'competitive-strategy';
  if (/market size|how big|tam|sam|som|break even|break-even/.test(q)) return 'market-sizing';
  return 'generic';
}
