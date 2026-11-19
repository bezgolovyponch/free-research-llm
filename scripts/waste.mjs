#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseDateArg(arg, endOfDay = false) {
  const date = new Date(arg + (endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'));
  if (isNaN(date.getTime())) throw new Error(`Invalid date: ${arg}`);
  return date;
}

export function readCalls(filePath, since, until) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  const calls = [];
  for (const line of lines) {
    try {
      const call = JSON.parse(line);
      const ts = new Date(call.ts);
      if (ts >= since && ts <= until) calls.push(call);
    } catch {
    }
  }
  return calls;
}

export function computeWasteStats(filePath, since) {
  const calls = readCalls(filePath, since, new Date('2099-12-31'));
  let total = 0;
  let failed = 0;
  for (const call of calls) {
    total++;
    if (!call.ok) failed++;
  }
  const failPct = total ? Math.round((failed / total) * 1000) / 10 : 0;
  return { total, failed, failPct };
}

export function aggregate(calls) {
  const byPurpose = {};
  const byProvider = {};
  let totalTokens = 0;
  let totalCalls = 0;
  let totalFailed = 0;

  for (const call of calls) {
    totalCalls++;
    totalTokens += call.tokens || 0;
    if (!call.ok) totalFailed++;

    if (!byPurpose[call.purpose]) byPurpose[call.purpose] = [];
    byPurpose[call.purpose].push(call);

    if (!byProvider[call.provider]) byProvider[call.provider] = [];
    byProvider[call.provider].push(call);
  }

  function compute(groups) {
    const result = {};
    for (const [key, group] of Object.entries(groups)) {
      const groupCalls = group.length;
      const groupFailed = group.filter((c) => !c.ok).length;
      const groupTokens = group.reduce((sum, c) => sum + (c.tokens || 0), 0);
      const errors = group.filter((c) => !c.ok && c.error).map((c) => c.error.slice(0, 40));
      const errorCounts = new Map();
      for (const err of errors) errorCounts.set(err, (errorCounts.get(err) || 0) + 1);
      const topErrors = [...errorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([err]) => err);
      result[key] = {
        calls: groupCalls,
        failed: groupFailed,
        failedPct: groupCalls ? Math.round((groupFailed / groupCalls) * 1000) / 10 : 0,
        tokens: groupTokens,
        tokenShare: totalTokens ? Math.round((groupTokens / totalTokens) * 1000) / 10 : 0,
        topErrors,
      };
    }
    return result;
  }

  return {
    byPurpose: compute(byPurpose),
    byProvider: compute(byProvider),
    totalTokens,
    totalCalls,
    totalFailed,
  };
}

function printTable(title, data, json = false) {
  if (json) return;
  console.log(`\n${title}`);
  console.log('─'.repeat(80));
  console.log('name'.padEnd(20) + 'calls'.padStart(8) + 'failed'.padStart(8) + 'fail%'.padStart(8) + 'tokens'.padStart(14) + 'share%'.padStart(8) + '  top errors');
  console.log('─'.repeat(80));
  for (const [name, agg] of Object.entries(data).sort((a, b) => b[1].calls - a[1].calls)) {
    const errors = agg.topErrors.length ? agg.topErrors.join('; ') : '-';
    console.log(
      name.slice(0, 20).padEnd(20) +
      String(agg.calls).padStart(8) +
      String(agg.failed).padStart(8) +
      String(agg.failedPct).padStart(7) + '%' +
      String(agg.tokens).padStart(14) +
      String(agg.tokenShare).padStart(7) + '%' +
      '  ' + errors
    );
  }
}

function printSummary(totalCalls, totalFailed, totalTokens, json = false) {
  if (json) return;
  const failPct = totalCalls ? Math.round((totalFailed / totalCalls) * 1000) / 10 : 0;
  console.log('\n' + '─'.repeat(80));
  console.log(`TOTAL: ${totalCalls} calls, ${totalFailed} failed (${failPct}%), ${totalTokens} tokens`);
}

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      since: { type: 'string', short: 's' },
      until: { type: 'string', short: 'u' },
      data: { type: 'string', short: 'd', default: path.join(ROOT, 'data') },
      json: { type: 'boolean', short: 'j', default: false },
    },
    allowPositionals: true,
  });

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

  const since = values.since ? parseDateArg(values.since) : todayStart;
  const until = values.until ? parseDateArg(values.until, true) : todayEnd;
  const dataDir = values.data;
  const json = values.json;

  const filePath = path.join(dataDir, 'logs', 'model-calls.jsonl');
  const calls = readCalls(filePath, since, until);

  if (calls.length === 0) {
    if (json) {
      console.log(JSON.stringify({ since: since.toISOString(), until: until.toISOString(), calls: 0, byPurpose: {}, byProvider: {} }, null, 2));
    } else {
      console.log(`No calls found for ${since.toISOString().slice(0, 10)} to ${until.toISOString().slice(0, 10)}`);
    }
    return;
  }

  const { byPurpose, byProvider, totalTokens, totalCalls, totalFailed } = aggregate(calls);

  if (json) {
    console.log(JSON.stringify({
      since: since.toISOString(),
      until: until.toISOString(),
      totalCalls,
      totalFailed,
      totalTokens,
      byPurpose,
      byProvider,
    }, null, 2));
  } else {
    console.log(`Model call waste report: ${since.toISOString().slice(0, 10)} to ${until.toISOString().slice(0, 10)}`);
    printTable('BY PURPOSE', byPurpose);
    printTable('BY PROVIDER', byProvider);
    printSummary(totalCalls, totalFailed, totalTokens);
  }
}

main();