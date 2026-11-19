#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acceptanceSummaryOf, scoreOf, verdictReport } from '../src/research/verdict.mjs';

export function replayLines(project, label = '') {
  const result = project?.acceptanceResult;
  if (!result?.items) return [`${label}: no acceptance result stored`];
  const report = verdictReport(project);
  const items = (project.checklist ?? []).flatMap((cluster) => cluster.items ?? []);
  const tiers = report.items.reduce((counts, item) => ({ ...counts, [item.tier]: (counts[item.tier] ?? 0) + 1 }), {});
  return [
    `--- ${label} ---`,
    `stored summary : ${acceptanceSummaryOf(project)}`,
    `old headline   : ${Math.round(scoreOf(result.checks ?? []) * 100)}% met (mean of ${(result.checks ?? []).length} checks)`,
    `new headline   : ${report.upTo ? `${report.headline}; ${report.upTo}` : report.headline}`,
    `tiers          : ${['confirmed', 'to-confirm', 'rejected', 'not-judged'].map((tier) => `${tier} ${tiers[tier] ?? 0}`).join(' · ')}`,
    `criteria       : ${(project.decisionModel?.criteria ?? []).length}`,
    `must-have items: ${items.filter((item) => item.hard).length} of ${items.length}`,
  ];
}

export async function main(args) {
  const [dataDir, ...ids] = args;
  if (!dataDir || !ids.length) {
    console.log('usage: node scripts/headline-replay.mjs <data/projects dir> <project id suffix>...');
    return 1;
  }
  const files = await fs.readdir(dataDir);
  for (const suffix of ids) {
    const file = files.find((name) => name.endsWith(`${suffix}.json`));
    if (!file) {
      console.log(`${suffix}: no stored project`);
      continue;
    }
    const project = JSON.parse(await fs.readFile(path.join(dataDir, file), 'utf8'));
    console.log(replayLines(project, suffix).join('\n'));
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
