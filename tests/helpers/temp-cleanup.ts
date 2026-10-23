import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TEST_TEMP_PREFIX = 'frl-';
const E2E_DATA_PREFIX = 'frl-e2e-';

export default function setup() {
  const startedAt = Date.now();
  return async function removeTempDirsLeftByThisRun() {
    const root = os.tmpdir();
    for (const entry of await fs.readdir(root).catch(() => [])) {
      if (!entry.startsWith(TEST_TEMP_PREFIX) || entry.startsWith(E2E_DATA_PREFIX)) continue;
      const target = path.join(root, entry);
      const stat = await fs.stat(target).catch(() => null);
      if (stat && stat.birthtimeMs >= startedAt) await fs.rm(target, { recursive: true, force: true });
    }
  };
}
