import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases';
export const SERVER_PORT = 8090;
export const HELPER_PORT = 50052;
export const GPU_KINDS = {
  win32: ['vulkan', 'cuda', 'cpu'],
  darwin: ['metal'],
  linux: ['vulkan', 'cuda', 'cpu'],
};

export const MODELS = [
  { vram: 2, hf: 'ggml-org/Qwen3-1.7B-GGUF:Q4_K_M', size: 1.2, use: 'smoke test only; too small for research' },
  { vram: 4, hf: 'ggml-org/Qwen3-4B-GGUF:Q4_K_M', size: 2.3, use: 'reviews and roll-ups' },
  { vram: 11, hf: 'ggml-org/Qwen3-14B-GGUF:Q4_K_M', size: 8.4, use: 'researching pieces, reviews' },
  { vram: 14, hf: 'ggml-org/gpt-oss-20b-GGUF', size: 11.3, use: 'the same model family Groq and Cerebras serve; good all-round' },
  { vram: 19, hf: 'ggml-org/gemma-3-27b-it-GGUF:Q4_K_M', size: 15.4, use: 'deep work: trees, memos' },
  { vram: 22, hf: 'ggml-org/Qwen3-32B-GGUF:Q4_K_M', size: 18.4, use: 'strongest that fits 24 GB' },
];

export function recommendModel(vramGb) {
  const fits = MODELS.filter((m) => m.vram <= Number(vramGb));
  return fits.at(-1) ?? MODELS[0];
}

export function assetNames(tag, { platform, arch, gpu }) {
  const cpu = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'win32') {
    if (gpu === 'cuda') return [`llama-${tag}-bin-win-cuda-12.4-${cpu}.zip`, `cudart-llama-bin-win-cuda-12.4-${cpu}.zip`];
    if (gpu === 'cpu') return [`llama-${tag}-bin-win-cpu-${cpu}.zip`];
    return [`llama-${tag}-bin-win-vulkan-${cpu}.zip`];
  }
  if (platform === 'darwin') return [`llama-${tag}-bin-macos-${cpu}.tar.gz`];
  if (platform === 'linux') {
    if (gpu === 'cuda') return [`llama-${tag}-bin-ubuntu-cuda-12.8-${cpu}.tar.gz`, `cudart-llama-${tag}-bin-ubuntu-cuda-12.8-${cpu}.tar.gz`];
    if (gpu === 'vulkan') return [`llama-${tag}-bin-ubuntu-vulkan-${cpu}.tar.gz`];
    return [`llama-${tag}-bin-ubuntu-${cpu}.tar.gz`];
  }
  throw new Error(`no llama.cpp build for ${platform}`);
}

export function pickAssets(release, target) {
  const wanted = assetNames(release.tag_name, target);
  const assets = wanted.map((name) => (release.assets ?? []).find((a) => a.name === name) ?? null);
  const missing = wanted.filter((_, i) => !assets[i]);
  if (missing.length) throw new Error(`release ${release.tag_name} has no ${missing.join(', ')}`);
  return assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size, sha256: String(a.digest ?? '').replace(/^sha256:/, '') || null }));
}

export function exe(name, platform) {
  return platform === 'win32' ? `${name}.exe` : name;
}

const HOST_PORT = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9][a-z0-9.-]{0,62}):\d{2,5}$/i;

export function parseHelpers(text) {
  const list = String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((h) => !HOST_PORT.test(h));
  if (bad.length) throw new Error(`helpers must be host:port, e.g. 192.168.1.20:${HELPER_PORT} (bad: ${bad.join(', ')})`);
  return list;
}

export function isPrivateHost(host) {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) || host === 'localhost';
}

export function aliasFor(model) {
  const base = String(model ?? '').split(/[\\/]/).pop().replace(/\.gguf$/i, '').replace(/:.*$/, '').replace(/-GGUF$/i, '');
  return base || 'local';
}

const KV_TYPES = new Set(['f16', 'q8_0', 'q4_0']);

export const PROMPT_CACHE_MIB = 0;
export const SLEEP_IDLE_SECONDS = 300;

export function serverArgs({ model, helpers = [], port = SERVER_PORT, ctx = 16384, split = '', parallel = 2, kv = '', cacheRam = PROMPT_CACHE_MIB, sleepIdle = SLEEP_IDLE_SECONDS }) {
  if (!model) throw new Error('choose a model, e.g. --model ggml-org/gpt-oss-20b-GGUF');
  if (kv && !KV_TYPES.has(kv)) throw new Error(`--kv takes one of ${[...KV_TYPES].join(', ')}`);
  const source = /\.gguf$/i.test(model) ? ['-m', model] : ['-hf', model];
  const slots = Math.max(1, Math.floor(Number(parallel) || 1));
  return [...source, '-ngl', '99', '-c', String(ctx * slots), '-np', String(slots), ...(kv ? ['-fa', 'on', '-ctk', kv, '-ctv', kv] : []), '--cache-ram', String(cacheRam), ...(sleepIdle > 0 ? ['--sleep-idle-seconds', String(sleepIdle)] : []), '--host', '127.0.0.1', '--port', String(port), '-a', aliasFor(model), ...(helpers.length ? ['--rpc', helpers.join(',')] : []), ...(split ? ['-ts', split] : [])];
}

export function helperArgs({ host, port = HELPER_PORT, cache = true }) {
  if (!host) throw new Error('give the LAN address of this device, e.g. --host 192.168.1.20');
  if (!isPrivateHost(host)) throw new Error(`${host} is not a private LAN or Tailscale address; the RPC helper has no authentication, so it must never face the internet`);
  return ['-H', host, '-p', String(port), ...(cache ? ['-c'] : [])];
}

export function speedOf(reply) {
  const t = reply?.timings;
  if (!t) return null;
  return { promptTokens: t.prompt_n, prefillPerSecond: Math.round(t.prompt_per_second * 10) / 10, decodePerSecond: Math.round(t.predicted_per_second * 10) / 10 };
}

async function findFile(dir, name) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const hit = await findFile(full, name);
      if (hit) return hit;
    }
  }
  return null;
}

export class LlamaCppInstaller {
  constructor({ dir, fetchImpl = fetch, run, platform = process.platform, arch = process.arch, log = () => {} }) {
    this.dir = dir;
    this.fetchImpl = fetchImpl;
    this.run = run;
    this.platform = platform;
    this.arch = arch;
    this.log = log;
  }

  async release(tag = 'latest') {
    const res = await this.fetchImpl(tag === 'latest' ? `${RELEASES_API}/latest` : `${RELEASES_API}/tags/${encodeURIComponent(tag)}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'free-research-llm' } });
    if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
    const release = await res.json();
    if ((release.assets ?? []).length < 4) {
      const list = await (await this.fetchImpl(`${RELEASES_API}?per_page=5`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'free-research-llm' } })).json();
      return list.find((r) => (r.assets ?? []).length >= 4) ?? release;
    }
    return release;
  }

  async download(asset, target) {
    const res = await this.fetchImpl(asset.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download ${asset.name}: HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    const sha = createHash('sha256').update(body).digest('hex');
    if (asset.sha256 && sha !== asset.sha256) throw new Error(`${asset.name}: checksum mismatch (expected ${asset.sha256}, got ${sha})`);
    await fs.writeFile(target, body);
    return { sha, verified: Boolean(asset.sha256) };
  }

  async install({ gpu = GPU_KINDS[this.platform]?.[0] ?? 'cpu', tag = 'latest' } = {}) {
    if (!GPU_KINDS[this.platform]?.includes(gpu)) throw new Error(`gpu must be one of ${(GPU_KINDS[this.platform] ?? ['cpu']).join(', ')} on ${this.platform}`);
    const release = await this.release(tag);
    const assets = pickAssets(release, { platform: this.platform, arch: this.arch, gpu });
    const home = path.join(this.dir, `${release.tag_name}-${gpu}`);
    await fs.mkdir(home, { recursive: true });
    for (const asset of assets) {
      const file = path.join(home, asset.name);
      this.log(`downloading ${asset.name} (${Math.round(asset.size / 1048576)} MB)`);
      const { verified } = await this.download(asset, file);
      this.log(verified ? '  sha256 matches the release' : '  no checksum published for this file');
      const code = await this.run('tar', ['-xf', file, '-C', home]);
      if (code !== 0) throw new Error(`could not unpack ${asset.name} (tar exit ${code})`);
      await fs.rm(file, { force: true });
    }
    const server = await findFile(home, exe('llama-server', this.platform));
    const helper = await findFile(home, exe('ggml-rpc-server', this.platform));
    if (!server || !helper) throw new Error(`unpacked ${release.tag_name} but llama-server or ggml-rpc-server is missing`);
    if (this.platform !== 'win32') for (const f of [server, helper]) await fs.chmod(f, 0o755);
    const current = { tag: release.tag_name, gpu, server, helper, installedAt: new Date().toISOString() };
    await fs.writeFile(path.join(this.dir, 'current.json'), JSON.stringify(current, null, 1));
    return current;
  }

  async current() {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir, 'current.json'), 'utf8'));
    } catch {
      return null;
    }
  }
}
