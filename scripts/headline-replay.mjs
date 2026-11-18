#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verdict, scoreOf, headlineOf } from '../src/research/verdict.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURES_DIR = path.join(ROOT, 'tests', 'fixtures', 'replay', 'projects');
const VERDICT_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'verdict-0c750f.json');

async function loadFixture(file) {
  const content = await fs.readFile(file, 'utf8');
  return JSON.parse(content);
}

function computeOldHeadline(verdictResult) {
  const checks = [];
  if (verdictResult.perCheck) {
    for (const pc of verdictResult.perCheck) {
      const total = pc.yes + pc.no + pc.unknown;
      const rate = total ? pc.yes / total : 0;
      checks.push({ value: rate });
    }
  }
  const oldMean = scoreOf(checks);
  return Math.round(oldMean * 1000) / 1000;
}

function countCriteria(verdictResult) {
  return verdictResult.perCheck?.length ?? 0;
}

function countHardChecks(verdictResult) {
  if (!verdictResult.perCheck) return 0;
  let total = 0;
  for (const pc of verdictResult.perCheck) {
    total += pc.yes + pc.no + pc.unknown;
  }
  return total;
}

async function replay() {
  console.log('=== Headline Replay ===');
  console.log('');
  
  const b2f5b7 = await loadFixture(path.join(FIXTURES_DIR, 'b2f5b7-fixture.json'));
  const verdict0c750f = await loadFixture(VERDICT_FIXTURE);
  
  const projects = [
    { id: 'b2f5b7', data: b2f5b7 },
    { id: '0c750f', data: verdict0c750f },
  ];
  
  for (const proj of projects) {
    const { acceptance, checklist, acceptanceResult } = proj.data;
    
    if (!acceptanceResult) {
      console.log(proj.id + ': No acceptanceResult, skipping');
      continue;
    }
    
    const vr = verdict(acceptanceResult.items, acceptance, checklist);
    const oldHeadline = computeOldHeadline(vr);
    const newHeadline = headlineOf(vr);
    const criteriaCount = countCriteria(vr);
    const hardCheckCount = countHardChecks(vr);
    
    console.log('--- ' + proj.id + ' ---');
    console.log('Old headline (arithmetic mean): ' + oldHeadline);
    console.log('New headline: ' + newHeadline.headline);
    console.log('Plausibility: ' + newHeadline.plausibility);
    console.log('Criteria count: ' + criteriaCount);
    console.log('Hard-check count (judged items): ' + hardCheckCount);
    console.log('');
  }
  
  console.log('Counts must be identical before/after (criteria count and hard-check count are properties of the verdict, not changed by headline computation)');
}

replay().catch(console.error);
