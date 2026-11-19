#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateDeliverables } from '../src/research/candidates.mjs';
import { adaptForChecklist, MEASURES, compare } from '../src/research/measures.mjs';
import { pairRuns, bootstrapDifference } from '../src/research/agreement.mjs';
import { createAnswerTape } from './answer-tape.mjs';
import { ChecklistJudge } from '../src/research/checklist.mjs';
import { sentenceSpans } from '../src/research/spans.mjs';
import { ModelRouter } from '../src/llm/router.mjs';
import { ProviderFactory, routeOrderFrom } from '../src/app.mjs';
import { verdict, hardIdsOf, itemTier, qualifies } from '../src/research/verdict.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const command = argv[0];
  const values = (flag) => argv.flatMap((arg, index) => (arg === flag && argv[index + 1] !== undefined ? [argv[index + 1]] : []));
  const value = (flag) => values(flag)[0] ?? null;
  const hasFlag = (flag) => argv.includes(flag);
  if (!['record', 'check'].includes(command)) return { error: 'usage:\n  node scripts/zero-loss.mjs record <snapshotDir> --out <file> [--judge]\n  node scripts/zero-loss.mjs check <snapshotDir> --baseline <file> [--judge]' };
  const snapshotDir = path.resolve(value('<snapshotDir>') ?? argv[1]);
  if (!snapshotDir) return { error: 'snapshotDir is required' };
  const judge = hasFlag('--judge');
  if (command === 'record') {
    const out = value('--out');
    if (!out) return { error: '--out is required' };
    return { command, snapshotDir, out: path.resolve(out), judge };
  }
  const baseline = value('--baseline');
  if (!baseline) return { error: '--baseline is required' };
  return { command, snapshotDir, baseline: path.resolve(baseline), judge };
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

function extractJudgedItems(project) {
  const items = project?.acceptanceResult?.items ?? [];
  if (!items.length) return [];

  const checklist = project?.decisionModel?.checklist ?? project?.checklist ?? [];
  const kind = project?.decisionModel?.kind ?? null;
  const spec = project?.acceptance ?? {};

  return items.map((item) => {
    let checks = item.checks ?? [];
    if (!checks.length && item.plan?.checks) {
      checks = item.plan.checks.map((c) => ({
        id: c.id,
        answer: c.ok ? 'yes' : 'no',
        quote: c.detail ?? '',
        hard: true,
        clause: c.label,
      }));
    }
    return {
      url: item.url,
      title: item.title,
      evidence: item.evidence ?? item.pageUrl ?? item.url,
      live: item.live ?? true,
      listing: item.listing ?? false,
      inRange: item.inRange ?? null,
      purpose: item.purpose ?? [],
      checks,
      tier: item.tier ?? null,
      support: item.support ?? null,
      valid: item.valid ?? false,
      proposal: item.proposal ?? null,
    };
  });
}

function computeTiers(project) {
  const judgedItems = extractJudgedItems(project);
  if (!judgedItems.length) return { items: [], tiers: { confirmed: 0, 'to-confirm': 0, rejected: 0, 'not-judged': 0 }, summary: '' };

  const checklist = project?.decisionModel?.checklist ?? project?.checklist ?? [];
  const kind = project?.decisionModel?.kind ?? null;
  const spec = project?.acceptance ?? {};

  const result = verdict(judgedItems, spec, checklist, kind);

  return {
    items: result.items.map((item) => ({
      url: item.url,
      tier: item.tier,
      support: item.support,
      checks: item.checks,
    })),
    tiers: {
      confirmed: result.tiers.confirmed ?? 0,
      'to-confirm': result.tiers.toConfirm ?? 0,
      rejected: result.tiers.rejected ?? 0,
      'not-judged': result.tiers.notJudged ?? 0,
    },
    summary: result.summary,
    perCheck: result.perCheck,
  };
}

function extractStoredJudgeAnswers(project) {
  const items = project?.acceptanceResult?.items ?? [];
  if (!items.length) return [];

  const outcomes = [];
  for (const item of items) {
    const checks = item.checks ?? [];
    if (!checks.length && item.plan?.checks) {
      continue;
    }
    for (const check of checks) {
      if (check.answer !== undefined && check.answer !== null && check.answer !== '') {
        outcomes.push({
          project: project.id,
          url: item.url,
          clause: check.clause,
          question: check.id.split('|')[1] ?? check.id,
          hard: check.hard ?? false,
          measure: 'judge-stored',
          outcome: check.answer,
          quote: check.quote ?? '',
        });
      }
    }
  }
  return outcomes;
}

async function outcomesOf(projectFile, srcDir) {
  const project = JSON.parse(await fs.readFile(projectFile, 'utf8'));
  const items = checklistItems(project);
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

  const tierResult = computeTiers(project);
  const tierOutcomes = [];
  for (const item of tierResult.items) {
    tierOutcomes.push({
      url: item.url,
      clause: 'verdict',
      question: 'tier',
      hard: false,
      measure: 'tier',
      outcome: item.tier,
      support: item.support,
    });
  }

  const storedJudgeOutcomes = extractStoredJudgeAnswers(project);

  return {
    outcomes,
    tierOutcomes,
    storedJudgeOutcomes,
    criteriaCount: decisionCriteriaCount(project),
    hardCount: hardChecklistItemsCount(project),
    tierSummary: tierResult.summary,
    tierCounts: tierResult.tiers,
    perCheck: tierResult.perCheck,
  };
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

function tierKey(outcome) {
  return outcome.project + '|' + outcome.url;
}

function negativeTierFlips(baseline, current) {
  const baseByKey = new Map();
  if (baseline.tierOutcomes) {
    for (const o of baseline.tierOutcomes) {
      baseByKey.set(tierKey(o), o);
    }
  }
  const flips = [];
  if (current.tierOutcomes) {
    for (const curr of current.tierOutcomes) {
      const base = baseByKey.get(tierKey(curr));
      if (base && base.outcome === 'confirmed' && curr.outcome !== 'confirmed') {
        flips.push({ url: curr.url, project: curr.project, baselineTier: base.outcome, currentTier: curr.outcome });
      }
    }
  }
  return flips;
}

function positiveTierFlips(baseline, current) {
  const baseByKey = new Map();
  if (baseline.tierOutcomes) {
    for (const o of baseline.tierOutcomes) {
      baseByKey.set(tierKey(o), o);
    }
  }
  const flips = [];
  if (current.tierOutcomes) {
    for (const curr of current.tierOutcomes) {
      const base = baseByKey.get(tierKey(curr));
      if (base && base.outcome !== 'confirmed' && curr.outcome === 'confirmed') {
        flips.push({ url: curr.url, project: curr.project, baselineTier: base.outcome, currentTier: curr.outcome });
      }
    }
  }
  return flips;
}

function checkKey(outcome) {
  return outcome.project + '|' + outcome.url + '|' + outcome.clause + '|' + outcome.question;
}

function negativeHardCheckFlips(baseline, current) {
  const baseByKey = new Map();
  if (baseline.storedJudgeOutcomes) {
    for (const o of baseline.storedJudgeOutcomes) {
      if (o.hard) baseByKey.set(checkKey(o), o);
    }
  }
  const flips = [];
  if (current.storedJudgeOutcomes) {
    for (const curr of current.storedJudgeOutcomes) {
      if (!curr.hard) continue;
      const base = baseByKey.get(checkKey(curr));
      if (base && base.outcome === 'yes' && curr.outcome !== 'yes') {
        flips.push({ url: curr.url, project: curr.project, checkId: curr.clause + '|' + curr.question, baselineAnswer: base.outcome, currentAnswer: curr.outcome });
      }
    }
  }
  return flips;
}

function positiveHardCheckFlips(baseline, current) {
  const baseByKey = new Map();
  if (baseline.storedJudgeOutcomes) {
    for (const o of baseline.storedJudgeOutcomes) {
      if (o.hard) baseByKey.set(checkKey(o), o);
    }
  }
  const flips = [];
  if (current.storedJudgeOutcomes) {
    for (const curr of current.storedJudgeOutcomes) {
      if (!curr.hard) continue;
      const base = baseByKey.get(checkKey(curr));
      if (base && base.outcome !== 'yes' && curr.outcome === 'yes') {
        flips.push({ url: curr.url, project: curr.project, checkId: curr.clause + '|' + curr.question, baselineAnswer: base.outcome, currentAnswer: curr.outcome });
      }
    }
  }
  return flips;
}

function positiveFlips(baseline, current) {
  const baseByKey = new Map(baseline.outcomes.map((o) => [keyOf(o), o]));
  const flips = [];
  for (const curr of current.outcomes) {
    const base = baseByKey.get(keyOf(curr));
    if (base && base.outcome !== 'yes' && curr.outcome === 'yes') {
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

async function checkSnapshot(snapshotDir, baselineFile, judge = false) {
  const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8'));
  const projectsDir = path.join(snapshotDir, 'projects');
  const projects = await loadProjects(projectsDir);

  const allOutcomes = [];
  const allTierOutcomes = [];
  const allStoredJudgeOutcomes = [];
  let totalCriteria = 0;
  let totalHard = 0;

  for (const project of projects) {
    const { outcomes, tierOutcomes, storedJudgeOutcomes, criteriaCount, hardCount } = await outcomesOf(path.join(projectsDir, project.id + '.json'), ROOT);
    allOutcomes.push(...outcomes.map((o) => ({ ...o, project: project.id })));
    allTierOutcomes.push(...tierOutcomes.map((o) => ({ ...o, project: project.id })));
    allStoredJudgeOutcomes.push(...storedJudgeOutcomes);
    totalCriteria += criteriaCount;
    totalHard += hardCount;
  }

  const current = {
    outcomes: allOutcomes,
    tierOutcomes: allTierOutcomes,
    storedJudgeOutcomes: allStoredJudgeOutcomes,
    totalCriteria,
    totalHard
  };

  const flips = negativeFlips(baseline, current);
  const tierFlips = negativeTierFlips(baseline, current);
  const hardCheckFlips = negativeHardCheckFlips(baseline, current);
  const positiveNumericFlips = positiveFlips(baseline, current);
  const positiveTierFlipsResult = positiveTierFlips(baseline, current);
  const positiveHardCheckFlipsResult = positiveHardCheckFlips(baseline, current);

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
  console.log('Negative flips (numeric): ' + flips.length);
  if (flips.length) {
    for (const flip of flips) {
      console.log('  ' + flip.project + ' | ' + flip.url + ' | ' + flip.clause + ' | ' + flip.question);
    }
  }
  console.log('Negative tier flips (confirmed->not confirmed): ' + tierFlips.length);
  if (tierFlips.length) {
    for (const flip of tierFlips) {
      console.log('  ' + flip.project + ' | ' + flip.url + ' | baseline tier: ' + flip.baselineTier + ' -> current tier: ' + flip.currentTier);
    }
  }
  console.log('Negative hard-check flips (yes->not yes): ' + hardCheckFlips.length);
  if (hardCheckFlips.length) {
    for (const flip of hardCheckFlips) {
      console.log('  ' + flip.project + ' | ' + flip.url + ' | ' + flip.checkId + ' | baseline: ' + flip.baselineAnswer + ' -> current: ' + flip.currentAnswer);
    }
  }
  console.log('Positive flips (numeric): ' + positiveNumericFlips.length);
  console.log('Positive tier flips (not confirmed->confirmed): ' + positiveTierFlipsResult.length);
  console.log('Positive hard-check flips (not yes->yes): ' + positiveHardCheckFlipsResult.length);
  console.log('Criteria count: ' + (criteriaDrop ? 'DROP' : 'OK') + ' (' + baseline.totalCriteria + ' -> ' + current.totalCriteria + ')');
  console.log('Hard checklist: ' + (hardDrop ? 'DROP' : 'OK') + ' (' + baseline.totalHard + ' -> ' + current.totalHard + ')');
  console.log('Yes-rate diff: ' + (yesRateDiff * 100).toFixed(2) + ' points');
  if (bootstrapInterval.difference !== null) {
    console.log('Bootstrap 95% CI for diff: [' + (bootstrapInterval.low * 100).toFixed(2) + ', ' + (bootstrapInterval.high * 100).toFixed(2) + '] (' + paired.length + ' paired items, ' + new Set(paired.map(p => p.cluster)).size + ' researches)');
    console.log('Interval entirely below 0: ' + (intervalBelowZero ? 'YES' : 'NO'));
  }

  const b = flips.length + tierFlips.length + hardCheckFlips.length;
  const c = positiveNumericFlips.length + positiveTierFlipsResult.length + positiveHardCheckFlipsResult.length;
  const pValue = mcNemarExact(b, c);
  console.log('McNemar exact (b=' + b + ', c=' + c + '): p = ' + pValue.toFixed(6));

  const failed = flips.length > 0 || tierFlips.length > 0 || hardCheckFlips.length > 0 || criteriaDrop || hardDrop || intervalBelowZero;

  if (judge) {
    const judgeResult = await runJudgeCheck(snapshotDir, baseline, current);
    console.log('\n=== Judge Check ===');
    console.log('Judge negative flips: ' + judgeResult.flips.length);
    if (judgeResult.flips.length) {
      for (const flip of judgeResult.flips) {
        console.log('  ' + flip.project + ' | ' + flip.url + ' | ' + flip.clause + ' | ' + flip.question + ' (baseline: ' + flip.baselineAnswer + ' -> current: ' + flip.currentAnswer + ')');
      }
    }
    console.log('Unrecorded prompts: ' + judgeResult.unrecorded.length);
    if (judgeResult.unrecorded.length) {
      for (const u of judgeResult.unrecorded) {
        console.log('  ' + u.project + ' | ' + u.url + ' | ' + u.clause + ' | ' + u.question);
      }
    }
    if (judgeResult.flips.length > 0) {
      console.log('\nFAIL (judge flips)');
      return 1;
    }
    console.log('\nPASS (judge)');
  } else {
    console.log(failed ? '\nFAIL' : '\nPASS');
  }
  return failed ? 1 : 0;
}

function getTapeDir(snapshotDir) {
  const envTape = process.env.FRL_TAPE_DIR;
  if (envTape) return path.resolve(envTape);
  return path.join(snapshotDir, 'tape');
}

function createTapeRouter(tapeDir, mode) {
  const tape = createAnswerTape({ dir: tapeDir, mode, fetchImpl: fetch });
  const factory = new ProviderFactory({ env: process.env, fetchImpl: tape.fetch });
  const providers = factory.order().map((preset) => factory.build(preset));
  const router = new ModelRouter({ providers, routeOrder: routeOrderFrom(process.env) });
  return { router, tape, providers };
}

async function loadFullProject(projectFile) {
  return JSON.parse(await fs.readFile(projectFile, 'utf8'));
}

function findPageText(project, url) {
  for (const node of project.nodes ?? []) {
    for (const source of node.sources ?? []) {
      if (source.url === url && source.text) {
        return source.text;
      }
    }
  }
  return null;
}

function getQualitativeItems(checklist) {
  const items = checklistItems({ decisionModel: { checklist } });
  return items.filter((item) => !item.numeric?.measure);
}

async function runJudgeOnItem(judge, item, pageText, checklist, kind, decisionCriteria) {
  if (!pageText) return [];
  return judge.judge(item, pageText, checklist, kind, decisionCriteria, {});
}

function judgeKey(projectId, url, clause, question) {
  return projectId + '|' + url + '|' + clause + '|' + question;
}

async function runJudgeCheck(snapshotDir, baseline, current) {
  const tapeDir = getTapeDir(snapshotDir);
  const tapeExists = await fs.stat(tapeDir).then(() => true).catch(() => false);
  if (!tapeExists) {
    console.log('Tape directory not found: ' + tapeDir + ' (skipping judge check)');
    return { flips: [], unrecorded: [] };
  }

  const { router, tape } = createTapeRouter(tapeDir, 'replay');
  const judge = new ChecklistJudge({ router });

  const projectsDir = path.join(snapshotDir, 'projects');
  const projects = await loadProjects(projectsDir);

  const baselineByKey = new Map();
  for (const outcome of baseline.outcomes) {
    if (outcome.measure === 'judge') {
      baselineByKey.set(judgeKey(outcome.project, outcome.url, outcome.clause, outcome.question), outcome);
    }
  }

  const flips = [];
  const unrecorded = [];

  for (const project of projects) {
    const fullProject = await loadFullProject(path.join(projectsDir, project.id + '.json'));
    const checklist = fullProject.decisionModel?.checklist ?? fullProject.checklist ?? [];
    const decisionCriteria = fullProject.decisionModel?.criteria ?? [];
    const kind = fullProject.brief?.kind ?? null;
    const qualitativeItems = getQualitativeItems(checklist);

    if (!qualitativeItems.length) continue;

    const deliverables = candidateDeliverables(fullProject.candidates);
    for (const deliverable of deliverables) {
      const pageText = findPageText(fullProject, deliverable.url);
      if (!pageText) continue;

      const checks = await runJudgeOnItem(judge, deliverable, pageText, checklist, kind, decisionCriteria);
      for (const check of checks) {
        const key = judgeKey(project.id, deliverable.url, check.clause, check.id.split('|')[1] ?? check.id);
        const baselineOutcome = baselineByKey.get(key);
        const currentAnswer = check.answer;

        if (tape.stats.misses > 0 || tape.stats.blocked > 0) {
          unrecorded.push({ project: project.id, url: deliverable.url, clause: check.clause, question: check.id.split('|')[1] ?? check.id });
        }

        if (baselineOutcome && baselineOutcome.outcome === 'yes' && currentAnswer !== 'yes') {
          flips.push({ project: project.id, url: deliverable.url, clause: check.clause, question: check.id.split('|')[1] ?? check.id, baselineAnswer: baselineOutcome.outcome, currentAnswer });
        }
      }
    }
  }

  return { flips, unrecorded };
}

async function recordSnapshot(snapshotDir, outFile, judge = false) {
  const projectsDir = path.join(snapshotDir, 'projects');
  const projects = await loadProjects(projectsDir);
  const allOutcomes = [];
  let totalCriteria = 0;
  let totalHard = 0;

  if (judge) {
    const tapeDir = getTapeDir(snapshotDir);
    const { router, tape } = createTapeRouter(tapeDir, 'record');
    const judgeInstance = new ChecklistJudge({ router });

    for (const project of projects) {
      const fullProject = await loadFullProject(path.join(projectsDir, project.id + '.json'));
      const checklist = fullProject.decisionModel?.checklist ?? fullProject.checklist ?? [];
      const decisionCriteria = fullProject.decisionModel?.criteria ?? [];
      const kind = fullProject.brief?.kind ?? null;
      const qualitativeItems = getQualitativeItems(checklist);

      if (!qualitativeItems.length) continue;

      const deliverables = candidateDeliverables(fullProject.candidates);
      for (const deliverable of deliverables) {
        const pageText = findPageText(fullProject, deliverable.url);
        if (!pageText) continue;

        const checks = await runJudgeOnItem(judgeInstance, deliverable, pageText, checklist, kind, decisionCriteria);
        for (const check of checks) {
          allOutcomes.push({
            project: project.id,
            url: deliverable.url,
            clause: check.clause,
            question: check.id.split('|')[1] ?? check.id,
            hard: check.hard,
            measure: 'judge',
            outcome: check.answer,
          });
        }
      }
    }

    console.log('Recorded ' + tape.stats.recorded + ' model answers to tape at ' + tapeDir);
  }

  let allTierOutcomes = [];
  let allStoredJudgeOutcomes = [];
  const tierSummaries = {};
  const tierCountsPerProject = {};
  const perCheckPerProject = {};

  for (const project of projects) {
    const { outcomes, tierOutcomes, storedJudgeOutcomes, criteriaCount, hardCount, tierSummary, tierCounts, perCheck } = await outcomesOf(path.join(projectsDir, project.id + '.json'), ROOT);
    allOutcomes.push(...outcomes.map((o) => ({ ...o, project: project.id })));
    allTierOutcomes.push(...tierOutcomes.map((o) => ({ ...o, project: project.id })));
    allStoredJudgeOutcomes.push(...storedJudgeOutcomes);
    totalCriteria += criteriaCount;
    totalHard += hardCount;
    if (tierSummary) tierSummaries[project.id] = tierSummary;
    if (tierCounts) tierCountsPerProject[project.id] = tierCounts;
    if (perCheck) perCheckPerProject[project.id] = perCheck;
  }

  const snapshot = {
    recordedAt: new Date().toISOString(),
    projects: projects.map((p) => p.id),
    totalCriteria,
    totalHard,
    outcomes: allOutcomes,
    tierOutcomes: allTierOutcomes,
    storedJudgeOutcomes: allStoredJudgeOutcomes,
    tierSummaries,
    tierCountsPerProject,
    perCheckPerProject,
  };
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(snapshot, null, 1));
  console.log('Recorded ' + allOutcomes.length + ' outcomes from ' + projects.length + ' projects (criteria: ' + totalCriteria + ', hard: ' + totalHard + ') to ' + outFile);
  console.log('  Tier outcomes: ' + allTierOutcomes.length);
  console.log('  Stored judge outcomes: ' + allStoredJudgeOutcomes.length);
  for (const pid of projects.map(p => p.id)) {
    if (tierCountsPerProject[pid]) {
      const tc = tierCountsPerProject[pid];
      console.log('  ' + pid + ': confirmed=' + tc.confirmed + ', to-confirm=' + tc['to-confirm'] + ', rejected=' + tc.rejected + ', not-judged=' + tc['not-judged']);
    }
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    return 1;
  }
  if (args.command === 'record') {
    return await recordSnapshot(args.snapshotDir, args.out, args.judge);
  }
  return await checkSnapshot(args.snapshotDir, args.baseline, args.judge);
}

if (process.argv[1] && import.meta.url === 'file://' + process.argv[1]) process.exit(await main(process.argv.slice(2)));

export { outcomesOf, negativeFlips, negativeTierFlips, positiveTierFlips, negativeHardCheckFlips, positiveHardCheckFlips, positiveFlips, mcNemarExact, binomialCoefficient, recordSnapshot, checkSnapshot, runJudgeCheck, createTapeRouter, getTapeDir, judgeKey, findPageText, getQualitativeItems, runJudgeOnItem, loadFullProject, extractJudgedItems, computeTiers, extractStoredJudgeAnswers };