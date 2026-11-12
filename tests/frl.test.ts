import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { serverSpawnArgs } from '../src/frl.mjs';
import { NODE_HEAP_FLAG } from '../src/service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('frl start', () => {
  it('spawns the server with the 4 GB heap flag before server.mjs', () => {
    const args = serverSpawnArgs();
    const flagAt = args.indexOf(NODE_HEAP_FLAG);
    const serverAt = args.findIndex((a) => a.endsWith(path.join('src', 'server.mjs')));
    expect(flagAt).toBe(0);
    expect(serverAt).toBeGreaterThan(flagAt);
  });

  it('starts the server with the 4 GB heap flag in start.command', () => {
    const command = fs.readFileSync(path.join(ROOT, 'start.command'), 'utf8');
    const flagAt = command.indexOf(NODE_HEAP_FLAG);
    expect(flagAt).toBeGreaterThan(-1);
    expect(flagAt).toBeLessThan(command.indexOf('src/server.mjs'));
    expect(command).toMatch(/exec node --max-old-space-size=4096 src\/server\.mjs/);
  });
});
