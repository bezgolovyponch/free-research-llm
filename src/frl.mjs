#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { newAccessToken } from './auth.mjs';
import { openKeys, sealKeys } from './keybundle.mjs';
import { KeyChecker } from './keycheck.mjs';
import { TICKET_ID, claudePrompt } from './changes.mjs';
import { spawnSync } from 'node:child_process';
import { PROVIDER_PRESETS, SEARCH_KEYS } from './llm/presets.mjs';
import { guideFor } from './llm/guides.mjs';
import { HELPER_PORT, LlamaCppInstaller, MODELS, SERVER_PORT, helperArgs, parseHelpers, recommendModel, serverArgs, speedOf } from './local/llamacpp.mjs';
import { CREDSTORE, KeychainSecrets, runCommand, secretNames } from './secrets.mjs';
import { shareLinks } from './share.mjs';
import { pcSetupCommand } from './local/pcsetup.mjs';
import { probePeer } from './local/peer.mjs';
import { rememberServe } from './local/autostart.mjs';
import { SERVICE_LABEL, SYSTEMD_UNIT, WINDOWS_TASK, accessLinks, stableNodePath, lanAddresses, launchAgentPlist, systemdUnit, windowsServiceScript, windowsTaskArgs } from './service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4600);
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
const WIN_SCRIPT = path.join(ROOT, 'data', 'frl-service.ps1');
const UNIT_PATH = `/etc/systemd/system/${SYSTEMD_UNIT}`;
const TAILSCALE = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
const secrets = new KeychainSecrets();

const KEY_LIST = [
  ...PROVIDER_PRESETS.filter((p) => p.keyEnv || p.baseEnv).flatMap((p) => [
    ...(p.baseEnv ? [{ env: p.baseEnv, label: `${p.label}: base URL${p.id === 'custom' ? ' (FreeLLMAPI: http://localhost:3001/v1)' : p.baseURL ? ` (default ${p.baseURL})` : ''}`, signup: p.signup, plain: true }] : []),
    ...(p.modelEnv ? [{ env: p.modelEnv, label: `${p.label}: model${p.id === 'custom' ? ' (FreeLLMAPI: auto)' : ''}`, signup: p.signup, plain: true }] : []),
    ...(p.accountEnv ? [{ env: p.accountEnv, label: `${p.label}: account ID`, signup: p.signup }] : []),
    ...(p.keyEnv ? [{ env: p.keyEnv, label: p.label, signup: p.signup }] : []),
  ]),
  ...SEARCH_KEYS.map((k) => ({ env: k.env, label: k.label, signup: k.signup, search: true })),
  { env: 'FRL_PROVIDER_ORDER', label: 'Provider order, first tried first (with FreeLLMAPI: custom,pollinations)', signup: 'GUIDE: FREE-ROUTING.md', plain: true },
];

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

function mask(value) {
  return value.length <= 10 ? `${value.length} chars` : `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
}

async function local(pathname, init) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, init);
  return res.json();
}

async function reloadApp() {
  try {
    await local('/api/keys/reload', { method: 'POST' });
    console.log('The running app reloaded the keys (no restart needed).');
  } catch {
    console.log('Start the app with: node src/frl.mjs start');
  }
  if (process.platform === 'win32') console.log('Windows: open a NEW terminal window before starting the app by hand, so it sees new keys.');
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

async function funnelOn() {
  for (const bin of TAILSCALE) {
    try {
      const { stdout } = await runCommand(bin, ['funnel', 'status']);
      return /https:\/\//.test(stdout) && /Funnel on/i.test(stdout);
    } catch {
      continue;
    }
  }
  return false;
}

async function printLinks() {
  const links = accessLinks({ port: PORT, token: await accessToken(), lan: lanAddresses(os.networkInterfaces()), tailscale: await tailscaleName(), funnel: await funnelOn() });
  for (const l of links) console.log(`  ${l.label.padEnd(30)} ${l.url}`);
  if (!links.some((l) => l.label.startsWith('anywhere'))) console.log('  anywhere: install Tailscale (https://tailscale.com/download) on this computer and the other device, sign in to both, then run this again');
  console.log('\n  Keep the token links private: anyone with one can use your research app, its terminal and your free quotas.');
}

async function saveChecked(checker, name, raw) {
  const result = await checker.verify(name, raw);
  console.log(`        got ${mask(result.value)}`);
  if (result.ok === false && !result.repaired) {
    console.log(`        ✗ this key does not work: ${[result.detail, result.hint].filter(Boolean).join(' · ')}`);
    if (!/^y/i.test(await ask('        save it anyway? (y/N) '))) return false;
  }
  await secrets.write(name, result.value);
  console.log(result.repaired ? `        ✓ repaired and saved: ${result.repaired}` : result.ok ? `        ✓ works (${result.detail}) — saved` : `        saved (${result.detail})`);
  return true;
}

const SERVICES = {
  darwin: {
    async install() {
      await fs.mkdir(path.dirname(PLIST), { recursive: true });
      await fs.writeFile(PLIST, launchAgentPlist({ nodePath: stableNodePath(process.execPath), root: ROOT, port: PORT, pathEnv: process.env.PATH ?? '' }));
      const domain = `gui/${process.getuid()}`;
      await runCommand('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`]).catch(() => {});
      for (let i = 0; i < 20 && (await runCommand('launchctl', ['print', `${domain}/${SERVICE_LABEL}`]).then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 500));
      for (let attempt = 0; ; attempt++) {
        try {
          await runCommand('launchctl', ['bootstrap', domain, PLIST]);
          break;
        } catch (error) {
          if (attempt >= 4) throw error;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      return `macOS login service (${PLIST})`;
    },
    async uninstall() {
      await runCommand('launchctl', ['bootout', `gui/${process.getuid()}/${SERVICE_LABEL}`]).catch(() => {});
      await fs.rm(PLIST, { force: true });
    },
    async state() {
      return runCommand('launchctl', ['print', `gui/${process.getuid()}/${SERVICE_LABEL}`]).then((r) => r.stdout.match(/state = (\w+)/)?.[1] ?? 'loaded', () => 'not installed');
    },
  },
  win32: {
    async install() {
      await fs.writeFile(WIN_SCRIPT, windowsServiceScript({ nodePath: process.execPath, root: ROOT, port: PORT }));
      await runCommand('schtasks', windowsTaskArgs(WIN_SCRIPT));
      await runCommand('schtasks', ['/Run', '/TN', WINDOWS_TASK]);
      return `Windows logon task "${WINDOWS_TASK}" (hidden window, restarts the app if it stops)`;
    },
    async uninstall() {
      await runCommand('schtasks', ['/End', '/TN', WINDOWS_TASK]).catch(() => {});
      await runCommand('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F']).catch(() => {});
      await fs.rm(WIN_SCRIPT, { force: true });
    },
    async state() {
      return runCommand('schtasks', ['/Query', '/TN', WINDOWS_TASK, '/FO', 'LIST']).then((r) => r.stdout.match(/Status:\s*(.+)/)?.[1]?.trim() ?? 'installed', () => 'not installed');
    },
  },
  linux: {
    async install() {
      const present = [];
      for (const name of secretNames()) {
        const exists = await runCommand('sudo', ['test', '-f', `${CREDSTORE}/${name}`]).then(() => true, () => false);
        if (exists) present.push(name);
      }
      const unit = systemdUnit({ nodePath: stableNodePath(process.execPath), root: ROOT, user: os.userInfo().username, port: PORT, credentials: present });
      await runCommand('sudo', ['tee', UNIT_PATH], { input: unit });
      await runCommand('sudo', ['systemctl', 'daemon-reload']);
      await runCommand('sudo', ['systemctl', 'enable', SYSTEMD_UNIT]);
      await runCommand('sudo', ['systemctl', 'restart', SYSTEMD_UNIT]);
      return `systemd service ${SYSTEMD_UNIT} with ${present.length} encrypted credentials (${present.join(', ') || 'none yet: run keys import first'})`;
    },
    async uninstall() {
      await runCommand('sudo', ['systemctl', 'disable', '--now', SYSTEMD_UNIT]).catch(() => {});
      await runCommand('sudo', ['rm', '-f', UNIT_PATH]).catch(() => {});
      await runCommand('sudo', ['systemctl', 'daemon-reload']).catch(() => {});
    },
    async state() {
      return runCommand('systemctl', ['is-active', SYSTEMD_UNIT]).then((r) => r.stdout.trim(), (e) => String(e.stdout ?? '').trim() || 'not installed');
    },
  },
};

const service = SERVICES[process.platform] ?? null;

const keyCommands = {
  async setup([scope]) {
    const checker = new KeyChecker();
    console.log(`\nFree Research LLM - key setup\nKeys are stored in the ${secrets.label}, never in a file.\nFor each line: open the link, create a key, paste it (input is hidden), press Enter.\nEnter on an empty line skips. Type - to delete a saved key.\n`);
    for (const k of KEY_LIST) {
      if (scope === 'search' && !k.search) continue;
      const saved = Boolean(await secrets.read(k.env));
      const guide = guideFor(k.env);
      console.log(`${saved ? '[saved]' : '[empty]'} ${k.label}\n${guide ? guide.steps.map((t, i) => `        ${i + 1}. ${t}`).join('\n') : `        ${k.signup}`}`);
      const value = await ask(`        ${k.plain ? 'type' : 'paste'} ${k.env}: `, { hidden: !k.plain });
      if (value === '-') console.log((await secrets.remove(k.env)) ? '        deleted' : '        nothing to delete');
      else if (value && k.plain) console.log((await secrets.write(k.env, value), `        saved ${value}`));
      else if (value) await saveChecked(checker, k.env, value);
    }
    await reloadApp();
  },
  async set([name]) {
    const k = KEY_LIST.find((x) => x.env === name);
    if (!k) return console.log(`usage: node src/frl.mjs keys set NAME   (one of: ${KEY_LIST.map((x) => x.env).join(', ')})`);
    const guide = guideFor(k.env);
    if (guide) console.log(guide.steps.map((t, i) => `  ${i + 1}. ${t}`).join('\n'));
    const value = await ask(`${k.label}\n${k.plain ? 'type' : 'paste'} ${k.env}: `, { hidden: !k.plain });
    if (!value) return console.log('nothing saved');
    if (k.plain) {
      await secrets.write(k.env, value);
      console.log(`saved ${value}`);
    } else await saveChecked(new KeyChecker(), k.env, value);
    await reloadApp();
  },
  async check() {
    const checker = new KeyChecker();
    console.log('\nChecking every saved key against its provider (keys cut off while pasting are repaired):');
    for (const k of KEY_LIST) {
      const value = await secrets.read(k.env);
      if (!value || k.plain) continue;
      console.log(k.env);
      const result = await checker.verify(k.env, value);
      if (result.repaired) await secrets.write(k.env, result.value);
      console.log(result.repaired ? `        ✓ repaired and saved: ${result.repaired}` : result.ok ? `        ✓ works (${result.detail})` : result.ok === null ? `        ? ${result.detail}` : `        ✗ does not work: ${[result.detail, result.hint].filter(Boolean).join(' · ')}`);
    }
    await reloadApp();
  },
  async list() {
    console.log(`Keys in the ${secrets.label}:`);
    for (const k of KEY_LIST) {
      const value = await secrets.read(k.env);
      console.log(`  ${value ? '●' : '○'} ${k.env.padEnd(24)} ${value ? (k.plain ? value : mask(value)) : 'not set'}`);
    }
  },
  async export() {
    const keys = {};
    for (const name of secretNames().filter((n) => n !== 'FRL_ACCESS_TOKEN')) {
      const value = await secrets.read(name);
      if (value) keys[name] = value;
    }
    if (!Object.keys(keys).length) return console.log(`No keys found in the ${secrets.label}.`);
    const pass = await ask('Choose a passphrase (10+ characters, you will type it on the other computer): ', { hidden: true });
    if (pass !== (await ask('Repeat the passphrase: ', { hidden: true }))) return console.log('The passphrases differ. Nothing exported.');
    console.log(`\nEncrypted bundle with ${Object.keys(keys).length} keys (${Object.keys(keys).join(', ')}).\nCopy the whole line below and paste it into "node src/frl.mjs keys import" on the other computer. Send the passphrase separately.\n`);
    console.log(sealKeys(keys, pass));
  },
  async import() {
    const bundle = await ask('Paste the bundle (starts with frl1.): ');
    const keys = openKeys(bundle, await ask('Passphrase: ', { hidden: true }));
    for (const [name, value] of Object.entries(keys)) await secrets.write(name, value);
    console.log(`Saved ${Object.keys(keys).length} keys in the ${secrets.label}: ${Object.keys(keys).join(', ')}`);
    await reloadApp();
  },
};

function run(command, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32', ...opts });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

const commands = {
  async start(args) {
    const remote = args.includes('--remote');
    const env = { ...process.env, HOST: remote ? '0.0.0.0' : '127.0.0.1', PORT: String(PORT) };
    if (remote) await accessToken();
    try {
      await local('/api/status');
      return console.log(`The app is already running → http://127.0.0.1:${PORT}`);
    } catch {
      spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], { stdio: 'inherit', env, cwd: ROOT });
    }
  },

  async install() {
    if (!service) return console.log(`No always-on service for ${process.platform}: run "node src/frl.mjs start --remote" from your startup apps.`);
    await accessToken();
    await fs.mkdir(path.join(ROOT, 'data', 'logs'), { recursive: true });
    console.log(`Installed: ${await service.install()}.\nThe app starts at login (or boot) and restarts if it stops. Open it from:`);
    await printLinks();
  },

  async uninstall() {
    if (!service) return console.log('nothing to remove');
    await service.uninstall();
    console.log('Removed the always-on service. Start the app by hand with "node src/frl.mjs start".');
  },

  async status() {
    const state = service ? await service.state() : 'none';
    let app;
    try {
      const s = await local('/api/status');
      app = `running · models: ${s.providers.filter((p) => p.state === 'ready').map((p) => p.id).join(', ') || 'none'} · search: ${s.search.backends.join(', ')}`;
    } catch {
      app = `not answering on port ${PORT}`;
    }
    console.log(`service: ${state}\napp:     ${app}\nkeys:    ${secrets.label}`);
  },

  async url() {
    await printLinks();
  },

  async share([projectId, flag]) {
    let projects;
    try {
      projects = await local('/api/projects');
    } catch {
      return console.log(`The app is not answering on port ${PORT}: run "node src/frl.mjs start --remote" first.`);
    }
    if (!projectId) {
      console.log('usage: node src/frl.mjs share <research id> [--off]\n\nResearches:');
      for (const p of projects) console.log(`  ${p.id}  ${String(p.question).slice(0, 70)}`);
      return;
    }
    const method = flag === '--off' ? 'DELETE' : 'POST';
    const view = await local(`/api/projects/${encodeURIComponent(projectId)}/share`, { method });
    if (view.error) return console.log(view.error);
    if (!view.enabled) return console.log('Link turned off: whoever had it has lost access.');
    if (!view.remote) console.log('Remote access is off, so other computers cannot reach the app: run "node src/frl.mjs install" (or "start --remote"), then share again.');
    const bases = accessLinks({ port: PORT, lan: lanAddresses(os.networkInterfaces()), tailscale: await tailscaleName(), funnel: await funnelOn() }).filter((l) => !l.url.includes('127.0.0.1'));
    console.log('Link for this one research (chat, run, add pieces; no other researches, keys or terminal):');
    for (const l of shareLinks(bases, { projectId, token: view.token })) console.log(`  ${l.label.padEnd(30)} ${l.url}`);
    if (bases[0]) console.log(`\n  Let that PC's graphics card research too: on the PC open PowerShell and run\n    ${pcSetupCommand(bases[0].url, view.token)}\n  The app connects its model within a minute of the PC opening the link.`);
    if (!bases.some((l) => l.label.startsWith('anywhere'))) console.log('  anywhere: install Tailscale (https://tailscale.com/download) on both computers, sign in to both, then run this again');
    console.log('\n  Keep the link private. Turn it off with: node src/frl.mjs share ' + projectId + ' --off');
  },

  async token(args) {
    await accessToken({ rotate: args.includes('--rotate') });
    console.log(args.includes('--rotate') ? 'New token saved. Restart the app (node src/frl.mjs restart) and open the new links:' : 'Current links:');
    await printLinks();
  },

  async keys([action, ...rest]) {
    if (!keyCommands[action]) return console.log('usage: node src/frl.mjs keys setup [search] | set NAME | check | list | export | import');
    await keyCommands[action](rest);
  },

  async update() {
    if ((await run('git', ['pull', '--ff-only'])) !== 0) return console.log('git pull failed: commit or stash your local changes first, then run this again.');
    const devTools = await fs.access(path.join(ROOT, 'node_modules', '@playwright', 'test')).then(() => true, () => false);
    if ((await run('npm', devTools ? ['install'] : ['install', '--omit=dev'])) !== 0) return console.log('npm install failed: see the output above.');
    console.log('Updated. Restart the app to use the new version: node src/frl.mjs restart');
  },

  async restart() {
    try {
      const r = await local('/api/app/restart', { method: 'POST' });
      console.log(r.message ?? r.error);
    } catch {
      console.log(`The app is not answering on port ${PORT}. Start it: node src/frl.mjs start`);
    }
  },

  async change([id, mode]) {
    if (!TICKET_ID.test(String(id ?? ''))) return console.log('usage: node src/frl.mjs change C1 [--claude]   (tickets are created in the App chat)');
    const ticketFile = path.join(ROOT, 'data', 'changes', `${id}.md`);
    if (!(await fs.access(ticketFile).then(() => true, () => false))) return console.log(`No ticket ${id}: create it in the App chat first.`);
    if (mode !== '--claude') {
      const started = await local(`/api/changes/${id}/run`, { method: 'POST' }).catch((e) => ({ error: e.message }));
      console.log(started.message ?? started.error ?? `The app is not answering on port ${PORT}. Start it: node src/frl.mjs start`);
      if (!started.started && !/already/.test(String(started.message))) return;
      let state = '';
      for (;;) {
        await new Promise((r) => setTimeout(r, 5000));
        const ticket = (await local('/api/changes').catch(() => [])).find?.((t) => t.id === id);
        if (ticket && ticket.state !== state) console.log(`${id}: ${(state = ticket.state)}`);
        if (ticket && ['done', 'failed'].includes(ticket.state)) return console.log(ticket.result?.summary ?? '');
      }
    }
    const report = (body) => local(`/api/changes/${id}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    await report({ state: 'running' });
    console.log(`Change ${id}: ${ticketFile}\nClaude Code opens now. When it is done, exit it (/exit) and the quality gate runs.\n`);
    const code = await run('claude', [process.platform === 'win32' ? `"${claudePrompt(id)}"` : claudePrompt(id)]);
    if (code !== 0) console.log(`Claude Code exited with code ${code}${code === 1 ? ' (is it installed? https://docs.claude.com/en/docs/claude-code)' : ''}.`);
    console.log('\nRunning the quality gate…');
    const gate = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '--silent', 'quality'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
    const output = `${gate.stdout ?? ''}${gate.stderr ?? ''}`;
    process.stdout.write(output);
    const passed = gate.status === 0 && /quality gate: PASSED/.test(output);
    await report({ state: passed ? 'done' : 'failed', passed, summary: output.split('\n').filter((l) => /^(PASS|FAIL) /.test(l)).join('\n') });
    console.log(passed ? `\nChange ${id} done: the gate passed. The result is in the App chat.` : `\nChange ${id} is not done: the gate failed. Run "node src/frl.mjs change ${id}" again to continue.`);
  },

  async searxng() {
    const port = 8888;
    if ((await run('docker', ['info'], { shell: false, stdio: 'ignore' })) !== 0) return console.log('Docker is not answering. Open Docker Desktop, wait for "Engine running", then run this again.');
    const dir = path.join(os.homedir(), '.config', 'free-research-llm', 'searxng');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'settings.yml'), 'use_default_settings: true\nserver:\n  limiter: false\n  public_instance: false\nsearch:\n  formats:\n    - html\n    - json\n');
    await run('docker', ['rm', '-f', 'frl-searxng'], { shell: false, stdio: 'ignore' });
    const started = await run('docker', ['run', '--name', 'frl-searxng', '-d', '--restart', 'unless-stopped', '-p', `127.0.0.1:${port}:8080`, '-v', `${dir}:/etc/searxng/`, '-e', `SEARXNG_SECRET=${randomBytes(32).toString('hex')}`, 'docker.io/searxng/searxng:latest'], { shell: false });
    if (started !== 0) return console.log('docker run failed: see the output above.');
    console.log('Waiting for SearXNG to start…');
    for (let i = 0; i < 30; i++) {
      const answered = await fetch(`http://127.0.0.1:${port}/search?q=test&format=json`).then((r) => r.ok, () => false);
      if (answered) {
        await secrets.write('SEARXNG_URL', `http://127.0.0.1:${port}`);
        console.log(`SearXNG is running at http://127.0.0.1:${port} (unlimited, no key) and SEARXNG_URL is saved in the ${secrets.label}.`);
        return reloadApp();
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log('SearXNG did not answer yet. Check: docker logs frl-searxng');
  },

  async local([action, ...rest]) {
    const flag = (name, fallback = '') => {
      const i = rest.indexOf(`--${name}`);
      return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : fallback;
    };
    const installer = new LlamaCppInstaller({ dir: path.join(ROOT, 'data', 'llama'), run: (c, a) => run(c, a, { shell: false }), log: (m) => console.log(m) });
    const current = await installer.current();
    const need = () => console.log('llama.cpp is not installed yet: node src/frl.mjs local install');
    if (action === 'install') {
      const done = await installer.install({ gpu: rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined, tag: flag('tag', 'latest') });
      return console.log(`\nllama.cpp ${done.tag} (${done.gpu}) installed.\n  server: ${done.server}\n  helper: ${done.helper}\nNext: node src/frl.mjs local models   then   node src/frl.mjs local start --model <one of them>`);
    }
    if (action === 'models') {
      console.log('Pick by the free memory of your GPU (VRAM). The file downloads once on the first start.\n');
      for (const m of MODELS) console.log(`  ${String(m.vram).padStart(2)} GB+  ${m.hf.padEnd(38)} ${String(m.size).padStart(5)} GB file · ${m.use}`);
      const vram = flag('vram');
      if (vram) console.log(`\nFor ${vram} GB: node src/frl.mjs local start --model ${recommendModel(vram).hf}`);
      return;
    }
    if (action === 'helper') {
      if (!current) return need();
      const args = helperArgs({ host: flag('host'), port: Number(flag('port', HELPER_PORT)) });
      console.log(`Helper device: lending this machine's GPU to the main PC at ${flag('host')}:${flag('port', HELPER_PORT)}.\nIt has no password: keep it on your home network or Tailscale only. Press Ctrl+C to stop.\n`);
      return run(current.helper, args, { shell: false });
    }
    if (action === 'start') {
      if (!current) return need();
      const helpers = parseHelpers(flag('helpers'));
      const port = Number(flag('port', SERVER_PORT));
      const args = serverArgs({ model: flag('model'), helpers, port, ctx: Number(flag('ctx', 16384)), split: flag('split'), parallel: Number(flag('parallel', 1)), kv: flag('kv', '') });
      await secrets.write('LLAMACPP_BASE_URL', `http://127.0.0.1:${port}/v1`).catch(() => {});
      await rememberServe(ROOT, { server: current.server, args, port });
      if (args.includes('--background') || process.argv.includes('--background')) {
        await fs.mkdir(path.join(ROOT, 'data', 'logs'), { recursive: true });
        const out = await fs.open(path.join(ROOT, 'data', 'logs', 'llama.out'), 'a');
        const child = spawn(current.server, args, { detached: true, stdio: ['ignore', out.fd, out.fd] });
        child.unref();
        await out.close();
        console.log(`Local model starting in the background (pid ${child.pid}) on http://127.0.0.1:${port}/v1. Log: data/logs/llama.out. Stop it with: kill ${child.pid}`);
        return void reloadApp();
      }
      console.log(`Local model on http://127.0.0.1:${port}/v1${helpers.length ? ` with helpers ${helpers.join(', ')}` : ''}. The research app uses it as the "llamacpp" provider (Models & router). Press Ctrl+C to stop.\n`);
      void reloadApp();
      return run(current.server, args, { shell: false });
    }
    if (action === 'pc') {
      const found = await probePeer(rest[0]);
      for (const f of found) console.log(`  ${f.label.padEnd(10)} ${f.url}  ${f.ok ? 'OK' : 'missing'} · ${f.detail}`);
      const ready = found.filter((f) => f.ok);
      for (const f of ready) await secrets.write(f.env, f.url);
      if (!ready.length) return console.log('\nNothing to connect yet. On the other PC start Ollama (with OLLAMA_HOST=0.0.0.0:11434) or llama-server (with --host 0.0.0.0 --port 8090), allow it in Windows Firewall on private networks, then run this again.');
      console.log(`\nSaved ${ready.map((f) => f.env).join(' and ')}. The research app now uses the other PC's model(s) with no quota.`);
      return void reloadApp();
    }
    if (action === 'status' || action === 'bench') {
      const port = Number(flag('port', SERVER_PORT));
      console.log(current ? `llama.cpp ${current.tag} (${current.gpu}) at ${path.dirname(current.server)}` : 'llama.cpp: not installed');
      try {
        const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
        console.log(`server on port ${port}: ${health.status}`);
      } catch {
        return console.log(`server on port ${port}: not running (node src/frl.mjs local start --model ...)`);
      }
      if (action === 'status') return;
      const prompt = 'Summarise in two sentences why used-car prices differ between Germany and Czechia. '.repeat(40);
      const reply = await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'bench', messages: [{ role: 'user', content: prompt }], max_tokens: 64 }) })).json();
      const speed = speedOf(reply);
      return console.log(speed ? `prefill (reading): ${speed.prefillPerSecond} tokens/s over ${speed.promptTokens} tokens · decode (writing): ${speed.decodePerSecond} tokens/s` : 'no timings in the reply');
    }
    console.log('usage: node src/frl.mjs local install [vulkan|cuda|cpu|metal] | models [--vram GB] | start --model REPO[:QUANT] [--helpers host:port,...] [--ctx N per request] [--parallel N] [--kv q8_0] [--split a,b] [--background] | helper --host LAN-IP [--port 50052] | pc <other PC address> | status | bench');
  },

  async logs() {
    const text = await fs.readFile(path.join(ROOT, 'data', 'logs', 'server.out'), 'utf8').catch(() => 'no log yet');
    console.log(text.split('\n').slice(-40).join('\n'));
  },
};

const [command = 'help', ...args] = process.argv.slice(2);
if (!commands[command]) {
  console.log(`frl — Free Research LLM (macOS, Windows, Linux). Run from the app folder, or in the app's Terminal.

  node src/frl.mjs start [--remote]   run the app (--remote: other devices may connect with the token link)
  node src/frl.mjs install            always on: starts at login/boot, restarts if it stops
  node src/frl.mjs uninstall          remove the always-on service
  node src/frl.mjs status             is it running, which models and search engines
  node src/frl.mjs url                links for this computer, your Wi-Fi and Tailscale
  node src/frl.mjs restart            save running work and restart (always-on service)
  node src/frl.mjs update             pull the newest version from GitHub and install it
  node src/frl.mjs token [--rotate]   show or replace the access token
  node src/frl.mjs share [ID] [--off]  link that opens one research on another PC (no Docker), or turn it off
  node src/frl.mjs keys setup         paste free keys; each is tested and saved in the system key store
  node src/frl.mjs keys set NAME      save one key or setting (e.g. CUSTOM_LLM_BASE_URL, FRL_PROVIDER_ORDER)
  node src/frl.mjs keys check         test every saved key; repair keys cut off while pasting
  node src/frl.mjs keys list          which keys are saved (masked)
  node src/frl.mjs keys export        encrypted bundle of your keys for another computer
  node src/frl.mjs keys import        paste a bundle on the other computer
  node src/frl.mjs change C1 [--claude]  run an App chat change ticket with the free-model coder (or Claude Code), gated by quality
  node src/frl.mjs searxng           start the free, unlimited SearXNG search engine in Docker and save its address
  node src/frl.mjs local ...         run a model on this PC's GPU (llama.cpp), optionally with helper devices: install | models | start | helper | status | bench
  node src/frl.mjs local pc ADDRESS  find Ollama / llama.cpp on another PC in your network and use them
  node src/frl.mjs logs               last lines of the app log`);
} else {
  try {
    await commands[command](args);
  } catch (error) {
    console.error(`frl ${command}: ${error.message}`);
    process.exitCode = 1;
  }
}
