import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchEngine } from '../src/research/engine.mjs';
import { ExchangeRates } from '../src/research/rates.mjs';
import { previewMaintenance } from '../src/research/dryrun.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2];
if (!id) {
  console.log('usage: node scripts/dryrun.mjs <research id>   (read-only preview of start-of-loop repairs and gates)');
  process.exit(1);
}
const project = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'projects', `${id}.json`), 'utf8'));
const engine = new ResearchEngine({ router: null, search: null, store: { cache: new Map(), save: async (p) => p }, rates: new ExchangeRates({ fetchImpl: fetch }) });
const report = await previewMaintenance(engine, project);
const section = (title, rows) => console.log(`\n${title} (${rows.length})${rows.length ? `\n  ${rows.join('\n  ')}` : ''}`);
console.log(`Dry run for ${id}: nothing is written.`);
console.log(`sources capped: ${report.compacted} · tree repairs: ${report.repairs.join(', ') || 'none'} · checks re-grounded: ${report.regrounded}`);
section('pieces moved', report.changes.moved);
section('titles changed', report.changes.retitled);
section('grades changed', report.changes.regraded);
section('listings removed by the item gate', report.changes.removedItems);
console.log(`\nlistings kept: ${report.itemsKept}`);
