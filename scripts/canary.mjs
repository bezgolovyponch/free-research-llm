#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { computeWasteStats } from './waste.mjs';
import { startedDirectly } from './tool-entry.mjs';
import { evaluationKind, qualifies, itemTier, hardIdsOf, itemEvidence, verdict, acceptanceSummaryOf } from '../src/research/verdict.mjs';
import { kindCluster } from '../src/research/checklist.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
const DEFAULT_PROJECTS_DIR = path.join(DEFAULT_DATA_DIR, 'projects');
const LOGS_DIR = path.join(DEFAULT_DATA_DIR, 'logs');
const API_URL = 'http://127.0.0.1:4600/api/projects';

function getDataDir() {
  const envDir = process.env.FRL_DATA_DIR;
  if (envDir) return path.resolve(envDir);
  return DEFAULT_DATA_DIR;
}

function getProjectsDir(dataDir) {
  return path.join(dataDir, 'projects');
}

function refused(item, spec) {
  return !opens(item, spec) || (item.purpose ?? []).some((c) => purposeState(item, c) === 'no');
}

function opens(item, spec) {
  const entity = Boolean(item.evidence);
  return Boolean(item.live && (entity || item.listing) && (!spec?.valueRange || item.inRange));
}

function purposeState(item, criterion) {
  if (criterion.passed) return 'yes';
  if (criterion.id !== 'purpose-kind') return 'no';
  const judged = (item.checks ?? []).filter((c) => c?.clause === 'kind' && String(c.id ?? '').startsWith('kind|'));
  if (judged.some((c) => c.answer === 'yes' && c.quote)) return 'yes';
  if (judged.some((c) => c.answer === 'no' && c.quote)) return 'no';
  return judged.length ? 'unknown' : 'no';
}

function extractHardChecklistClauses(project) {
  const clusters = project?.decisionModel?.checklist ?? project?.checklist ?? [];
  const clauses = [];
  for (const cluster of clusters) {
    for (const item of cluster.items ?? []) {
      if (item.hard) {
        clauses.push({
          clause: cluster.clause,
          question: item.question,
          numeric: item.numeric ? {
            measure: item.numeric.measure,
            op: item.numeric.op,
            value: item.numeric.value,
            unit: item.numeric.unit,
          } : null,
        });
      }
    }
  }
  return clauses;
}

function extractDecisionCriteria(project) {
  const criteria = project?.decisionModel?.criteria ?? [];
  return criteria.map((c) => ({
    id: c.id,
    measure: c.measure,
    op: c.op,
    value: c.value,
    clause: c.clause,
    source: c.source,
    quote: c.quote,
  }));
}

function getDecisionModelVersion(project) {
  return project?.decisionModel?.version ?? null;
}

function getChecklistVersion(project) {
  return project?.decisionModel?.checklistVersion ?? null;
}

function extractJudgedItems(project) {
  const items = project?.acceptanceResult?.items ?? [];
  if (!items.length) return [];

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
  const kind = evaluationKind(project);
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

function candidateDeliverables(candidates) {
  return (candidates?.kept ?? []).filter((row) => countsTowardResult(row, candidates)).map((row) => ({
    title: row.title,
    url: row.url,
    value: row.value,
    unit: row.unit,
    rawPrice: row.price,
    rawCurrency: row.currency,
    ...(Number.isFinite(row.distanceKm) ? { distanceKm: row.distanceKm } : {}),
    ...(row.site ? { site: row.site } : {}),
    ...(row.plan ? { plan: row.plan } : {}),
    ...(row.verified ? { verified: row.verified } : {}),
    nodeId: row.nodeId,
    harvested: true,
    candidate: true,
  }));
}

function countsTowardResult(row, candidates) {
  return !row.plan || (row.plan.tier === 'fits' && (row.verified?.verdict === 'confirmed' || !candidates?.verification));
}

async function loadProject(projectsDir, id) {
  const file = path.join(projectsDir, id + '.json');
  if (!fsSync.existsSync(file)) return null;
  const content = await fs.readFile(file, 'utf8');
  return JSON.parse(content);
}

async function getProjectIdsFromDir(projectsDir) {
  if (!fsSync.existsSync(projectsDir)) return [];
  const files = await fs.readdir(projectsDir);
  return files.filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
}

async function getProjectIdsFromApi() {
  try {
    const res = await fetch(API_URL);
    if (!res.ok) return [];
    const data = await res.json();
    return data.map((p) => p.id).filter(Boolean);
  } catch {
    return [];
  }
}

async function getProjectIds(dataDir, useApi) {
  const projectsDir = getProjectsDir(dataDir);
  if (useApi) {
    const apiIds = await getProjectIdsFromApi();
    if (apiIds.length > 0) return apiIds;
  }
  return getProjectIdsFromDir(projectsDir);
}

function getLoopState(project) {
  const trials = project?.improve?.trials ?? [];
  const active = trials.some(t => !FUTILE.has(t.outcome) && !GAIN_OUTCOMES.has(t.outcome));
  const kept = trials.filter(t => GAIN_OUTCOMES.has(t.outcome)).length;
  return { active: active ? 1 : 0, trials: trials.length, kept };
}

const FUTILE = new Set(['repeat', 'reverted-noise', 'reverted-whole', 'reverted-piece', 'reverted-regression', 'no-change', 'no-gain', 'no-new-evidence', 'reverted-structure']);
const GAIN_OUTCOMES = new Set(['kept', 'kept-data']);

function getDecisionModelFits(project) {
  const candidates = project?.candidates;
  if (!candidates) return { fits: 0, confirmedFits: 0 };
  const kept = candidateDeliverables(candidates);
  const fits = kept.filter(r => r.plan?.tier === 'fits').length;
  const confirmedFits = kept.filter(r => r.plan?.tier === 'fits' && r.verified?.verdict === 'confirmed').length;
  return { fits, confirmedFits };
}

async function computeFailedCallShare(dataDir) {
  const logsDir = path.join(dataDir, 'logs');
  const filePath = path.join(logsDir, 'model-calls.jsonl');
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const stats = computeWasteStats(filePath, since);
  return stats.failPct;
}

async function snapOne(projectsDir, project) {
  const tierResult = computeTiers(project);
  const loopState = getLoopState(project);
  const dmFits = getDecisionModelFits(project);
  const candidates = project?.candidates;
  const keptCount = candidates?.kept?.length ?? 0;
  const summary = acceptanceSummaryOf(project);

  return {
    id: project.id,
    question: project.question,
    decisionCriteria: decisionCriteriaCount(project),
    decisionCriteriaList: extractDecisionCriteria(project),
    hardChecklistItems: hardChecklistItemsCount(project),
    hardChecklistClauses: extractHardChecklistClauses(project),
    decisionModelVersion: getDecisionModelVersion(project),
    checklistVersion: getChecklistVersion(project),
    verdictTiers: tierResult.tiers,
    verdictSummary: summary,
    decisionModelFits: dmFits.fits,
    confirmedFits: dmFits.confirmedFits,
    candidateRowsKept: keptCount,
    loopState,
  };
}

async function snapAll(dataDir, useApi) {
  const projectsDir = getProjectsDir(dataDir);
  const ids = await getProjectIds(dataDir, useApi);
  const projects = [];
  for (const id of ids) {
    const project = await loadProject(projectsDir, id);
    if (project) projects.push(project);
  }
  const results = [];
  for (const project of projects) {
    results.push(await snapOne(projectsDir, project));
  }
  const failedCallShare = await computeFailedCallShare(dataDir);
  return {
    timestamp: new Date().toISOString(),
    projects: results,
    failedCallShare,
  };
}

function compareClauses(beforeClauses, afterClauses) {
  const removed = [];
  const added = [];

  for (const b of beforeClauses) {
    const found = afterClauses.some(a =>
      a.clause === b.clause &&
      a.question === b.question &&
      ((b.numeric && a.numeric && a.numeric.measure === b.numeric.measure && a.numeric.op === b.numeric.op && a.numeric.value === b.numeric.value && a.numeric.unit === b.numeric.unit) ||
       (!b.numeric && !a.numeric))
    );
    if (!found) removed.push(b);
  }

  for (const a of afterClauses) {
    const found = beforeClauses.some(b =>
      b.clause === a.clause &&
      b.question === a.question &&
      ((a.numeric && b.numeric && b.numeric.measure === a.numeric.measure && b.numeric.op === a.numeric.op && b.numeric.value === a.numeric.value && b.numeric.unit === a.numeric.unit) ||
       (!a.numeric && !b.numeric))
    );
    if (!found) added.push(a);
  }

  return { removed, added };
}

function compareCriteria(beforeCriteria, afterCriteria) {
  const removed = [];
  const added = [];

  for (const b of beforeCriteria) {
    const found = afterCriteria.some(a =>
      a.id === b.id &&
      a.measure === b.measure &&
      a.op === b.op &&
      a.value === b.value
    );
    if (!found) removed.push(b);
  }

  for (const a of afterCriteria) {
    const found = beforeCriteria.some(b =>
      b.id === a.id &&
      b.measure === a.measure &&
      b.op === a.op &&
      b.value === a.value
    );
    if (!found) added.push(a);
  }

  return { removed, added };
}

function printTable(projects, before, after) {
  console.log('\n=== Canary Compare ===');
  console.log('Before: ' + before.timestamp);
  console.log('After:  ' + after.timestamp);
  console.log('');

  const headers = ['Research', 'Criteria', 'Hard', 'Confirmed', 'To-Confirm', 'Rejected', 'Fits', 'ConfFits', 'Kept', 'Loop(active/trials/kept)', 'Fail%'];
  const colWidths = headers.map(h => h.length);
  const rows = [];

  for (const proj of projects) {
    const b = before.projects.find(p => p.id === proj.id);
    const a = after.projects.find(p => p.id === proj.id);
    if (!b || !a) continue;

    const criteriaDrop = a.decisionCriteria < b.decisionCriteria ? '↓' : (a.decisionCriteria > b.decisionCriteria ? '↑' : '');
    const hardDrop = a.hardChecklistItems < b.hardChecklistItems ? '↓' : (a.hardChecklistItems > b.hardChecklistItems ? '↑' : '');
    const confirmedDrop = a.verdictTiers.confirmed < b.verdictTiers.confirmed ? '↓' : (a.verdictTiers.confirmed > b.verdictTiers.confirmed ? '↑' : '');
    const toConfirmChange = a.verdictTiers['to-confirm'] !== b.verdictTiers['to-confirm'] ? (a.verdictTiers['to-confirm'] > b.verdictTiers['to-confirm'] ? '↑' : '↓') : '';
    const rejectedRise = a.verdictTiers.rejected > b.verdictTiers.rejected ? '↑' : (a.verdictTiers.rejected < b.verdictTiers.rejected ? '↓' : '');
    const fitsDrop = a.decisionModelFits < b.decisionModelFits ? '↓' : (a.decisionModelFits > b.decisionModelFits ? '↑' : '');
    const confFitsDrop = a.confirmedFits < b.confirmedFits ? '↓' : (a.confirmedFits > b.confirmedFits ? '↑' : '');
    const keptChange = a.candidateRowsKept !== b.candidateRowsKept ? (a.candidateRowsKept > b.candidateRowsKept ? '↑' : '↓') : '';
    const loopActiveChange = a.loopState.active !== b.loopState.active ? (a.loopState.active > b.loopState.active ? '↑' : '↓') : '';
    const loopTrialsChange = a.loopState.trials !== b.loopState.trials ? (a.loopState.trials > b.loopState.trials ? '↑' : '↓') : '';
    const loopKeptChange = a.loopState.kept !== b.loopState.kept ? (a.loopState.kept > b.loopState.kept ? '↑' : '↓') : '';
    const failPctRise = a.failedCallShare > b.failedCallShare ? '↑' : (a.failedCallShare < b.failedCallShare ? '↓' : '');

    rows.push({
      name: proj.id.slice(0, 30),
      criteria: b.decisionCriteria + '→' + a.decisionCriteria + criteriaDrop,
      hard: b.hardChecklistItems + '→' + a.hardChecklistItems + hardDrop,
      confirmed: b.verdictTiers.confirmed + '→' + a.verdictTiers.confirmed + confirmedDrop,
      toConfirm: b.verdictTiers['to-confirm'] + '→' + a.verdictTiers['to-confirm'] + toConfirmChange,
      rejected: b.verdictTiers.rejected + '→' + a.verdictTiers.rejected + rejectedRise,
      fits: b.decisionModelFits + '→' + a.decisionModelFits + fitsDrop,
      confFits: b.confirmedFits + '→' + a.confirmedFits + confFitsDrop,
      kept: b.candidateRowsKept + '→' + a.candidateRowsKept + keptChange,
      loop: b.loopState.active + '/' + b.loopState.trials + '/' + b.loopState.kept + '→' + a.loopState.active + '/' + a.loopState.trials + '/' + a.loopState.kept + loopActiveChange + loopTrialsChange + loopKeptChange,
      failPct: b.failedCallShare + '→' + a.failedCallShare + failPctRise,
    });
  }

  for (const row of rows) {
    colWidths[0] = Math.max(colWidths[0], row.name.length);
    colWidths[1] = Math.max(colWidths[1], row.criteria.length);
    colWidths[2] = Math.max(colWidths[2], row.hard.length);
    colWidths[3] = Math.max(colWidths[3], row.confirmed.length);
    colWidths[4] = Math.max(colWidths[4], row.toConfirm.length);
    colWidths[5] = Math.max(colWidths[5], row.rejected.length);
    colWidths[6] = Math.max(colWidths[6], row.fits.length);
    colWidths[7] = Math.max(colWidths[7], row.confFits.length);
    colWidths[8] = Math.max(colWidths[8], row.kept.length);
    colWidths[9] = Math.max(colWidths[9], row.loop.length);
    colWidths[10] = Math.max(colWidths[10], row.failPct.length);
  }

  const fmt = (str, width) => str.padEnd(width);
  console.log(headers.map((h, i) => fmt(h, colWidths[i])).join(' | '));
  console.log(colWidths.map(w => '─'.repeat(w)).join('-+-'));
  for (const row of rows) {
    console.log([
      fmt(row.name, colWidths[0]),
      fmt(row.criteria, colWidths[1]),
      fmt(row.hard, colWidths[2]),
      fmt(row.confirmed, colWidths[3]),
      fmt(row.toConfirm, colWidths[4]),
      fmt(row.rejected, colWidths[5]),
      fmt(row.fits, colWidths[6]),
      fmt(row.confFits, colWidths[7]),
      fmt(row.kept, colWidths[8]),
      fmt(row.loop, colWidths[9]),
      fmt(row.failPct, colWidths[10]),
    ].join(' | '));
  }
}

function checkFlags(before, after) {
  const flags = [];

  for (const proj of after.projects) {
    const b = before.projects.find(p => p.id === proj.id);
    if (!b) continue;

    if (proj.decisionModelVersion !== b.decisionModelVersion || proj.checklistVersion !== b.checklistVersion) {
      flags.push(proj.id + ': model rebuilt (decisionModel.version ' + (b.decisionModelVersion ?? 'none') + ' → ' + (proj.decisionModelVersion ?? 'none') + ', checklistVersion ' + (b.checklistVersion ?? 'none') + ' → ' + (proj.checklistVersion ?? 'none') + ')');
    }

    if (proj.decisionCriteria < b.decisionCriteria) {
      flags.push(proj.id + ': decision criteria dropped (' + b.decisionCriteria + ' → ' + proj.decisionCriteria + ')');
    }
    if (proj.hardChecklistItems < b.hardChecklistItems) {
      flags.push(proj.id + ': hard checklist items dropped (' + b.hardChecklistItems + ' → ' + proj.hardChecklistItems + ')');
    }

    if (proj.verdictTiers.confirmed < b.verdictTiers.confirmed) {
      flags.push(proj.id + ': confirmed dropped (' + b.verdictTiers.confirmed + ' → ' + proj.verdictTiers.confirmed + ')');
    }
    if (proj.confirmedFits < b.confirmedFits) {
      flags.push(proj.id + ': confirmed fits dropped (' + b.confirmedFits + ' → ' + proj.confirmedFits + ')');
    }

    const rejectedBefore = b.verdictTiers.rejected;
    const rejectedAfter = proj.verdictTiers.rejected;
    const confirmedBefore = b.verdictTiers.confirmed;
    const confirmedAfter = proj.verdictTiers.confirmed;
    if (rejectedBefore > 0) {
      const rejectedRisePct = ((rejectedAfter - rejectedBefore) / rejectedBefore) * 100;
      if (rejectedRisePct > 20 && confirmedAfter <= confirmedBefore) {
        flags.push(proj.id + ': rejected rose ' + rejectedRisePct.toFixed(1) + '% (' + rejectedBefore + ' → ' + rejectedAfter + ') while confirmed did not rise (' + confirmedBefore + ' → ' + confirmedAfter + ')');
      }
    } else if (rejectedAfter > 0 && confirmedAfter <= confirmedBefore) {
      flags.push(proj.id + ': rejected rose from 0 to ' + rejectedAfter + ' while confirmed did not rise (' + confirmedBefore + ' → ' + confirmedAfter + ')');
    }

    const clauseDiff = compareClauses(b.hardChecklistClauses ?? [], proj.hardChecklistClauses ?? []);
    if (clauseDiff.removed.length > 0) {
      for (const c of clauseDiff.removed) {
        const numeric = c.numeric ? ` ${c.numeric.measure} ${c.numeric.op} ${c.numeric.value} ${c.numeric.unit}` : '';
        flags.push(proj.id + ': hard checklist clause removed: ' + c.clause + ' — ' + c.question + numeric);
      }
    }
    if (clauseDiff.added.length > 0) {
      for (const c of clauseDiff.added) {
        const numeric = c.numeric ? ` ${c.numeric.measure} ${c.numeric.op} ${c.numeric.value} ${c.numeric.unit}` : '';
        flags.push(proj.id + ': hard checklist clause added: ' + c.clause + ' — ' + c.question + numeric);
      }
    }

    const criteriaDiff = compareCriteria(b.decisionCriteriaList ?? [], proj.decisionCriteriaList ?? []);
    if (criteriaDiff.removed.length > 0) {
      for (const c of criteriaDiff.removed) {
        flags.push(proj.id + ': decision criterion removed: ' + (c.clause ?? c.id) + ' — ' + c.measure + ' ' + c.op + ' ' + c.value + (c.quote ? ' [' + c.quote + ']' : ''));
      }
    }
    if (criteriaDiff.added.length > 0) {
      for (const c of criteriaDiff.added) {
        flags.push(proj.id + ': decision criterion added: ' + (c.clause ?? c.id) + ' — ' + c.measure + ' ' + c.op + ' ' + c.value + (c.quote ? ' [' + c.quote + ']' : ''));
      }
    }
  }

  const failPctRise = after.failedCallShare - before.failedCallShare;
  if (failPctRise > 15) {
    flags.push('global: failed-call share rose ' + failPctRise.toFixed(1) + ' points (' + before.failedCallShare + ' → ' + after.failedCallShare + ')');
  }

  return flags;
}

async function getMergeSha() {
  try {
    const { spawnSync } = await import('node:child_process');
    const { stdout } = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    const sha = stdout.trim();
    const { stdout: log } = spawnSync('git', ['log', '-1', '--format=%P', sha], { cwd: ROOT, encoding: 'utf8' });
    const parents = log.trim().split(' ');
    if (parents.length > 1) return sha;
    return null;
  } catch {
    return null;
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: 'string', short: 'o' },
      after: { type: 'string', short: 'a' },
      data: { type: 'string', short: 'd' },
      api: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  const command = positionals[0];
  const dataDir = values.data ? path.resolve(values.data) : getDataDir();
  const useApi = values.api === true;

  if (command === 'snap') {
    const out = values.out;
    if (!out) {
      console.error('Usage: canary.mjs snap --out <file> [--data <dir>] [--api]');
      process.exit(1);
    }
    const snapshot = await snapAll(dataDir, useApi);
    if (snapshot.projects.length === 0) {
      console.error('NOT MEASURED: no researches found at ' + dataDir);
      process.exit(2);
    }
    await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await fs.writeFile(path.resolve(out), JSON.stringify(snapshot, null, 1));
    console.log('Snapshot written to ' + out);
    console.log('Projects: ' + snapshot.projects.length + ', Failed-call share: ' + snapshot.failedCallShare + '%');
    return 0;
  }

  if (command === 'compare') {
    const beforeFile = positionals[1];
    if (!beforeFile) {
      console.error('Usage: canary.mjs compare <before> [--after <file>] [--data <dir>] [--api]');
      process.exit(1);
    }
    const before = JSON.parse(await fs.readFile(path.resolve(beforeFile), 'utf8'));

    let after;
    if (values.after) {
      after = JSON.parse(await fs.readFile(path.resolve(values.after), 'utf8'));
    } else {
      after = await snapAll(dataDir, useApi);
      if (after.projects.length === 0) {
        console.error('NOT MEASURED: no researches found at ' + dataDir);
        process.exit(2);
      }
    }

    printTable(after.projects, before, after);

    const flags = checkFlags(before, after);
    if (flags.length > 0) {
      console.log('\n⚠ FLAGS:');
      for (const flag of flags) console.log('  ' + flag);
      const mergeSha = await getMergeSha();
      if (mergeSha) {
        console.log('\nRevert command: git revert -m 1 ' + mergeSha);
      }
      process.exit(1);
    } else {
      console.log('\n✓ No significant drops detected');
      process.exit(0);
    }
  }

  console.error('Usage: canary.mjs snap --out <file> [--data <dir>] [--api] | compare <before> [--after <file>] [--data <dir>] [--api]');
  process.exit(1);
}

function decisionCriteriaCount(project) {
  return (project?.decisionModel?.criteria ?? []).length;
}

function hardChecklistItemsCount(project) {
  const clusters = project?.decisionModel?.checklist ?? project?.checklist ?? [];
  return clusters.flatMap((c) => c.items ?? []).filter((i) => i.hard).length;
}

if (startedDirectly(import.meta.url)) main().catch(err => {
  console.error(err);
  process.exit(1);
});

export { snapAll, snapOne, computeTiers, checkFlags, hardIdsOf, kindCluster, itemTier, qualifies, refused, opens, purposeState, verdict, itemEvidence, acceptanceSummaryOf, decisionCriteriaCount, hardChecklistItemsCount, extractJudgedItems, candidateDeliverables, countsTowardResult, getLoopState, getDecisionModelFits, computeFailedCallShare, printTable, getMergeSha, extractHardChecklistClauses, extractDecisionCriteria, getDecisionModelVersion, getChecklistVersion, compareClauses, compareCriteria };