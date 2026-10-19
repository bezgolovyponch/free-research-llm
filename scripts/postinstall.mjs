#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREBUILDS = path.join(ROOT, 'node_modules', 'node-pty', 'prebuilds');

if (process.platform !== 'win32' && fs.existsSync(PREBUILDS)) {
  for (const dir of fs.readdirSync(PREBUILDS)) {
    const helper = path.join(PREBUILDS, dir, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}
if (fs.existsSync(path.join(ROOT, '.git'))) spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: ROOT, stdio: 'ignore' });
