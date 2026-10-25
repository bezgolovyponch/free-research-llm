import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchEngine } from '../src/research/engine.mjs';
import { ExchangeRates } from '../src/research/rates.mjs';
import { previewMaintenance } from '../src/research/dryrun.mjs';
import { SiteAssessor } from '../src/research/site.mjs';
import { SearchService } from '../src/search/search.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2];
if (!id) {
  console.log('usage: node scripts/dryrun.mjs <research id> [--sites <cache file>]   (read-only preview of start-of-loop repairs and gates; --sites also measures site fit, reading listing pages and free map and weather data)');
  process.exit(1);
}
const project = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'projects', `${id}.json`), 'utf8'));
const sitesAt = process.argv.indexOf('--sites');
const sites = sitesAt > 0 && process.argv[sitesAt + 1] ? new SiteAssessor({ file: path.resolve(process.argv[sitesAt + 1]) }) : null;
const engine = new ResearchEngine({ router: null, search: sites ? new SearchService({ backends: [] }) : null, store: { cache: new Map(), save: async (p) => p }, rates: new ExchangeRates({ fetchImpl: fetch }), sites, onEvent: (_id, e) => { if (e.type === 'candidates') console.log(e.message); } });
const report = await previewMaintenance(engine, project);
const section = (title, rows) => console.log(`\n${title} (${rows.length})${rows.length ? `\n  ${rows.join('\n  ')}` : ''}`);
console.log(`Dry run for ${id}: nothing is written.`);
console.log(`sources capped: ${report.compacted} · tree repairs: ${report.repairs.join(', ') || 'none'} · checks re-grounded: ${report.regrounded}`);
section('pieces moved', report.changes.moved);
section('titles changed', report.changes.retitled);
section('grades changed', report.changes.regraded);
section('listings removed by the item gate', report.changes.removedItems);
section('listings taken from pages already read', report.harvested);
console.log(`\nlistings kept: ${report.itemsKept}`);
const c = report.candidates;
if (c) console.log(`candidate table (no new page reads): ${c.found} found, ${c.keptCount} kept, ${c.toCheckCount} to check, ${c.screenedCount} screened out${Object.keys(c.screened).length ? ` (${Object.entries(c.screened).map(([r, n]) => `${r} ${n}`).join(', ')})` : ''}`);
if (c?.sites) {
  console.log(`\nsite fit: ${JSON.stringify(c.sites)}`);
  for (const r of c.kept.slice(0, 25)) console.log(`  ${r.fit ? r.fit.score.toFixed(2) : ' -  '} | ${r.value ?? '?'} ${r.unit} | ${r.area ?? '?'} m² | sea ${r.site?.coastKm ?? '?'} km | ${r.site?.climate ? `${r.site.climate.workable} workable / ${r.site.climate.comfortable} comfortable months, hottest ${r.site.climate.hottest}°C` : r.siteNote ?? ''} | explore ${r.site ? r.site.beaches + r.site.viewpoints + r.site.attractions + r.site.reserves + r.site.protectedAreas + r.site.hikingRoutes : '?'} | ${r.fit?.zoning ?? ''} | ${r.country} | ${r.url}`);
}
