import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PROVIDER_PRESETS, SEARCH_KEYS } from './llm/presets.mjs';

export const KEYCHAIN_SERVICE = 'free-research-llm';

export function secretNames() {
  const names = PROVIDER_PRESETS.flatMap((p) => [p.keyEnv, p.accountEnv]).filter(Boolean);
  return [...new Set([...names, ...SEARCH_KEYS.map((k) => k.env)])];
}

export class KeychainSecrets {
  constructor({ platform = process.platform, run = promisify(execFile) } = {}) {
    this.platform = platform;
    this.run = run;
  }

  async read(name) {
    try {
      const { stdout } = await this.run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w']);
      return String(stdout).trim();
    } catch {
      return '';
    }
  }

  async fillMissing(env, names = secretNames()) {
    if (this.platform !== 'darwin') return [];
    const loaded = [];
    for (const name of names) {
      if (env[name]) continue;
      const value = await this.read(name);
      if (value) {
        env[name] = value;
        loaded.push(name);
      }
    }
    return loaded;
  }
}
