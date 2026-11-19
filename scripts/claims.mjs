import { startedDirectly } from './tool-entry.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED_COMMAND_PREFIXES = [
  'node scripts/',
  'npx vitest run ',
  'git ',
  'grep ',
];

export function isAllowedCommand(cmd) {
  const trimmed = cmd.trim();
  return ALLOWED_COMMAND_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function parseClaims(content) {
  const claims = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('claim:')) continue;
    const parts = trimmed.slice(6).split('|').map((p) => p.trim());
    if (parts.length !== 3) continue;
    const claimText = parts[0].replace(/^claim:\s*/, '');
    const cmdMatch = parts[1].match(/^cmd:\s*(.+)$/);
    const expectMatch = parts[2].match(/^expect:\s*(.+)$/);
    if (!cmdMatch || !expectMatch) continue;
    claims.push({
      claim: claimText,
      cmd: cmdMatch[1],
      expect: expectMatch[1],
    });
  }
  return claims;
}

function runCommand(cmd) {
  if (!isAllowedCommand(cmd)) {
    return { status: 1, stdout: '', stderr: 'Command not allowed: ' + cmd, allowed: false };
  }
  const parts = cmd.trim().split(/\s+/);
  const result = spawnSync(parts[0], parts.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    shell: true,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    allowed: true,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node scripts/claims.mjs <markdown-file>');
    process.exitCode = 1;
    return;
  }
  const filePath = path.resolve(args[0]);
  const content = await fs.readFile(filePath, 'utf8');
  const claims = parseClaims(content);
  if (claims.length === 0) {
    console.log('No claims found in ' + filePath);
    return;
  }
  let allPassed = true;
  for (const claim of claims) {
    const result = runCommand(claim.cmd);
    const output = result.stdout + result.stderr;
    const passed = result.allowed && result.status === 0 && output.includes(claim.expect);
    console.log((passed ? 'VERIFIED' : 'FAILED') + ' | ' + claim.claim);
    console.log('  cmd: ' + claim.cmd);
    console.log('  expect: ' + claim.expect);
    if (!result.allowed) {
      console.log('  ERROR: Command not in allowed list');
    } else if (result.status !== 0) {
      console.log('  ERROR: Command exited with code ' + result.status);
      console.log('  stdout: ' + result.stdout.slice(0, 200));
      console.log('  stderr: ' + result.stderr.slice(0, 200));
    } else if (!output.includes(claim.expect)) {
      console.log('  ERROR: Expected substring not found in output');
      console.log('  output (first 200 chars): ' + output.slice(0, 200));
    }
    if (!passed) allPassed = false;
  }
  console.log('\n' + (allPassed ? 'All claims verified' : 'Some claims failed'));
  if (!allPassed) process.exitCode = 1;
}

if (startedDirectly(import.meta.url)) main();
