import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conceptAudit } from '../src/research/conceptaudit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const all = args.includes('--all');
const wanted = args.find((arg) => !arg.startsWith('--'));

if (!all && !wanted) {
  console.log('usage: node scripts/concept-audit.mjs [<research id> | --all]');
  process.exit(1);
}

const dir = path.join(ROOT, 'data', 'projects');
let files;
if (all) {
  files = (await fs.readdir(dir)).filter((name) => name.endsWith('.json')).sort();
} else {
  files = [`${wanted}.json`];
}

let totalErrors = 0;
let totalWarnings = 0;
for (const file of files) {
  let project;
  try {
    project = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
  } catch {
    console.log(`${path.basename(file, '.json')}: cannot read ${file}`);
    continue;
  }
  const audit = conceptAudit(project);
  const id = project.id ?? path.basename(file, '.json');
  const question = typeof project.question === 'string' ? project.question.slice(0, 80) : '';
  console.log(`${id} · ${audit.errors} error(s), ${audit.warnings} warning(s)${question ? ` · ${question}` : ''}`);
  for (const finding of audit.findings.filter((f) => !f.ok)) {
    console.log(`${finding.severity === 'error' ? '✗' : '⚠'} ${finding.id} ${finding.label} — ${finding.detail}`);
  }
  totalErrors += audit.errors;
  totalWarnings += audit.warnings;
}
console.log(`total: ${totalErrors} error(s), ${totalWarnings} warning(s)`);
process.exit(totalErrors > 0 ? 1 : 0);
