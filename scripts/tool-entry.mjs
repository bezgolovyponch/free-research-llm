import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function startedDirectly(metaUrl, argv1 = process.argv[1], platform = process.platform) {
  if (!metaUrl || !argv1) return false;
  const windows = platform === 'win32';
  const href = pathToFileURL(argv1, { windows }).href;
  return windows ? href.toLowerCase() === String(metaUrl).toLowerCase() : href === metaUrl;
}

export function binEntry(pkg, name, root, readFile = fs.readFileSync) {
  const dir = path.join(root, 'node_modules', pkg);
  const meta = JSON.parse(readFile(path.join(dir, 'package.json'), 'utf8'));
  const bin = typeof meta.bin === 'string' ? meta.bin : meta.bin?.[name];
  if (!bin) throw new Error(`${pkg} has no "${name}" command in its package.json`);
  return path.join(dir, bin);
}
