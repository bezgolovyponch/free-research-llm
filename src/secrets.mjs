import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PROVIDER_PRESETS, SEARCH_KEYS } from './llm/presets.mjs';

export const KEYCHAIN_SERVICE = 'free-research-llm';

export const SECRET_PATTERNS = [
  ['google-api-key', /AIza[0-9A-Za-z_-]{35}/],
  ['google-auth-key', /\bAQ\.[0-9A-Za-z_-]{40,}/],
  ['groq-key', /gsk_[0-9A-Za-z]{40,}/],
  ['openrouter-key', /sk-or-v1-[0-9a-f]{40,}/],
  ['cerebras-key', /csk-[0-9a-z]{40,}/],
  ['nvidia-key', /nvapi-[0-9A-Za-z_-]{40,}/],
  ['tavily-key', /tvly-[0-9A-Za-z-]{20,}/],
  ['jina-key', /jina_[0-9a-f]{30,}/],
  ['firecrawl-key', /fc-[0-9a-f]{32}/],
  ['generic-sk-key', /\bsk-[0-9A-Za-z]{32,}\b/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

export function secretNames() {
  const names = PROVIDER_PRESETS.flatMap((p) => [p.keyEnv, p.accountEnv, p.baseEnv, p.modelEnv]).filter(Boolean);
  return [...new Set([...names, ...SEARCH_KEYS.map((k) => k.env), 'FRL_ACCESS_TOKEN', 'FRL_PROVIDER_ORDER'])];
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
    remove: (run, name) => run('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name]),
  },
  linux: {
    label: 'Secret Service (secret-tool)',
    read: (run, name) => run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', name]),
    remove: (run, name) => run('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', name]),
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
    remove: (run, name) => run('reg', ['delete', 'HKCU\\Environment', '/v', name, '/f']),
  },
  systemd: {
    label: 'systemd encrypted credentials (/etc/credstore.encrypted)',
    read: async (run, name, env) => {
      if (env.CREDENTIALS_DIRECTORY) return { stdout: await fs.readFile(path.join(env.CREDENTIALS_DIRECTORY, name), 'utf8') };
      return run('sudo', ['-n', 'systemd-creds', 'decrypt', `${CREDSTORE}/${name}`, '-']);
    },
    write: async (run, name, value) => {
      await run('sudo', ['mkdir', '-p', '-m', '0700', CREDSTORE]);
      return run('sudo', ['systemd-creds', 'encrypt', `--name=${name}`, '-', `${CREDSTORE}/${name}`], { input: value });
    },
    remove: (run, name) => run('sudo', ['rm', '-f', `${CREDSTORE}/${name}`]),
  },
};

export const CREDSTORE = '/etc/credstore.encrypted';

export function storeFor(platform, env) {
  if (platform !== 'linux' || env.FRL_SECRET_STORE === 'secret-tool') return platform;
  if (env.FRL_SECRET_STORE === 'systemd' || env.CREDENTIALS_DIRECTORY || (!env.DISPLAY && !env.WAYLAND_DISPLAY)) return 'systemd';
  return platform;
}

export class KeychainSecrets {
  constructor({ platform = process.platform, run = runCommand, env = process.env } = {}) {
    this.platform = platform;
    this.run = run;
    this.env = env;
    this.storeId = storeFor(platform, env);
    this.store = STORES[this.storeId] ?? null;
    this.loaded = new Set();
  }

  get label() {
    return this.store?.label ?? 'none';
  }

  async read(name) {
    if (!this.store) return '';
    try {
      const { stdout } = await this.store.read(this.run, name, this.env);
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

  async remove(name) {
    if (!this.store) return false;
    try {
      await this.store.remove(this.run, name);
      return true;
    } catch {
      return false;
    }
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
