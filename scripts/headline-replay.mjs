#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { verdict, scoreOf, headlineOf, acceptanceSummaryOf } from '../src/research/verdict.mjs';

const [dataDir, ...ids] = process.argv.slice(2);
if (!dataDir || !ids.length) {
  console.log('usage: node scripts/headline-replay.mjs <data/projects dir> <project id suffix>...');
  process.exit(1);
}

const files = await fs.readdir(dataDir);
for (const suffix of ids) {
  const file = files.find((name) => name.endsWith(`${suffix}.json`));
  if (!file) {
    console.log(`${suffix}: no stored project`);
    continue;
  }
  const project = JSON.parse(await fs.readFile(path.join(dataDir, file), 'utf8'));
  const result = project.acceptanceResult;
  if (!result?.items) {
    console.log(`${suffix}: no acceptance result stored`);
    continue;
  }
  const kind = project.decisionModel?.kind ?? null;
  const asked = result.totalAsked || project.acceptance?.itemCount;
  const spec = { ...(project.acceptance ?? {}), ...(asked ? { itemCount: asked } : {}) };
  const judged = verdict(result.items, spec, project.checklist, kind);
  const head = headlineOf(judged);
  const items = (project.checklist ?? []).flatMap((cluster) => cluster.items ?? []);
  console.log(`--- ${suffix} ---`);
  console.log(`stored summary : ${acceptanceSummaryOf(project)}`);
  console.log(`old headline   : ${Math.round(scoreOf(result.checks ?? []) * 100)}% met (mean of ${(result.checks ?? []).length} checks)`);
  console.log(`new headline   : ${head.headline}; ${head.plausibility}`);
  console.log(`criteria       : ${(project.decisionModel?.criteria ?? []).length}`);
  console.log(`must-have items: ${items.filter((item) => item.hard).length} of ${items.length}`);
}
