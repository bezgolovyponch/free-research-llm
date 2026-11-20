#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join, resolve, dirname } from 'node:path';
import { verdict, runOutcome, verdictInvariants, evaluationKind } from '../src/research/verdict.mjs';
import { purposeChecks } from '../src/research/acceptance.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || !['run', 'accept'].includes(command)) {
    console.error('Usage: node scripts/rebuild-check.mjs run <snapshotDir> [--only id1,id2] [--ledger <file>]');
    console.error('       node scripts/rebuild-check.mjs accept <snapshotDir> --ledger <file> --reason "<text>" [--only id1,id2]');
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
  let ledgerFile = null;
  const ledgerIdx = args.indexOf('--ledger');
  if (ledgerIdx >= 0 && args[ledgerIdx + 1]) {
    ledgerFile = resolve(args[ledgerIdx + 1]);
  }
  let reason = null;
  const reasonIdx = args.indexOf('--reason');
  if (reasonIdx >= 0 && args[reasonIdx + 1]) {
    reason = args[reasonIdx + 1];
  }
  return { command, snapshotDir: resolve(snapshotDir), onlyPrefixes, ledgerFile, reason };
}

function matchesOnly(id, prefixes) {
  if (!prefixes.length) return true;
  return prefixes.some(p => {
    if (id.startsWith(p)) return true;
    const parts = id.split('-');
    return parts[parts.length - 1] === p;
  });
}

async function loadLedger(ledgerFile) {
  try {
    const content = await readFile(ledgerFile, 'utf8');
    return JSON.parse(content);
  } catch {
    return { entries: [] };
  }
}

async function saveLedger(ledgerFile, ledger) {
  await mkdir(dirname(ledgerFile), { recursive: true });
  await writeFile(ledgerFile, JSON.stringify(ledger, null, 1));
}

function ledgerKey(project, unit, stored, rebuilt) {
  return `${project}|${unit}|${stored}|${rebuilt}`;
}

function findLedgerEntry(ledger, project, unit, stored, rebuilt) {
  const key = ledgerKey(project, unit, stored, rebuilt);
  return ledger.entries.find(e => e.key === key);
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

async function checkProject(project, projectPath, ledger, useLedger) {
  const id = project.id ?? basename(projectPath, '.json');
  const kind = project.decisionModel?.kind?.label ?? project.brief?.kind?.label ?? 'unknown';
  const lines = [];
  let hasDrift = false;
  let skipCount = 0;
  const drifts = [];

  const acceptance = project.acceptance ?? {};
  const checklist = project.checklist ?? null;
  const kindObj = evaluationKind(project);
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

    const acceptanceDrifts = compareCounts('acceptance', {
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
    for (const d of acceptanceDrifts) {
      drifts.push({ project: id, kind, unit: d.unit, stored: d.stored, rebuilt: d.rebuilt });
    }

    if (drifts.length === 0) {
      lines.push(`${id} | ${kind} | OK acceptance`);
    }

    if (report?.verdict) {
      const parsed = parseAcceptanceClause(report.verdict);
      const verdictDrifts = compareCounts('verdict', {
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
      for (const d of verdictDrifts) {
        drifts.push({ project: id, kind, unit: d.unit, stored: d.stored, rebuilt: d.rebuilt });
      }
      if (verdictDrifts.length === 0) {
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
      drifts.push({ project: id, kind, unit: 'runOutcome', stored: JSON.stringify(stored), rebuilt: JSON.stringify(rebuiltOutcome) });
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
      drifts.push({ project: id, kind, unit: 'chosenOption', stored: `id ${chosen} not among the option ids`, rebuilt: `id ${chosen} not among the option ids`, legacyFormat: `id ${chosen} not among the option ids` });
    } else if (chosenNote) {
      drifts.push({ project: id, kind, unit: 'chosenOption', stored: `id ${chosen} stored with note ${chosenNote}`, rebuilt: `id ${chosen} stored with note ${chosenNote}`, legacyFormat: `id ${chosen} stored with note ${chosenNote}` });
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
      drifts.push({ project: id, kind, unit: d.unit, stored: d.stored, rebuilt: d.rebuilt });
    }
    if (purposeDrifts.length === 0) {
      lines.push(`${id} | ${kind} | OK purposeChecks`);
    }
  }

  const invariantViolations = verdictInvariants(project, { memo: true });
  for (const reason of invariantViolations) {
    lines.push(`${id} | ${kind} | INVARIANT ${reason}`);
  }

  if (useLedger && ledger) {
    const matchedKeys = new Set();
    for (const d of drifts) {
      const entry = findLedgerEntry(ledger, d.project, d.unit, d.stored, d.rebuilt);
      if (entry) {
        matchedKeys.add(ledgerKey(d.project, d.unit, d.stored, d.rebuilt));
        const display = d.legacyFormat ? `${d.project} | ${d.kind} | ACCEPTED ${d.unit}: ${d.legacyFormat} (${entry.reason})` : `${d.project} | ${d.kind} | ACCEPTED ${d.unit}: stored ${d.stored} rebuilt ${d.rebuilt} (${entry.reason})`;
        lines.push(display);
      } else {
        const display = d.legacyFormat ? `${d.project} | ${d.kind} | DRIFT ${d.unit}: ${d.legacyFormat}` : `${d.project} | ${d.kind} | DRIFT ${d.unit}: stored ${d.stored} rebuilt ${d.rebuilt}`;
        lines.push(display);
        hasDrift = true;
      }
    }
    return { lines, hasDrift, skipCount, drifts, matchedKeys };
  } else {
    for (const d of drifts) {
      const display = d.legacyFormat ? `${d.project} | ${d.kind} | DRIFT ${d.unit}: ${d.legacyFormat}` : `${d.project} | ${d.kind} | DRIFT ${d.unit}: stored ${d.stored} rebuilt ${d.rebuilt}`;
      lines.push(display);
      hasDrift = true;
    }
    return { lines, hasDrift, skipCount, drifts, matchedKeys: new Set() };
  }
}

async function acceptCommand(snapshotDir, onlyPrefixes, ledgerFile, reason) {
  if (!ledgerFile) {
    console.error('accept command requires --ledger <file>');
    process.exit(1);
  }
  if (!reason) {
    console.error('accept command requires --reason "<text>"');
    process.exit(1);
  }

  const ledger = await loadLedger(ledgerFile);
  const projectsDir = join(snapshotDir, 'projects');
  let entries;
  try {
    entries = await readdir(projectsDir);
  } catch {
    console.error(`No projects directory at ${projectsDir}`);
    process.exit(1);
  }

  const projectFiles = entries.filter(f => f.endsWith('.json')).sort();
  let acceptedCount = 0;

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

    const { drifts } = await checkProject(project, projectPath, null, false);
    for (const d of drifts) {
      const key = ledgerKey(d.project, d.unit, d.stored, d.rebuilt);
      const existing = ledger.entries.find(e => e.key === key);
      if (!existing) {
        ledger.entries.push({
          key,
          project: d.project,
          unit: d.unit,
          stored: d.stored,
          rebuilt: d.rebuilt,
          reason,
          acceptedAt: new Date().toISOString()
        });
        acceptedCount++;
      }
    }
  }

  await saveLedger(ledgerFile, ledger);
  console.log(`Accepted ${acceptedCount} drift(s) into ledger at ${ledgerFile}`);
}

async function runCommand(snapshotDir, onlyPrefixes, ledgerFile) {
  const ledger = ledgerFile ? await loadLedger(ledgerFile) : null;
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
  const allMatchedKeys = new Set();

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

    const { lines, hasDrift, skipCount, matchedKeys } = await checkProject(project, projectPath, ledger, !!ledgerFile);
    for (const line of lines) {
      console.log(line);
    }
    totalSkips += skipCount;
    if (hasDrift) totalDrifts++;
    for (const key of matchedKeys) {
      allMatchedKeys.add(key);
    }
  }

  if (ledgerFile && ledger) {
    const staleCount = ledger.entries.filter(e => !allMatchedKeys.has(e.key)).length;
    if (staleCount > 0) {
      console.log(`stale ledger entries: ${staleCount}`);
    }
  }

  const status = totalDrifts === 0
    ? `PASS (${totalProjects} projects, ${totalSkips} skips)`
    : `FAIL (${totalDrifts} drifts; ${totalProjects} projects, ${totalSkips} skips)`;
  console.log(`rebuild-check: ${status}`);
  process.exit(totalDrifts > 0 ? 1 : 0);
}

async function main() {
  const { command, snapshotDir, onlyPrefixes, ledgerFile, reason } = parseArgs();
  if (command === 'accept') {
    await acceptCommand(snapshotDir, onlyPrefixes, ledgerFile, reason);
  } else {
    await runCommand(snapshotDir, onlyPrefixes, ledgerFile);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});