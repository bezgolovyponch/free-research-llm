#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { newAccessToken } from './auth.mjs';
import { openKeys, sealKeys } from './keybundle.mjs';
import { KeychainSecrets, runCommand, secretNames } from './secrets.mjs';
import { SERVICE_LABEL, accessLinks, lanAddresses, launchAgentPlist } from './service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4600);
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
const TAILSCALE = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
const secrets = new KeychainSecrets();

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (text) => { if (text.includes(question)) process.stdout.write(text); };
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function accessToken({ rotate = false } = {}) {
  let token = rotate ? '' : await secrets.read('FRL_ACCESS_TOKEN');
  if (!token) {
    token = newAccessToken();
    await secrets.write('FRL_ACCESS_TOKEN', token);
  }
  return token;
}

async function tailscaleName() {
  for (const bin of TAILSCALE) {
    try {
      const { stdout } = await runCommand(bin, ['status', '--json']);
      return JSON.parse(stdout).Self?.DNSName ?? '';
    } catch {
      continue;
    }
  }
  return '';
}

async function printLinks() {
  const links = accessLinks({ port: PORT, token: await accessToken(), lan: lanAddresses(os.networkInterfaces()), tailscale: await tailscaleName() });
  for (const l of links) console.log(`  ${l.label.padEnd(30)} ${l.url}`);
  if (!links.some((l) => l.label.startsWith('anywhere'))) console.log('  anywhere: install Tailscale (https://tailscale.com/download) on this Mac and the other device, sign in to both, then run "frl url" again');
  console.log('\n  Keep the token links private: anyone with one can use your research app and your free quotas.');
}

const launchctl = (...args) => runCommand('launchctl', args);
const domain = () => `gui/${process.getuid()}`;

const commands = {
  async start(args) {
    const remote = args.includes('--remote');
    const env = { ...process.env, HOST: remote ? '0.0.0.0' : '127.0.0.1', PORT: String(PORT) };
    if (remote) await accessToken();
    spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], { stdio: 'inherit', env, cwd: ROOT });
  },

  async install() {
    if (process.platform !== 'darwin') return console.log('frl install sets up a macOS login service. On Windows/Linux run "frl start --remote" (or add it to your startup apps).');
    await accessToken();
    await fs.mkdir(path.dirname(PLIST), { recursive: true });
    await fs.mkdir(path.join(ROOT, 'data', 'logs'), { recursive: true });
    await fs.writeFile(PLIST, launchAgentPlist({ nodePath: process.execPath, root: ROOT, port: PORT, pathEnv: process.env.PATH ?? '' }));
    await launchctl('bootout', `${domain()}/${SERVICE_LABEL}`).catch(() => {});
    await launchctl('bootstrap', domain(), PLIST);
    console.log(`Installed: the app now starts at login and restarts if it stops (${PLIST}).\nOpen it from:`);
    await printLinks();
  },

  async uninstall() {
    await launchctl('bootout', `${domain()}/${SERVICE_LABEL}`).catch(() => {});
    await fs.rm(PLIST, { force: true });
    console.log('Removed the login service. Start the app by hand with "frl start".');
  },

  async status() {
    const service = await launchctl('print', `${domain()}/${SERVICE_LABEL}`).then((r) => r.stdout.match(/state = (\w+)/)?.[1] ?? 'loaded', () => 'not installed');
    let app = 'not answering';
    try {
      const s = await (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json();
      app = `running · models: ${s.providers.filter((p) => p.state === 'ready').map((p) => p.id).join(', ') || 'none'} · search: ${s.search.backends.join(', ')}`;
    } catch {
      app = 'not answering on port ' + PORT;
    }
    console.log(`service: ${service}\napp:     ${app}`);
  },

  async url() {
    await printLinks();
  },

  async token(args) {
    await accessToken({ rotate: args.includes('--rotate') });
    console.log(args.includes('--rotate') ? 'New token saved. Restart the app (frl install, or frl start --remote) and open the new links:' : 'Current links:');
    await printLinks();
  },

  async keys([action]) {
    if (action === 'export') {
      const keys = {};
      for (const name of secretNames().filter((n) => n !== 'FRL_ACCESS_TOKEN')) {
        const value = await secrets.read(name);
        if (value) keys[name] = value;
      }
      if (!Object.keys(keys).length) return console.log(`No keys found in the ${secrets.label}.`);
      const pass = await ask('Choose a passphrase (10+ characters, you will type it on the other computer): ', { hidden: true });
      if (pass !== (await ask('Repeat the passphrase: ', { hidden: true }))) return console.log('The passphrases differ. Nothing exported.');
      console.log(`\nEncrypted bundle with ${Object.keys(keys).length} keys (${Object.keys(keys).join(', ')}).\nCopy the whole line below and paste it into "frl keys import" on the other computer. Send the passphrase separately.\n`);
      console.log(sealKeys(keys, pass));
      return;
    }
    if (action === 'import') {
      const bundle = await ask('Paste the bundle (starts with frl1.): ');
      const keys = openKeys(bundle, await ask('Passphrase: ', { hidden: true }));
      for (const [name, value] of Object.entries(keys)) await secrets.write(name, value);
      console.log(`Saved ${Object.keys(keys).length} keys in the ${secrets.label}: ${Object.keys(keys).join(', ')}`);
      if (process.platform === 'win32') console.log('Windows: open a NEW terminal before "frl start" so it sees the keys.');
      return;
    }
    console.log('usage: frl keys export | frl keys import');
  },

  async logs() {
    const text = await fs.readFile(path.join(ROOT, 'data', 'logs', 'server.out'), 'utf8').catch(() => 'no log yet');
    console.log(text.split('\n').slice(-40).join('\n'));
  },
};

const [command = 'help', ...args] = process.argv.slice(2);
if (!commands[command]) {
  console.log(`frl — Free Research LLM

  frl start [--remote]   run the app here (--remote: other devices may connect with the token link)
  frl install            macOS: always-on login service with remote access (restarts if it stops)
  frl uninstall          remove the login service
  frl status             is it running, which models and search engines
  frl url                links for this Mac, your Wi-Fi and Tailscale
  frl token [--rotate]   show or replace the access token
  frl keys export        encrypted, passphrase-protected bundle of your keys (copy to another computer)
  frl keys import        paste a bundle on the other computer; keys go to its secure store
  frl logs               last lines of the app log`);
} else {
  try {
    await commands[command](args);
  } catch (error) {
    console.error(`frl ${command}: ${error.message}`);
    process.exitCode = 1;
  }
}
