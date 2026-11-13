import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchEngine } from '../src/research/engine.mjs';
import { ExchangeRates } from '../src/research/rates.mjs';
import { previewMaintenance } from '../src/research/dryrun.mjs';
import { SiteAssessor } from '../src/research/site.mjs';
import { SearchService } from '../src/search/search.mjs';
import { modelText } from '../src/research/decision.mjs';
import { entityDeliverables, collectDeliverables, isExcludedSurfaceUrl, purposeChecks, AcceptanceChecker } from '../src/research/acceptance.mjs';
import { candidateDeliverables } from '../src/research/candidates.mjs';
import { collectDeliverables as collectNodeDeliverables } from '../src/research/acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2];
if (!id) {
  console.log('usage: node scripts/dryrun.mjs <research id> [--sweep] [--sites <cache file>]   (read-only preview of start-of-loop repairs and gates; --sweep also reads portal pages live; --sites also measures site fit, reading listing pages and free map and weather data)');
  process.exit(1);
}
const sweep = process.argv.includes('--sweep');
const project = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'projects', `${id}.json`), 'utf8'));
const sitesAt = process.argv.indexOf('--sites');
const sites = sitesAt > 0 && process.argv[sitesAt + 1] ? new SiteAssessor({ file: path.resolve(process.argv[sitesAt + 1]) }) : null;
const engine = new ResearchEngine({ router: null, search: sweep || sites ? new SearchService({ backends: [], fetchPages: true }) : null, store: { cache: new Map(), save: async (p) => p }, rates: new ExchangeRates({ fetchImpl: fetch }), sites, onEvent: (_id, e) => { if (e.type === 'candidates') console.log(e.message); } });
const report = await previewMaintenance(engine, project, { sweep });
const section = (title, rows) => console.log(`\n${title} (${rows.length})${rows.length ? `\n  ${rows.join('\n  ')}` : ''}`);
console.log(`Dry run for ${id}: nothing is written.`);
console.log(`sources capped: ${report.compacted} · tree repairs: ${report.repairs.join(', ') || 'none'} · checks re-grounded: ${report.regrounded}`);
section('pieces moved', report.changes.moved);
section('titles changed', report.changes.retitled);
section('grades changed', report.changes.regraded);
section('listings removed by the item gate', report.changes.removedItems);
section('listings taken from pages already read', report.harvested);
console.log(`\nlistings kept: ${report.itemsKept}`);
if (project.decisionModel) {
  console.log(`\n=== Decision Model ===`);
  console.log(modelText(project.decisionModel));
}
if (sweep) {
  const pagesRead = report.project?.sweep?.pagesRead ?? 0;
  const pages = (report.project?.sweep?.pages ?? []).slice(0, pagesRead);
  console.log(`\nportal sweep: ${pagesRead} page(s) read by code`);
  for (const page of pages) console.log(`  ${(page.listings ?? []).length} listing(s) | ${page.url}`);
}
const c = report.candidates;
if (c) console.log(`candidate table (${sweep ? 'live portal sweep' : 'no new page reads'}): ${c.found} found, ${c.keptCount} kept, ${c.toCheckCount} to check, ${c.screenedCount} screened out${Object.keys(c.screened).length ? ` (${Object.entries(c.screened).map(([r, n]) => `${r} ${n}`).join(', ')})` : ''}`);
if (sweep && c) for (const r of c.kept.slice(0, 25)) console.log(`  ${r.value ?? '?'} ${r.unit} | ${r.country} | ${r.title} | ${r.url}`);
if (c?.sites) {
  console.log(`\nsite fit: ${JSON.stringify(c.sites)}`);
  if (c.tiers) {
    console.log(`\ntiers: ${JSON.stringify(c.tiers)} · EU price trend ${c.sites.euHpi ?? '?'}%`);
    for (const r of c.kept) console.log(`  [${r.plan.tier}] ${r.country} | €${r.value ?? '?'} | entry ${r.plan.entry?.total ?? '?'} | ${r.plan.areaM2 ?? '?'} m² | sea ${r.site?.coastKm ?? '?'} km | ${r.plan.verdict}\n      why: ${r.plan.why.join('; ')}${r.plan.risks.length ? `\n      risks: ${r.plan.risks.join('; ')}` : ''}\n      ${r.url}`);
  } else for (const r of c.kept.slice(0, 25)) console.log(`  ${r.fit ? r.fit.score.toFixed(2) : ' -  '} | ${r.value ?? '?'} ${r.unit} | ${r.area ?? '?'} m² | sea ${r.site?.coastKm ?? '?'} km | ${r.site?.climate ? `${r.site.climate.workable} workable / ${r.site.climate.comfortable} comfortable months, hottest ${r.site.climate.hottest}°C` : r.siteNote ?? ''} | explore ${r.site ? r.site.beaches + r.site.viewpoints + r.site.attractions + r.site.reserves + r.site.protectedAreas + r.site.hikingRoutes : '?'} | ${r.fit?.zoning ?? ''} | ${r.country} | ${r.url}`);
}

// Acceptance preview
const useFetch = process.argv.includes('--fetch');
const brief = project.brief ?? { located: false, regions: [], kind: null };
if (!brief.regions?.length && project.area?.countries?.length) brief.regions = project.area.countries;
const terms = [...new Set([...(project.domain?.terms ?? []), ...(project.decisionModel?.kind?.terms ?? []), ...(brief.kind?.terms ?? [])])];
const notTerms = [...new Set([...(project.domain?.not ?? []), ...(project.decisionModel?.kind?.not ?? []), ...(brief.kind?.not ?? [])])];
const kindLabel = project.decisionModel?.kind?.label ?? brief.kind?.label ?? '';
const nodesForEntities = [...(project.nodes ?? []), { id: 'hubs', sources: project.hubSources ?? [] }];
const readPage = useFetch ? engine.cachedPageReader(null) : (url) => {
  // Try to find page in sweep pages cache
  const sweepPages = project.sweep?.pages ?? [];
  for (const page of sweepPages) {
    if (page.url === url) return Promise.resolve({ text: page.text ?? '', status: 200, listings: page.listings ?? [] });
  }
  // Try hub sources
  const hubSources = project.hubSources ?? [];
  for (const source of hubSources) {
    if (source.url === url) return Promise.resolve({ text: source.text ?? '', status: 200, listings: source.listings ?? [] });
  }
  // Try node sources
  for (const node of project.nodes ?? []) {
    for (const source of node.sources ?? []) {
      if (source.url === url) return Promise.resolve({ text: source.text ?? '', status: 200, listings: source.listings ?? [] });
    }
  }
  return Promise.resolve({ text: '', status: 0 });
};

const fromTable = candidateDeliverables(project.candidates);
const listed = new Set(fromTable.map((d) => d.url));
const deliverables = (brief.located === false
  ? await entityDeliverables(nodesForEntities, { terms, not: notTerms, kindLabel, regions: brief.regions ?? [], readPage })
  : (project.candidates ? fromTable : [...fromTable, ...collectNodeDeliverables(project.nodes).filter((d) => !listed.has(d.url))])).filter((d) => !isExcludedSurfaceUrl(d.url));

console.log(`\n--- Acceptance Preview ---`);
console.log(`deliverables: ${deliverables.length}`);
if (deliverables.length > 0) {
  console.log(`first 10 deliverable urls:`);
  for (const d of deliverables.slice(0, 10)) console.log(`  ${d.url}`);
}

if (project.acceptance && (project.acceptance.itemCount || project.acceptance.urlsLive || project.acceptance.valueRange || project.acceptance.mustMention?.length || purposeChecks(project).length)) {
  const convert = engine.rates ? await engine.rates.converter() : undefined;
  const checker = new AcceptanceChecker({ readPage, convert });
  const acceptanceResult = await checker.evaluate(project.acceptance, deliverables, { located: brief.located !== false, kind: brief.kind ?? null, purpose: purposeChecks(project) });
  if (acceptanceResult) {
    const passing = acceptanceResult.checks.filter((c) => c.passed).length;
    const total = acceptanceResult.checks.length;
    console.log(`\nacceptance: ${Math.round(acceptanceResult.score * 100)}% (${passing}/${total} checks passed)`);
    for (const check of acceptanceResult.checks) {
      console.log(`  ${check.label}: ${Math.round(check.value * 100)}% ${check.passed ? '✓' : '✗'}`);
    }
  }
}
