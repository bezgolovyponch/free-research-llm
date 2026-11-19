import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { binEntry, startedDirectly } from '../../scripts/tool-entry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readFrom(files: Record<string, unknown>) {
  return (file: string) => {
    if (!(file in files)) throw new Error(`missing ${file}`);
    return JSON.stringify(files[file]);
  };
}

describe('tool entry for the quality gate', () => {
  it('resolves a named command and a single-command package to the script node runs directly', () => {
    const read = readFrom({
      [path.join('/r', 'node_modules', '@playwright/test', 'package.json')]: { bin: { playwright: 'cli.js' } },
      [path.join('/r', 'node_modules', 'solo', 'package.json')]: { bin: './solo.mjs' },
    });
    expect(binEntry('@playwright/test', 'playwright', '/r', read)).toBe(path.join('/r', 'node_modules', '@playwright/test', 'cli.js'));
    expect(binEntry('solo', 'anything', '/r', read)).toBe(path.join('/r', 'node_modules', 'solo', 'solo.mjs'));
  });

  it('names the package when the command does not exist', () => {
    const read = readFrom({ [path.join('/r', 'node_modules', 'lib', 'package.json')]: { main: 'index.js' } });
    expect(() => binEntry('lib', 'lib', '/r', read)).toThrow(/lib has no "lib" command/);
  });

  it('knows a script was started directly from a Windows path, whatever the drive letter case, as well as from a POSIX path', () => {
    expect(startedDirectly('file:///C:/Users/me/app/scripts/quality.mjs', 'C:\\Users\\me\\app\\scripts\\quality.mjs', 'win32')).toBe(true);
    expect(startedDirectly('file:///C:/Users/me/app/scripts/quality.mjs', 'c:\\Users\\me\\app\\scripts\\quality.mjs', 'win32')).toBe(true);
    expect(startedDirectly('file:///home/me/app/scripts/quality.mjs', '/home/me/app/scripts/quality.mjs', 'linux')).toBe(true);
  });

  it('is false for another script, a missing path or a path that only matches as a raw string', () => {
    expect(startedDirectly('file:///C:/Users/me/app/scripts/quality.mjs', 'C:\\Users\\me\\app\\scripts\\waste.mjs', 'win32')).toBe(false);
    expect(startedDirectly('file:///home/me/app/scripts/quality.mjs', undefined, 'linux')).toBe(false);
    expect(startedDirectly('file:///home/me/app/scripts/Quality.mjs', '/home/me/app/scripts/quality.mjs', 'linux')).toBe(false);
  });

  it('starts the installed vitest without a shell, so the gate runs on Windows too', () => {
    const result = spawnSync(process.execPath, [binEntry('vitest', 'vitest', ROOT), '--version'], { cwd: ROOT, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });
});
