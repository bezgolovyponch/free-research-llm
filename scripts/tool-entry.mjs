import fs from 'node:fs';
import path from 'node:path';

export function binEntry(pkg, name, root, readFile = fs.readFileSync) {
  const dir = path.join(root, 'node_modules', pkg);
  const meta = JSON.parse(readFile(path.join(dir, 'package.json'), 'utf8'));
  const bin = typeof meta.bin === 'string' ? meta.bin : meta.bin?.[name];
  if (!bin) throw new Error(`${pkg} has no "${name}" command in its package.json`);
  return path.join(dir, bin);
}
