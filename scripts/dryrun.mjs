import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchEngine } from '../src/research/engine.mjs';
import { ExchangeRates } from '../src/research/rates.mjs';
import { previewMaintenance } from '../src/research/dryrun.mjs';
import { SiteAssessor } from '../src/research/site.mjs';
import { SearchService } from '../src/search/search.mjs';
import { modelText } from '../src/research/decision.mjs';

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
