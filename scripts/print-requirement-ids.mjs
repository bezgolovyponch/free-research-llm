import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { deriveRequirementIds } from '../src/research/engine.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadProject(filePath) {
  const content = readFileSync(filePath, 'utf8');
  return JSON.parse(content);
}

function printRequirementIds(project) {
  const model = project.decisionModel;
  if (!model) {
    console.log('Project ' + project.id + ': No decision model');
    return;
  }
  
  const ids = deriveRequirementIds(model);
  console.log('Project ' + project.id + ':');
  console.log('  Question: ' + (project.question?.slice(0, 80) || '') + '...');
  console.log('  Requirements: ' + ids.length);
  for (const req of ids) {
    console.log('    - ' + req.id + ': ' + req.label);
  }
  console.log('');
}

const args = process.argv.slice(2);
let files = args;

if (files.length === 0) {
  files = [
    resolve(__dirname, '../tests/fixtures/replay/projects/b2f5b7-fixture.json'),
  ];
}

for (const file of files) {
  try {
    const project = loadProject(file);
    printRequirementIds(project);
  } catch (error) {
    console.error('Error loading ' + file + ':', error.message);
  }
}
