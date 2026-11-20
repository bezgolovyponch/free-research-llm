#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilson, spreadOf } from '../src/research/agreement.mjs';
import { supportAudit } from '../src/research/support.mjs';
import { contractClass } from '../src/research/deliverable.mjs';
import { quoteFound } from '../src/research/quote.mjs';
import { plain } from '../src/research/itemgate.mjs';
import { startedDirectly } from './tool-entry.mjs';
import { computeTiers } from './zero-loss.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');

function parseArgs(argv) {
  if (argv.length < 1) return { error: 'usage: node scripts/meter.mjs <dataDir> [--out <file>] [--void-providers <id,id>]' };
  const dataDir = path.resolve(argv[0]);
  const values = (flag) => argv.flatMap((arg, index) => (arg === flag && argv[index + 1] !== undefined ? [argv[index + 1]] : []));
  const value = (flag) => values(flag)[0] ?? null;
  const out = value('--out');
  if (out) {
    const relative = (dir) => path.relative(dir, path.resolve(out));
    const inside = (dir) => relative(dir) === '' || (!relative(dir).startsWith('..') && !path.isAbsolute(relative(dir)));
    if (inside(ROOT) && !inside(DATA_DIR)) return { error: '--out inside the repository must be under data/ (gitignored); nothing was written' };
  }
  const voidProviders = new Set((value('--void-providers') ?? '').split(',').filter(Boolean));
  return { dataDir, out: out ? path.resolve(out) : null, voidProviders };
}

async function loadProjects(dataDir) {
  const projectsDir = path.join(dataDir, 'projects');
  const names = (await fs.readdir(projectsDir).catch(() => [])).filter((name) => name.endsWith('.json')).sort();
  const projects = [];
  for (const name of names) {
    try {
      const project = JSON.parse(await fs.readFile(path.join(projectsDir, name), 'utf8'));
      if (project?.id && typeof project.question === 'string') projects.push(project);
    } catch {
    }
  }
  return projects;
}

function readCalls(filePath) {
  if (!fsSync.existsSync(filePath)) return [];
  const content = fsSync.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  const calls = [];
  for (const line of lines) {
    try {
      const call = JSON.parse(line);
      calls.push(call);
    } catch {
    }
  }
  return calls;
}

function findPageText(project, url) {
  for (const node of project.nodes ?? []) {
    for (const source of node.sources ?? []) {
      if (source.url === url && source.text) {
        return source.text;
      }
    }
  }
  for (const source of project.sources ?? []) {
    if (source.url === url && source.text) {
      return source.text;
    }
  }
  return null;
}

function meterProject(project, rows, { voidProviders }) {
  const projectRows = rows.filter((row) => row.project === project.id && row.purpose !== 'router');
  let ok = 0;
  let failed = 0;
  let totalTokens = 0;
  const providers = {};
  let singleProvider = null;
  let providerAnswered = null;
  let voidFlag = false;

  for (const row of projectRows) {
    if (row.ok) {
      ok++;
      totalTokens += Number(row.tokens) || 0;
      providers[row.provider] = (providers[row.provider] ?? 0) + 1;
      if (providerAnswered === null) providerAnswered = row.provider;
      else if (providerAnswered !== row.provider) providerAnswered = 'multiple';
      if (voidProviders.has(row.provider)) voidFlag = true;
    } else {
      failed++;
    }
  }

  const total = ok + failed;
  const failedShare = total === 0 ? null : failed / total;
  const singleProviderFlag = providerAnswered === 'multiple' ? false : providerAnswered !== null;

  const recomputed = computeTiers(project).tiers;
  const tierCounts = { confirmed: recomputed.confirmed ?? 0, toConfirm: recomputed['to-confirm'] ?? 0, rejected: recomputed.rejected ?? 0, notJudged: recomputed['not-judged'] ?? 0 };

  const nodes = project.nodes ?? [];
  let piecesSettled = 0;
  let piecesTotal = 0;
  for (const node of nodes) {
    if (['verified', 'supported', 'covered'].includes(node.status)) piecesSettled++;
    piecesTotal++;
  }

  const units = tierCounts.confirmed + piecesSettled;

  const audit = supportAudit(nodes);
  const supported = audit.supported;
  const notSupported = audit.disagree + audit.unanswered;
  const unchecked = audit.stale;
  const denominator = supported + notSupported;
  const share = denominator === 0 ? null : supported / denominator;
  const interval = wilson(supported, denominator);

  let quoteFoundCount = 0;
  let quoteNotFoundCount = 0;
  let noQuoteCount = 0;
  let noPageTextCount = 0;
  let recomputedCount = 0;

  for (const node of nodes) {
    if (node.finding?.calculation?.recomputed !== undefined && typeof node.finding.calculation.recomputed === 'number') {
      recomputedCount++;
    }
    for (const claim of node.finding?.claims ?? []) {
      if (claim.answer !== 'yes') continue;
      const url = claim.evidence ?? claim.url;
      if (!url) {
        noPageTextCount++;
        continue;
      }
      const pageText = findPageText(project, url);
      if (!pageText) {
        noPageTextCount++;
        continue;
      }
      if (!claim.quote || claim.quote.trim() === '') {
        noQuoteCount++;
        continue;
      }
      if (quoteFound(pageText, claim.quote)) quoteFoundCount++;
      else quoteNotFoundCount++;
    }
  }

  const verifiedDenom = quoteFoundCount + quoteNotFoundCount + noQuoteCount;
  const verifiedShare = verifiedDenom === 0 ? null : quoteFoundCount / verifiedDenom;

  let settledPerCall = null;
  let settledPerCallLabel = 'model calls';
  if (total === 0) {
    settledPerCall = null;
    settledPerCallLabel = 'no calls';
  } else {
    settledPerCall = units / total;
  }

  let searchFetchCounter = null;
  let searchFetchCounterSource = 'not stored per research';

  const chosenOption = project.report?.chosenOption ?? 'absent';

  return {
    id: project.id,
    question: project.question,
    kind: contractClass(project),
    phase: project.phase,
    ended: project.phase === 'done',
    calls: {
      ok,
      failed,
      total,
      failedShare,
      tokens: totalTokens,
      providers,
      singleProvider: singleProviderFlag,
      void: voidFlag,
    },
    settled: {
      items: tierCounts,
      pieces: { settled: piecesSettled, total: piecesTotal },
      units,
    },
    claims: {
      supported,
      notSupported,
      unchecked,
      share,
      interval,
    },
    evidence: {
      recomputed: recomputedCount,
      quoteFound: quoteFoundCount,
      quoteNotFound: quoteNotFoundCount,
      noQuote: noQuoteCount,
      noPageText: noPageTextCount,
      verifiedShare,
    },
    settledPerCall,
    settledPerCallLabel,
    searchFetchCounter,
    searchFetchCounterSource,
    chosenOption,
  };
}

function bandOf(meters) {
  const groups = new Map();
  for (const m of meters) {
    const key = m.question + '|' + (m.project?.acceptance?.expected ?? '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const bands = [];
  for (const [key, runs] of groups) {
    if (runs.length < 2) continue;
    const n = runs.length;
    const fields = ['calls.failedShare', 'settledPerCall', 'claims.share', 'evidence.verifiedShare'];
    const band = { question: runs[0].question, expected: runs[0].project?.acceptance?.expected ?? '', n };
    for (const field of fields) {
      const values = [];
      let noneCount = 0;
      for (const run of runs) {
        const val = field.split('.').reduce((o, k) => o?.[k], run);
        if (val === null || val === undefined) noneCount++;
        else values.push(val);
      }
      band[field.replace('.', '_')] = values.length
        ? { min: Math.min(...values), max: Math.max(...values), runs: values.length, none: noneCount }
        : { min: null, max: null, runs: 0, none: noneCount };
    }
    const options = runs.map((r) => r.chosenOption);
    const hasAbsent = options.includes('absent');
    if (hasAbsent) {
      band.chosenOptionAgreement = 'not measurable';
    } else {
      const counts = {};
      for (const opt of options) counts[opt] = (counts[opt] ?? 0) + 1;
      const maxCount = Math.max(...Object.values(counts));
      band.chosenOptionAgreement = maxCount / options.length;
    }
    bands.push(band);
  }

  const kindMap = new Map();
  for (const m of meters) {
    const kind = m.kind;
    if (!kindMap.has(kind)) kindMap.set(kind, { projects: 0, calls: { ok: 0, failed: 0, total: 0 }, settled: { items: { confirmed: 0, toConfirm: 0, rejected: 0, notJudged: 0 }, pieces: { settled: 0, total: 0 }, units: 0 }, claims: { supported: 0, notSupported: 0, unchecked: 0 }, evidence: { recomputed: 0, quoteFound: 0, quoteNotFound: 0, noQuote: 0, noPageText: 0 } });
    const k = kindMap.get(kind);
    k.projects++;
    k.calls.ok += m.calls.ok;
    k.calls.failed += m.calls.failed;
    k.calls.total += m.calls.total;
    k.settled.items.confirmed += m.settled.items.confirmed;
    k.settled.items.toConfirm += m.settled.items.toConfirm;
    k.settled.items.rejected += m.settled.items.rejected;
    k.settled.items.notJudged += m.settled.items.notJudged;
    k.settled.pieces.settled += m.settled.pieces.settled;
    k.settled.pieces.total += m.settled.pieces.total;
    k.settled.units += m.settled.units;
    k.claims.supported += m.claims.supported;
    k.claims.notSupported += m.claims.notSupported;
    k.claims.unchecked += m.claims.unchecked;
    k.evidence.recomputed += m.evidence.recomputed;
    k.evidence.quoteFound += m.evidence.quoteFound;
    k.evidence.quoteNotFound += m.evidence.quoteNotFound;
    k.evidence.noQuote += m.evidence.noQuote;
    k.evidence.noPageText += m.evidence.noPageText;
  }

  const byKind = {};
  for (const [kind, k] of kindMap) {
    const claimsDenom = k.claims.supported + k.claims.notSupported;
    const claimsShare = claimsDenom === 0 ? null : k.claims.supported / claimsDenom;
    const verifiedDenom = k.evidence.quoteFound + k.evidence.quoteNotFound + k.evidence.noQuote;
    const verifiedShare = verifiedDenom === 0 ? null : k.evidence.quoteFound / verifiedDenom;
    const failedShare = k.calls.total === 0 ? null : k.calls.failed / k.calls.total;
    const settledPerCall = k.calls.total === 0 ? null : k.settled.units / k.calls.total;
    byKind[kind] = {
      projects: k.projects,
      calls: { ...k.calls, failedShare },
      settled: { ...k.settled, units: k.settled.units },
      claims: { ...k.claims, share: claimsShare },
      evidence: { ...k.evidence, verifiedShare },
      settledPerCall,
    };
  }

  return { bands, byKind };
}

function printTable(meters) {
  console.log('\n=== Per Research ===');
  console.log('id | kind | phase | calls | failed | failedShare | tokens | providers | singleProvider | void | settledUnits | settledPerCall | claimsShare | verifiedShare | chosenOption');
  for (const m of meters) {
    const providersStr = Object.entries(m.calls.providers).map(([k, v]) => `${k}:${v}`).join(',') || 'none';
    console.log(
      `${m.id} | ${m.kind} | ${m.phase} | ${m.calls.total} | ${m.calls.failed} | ` +
      `${m.calls.failedShare === null ? 'null' : m.calls.failedShare.toFixed(3)} | ${m.calls.tokens} | ` +
      `${providersStr} | ${m.calls.singleProvider} | ${m.calls.void} | ` +
      `${m.settled.units} | ${m.settledPerCall === null ? m.settledPerCallLabel : m.settledPerCall.toFixed(3)} | ` +
      `${m.claims.share === null ? 'null' : m.claims.share.toFixed(3)} | ` +
      `${m.evidence.verifiedShare === null ? 'null' : m.evidence.verifiedShare.toFixed(3)} | ` +
      `${m.chosenOption}`
    );
  }

  console.log('\n=== Bands (repeated requests) ===');
  for (const band of bandOf(meters).bands) {
    console.log(
      `Question: ${band.question} | Expected: ${band.expected} | n=${band.n}`
    );
    console.log(
      `  failedShare: min=${band.calls_failedShare?.min?.toFixed(3) ?? 'null'} max=${band.calls_failedShare?.max?.toFixed(3) ?? 'null'} (${band.calls_failedShare?.runs ?? 0} runs, ${band.calls_failedShare?.none ?? 0} none)`
    );
    console.log(
      `  settledPerCall: min=${band.settledPerCall?.min?.toFixed(3) ?? 'null'} max=${band.settledPerCall?.max?.toFixed(3) ?? 'null'} (${band.settledPerCall?.runs ?? 0} runs, ${band.settledPerCall?.none ?? 0} none)`
    );
    console.log(
      `  claimsShare: min=${band.claims_share?.min?.toFixed(3) ?? 'null'} max=${band.claims_share?.max?.toFixed(3) ?? 'null'} (${band.claims_share?.runs ?? 0} runs, ${band.claims_share?.none ?? 0} none)`
    );
    console.log(
      `  verifiedShare: min=${band.evidence_verifiedShare?.min?.toFixed(3) ?? 'null'} max=${band.evidence_verifiedShare?.max?.toFixed(3) ?? 'null'} (${band.evidence_verifiedShare?.runs ?? 0} runs, ${band.evidence_verifiedShare?.none ?? 0} none)`
    );
    console.log(`  chosenOptionAgreement: ${band.chosenOptionAgreement}`);
  }

  const { byKind } = bandOf(meters);
  console.log('\n=== By Kind ===');
  console.log('kind | projects | calls | failedShare | settledUnits | settledPerCall | claimsShare | verifiedShare');
  for (const [kind, k] of Object.entries(byKind)) {
    console.log(
      `${kind} | ${k.projects} | ${k.calls.total} | ${k.calls.failedShare === null ? 'null' : k.calls.failedShare.toFixed(3)} | ` +
      `${k.settled.units} | ${k.settledPerCall === null ? 'null' : k.settledPerCall.toFixed(3)} | ` +
      `${k.claims.share === null ? 'null' : k.claims.share.toFixed(3)} | ` +
      `${k.evidence.verifiedShare === null ? 'null' : k.evidence.verifiedShare.toFixed(3)}`
    );
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    return 1;
  }
  const projects = await loadProjects(args.dataDir);
  const callsPath = path.join(args.dataDir, 'logs', 'model-calls.jsonl');
  const rows = readCalls(callsPath);
  const meters = projects.map((project) => meterProject(project, rows, { voidProviders: args.voidProviders }));
  printTable(meters);
  if (args.out) {
    const output = {
      generatedAt: new Date().toISOString(),
      dataDir: args.dataDir,
      projects: meters,
      bands: bandOf(meters).bands,
      byKind: bandOf(meters).byKind,
    };
    await fs.mkdir(path.dirname(args.out), { recursive: true });
    await fs.writeFile(args.out, JSON.stringify(output, null, 1));
    console.log('\nWritten to ' + args.out);
  }
  return 0;
}

if (startedDirectly(import.meta.url)) process.exit(await main(process.argv.slice(2)));

export { meterProject, bandOf, parseArgs, loadProjects, readCalls, findPageText };