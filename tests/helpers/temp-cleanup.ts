import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TEMP_VARS = ['TEMP', 'TMP', 'TMPDIR'] as const;

export default function setup() {
  const original = Object.fromEntries(TEMP_VARS.map((name) => [name, process.env[name]]));
  const runRoot = path.join(os.tmpdir(), `vitest-run-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  mkdirSync(runRoot, { recursive: true });
  for (const name of TEMP_VARS) process.env[name] = runRoot;
  return async function removeThisRunsTempRoot() {
    for (const name of TEMP_VARS) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    await fs.rm(runRoot, { recursive: true, force: true });
  };
}
