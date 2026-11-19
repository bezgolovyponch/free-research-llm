#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateDeliverables } from '../src/research/candidates.mjs';
import { adaptForChecklist, MEASURES, compare } from '../src/research/measures.mjs';
import { pairRuns, bootstrapDifference } from '../src/research/agreement.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const command = argv[0];
  const values = (flag) => argv.flatMap((arg, index) => (arg === flag && argv[index + 1] !== undefined ? [argv[index + 1]] : []));
  const value = (flag) => values(flag)[0] ?? null;
  if (!['record', 'check'].includes(command)) return { error: 'usage:\n  node scripts/zero-loss.mjs record <snapshotDir> --out <file>\n  node scripts/zero-loss.mjs check <snapshotDir> --baseline <file>' };
  const snapshotDir = path.resolve(value('<snapshotDir>') ?? argv[1]);
  if (!snapshotDir) return { error: 'snapshotDir is required' };
  if (command === 'record') {
    const out = value('--out');
    if (!out) return { error: '--out is required' };
    return { command, snapshotDir, out: path.resolve(out) };
  }
  const baseline = value('--baseline');
  if (!baseline) return { error: '--baseline is required' };
  return { command, snapshotDir, baseline: path.resolve(baseline) };
}

async function loadProjects(dir) {
  const names = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json')).sort();
  const projects = [];
  for (const name of names) {
    try {
      const project = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      if (project?.id && typeof project.question === 'string') projects.push(project);
    } catch {
    }
  }
  return projects;
}

function checklistItems(project) {
  const clusters = project?.decisionModel?.checklist ?? project?.checklist ?? [];
  return clusters.flatMap((cluster) =>
    (cluster.items ?? []).filter((item) => item?.question && item.numeric?.measure).map((item) => ({
      clause: cluster.clause,
      question: item.question,
      hard: Boolean(item.hard),
      measure: item.numeric.measure,
      op: item.numeric.op,
      value: item.numeric.value,
    }))
  );
}

function decisionCriteriaCount(project) {
  return (project?.decisionModel?.criteria ?? []).length;
}

function hardChecklistItemsCount(project) {
  const clusters = project?.decisionModel?.checklist ?? project?.checklist ?? [];
  return clusters.flatMap((c) => c.items ?? []).filter((i) => i.hard).length;
}

async function outcomesOf(projectFile, srcDir) {
  const project = JSON.parse(await fs.readFile(projectFile, 'utf8'));
  const items = checklistItems(project);
  if (!items.length) return { outcomes: [], criteriaCount: decisionCriteriaCount(project), hardCount: hardChecklistItemsCount(project) };
  const M = adaptForChecklist(MEASURES);
  const decisionCriteria = project.decisionModel?.criteria ?? [];
  const ctx = {
    trends: project.candidates?.sites?.trends ?? null,
    euHpi: project.candidates?.sites?.euHpi ?? null,
  };
  const d = candidateDeliverables(project.candidates);
  const outcomes = [];
  for (const deliverable of d) {
    const url = deliverable.url;
    for (const item of items) {
      const m = M[item.measure];
      if (!m) {
        outcomes.push({ url, clause: item.clause, question: item.question, hard: item.hard, measure: item.measure, outcome: 'unknown' });
        continue;
      }
      let v = m.read(deliverable, ctx);
      let usedMeasure = item.measure;
      if (v === undefined) {
        for (const criterion of decisionCriteria) {
          if (criterion.measure && criterion.op === item.op && criterion.value === item.value && M[criterion.measure]) {
            const criterionMeasure = M[criterion.measure];
            const criterionVal = criterionMeasure.read(deliverable, ctx);
            if (criterionVal !== undefined) {
              v = criterionVal;
              usedMeasure = criterion.measure;
              break;
            }
          }
        }
      }
      let outcome;
      if (v === undefined || v === null || Number.isNaN(v)) {
        outcome = 'unknown';
      } else if (compare(v, item.op, item.value)) {
        outcome = 'yes';
      } else {
        outcome = 'no';
      }
      outcomes.push({ url, clause: item.clause, question: item.question, hard: item.hard, measure: usedMeasure, outcome });
    }
  }
  return { outcomes, criteriaCount: decisionCriteriaCount(project), hardCount: hardChecklistItemsCount(project) };
}

async function recordSnapshot(snapshotDir, outFile) {
  const projectsDir = path.join(snapshotDir, 'projects');
  const projects = await loadProjects(projectsDir);
  const allOutcomes = [];
  let totalCriteria = 0;
  let totalHard = 0;
  for (const project of projects) {
    const { outcomes, criteriaCount, hardCount } = await outcomesOf(path.join(projectsDir, project.id + '.json'), ROOT);
    allOutcomes.push(...outcomes.map((o) => ({ ...o, project: project.id })));
    totalCriteria += criteriaCount;
    totalHard += hardCount;
  }
  const snapshot = {
    recordedAt: new Date().toISOString(),
    projects: projects.map((p) => p.id),
    totalCriteria,
    totalHard,
    outcomes: allOutcomes,
  };
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(snapshot, null, 1));
  console.log('Recorded ' + allOutcomes.length + ' outcomes from ' + projects.length + ' projects (criteria: ' + totalCriteria + ', hard: ' + totalHard + ') to ' + outFile);
}

function keyOf(outcome) {
  return outcome.project + '|' + outcome.url + '|' + outcome.clause + '|' + outcome.question;
}

function negativeFlips(baseline, current) {
  const baseByKey = new Map(baseline.outcomes.map((o) => [keyOf(o), o]));
  const flips = [];
  for (const curr of current.outcomes) {
    const base = baseByKey.get(keyOf(curr));
    if (base && base.outcome === 'yes' && curr.outcome !== 'yes') {
      flips.push({ url: curr.url, project: curr.project, clause: curr.clause, question: curr.question, baselineMeasure: base.measure, currentMeasure: curr.measure });
    }
  }
  return flips;
}

function mcNemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const minBC = Math.min(b, c);
  let sum = 0;
  for (let k = 0; k <= minBC; k++) {
    sum += binomialCoefficient(n, k);
  }
  return Math.min(1, 2 * sum / Math.pow(2, n));
}

function binomialCoefficient(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= k; i++) {
    result = result * (n - k + i) / i;
  }
  return Math.round(result);
}

async function checkSnapshot(snapshotDir, baselineFile) {
  const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
  const projectsDir = path.join(snapshotDir, 'projects');
  const projects = await loadProjects(projectsDir);
  const allOutcomes = [];
  let totalCriteria = 0;
  let totalHard = 0;
  for (const project of projects) {
    const { outcomes, criteriaCount, hardCount } = await outcomesOf(path.join(projectsDir, project.id + '.json'), ROOT);
    allOutcomes.push(...outcomes.map((o) => ({ ...o, project: project.id })));
    totalCriteria += criteriaCount;
    totalHard += hardCount;
  }
  const current = { outcomes: allOutcomes, totalCriteria, totalHard };

  const flips = negativeFlips(baseline, current);
  const criteriaDrop = current.totalCriteria < baseline.totalCriteria;
  const hardDrop = current.totalHard < baseline.totalHard;

  const baselineYes = baseline.outcomes.filter((o) => o.outcome === 'yes').length;
  const baselineTotal = baseline.outcomes.length;
  const currentYes = current.outcomes.filter((o) => o.outcome === 'yes').length;
  const currentTotal = current.outcomes.length;

  const paired = pairRuns(
    baseline.outcomes.map((o) => ({ key: keyOf(o), value: o.outcome === 'yes' ? 1 : 0, research: o.project })),
    current.outcomes.map((o) => ({ key: keyOf(o), value: o.outcome === 'yes' ? 1 : 0, research: o.project })),
    { keyOf: (e) => e.key, clusterOf: (e) => e.research, scoreOf: (e) => e.value }
  );

  let bootstrapInterval = { low: null, high: null, difference: null };
  if (paired.length) {
    bootstrapInterval = bootstrapDifference(paired, { resamples: 2000, seed: 1 });
  }

  const yesRateDiff = currentTotal ? currentYes / currentTotal - (baselineTotal ? baselineYes / baselineTotal : 0) : 0;
  const intervalBelowZero = bootstrapInterval.low !== null && bootstrapInterval.high !== null && bootstrapInterval.high < 0;

  console.log('\n=== Zero-Loss Check ===');
  console.log('Baseline: ' + baseline.outcomes.length + ' outcomes, ' + baselineYes + ' yes (' + (baselineYes / baselineTotal * 100).toFixed(1) + '%), criteria ' + baseline.totalCriteria + ', hard ' + baseline.totalHard);
  console.log('Current:  ' + current.outcomes.length + ' outcomes, ' + currentYes + ' yes (' + (currentYes / currentTotal * 100).toFixed(1) + '%), criteria ' + current.totalCriteria + ', hard ' + current.totalHard);
  console.log('Negative flips: ' + flips.length);
  if (flips.length) {
    for (const flip of flips) {
      console.log('  ' + flip.project + ' | ' + flip.url + ' | ' + flip.clause + ' | ' + flip.question);
    }
  }
  console.log('Criteria count: ' + (criteriaDrop ? 'DROP' : 'OK') + ' (' + baseline.totalCriteria + ' -> ' + current.totalCriteria + ')');
  console.log('Hard checklist: ' + (hardDrop ? 'DROP' : 'OK') + ' (' + baseline.totalHard + ' -> ' + current.totalHard + ')');
  console.log('Yes-rate diff: ' + (yesRateDiff * 100).toFixed(2) + ' points');
  if (bootstrapInterval.difference !== null) {
    console.log('Bootstrap 95% CI for diff: [' + (bootstrapInterval.low * 100).toFixed(2) + ', ' + (bootstrapInterval.high * 100).toFixed(2) + '] (' + paired.length + ' paired items, ' + new Set(paired.map(p => p.cluster)).size + ' researches)');
    console.log('Interval entirely below 0: ' + (intervalBelowZero ? 'YES' : 'NO'));
  }

  const b = flips.length;
  const c = current.outcomes.filter((o) => {
    const base = baseline.outcomes.find((bo) => keyOf(bo) === keyOf(o));
    return base && base.outcome !== 'yes' && o.outcome === 'yes';
  }).length;
  const pValue = mcNemarExact(b, c);
  console.log('McNemar exact (b=' + b + ', c=' + c + '): p = ' + pValue.toFixed(6));

  const failed = flips.length > 0 || criteriaDrop || hardDrop || intervalBelowZero;
  console.log(failed ? '\nFAIL' : '\nPASS');
  return failed ? 1 : 0;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    return 1;
  }
  if (args.command === 'record') {
    return await recordSnapshot(args.snapshotDir, args.out);
  }
  return await checkSnapshot(args.snapshotDir, args.baseline);
}

if (process.argv[1] && import.meta.url === 'file://' + process.argv[1]) process.exit(await main(process.argv.slice(2)));

export { outcomesOf, negativeFlips, mcNemarExact, binomialCoefficient, recordSnapshot, checkSnapshot };