#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { verdict, runOutcome, verdictInvariants } from '../src/research/verdict.mjs';
import { purposeChecks } from '../src/research/acceptance.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  if (args[0] !== 'run') {
    console.error('Usage: node scripts/rebuild-check.mjs run <snapshotDir> [--only id1,id2]');
    process.exit(1);
  }
  const snapshotDir = args[1];
  if (!snapshotDir) {
    console.error('Missing snapshotDir');
    process.exit(1);
  }
  let onlyPrefixes = [];
  const onlyIdx = args.indexOf('--only');
  if (onlyIdx >= 0 && args[onlyIdx + 1]) {
    onlyPrefixes = args[onlyIdx + 1].split(',').map(s => s.trim()).filter(Boolean);
  }
  return { snapshotDir: resolve(snapshotDir), onlyPrefixes };
}

function matchesOnly(id, prefixes) {
  if (!prefixes.length) return true;
  return prefixes.some(p => {
    if (id.startsWith(p)) return true;
    const parts = id.split('-');
    return parts[parts.length - 1] === p;
  });
}

function parseAcceptanceClause(verdictText) {
  const text = String(verdictText ?? '');
  const counts = { confirmed: null, toConfirm: null, rejected: null, notRead: null };
  const confirmedMatch = text.match(/(\d+)\s+of\s+\d+\s+confirmed/i);
  if (confirmedMatch) {
    counts.confirmed = Number(confirmedMatch[1]);
  }
  const toConfirmMatch = text.match(/(\d+)\s+to\s+confirm/i);
  if (toConfirmMatch) {
    counts.toConfirm = Number(toConfirmMatch[1]);
  }
  const rejectedMatch = text.match(/(\d+)\s+rejected/i);
  if (rejectedMatch) {
    counts.rejected = Number(rejectedMatch[1]);
  }
  const notReadMatch = text.match(/(\d+)\s+not\s+read/i);
  if (notReadMatch) {
    counts.notRead = Number(notReadMatch[1]);
  }
  return counts;
}

function compareCounts(label, stored, rebuilt) {
  const drifts = [];
  for (const key of ['confirmed', 'toConfirm', 'rejected', 'notRead']) {
    const s = stored[key];
    const r = rebuilt[key];
    if (s !== null && r !== null && s !== r) {
      drifts.push({ unit: label + '.' + key, stored: s, rebuilt: r });
    }
  }
  return drifts;
}

function comparePurposeCriteria(storedProject, rebuiltChecks) {
  if (!storedProject.acceptanceResult?.items?.length) return null;
  const storedChecks = storedProject.acceptanceResult?.checks ?? [];
  const storedIds = storedChecks.map(c => String(c?.id ?? '')).filter(cid => cid.startsWith('purpose-'));
  const rebuiltIds = rebuiltChecks.map(c => String(c?.id ?? ''));
  if (!storedIds.length && !rebuiltIds.length) return null;
  const drifts = [];
  for (const cid of storedIds) {
    if (!rebuiltIds.includes(cid)) {
      drifts.push({ unit: 'purpose.' + cid, stored: 'present', rebuilt: 'missing' });
    }
  }
  for (const cid of rebuiltIds) {
    if (!storedIds.includes(cid)) {
      drifts.push({ unit: 'purpose.' + cid, stored: 'missing', rebuilt: 'present' });
    }
  }
  return drifts;
}

async function checkProject(project, projectPath) {
  const id = project.id ?? basename(projectPath, '.json');
  const kind = project.decisionModel?.kind?.label ?? project.brief?.kind?.label ?? 'unknown';
  const lines = [];
  let hasDrift = false;
  let skipCount = 0;

  const acceptance = project.acceptance ?? {};
  const checklist = project.checklist ?? null;
  const kindObj = project.decisionModel?.kind ?? project.brief?.kind ?? null;
  const acceptanceResult = project.acceptanceResult ?? null;
  const report = project.report ?? null;

  if (acceptanceResult?.items && checklist && acceptance.itemCount) {
    const spec = { ...acceptance, itemCount: acceptance.itemCount };
    const rebuiltVerdict = verdict(acceptanceResult.items, spec, checklist, kindObj);
    const rebuiltCounts = rebuiltVerdict.tiers;

    const storedCounts = acceptanceResult.verdict?.tiers ?? {
      confirmed: acceptanceResult.validCount ?? 0,
      toConfirm: acceptanceResult.tiers?.toConfirm ?? 0,
      rejected: acceptanceResult.tiers?.rejected ?? 0,
      notJudged: acceptanceResult.tiers?.notJudged ?? 0
    };

    const drifts = compareCounts('acceptance', {
      confirmed: storedCounts.confirmed,
      toConfirm: storedCounts.toConfirm,
      rejected: storedCounts.rejected,
      notRead: storedCounts.notJudged
    }, {
      confirmed: rebuiltCounts.confirmed,
      toConfirm: rebuiltCounts.toConfirm,
      rejected: rebuiltCounts.rejected,
      notRead: rebuiltCounts.notJudged
    });
    for (const d of drifts) {
      lines.push(`${id} | ${kind} | DRIFT ${d.unit}: stored ${d.stored} rebuilt ${d.rebuilt}`);
      hasDrift = true;
    }

    if (drifts.length === 0) {
      lines.push(`${id} | ${kind} | OK acceptance`);
    }

    if (report?.verdict) {
      const parsed = parseAcceptanceClause(report.verdict);
      const drifts2 = compareCounts('verdict', {
        confirmed: parsed.confirmed,
        toConfirm: parsed.toConfirm,
        rejected: parsed.rejected,
        notRead: parsed.notRead
      }, {
        confirmed: rebuiltCounts.confirmed,
        toConfirm: rebuiltCounts.toConfirm,
        rejected: rebuiltCounts.rejected,
        notRead: rebuiltCounts.notJudged
      });
      for (const d of drifts2) {
        lines.push(`${id} | ${kind} | DRIFT ${d.unit}: stored ${d.stored} rebuilt ${d.rebuilt}`);
        hasDrift = true;
      }
      if (drifts2.length === 0) {
        lines.push(`${id} | ${kind} | OK verdict`);
      }
    } else {
      lines.push(`${id} | ${kind} | SKIP verdict: no report.verdict`);
      skipCount++;
    }
  } else {
    lines.push(`${id} | ${kind} | SKIP acceptance: missing items, checklist, or spec`);
    skipCount++;
  }

  if (project.runOutcome) {
    const rebuiltOutcome = runOutcome(project);
    const stored = project.runOutcome;
    if (stored.state !== rebuiltOutcome.state || stored.confirmed !== rebuiltOutcome.confirmed || stored.asked !== rebuiltOutcome.asked) {
      lines.push(`${id} | ${kind} | DRIFT runOutcome: stored ${JSON.stringify(stored)} rebuilt ${JSON.stringify(rebuiltOutcome)}`);
      hasDrift = true;
    } else {
      lines.push(`${id} | ${kind} | OK runOutcome`);
    }
  } else {
    lines.push(`${id} | ${kind} | SKIP runOutcome: not stored (derived value)`);
    skipCount++;
  }

  const options = report?.options ?? [];
  const chosen = report?.chosenOption ?? null;
  const chosenNote = report?.chosenOptionNote ?? null;
  if (chosen !== null && chosen !== undefined && chosen !== '') {
    const optionIds = options.map(o => o?.id);
    if (!optionIds.includes(chosen)) {
      lines.push(`${id} | ${kind} | DRIFT chosenOption: id ${chosen} not among the option ids`);
      hasDrift = true;
    } else if (chosenNote) {
      lines.push(`${id} | ${kind} | DRIFT chosenOption: id ${chosen} stored with note ${chosenNote}`);
      hasDrift = true;
    } else {
      lines.push(`${id} | ${kind} | OK chosenOption`);
    }
  } else if (chosenNote) {
    lines.push(`${id} | ${kind} | OK chosenOption`);
  } else {
    lines.push(`${id} | ${kind} | SKIP chosenOption: none stored`);
    skipCount++;
  }

  const rebuiltPurpose = purposeChecks(project);
  const purposeDrifts = comparePurposeCriteria(project, rebuiltPurpose);
  if (purposeDrifts === null) {
    lines.push(`${id} | ${kind} | SKIP purposeChecks: no purpose criteria on an item path`);
    skipCount++;
  } else {
    for (const d of purposeDrifts) {
      lines.push(`${id} | ${kind} | DRIFT ${d.unit}: stored ${d.stored} rebuilt ${d.rebuilt}`);
      hasDrift = true;
    }
    if (purposeDrifts.length === 0) {
      lines.push(`${id} | ${kind} | OK purposeChecks`);
    }
  }

  const invariantViolations = verdictInvariants(project, { memo: true });
  for (const reason of invariantViolations) {
    lines.push(`${id} | ${kind} | INVARIANT ${reason}`);
  }

  return { lines, hasDrift, skipCount };
}

async function main() {
  const { snapshotDir, onlyPrefixes } = parseArgs();
  const projectsDir = join(snapshotDir, 'projects');
  let entries;
  try {
    entries = await readdir(projectsDir);
  } catch {
    console.error(`No projects directory at ${projectsDir}`);
    process.exit(1);
  }

  const projectFiles = entries.filter(f => f.endsWith('.json')).sort();
  let totalProjects = 0;
  let totalSkips = 0;
  let totalDrifts = 0;

  for (const file of projectFiles) {
    const projectPath = join(projectsDir, file);
    let project;
    try {
      const content = await readFile(projectPath, 'utf8');
      project = JSON.parse(content);
    } catch (e) {
      console.error(`Failed to load ${file}: ${e.message}`);
      continue;
    }

    if (!matchesOnly(project.id ?? file, onlyPrefixes)) continue;
    totalProjects++;

    const { lines, hasDrift, skipCount } = await checkProject(project, projectPath);
    for (const line of lines) {
      console.log(line);
    }
    totalSkips += skipCount;
    if (hasDrift) totalDrifts++;
  }

  const status = totalDrifts === 0
    ? `PASS (${totalProjects} projects, ${totalSkips} skips)`
    : `FAIL (${totalDrifts} drifts; ${totalProjects} projects, ${totalSkips} skips)`;
  console.log(`rebuild-check: ${status}`);
  process.exit(totalDrifts > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
