import { plain } from './itemgate.mjs';
import { zoningOf, explorePoints } from './site.mjs';

export const STRATEGY_TTL_MS = 7 * 24 * 3600 * 1000;

export const GLAMPING_LOW_ENTRY = {
  id: 'glamping-low-entry',
  templates: ['glamping-location'],
  label: 'Low-entry glamping: buy cheap land, open a small legal camping site, start with a few tent units',
  checkedAt: '2026-10-26',
  sources: [
    { id: 'pt-park', title: 'AC Arquitetos: parques de campismo, o que a lei exige (Portaria 1320/2008)', url: 'https://www.ac-arquitetos.com/post/parques-de-campismo-e-caravanismo-o-que-a-lei-portuguesa-exige-antes-de-abrir-portas', quotes: ['não pode exceder 60% da área total do parque', 'bungalows, mobile homes, glamping', 'nem a menos de 1000 metros de indústrias insalubres'] },
    { id: 'pt-rural', title: 'AC Arquitetos: parques de campismo rural, Portaria 1320/2008 art. 32', url: 'https://www.ac-arquitetos.com/post/parques-de-campismo-e-caravanismo-em-portugal-o-que-e-preciso-para-os-instalar-e-explorar', quotes: ['Área máxima do terreno: 5 000 m²', 'Capacidade máxima: 30 instalações e 90 campistas', '3 estrelas 18 m² 40 m²', 'só podem existir se os instrumentos de gestão territorial o permitirem'] },
    { id: 'pt-tax', title: 'CMS Expert Guide: Portugal real estate purchase costs', url: 'https://cms.law/en/INT/Expert-Guides/CMS-Expert-Guide-to-Commercial-Real-Estate/Portugal', quotes: ['The IMT rate is 5% for rural land and 6.5% for other urban properties', 'levied on the transfer of property ownership at 0.8%'] },
    { id: 'es-glamping', title: 'Legal Today: el glamping, una inversión con una compleja regulación (2025)', url: 'https://www.legaltoday.com/practica-juridica/derecho-civil/el-glamping-una-nueva-forma-de-inversion-inmobiliaria-con-una-compleja-regulacion-2025-01-29/', quotes: ['se implanta normalmente en suelo no urbanizable', 'Castilla-La Mancha, Aragón o Cataluña se han creado la modalidad del'] },
    { id: 'es-tax', title: 'Gibobs: ITP 2026 por comunidad autónoma', url: 'https://www.gibobs.com/blog/itp-2026/', quotes: ['Galicia 10 %', 'Comunidad Valenciana 10 %', 'Cantabria 10 %'] },
    { id: 'tr-foreign', title: 'Gratanet: land rights for foreign investors in Türkiye', url: 'https://gratanet.com/publications/land-rights-for-foreign-investors-in-turkiye', quotes: ['Agricultural lands may be acquired only subject to project development obligations within two years', '30 hectares per person nationwide'] },
    { id: 'tr-glamping', title: 'FFK Partner Hukuk: glamping tesisi kurmak için gerekli izinler (2026)', url: 'https://www.ffkpartnerhukuk.com.tr/glamping-tesisi-kurmak-icin-gerekli-izinler-2026-guncel-hukuk-rehberi/', quotes: ['Tarım arazilerinde özel sınırlamalar bulunabilir', 'Kültür ve Turizm Bakanlığı tarafından düzenlenen uygun turizm belgesinin'] },
    { id: 'tr-tax', title: 'Milliyet: 2026 tapu harcı', url: 'https://www.milliyet.com.tr/emlak/tapu-devir-ucreti-nedir-2026-tapu-harci-masrafi-ne-kadar-oldu-6515059', quotes: ["yüzde 2'sini alıcı"] },
    { id: 'vn-land', title: 'IFLR: Vietnam legal framework on foreign real estate ownership (2026)', url: 'https://www.iflr.com/article/2gi4ti8i1tgysiu7sddz4/sponsored/an-overview-of-vietnams-legal-framework-on-foreign-real-estate-ownership', quotes: ['direct private ownership of land is not permitted', 'may only buy directly from authorised developers'] },
    { id: 'tent', title: 'Boutique Camping: 5m Bell Tent Pro (shop data, GBP)', url: 'https://boutiquecamping.com/products/bell-tent-pro-5m.json', quotes: ['"price":"729.00"', '"price_currency":"GBP"'] },
    { id: 'units', title: 'TouchStay: glamping startup costs example (three units)', url: 'https://touchstay.com/blog/unlocking-glamping-profits', quotes: ['a glamping site with three luxury yurts'] },
    { id: 'eurostat', title: 'Eurostat house price index, annual rate of change (prc_hpi_a)', url: 'https://ec.europa.eu/eurostat/databrowser/view/prc_hpi_a/default/table', quotes: [] },
  ],
  rules: {
    minUnits: { value: 3, source: 'units' },
    pitchM2: { value: 40, source: 'pt-rural' },
    campingShare: { value: 0.6, source: 'pt-park' },
    ruralMaxM2: { value: 5000, source: 'pt-rural' },
    ruralMaxUnits: { value: 30, source: 'pt-rural' },
    tent: { value: 729, currency: 'GBP', source: 'tent' },
    minWorkableMonths: { value: 10, source: 'question' },
    maxHottest: { value: 31, source: 'assumption' },
    ebikeKm: { value: 20, source: 'guidance' },
    trendAboveEu: { value: true, source: 'eurostat' },
  },
  criteria: [
    { id: 'kind', label: 'a plot of land for sale', words: /\b(?:plot|land|terreno|parcel)/i, measure: 'item gate on every listing (kind, sale, single page)' },
    { id: 'price', label: 'price within the budget', words: /\d[\d.,\s]*(?:eur|€|euro)|\bmax\b|budget/i, measure: 'price read from the listing, converted at ECB rates' },
    { id: 'region', label: 'in the countries you named', words: null, measure: 'country from the site address, language or listing text' },
    { id: 'sea', label: 'sea within an e-bike ride', words: /\b(?:sea|ocean|coast|beach|e-?bike)/i, measure: 'distance to the OpenStreetMap coastline from the listing location' },
    { id: 'season', label: 'workable months a year', words: /\bmonths?\b|season|climate|weather/i, measure: 'Open-Meteo daily weather 2021–2025 at the listing' },
    { id: 'noAc', label: 'mild: no air conditioning', words: /\bmild\b|air ?condition|temperature|heat/i, measure: 'hottest month average daily high, Open-Meteo 2021–2025' },
    { id: 'trend', label: 'strong price increase trend', words: /price increase|\btrend\b|appreciat|grow/i, measure: 'Eurostat house price index of the country vs the EU average (country level, not land)' },
    { id: 'entry', label: 'very low entry investment', words: /entr(?:y|ance)|enterance|low invest|investment|\bcosts?\b|afford/i, measure: 'price + transfer tax + three bell tents, per country' },
    { id: 'units', label: 'room for a glamping site', words: /glamping|camp/i, measure: 'units at 40 m² on 60% of the land (Portaria 1320/2008)' },
    { id: 'demand', label: 'guests nearby', words: /glamping business|demand|touris|occupan|overnight|\bADR\b/i, measure: 'campsites and lodging within 15 km (OpenStreetMap)' },
    { id: 'legal', label: 'a legal path to run glamping', words: /glamping|business|camp|zoning|permit|regulat|legal|licen/i, measure: 'country path, foreign-buyer rules and industrial-site rule' },
  ],
  countries: {
    PT: {
      path: 'Rural camping park with glamping units (Portaria 1320/2008 art. 32: up to 5,000 m² and 30 units; RJET art. 19 allows glamping in camping parks)',
      tax: { agricultural: 0.058, buildable: 0.073, 'not stated': 0.073 },
      taxLabel: 'IMT 5% (rural) or 6.5% (urban) + stamp duty 0.8%',
      sources: ['pt-park', 'pt-rural', 'pt-tax'],
      risks: ['the municipal plan (PDM) must allow a rural camping park on this land; ask the Câmara before buying'],
      agriculturalRisk: 'rustic land: check RAN/REN status with the Câmara',
    },
    ES: {
      path: 'Tourist camping or "alojamiento singular" on non-urbanizable land, allowed by the municipality (sometimes through a Plan Especial)',
      tax: { agricultural: 0.1, buildable: 0.1, 'not stated': 0.1 },
      taxLabel: 'ITP 10% (general rate in Galicia, Valencia, Cantabria; Andalucía 7%; Cataluña 10–13%)',
      sources: ['es-glamping', 'es-tax'],
      risks: ['the regional camping decree and the municipality decide; confirm urban compatibility before buying'],
      agriculturalRisk: '',
    },
    TR: {
      path: 'Tourism-certified camp site (Ministry of Culture and Tourism document); on agricultural land a non-agricultural use permit first',
      tax: { agricultural: 0.02, buildable: 0.02, 'not stated': 0.02 },
      taxLabel: 'title-deed fee 2% paid by the buyer',
      sources: ['tr-glamping', 'tr-foreign', 'tr-tax'],
      risks: ['a foreign individual buying land must submit a development project within two years (Law 2644)'],
      agriculturalRisk: 'tarla: glamping needs a non-agricultural use permit, unpermitted use is fined and demolished',
    },
    VN: {
      blocker: 'a foreign individual cannot hold land in Vietnam (land stays with the state; foreigners buy only from authorised developers); fits only a Vietnamese national',
      sources: ['vn-land'],
    },
  },
};

const STRATEGIES = [GLAMPING_LOW_ENTRY];
const INDUSTRIAL = /zona industrial|industrial zone|estaleiro|armaz[eé]m|pol[ií]gono industrial|sanayi/i;
const SHARED_TITLE = /hisseli|hisse(?:li)? tapu|shared title|quota[- ]part/i;
const STRONG_EXPLORE = 20;

export function strategyFor(templateId) {
  return STRATEGIES.find((s) => s.templates.includes(templateId)) ?? null;
}

export function criteriaOfText(strategy, text) {
  return (strategy?.criteria ?? []).filter((c) => c.words?.test(String(text ?? ''))).map((c) => c.id);
}

export function clausesOf(question) {
  return String(question ?? '').split(/,|;|\bbut also\b|\band also\b|\bso\b/i).map((c) => c.trim()).filter((c) => c.split(/\s+/).length >= 2);
}

export function foundationOf(strategy, project) {
  const question = String(project?.question ?? '');
  const guidance = String(project?.guidance ?? '');
  const months = question.match(/(\d{1,2})\s*months?\b/i);
  const km = guidance.match(/about\s+(\d{1,3})\s*km/i);
  const rules = {
    ...strategy.rules,
    ...(months ? { minWorkableMonths: { value: Math.min(12, Number(months[1])), source: 'question' } } : {}),
    ...(km ? { ebikeKm: { value: Number(km[1]), source: 'guidance' } } : {}),
  };
  const clauses = clausesOf(question).map((text) => ({ text, criteria: criteriaOfText(strategy, text) }));
  const modelled = clauses.filter((c) => c.criteria.length);
  return { rules, criteria: strategy.criteria.map(({ id, label, measure }) => ({ id, label, measure })), clauses, complete: modelled.length === clauses.length, missing: clauses.filter((c) => !c.criteria.length).map((c) => c.text) };
}

export function foundationText(foundation) {
  if (!foundation) return '';
  const r = foundation.rules;
  const lines = [`Decision model (code checks every listing against it; a listing counts only when every check is measured and met): sea within ${r.ebikeKm.value} km by e-bike; at least ${r.minWorkableMonths.value} workable months; hottest month at most ${r.maxHottest.value} °C (no air conditioning${r.maxHottest.source === 'assumption' ? '; this limit is assumed, not taken from your words or a source' : ''}); room for ${r.minUnits.value}+ units; a legal path for the buyer; country price trend above the EU average; entry cost = price + transfer tax + ${r.minUnits.value} bell tents.`];
  if (foundation.missing.length) lines.push(`Not modelled yet (no code check): ${foundation.missing.join('; ')}`);
  return lines.join('\n');
}

export function quoteFound(text, quote) {
  return plain(String(text ?? '').replace(/\s+/g, ' ')).includes(plain(quote.replace(/\s+/g, ' ')));
}

export function areaM2(row) {
  const area = Number(row.area);
  if (!Number.isFinite(area) || area <= 0) return null;
  const unit = plain(row.areaUnit ?? '');
  if (/^(?:ha|hectares?)$/.test(unit)) return area * 10000;
  if (/^acres?$/.test(unit)) return Math.round(area * 4046.86);
  if (/^d[oö]n[uü]m$/.test(plain(unit))) return area * 1000;
  return area;
}

export function unitsFor(m2, rules) {
  if (!m2) return null;
  return Math.min(rules.ruralMaxUnits.value, Math.floor((Math.min(m2, rules.ruralMaxM2.value) * rules.campingShare.value) / rules.pitchM2.value));
}

const eur = (n) => `€${Math.round(n).toLocaleString('en-US')}`;
const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

export function entryCost(row, country, units, rules, convert) {
  if (!country?.tax || !Number.isFinite(row.value)) return null;
  const zoning = zoningOf(row);
  const rate = country.tax[zoning] ?? country.tax['not stated'];
  const tentEur = convert ? convert(rules.tent.value, rules.tent.currency, 'EUR') : null;
  const tents = Number.isFinite(tentEur) ? Math.round(tentEur) * rules.minUnits.value : null;
  const tax = Math.round(row.value * rate);
  return { price: row.value, tax, taxLabel: country.taxLabel, tents, units: rules.minUnits.value, total: row.value + tax + (tents ?? 0), excludes: 'permits, platforms, water, power and furniture' };
}

function check(id, label, ok, detail) {
  return { id, label, ok, detail };
}

export function planFor(row, strategy, { convert = null, euHpi = null, trends = null } = {}) {
  const rules = strategy.rules;
  const trend = trends?.[row.countryCode] ?? null;
  const hpi = trend?.real ?? row.fit?.hpi ?? null;
  const country = strategy.countries[row.countryCode] ?? null;
  const site = row.site;
  const climate = site?.climate ?? null;
  const m2 = areaM2(row);
  const units = unitsFor(m2, rules);
  const cost = entryCost(row, country, units, rules, convert);
  const words = `${row.title ?? ''} ${row.place ?? ''}`;
  const zoning = zoningOf(row);
  const ebike = rules.ebikeKm.value;
  const checks = [
    check('sea', `sea within ${ebike} km by e-bike`, site ? site.coastKm !== null && site.coastKm <= ebike : null, site ? `sea ${site.coastKm ?? '>25'} km` : 'location not measured yet'),
    check('season', `${rules.minWorkableMonths.value}+ workable months`, climate ? climate.workable >= rules.minWorkableMonths.value : null, climate ? `${climate.workable} workable months (${climate.comfortable} comfortable)` : 'climate not measured yet'),
    check('noAc', 'no air conditioning needed', climate ? climate.hottest <= rules.maxHottest.value : null, climate ? `hottest month average max ${climate.hottest} °C` : 'climate not measured yet'),
    check('units', `room for ${rules.minUnits.value}+ units`, units === null ? null : units >= rules.minUnits.value, m2 ? `${Math.round(m2).toLocaleString('en-US')} m² → ${units} units at ${rules.pitchM2.value} m² each on ${rules.campingShare.value * 100}% of the land` : 'area not shown'),
    check('trend', 'real price trend above the EU average', hpi === null || euHpi === null ? null : hpi > euHpi, hpi === null ? `no official price series for ${row.country || 'this country'} in the model` : `${row.country} ${signed(hpi)}% a year after inflation vs EU ${euHpi === null ? '?' : `${signed(euHpi)}%`} (Eurostat, housing)`),
    check('location', 'the listing location is consistent', row.placeConflict ? null : true, row.placeConflict ?? 'map point and title agree'),
    check('legal', 'a legal path for a buyer', country ? !country.blocker && !INDUSTRIAL.test(words) : null, country?.blocker ?? (INDUSTRIAL.test(words) ? 'industrial site: camping parks must be 1,000 m from insalubrious industry (Portaria 1320/2008)' : country?.path ?? 'no path researched for this country')),
  ];
  const failed = checks.filter((c) => c.ok === false);
  const unknown = checks.filter((c) => c.ok === null);
  const blocked = checks.find((c) => c.id === 'legal' && c.ok === false);
  const why = [];
  if (site?.coastKm !== null && site?.coastKm !== undefined && site.coastKm <= ebike) why.push(`sea ${site.coastKm} km${site.beachKm !== null && site.beachKm !== undefined ? `, beach ${site.beachKm} km` : ''}: inside the ${ebike} km e-bike ride`);
  if (climate && climate.workable >= rules.minWorkableMonths.value) why.push(`${climate.workable} workable months a year`);
  if (climate && climate.hottest <= rules.maxHottest.value) why.push(`hottest month average high ${climate.hottest} °C: tents work without air conditioning`);
  if (units !== null && units >= rules.minUnits.value) why.push(`${Math.round(m2).toLocaleString('en-US')} m² holds ${units} units, ${rules.minUnits.value} are enough to open`);
  if (cost) why.push(`entry ≈ ${eur(cost.total)} (price ${eur(cost.price)} + ${cost.taxLabel} ${eur(cost.tax)}${cost.tents !== null ? ` + ${cost.units} bell tents ${eur(cost.tents)}` : ''}; excludes ${cost.excludes})`);
  if (hpi !== null && euHpi !== null && hpi > euHpi) why.push(`${row.country} house prices ${signed(hpi)}% a year after inflation${trend ? ` (nominal ${signed(trend.change)}%, inflation ${trend.inflation}%, ${trend.year})` : ''} vs EU ${signed(euHpi)}% (Eurostat, country level, not land)`);
  if (site) why.push(`${explorePoints(site)} things to explore and ${(site.lodging ?? 0) + (site.campsites ?? 0)} places to stay within 15 km (demand)`);
  if (country?.path && !country.blocker) why.push(`path: ${country.path}`);
  const potential = [];
  let draw = false;
  if (site) {
    if (site.lakesNamed && site.lakeKm !== null && site.lakeKm !== undefined && site.lakeKm <= 5) {
      potential.push(`named lake or reservoir ${site.lakeKm} km away`);
      draw = true;
    }
    if (explorePoints(site) >= STRONG_EXPLORE) {
      potential.push(`${explorePoints(site)} beaches, viewpoints, sights, reserves and trails within 15 km`);
      draw = true;
    }
    if (failed.some((c) => c.id === 'season') && site.coastKm !== null && site.coastKm !== undefined && site.coastKm <= ebike) {
      potential.push(`sea ${site.coastKm} km: a strong short-season location`);
      draw = true;
    }
    if (climate && climate.workable >= rules.minWorkableMonths.value && failed.some((c) => c.id !== 'season')) potential.push(`${climate.workable}-month season`);
    if ((site.campsites ?? 0) > 0) potential.push(`${site.campsites} campsites nearby prove camping demand`);
  }
  const tooSmall = failed.some((c) => c.id === 'units');
  const tier = blocked ? 'blocked' : tooSmall ? 'weak' : failed.length ? (draw ? 'trade-off' : 'weak') : unknown.length ? 'unverified' : 'fits';
  const risks = [...(country?.risks ?? [])];
  if (zoning === 'agricultural' && country?.agriculturalRisk) risks.push(country.agriculturalRisk);
  if (SHARED_TITLE.test(words)) risks.push('shared title (hisseli): you buy a share, not a parcel');
  const tradeoffs = failed.filter((c) => c.id !== 'legal').map((c) => `${c.label}: no (${c.detail})`);
  const verdict = tier === 'fits' ? 'fits every criterion' : tier === 'blocked' ? `blocked: ${blocked.detail}` : tier === 'unverified' ? `to confirm: ${[...new Set(unknown.map((c) => c.detail))].join('; ')}` : tier === 'trade-off' ? `trade-off with potential: ${potential.join('; ')}` : tooSmall ? `does not fit: ${tradeoffs.join('; ')}; too little land for a glamping site, which nothing nearby can make up for` : `does not fit: ${tradeoffs.join('; ')}; nothing nearby draws guests to make up for it`;
  const measured = checks.filter((c) => c.ok !== null);
  const share = measured.length ? Math.round((measured.filter((c) => c.ok).length / checks.length) * 100) / 100 : 0;
  return { tier, verdict, checks, why, tradeoffs, potential, risks, units, areaM2: m2, trend: hpi, share, entry: cost, path: country?.blocker ? null : country?.path ?? null, sources: country?.sources ?? [] };
}

export const PROJECTION_YEARS = 5;
export const FEW_COMPETITORS = 2;

export function opportunityOf(row, plan, { trends = null, euTrend = null } = {}) {
  const trend = trends?.[row.countryCode] ?? null;
  const site = row.site;
  const reasons = [];
  let score = 0;
  const met = plan.checks.filter((c) => ['sea', 'season', 'noAc', 'units'].includes(c.id));
  const passed = met.filter((c) => c.ok === true).length;
  score += passed;
  reasons.push(`${passed} of ${met.length} site checks met (${met.map((c) => `${c.label}: ${c.ok === true ? 'yes' : c.ok === false ? 'no' : '?'}`).join(', ')})`);
  if (trend?.realCagr !== null && trend?.realCagr !== undefined) {
    const projected = Math.round(((1 + trend.realCagr / 100) ** PROJECTION_YEARS - 1) * 100);
    const above = euTrend?.realCagr !== null && euTrend?.realCagr !== undefined && trend.realCagr > euTrend.realCagr;
    if (above) score += 2;
    reasons.push(`${row.country} house prices ${trend.realCagr >= 0 ? '+' : ''}${trend.realCagr}% a year after inflation ${trend.since}–${trend.year}${euTrend?.realCagr !== undefined && euTrend?.realCagr !== null ? ` (EU ${euTrend.realCagr >= 0 ? '+' : ''}${euTrend.realCagr}%)` : ''}; if that continues, about ${projected >= 0 ? '+' : ''}${projected}% in ${PROJECTION_YEARS} years (a trend continuation for housing, not a land forecast)`);
  }
  if (site) {
    const scenic = explorePoints(site);
    const rivals = (site.campsites ?? 0);
    if (scenic >= STRONG_EXPLORE && rivals <= FEW_COMPETITORS) {
      score += 2;
      reasons.push(`scenic and still open: ${scenic} beaches, viewpoints, sights, reserves and trails within 15 km, only ${rivals} campsite${rivals === 1 ? '' : 's'}`);
    } else reasons.push(`${scenic} things to explore and ${rivals} campsites within 15 km`);
  }
  if (plan.entry) reasons.push(`entry ≈ €${Math.round(plan.entry.total).toLocaleString('en-US')}`);
  return { score, reasons };
}

export const TIER_ORDER = { fits: 0, 'trade-off': 1, unverified: 2, weak: 3, blocked: 4 };
export const MIN_ROWS_FOR_MEDIAN = 5;

const priceGroup = (row) => `${row.countryCode}|${zoningOf(row)}`;

export const MAD_THRESHOLD = 2.5;
export const MAD_CONSISTENCY = 1.4826;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function pricePerM2Medians(rows) {
  const by = {};
  for (const r of rows) {
    const m2 = areaM2(r);
    if (!m2 || !Number.isFinite(r.value) || r.value <= 0) continue;
    (by[priceGroup(r)] ??= []).push(Math.log(r.value / m2));
  }
  return Object.fromEntries(Object.entries(by).filter(([, v]) => v.length >= MIN_ROWS_FOR_MEDIAN).map(([group, logs]) => {
    const mid = median(logs);
    return [group, { median: Math.exp(mid), logMedian: mid, logMad: median(logs.map((x) => Math.abs(x - mid))), n: logs.length }];
  }));
}

export function implausiblyCheap(row, medians) {
  const m2 = areaM2(row);
  const stats = medians[priceGroup(row)];
  if (!m2 || !stats || !Number.isFinite(row.value) || row.value <= 0) return null;
  const perM2 = row.value / m2;
  const floor = stats.logMedian - MAD_THRESHOLD * MAD_CONSISTENCY * stats.logMad;
  const zoning = zoningOf(row);
  return Math.log(perM2) < floor ? `€${perM2.toFixed(2)}/m² is a low outlier for ${zoning === 'not stated' ? '' : `${zoning} `}land in ${row.country || row.countryCode} among the ${stats.n} listings found (median €${stats.median.toFixed(2)}/m²; outliers below €${Math.exp(floor).toFixed(2)}/m² by median − 2.5 MAD): check the price and area on the listing` : null;
}

export function applyStrategy(candidates, strategy, { convert = null, retrieved = null, foundation = null } = {}) {
  if (!candidates || !strategy) return candidates;
  const model = foundation ? { ...strategy, rules: foundation.rules } : strategy;
  const euHpi = candidates.sites?.euHpi ?? null;
  const trends = candidates.sites?.trends ?? null;
  const all = [...(candidates.kept ?? []), ...(candidates.far ?? [])];
  const medians = { ...pricePerM2Medians(all), ...(candidates.priceMedians ?? {}) };
  const rows = all.map((row) => {
    const plan = planFor(row, model, { convert, euHpi, trends });
    const cheap = implausiblyCheap(row, medians);
    if (!cheap) return { ...row, plan };
    const doubtful = ['fits', 'trade-off'].includes(plan.tier);
    return { ...row, plan: { ...plan, risks: [...plan.risks, cheap], ...(doubtful ? { tier: 'unverified', verdict: `to confirm: ${cheap}` } : {}) } };
  });
  rows.sort((a, b) => TIER_ORDER[a.plan.tier] - TIER_ORDER[b.plan.tier] || b.plan.share - a.plan.share || (a.plan.entry?.total ?? Infinity) - (b.plan.entry?.total ?? Infinity));
  const tiers = Object.fromEntries(Object.keys(TIER_ORDER).map((t) => [t, rows.filter((r) => r.plan.tier === t).length]));
  const euTrend = trends?.EU27_2020 ?? null;
  const outside = (candidates.outside ?? []).map((row) => {
    const plan = planFor(row, model, { convert, euHpi, trends });
    return { ...row, plan: { ...plan, opportunity: opportunityOf(row, plan, { trends, euTrend }) } };
  }).sort((a, b) => b.plan.opportunity.score - a.plan.opportunity.score || (a.plan.entry?.total ?? Infinity) - (b.plan.entry?.total ?? Infinity));
  const { far, ...rest } = candidates;
  const moved = far?.length ?? 0;
  const screened = { ...rest.screened };
  if (moved && rest.farReason) {
    screened[rest.farReason] = (screened[rest.farReason] ?? 0) - moved;
    if (screened[rest.farReason] <= 0) delete screened[rest.farReason];
  }
  return { ...rest, screened, screenedCount: (rest.screenedCount ?? 0) - moved, examples: (rest.examples ?? []).filter((e) => !rows.some((r) => r.url === e.url)), outside, kept: rows, keptCount: tiers.fits, tiers, strategy: { id: strategy.id, label: strategy.label, rules: model.rules, foundation, euHpi, sources: strategy.sources.map(({ id, title, url, quotes }) => ({ id, title, url, quoted: quotes.length > 0, ...(retrieved?.[id] ?? {}) })), retrievedAt: retrieved?.at ?? null } };
}

export class StrategyRetriever {
  constructor({ readPage, now = () => Date.now() } = {}) {
    this.readPage = readPage;
    this.now = now;
  }

  async retrieve(strategy, previous = null) {
    if (previous?.at && this.now() - Date.parse(previous.at) < STRATEGY_TTL_MS) return previous;
    const out = { at: new Date(this.now()).toISOString() };
    for (const source of strategy.sources.filter((s) => s.quotes.length)) {
      try {
        const page = await this.readPage(source.url);
        const text = page?.text ?? '';
      const found = source.quotes.filter((q) => quoteFound(text, q));
        out[source.id] = { status: page?.status ?? 0, confirmed: found.length, quotes: source.quotes.length };
      } catch (error) {
        out[source.id] = { status: 0, confirmed: 0, quotes: source.quotes.length, error: String(error.message).slice(0, 80) };
      }
    }
    return out;
  }
}
