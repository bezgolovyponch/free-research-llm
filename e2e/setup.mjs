import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const E2E_DATA_PREFIX = 'frl-e2e-';

export default async function removeDataDirsOfEarlierRuns() {
  const current = path.basename(process.env.FRL_E2E_DATA_DIR ?? '');
  for (const entry of await fs.readdir(os.tmpdir()).catch(() => [])) {
    if (entry.startsWith(E2E_DATA_PREFIX) && entry !== current) await fs.rm(path.join(os.tmpdir(), entry), { recursive: true, force: true });
  }
}
