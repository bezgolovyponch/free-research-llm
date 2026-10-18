import { execFile } from 'node:child_process';
import { PROVIDER_PRESETS, SEARCH_KEYS } from './llm/presets.mjs';

export const KEYCHAIN_SERVICE = 'free-research-llm';

export function secretNames() {
  const names = PROVIDER_PRESETS.flatMap((p) => [p.keyEnv, p.accountEnv]).filter(Boolean);
  return [...new Set([...names, ...SEARCH_KEYS.map((k) => k.env), 'FRL_ACCESS_TOKEN'])];
}

export function runCommand(command, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })));
    if (input !== undefined) child.stdin.end(input);
  });
}

const STORES = {
  darwin: {
    label: 'macOS Keychain',
    read: (run, name) => run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w']),
    write: (run, name, value) => run('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', name, '-w', value]),
  },
  linux: {
    label: 'Secret Service (secret-tool)',
    read: (run, name) => run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', name]),
    write: (run, name, value) => run('secret-tool', ['store', '--label', `${KEYCHAIN_SERVICE} ${name}`, 'service', KEYCHAIN_SERVICE, 'account', name], { input: value }),
  },
  win32: {
    label: 'Windows user environment',
    read: async (run, name) => {
      const { stdout } = await run('reg', ['query', 'HKCU\\Environment', '/v', name]);
      const match = String(stdout).match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`));
      if (!match) throw new Error('not set');
      return { stdout: match[1] };
    },
    write: (run, name, value) => run('setx', [name, value]),
  },
};

export class KeychainSecrets {
  constructor({ platform = process.platform, run = runCommand } = {}) {
    this.platform = platform;
    this.run = run;
    this.store = STORES[platform] ?? null;
    this.loaded = new Set();
  }

  get label() {
    return this.store?.label ?? 'none';
  }

  async read(name) {
    if (!this.store) return '';
    try {
      const { stdout } = await this.store.read(this.run, name);
      return String(stdout).trim();
    } catch {
      return '';
    }
  }

  async write(name, value) {
    if (!this.store) return false;
    await this.store.write(this.run, name, value);
    return true;
  }

  async fillMissing(env, names = secretNames()) {
    if (!this.store) return [];
    const loaded = [];
    for (const name of names) {
      if (env[name]) continue;
      const value = await this.read(name);
      if (value) {
        env[name] = value;
        loaded.push(name);
        this.loaded.add(name);
      }
    }
    return loaded;
  }

  async refresh(env, names = secretNames()) {
    if (!this.store) return [];
    const changed = [];
    for (const name of names) {
      if (env[name] && !this.loaded.has(name)) continue;
      const value = await this.read(name);
      if (value && value !== env[name]) {
        env[name] = value;
        this.loaded.add(name);
        changed.push(name);
      } else if (!value && this.loaded.has(name)) {
        delete env[name];
        this.loaded.delete(name);
        changed.push(name);
      }
    }
    return changed;
  }
}
