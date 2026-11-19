import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LlamaCppInstaller, MODELS, aliasFor, assetNames, helpCacheFile, helperArgs, isPrivateHost, listsFlag, nglFor, noMmapArgs, parseHelpers, pickAssets, recommendModel, serverArgs, serverHelp, speedOf } from '../../src/local/llamacpp.mjs';

const HELP_LOAD_MODE = [
  '-lm,   --load-mode MODE                 model loading mode (default: auto)',
  '                                        - auto: mmap, unless a device does not support it',
  '                                        - none: no special loading mode',
  '                                        - mmap: memory-map model (if mmap disabled, slower load but may reduce',
  '                                        pageouts if not using mlock)',
  '-ngl,  --gpu-layers, --n-gpu-layers N   max. number of layers to store in VRAM, either an exact number,',
  '',
].join('\n');
const HELP_NO_MMAP = [
  '--no-mmap                       do not memory-map model (slower load but may reduce pageouts if not using mlock)',
  '-ngl, --gpu-layers N            number of layers to store in VRAM',
  '',
].join('\n');
const HELP_NEITHER = [
  '-ngl,  --gpu-layers, --n-gpu-layers N   max. number of layers to store in VRAM',
  '                                        see --load-mode-x and --no-mmapping for details; use --load-mode',
  '',
].join('\n');

describe('llama.cpp on this computer', () => {
  it('picks the official build for Windows (Vulkan by default, CUDA with its runtime), macOS and Linux', () => {
    expect(assetNames('b11738', { platform: 'win32', arch: 'x64', gpu: 'vulkan' })).toEqual(['llama-b11738-bin-win-vulkan-x64.zip']);
    expect(assetNames('b11738', { platform: 'win32', arch: 'x64', gpu: 'cuda' })).toEqual(['llama-b11738-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip']);
    expect(assetNames('b11738', { platform: 'darwin', arch: 'arm64', gpu: 'metal' })).toEqual(['llama-b11738-bin-macos-arm64.tar.gz']);
    expect(assetNames('b11738', { platform: 'linux', arch: 'x64', gpu: 'cpu' })).toEqual(['llama-b11738-bin-ubuntu-x64.tar.gz']);
    const release = { tag_name: 'b1', assets: [{ name: 'llama-b1-bin-win-vulkan-x64.zip', browser_download_url: 'https://x/z', size: 9, digest: 'sha256:ab' }] };
    expect(pickAssets(release, { platform: 'win32', arch: 'x64', gpu: 'vulkan' })).toEqual([{ name: 'llama-b1-bin-win-vulkan-x64.zip', url: 'https://x/z', size: 9, sha256: 'ab' }]);
    expect(() => pickAssets(release, { platform: 'win32', arch: 'x64', gpu: 'cuda' })).toThrow(/has no llama-b1-bin-win-cuda/);
  });

  it('builds the server command: whole model on the GPU, localhost only, named after the model, helpers over RPC', () => {
    expect(serverArgs({ model: 'ggml-org/gpt-oss-20b-GGUF', helpers: ['192.168.1.20:50052'], vramMb: 48 * 1024 })).toEqual(['-hf', 'ggml-org/gpt-oss-20b-GGUF', '-ngl', '99', '-c', '32768', '-np', '2', '--cache-ram', '0', '--sleep-idle-seconds', '300', '--host', '127.0.0.1', '--port', '8090', '-a', 'gpt-oss-20b', '--rpc', '192.168.1.20:50052']);
    expect(serverArgs({ model: 'C:\\models\\Qwen3-14B-Q4_K_M.gguf', split: '3,1', vramMb: 48 * 1024 })).toEqual(expect.arrayContaining(['-m', 'C:\\models\\Qwen3-14B-Q4_K_M.gguf', '-a', 'Qwen3-14B-Q4_K_M', '-ts', '3,1']));
    expect(aliasFor('ggml-org/Qwen3-32B-GGUF:Q4_K_M')).toBe('Qwen3-32B');
    expect(() => serverArgs({})).toThrow(/choose a model/);
    expect(serverArgs({ model: 'ggml-org/Qwen3-4B-GGUF:Q4_K_M', ctx: 16384, parallel: 1, kv: 'q8_0', vramMb: 48 * 1024 })).toEqual(['-hf', 'ggml-org/Qwen3-4B-GGUF:Q4_K_M', '-ngl', '99', '-c', '16384', '-np', '1', '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '--cache-ram', '0', '--sleep-idle-seconds', '300', '--host', '127.0.0.1', '--port', '8090', '-a', 'Qwen3-4B']);
    expect(() => serverArgs({ model: 'x', kv: 'q2' })).toThrow(/--kv takes/);
    expect(parseHelpers(' 192.168.1.20:50052 , mac.local:50052')).toEqual(['192.168.1.20:50052', 'mac.local:50052']);
    expect(() => parseHelpers('192.168.1.20')).toThrow(/host:port/);
  });

  it('keeps a model on the CPU when its GPU cannot hold it and its KV cache, so the machine does not thrash', () => {
    expect(nglFor({ model: 'ggml-org/Qwen3-4B-GGUF:Q4_K_M', vramMb: 0, ctx: 16384 })).toBe(0);
    expect(nglFor({ model: 'ggml-org/Qwen3-4B-GGUF:Q4_K_M', vramMb: 4096, ctx: 16384 })).toBe(0);
    expect(nglFor({ model: 'ggml-org/Qwen3-4B-GGUF:Q4_K_M', vramMb: 8192, ctx: 4096 })).toBe(99);
    expect(nglFor({ model: 'ggml-org/gpt-oss-20b-GGUF', vramMb: 48 * 1024, ctx: 16384 })).toBe(99);
    expect(nglFor({ model: 'ggml-org/Qwen3-32B-GGUF:Q4_K_M', vramMb: 24 * 1024, ctx: 16384 })).toBe(0);
    expect(nglFor({ model: 'unknown-model', vramMb: 0 })).toBe(99);
    expect(serverArgs({ model: 'ggml-org/Qwen3-4B-GGUF:Q4_K_M', ctx: 16384, parallel: 1, kv: 'q8_0' })).toEqual(['-hf', 'ggml-org/Qwen3-4B-GGUF:Q4_K_M', '-ngl', '0', '-c', '16384', '-np', '1', '--cache-ram', '0', '--sleep-idle-seconds', '300', '--host', '127.0.0.1', '--port', '8090', '-a', 'Qwen3-4B']);
  });

  it('reads which no-mmap flag a build lists, from the head of a help line only, never from a description', () => {
    expect(listsFlag(HELP_LOAD_MODE, '--load-mode')).toBe(true);
    expect(listsFlag(HELP_LOAD_MODE, '--n-gpu-layers')).toBe(true);
    expect(listsFlag(HELP_LOAD_MODE, '--no-mmap')).toBe(false);
    expect(listsFlag(HELP_NEITHER, '--load-mode')).toBe(false);
    expect(listsFlag(HELP_NEITHER, '--no-mmap')).toBe(false);
    expect(noMmapArgs(HELP_LOAD_MODE)).toEqual(['--load-mode', 'none']);
    expect(noMmapArgs(HELP_NO_MMAP)).toEqual(['--no-mmap']);
    expect(noMmapArgs(`${HELP_NO_MMAP}${HELP_LOAD_MODE}`)).toEqual(['--load-mode', 'none']);
    expect(noMmapArgs(HELP_NEITHER)).toEqual([]);
    expect(noMmapArgs('')).toEqual([]);
    expect(noMmapArgs(undefined)).toEqual([]);
  });

  it('on Windows asks llama-server not to memory-map a model that lives entirely on the GPU, with the flag this build lists, and keeps mmap for a partial offload or another OS', () => {
    const full = { model: 'ggml-org/gpt-oss-20b-GGUF', ctx: 16384, parallel: 2, vramMb: 48 * 1024, help: HELP_LOAD_MODE };
    expect(serverArgs({ ...full, platform: 'win32' })).toEqual(['-hf', 'ggml-org/gpt-oss-20b-GGUF', '-ngl', '99', '-c', '32768', '-np', '2', '--load-mode', 'none', '--cache-ram', '0', '--sleep-idle-seconds', '300', '--host', '127.0.0.1', '--port', '8090', '-a', 'gpt-oss-20b']);
    expect(serverArgs({ ...full, kv: 'q8_0', platform: 'win32' })).toEqual(['-hf', 'ggml-org/gpt-oss-20b-GGUF', '-ngl', '99', '-c', '32768', '-np', '2', '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '--load-mode', 'none', '--cache-ram', '0', '--sleep-idle-seconds', '300', '--host', '127.0.0.1', '--port', '8090', '-a', 'gpt-oss-20b']);
    expect(serverArgs({ ...full, platform: 'win32', help: HELP_NO_MMAP })).toEqual(expect.arrayContaining(['-ngl', '99', '--no-mmap']));
    expect(serverArgs({ ...full, platform: 'win32', help: HELP_NEITHER })).toEqual(['-hf', 'ggml-org/gpt-oss-20b-GGUF', '-ngl', '99', '-c', '32768', '-np', '2', '--cache-ram', '0', '--sleep-idle-seconds', '300', '--host', '127.0.0.1', '--port', '8090', '-a', 'gpt-oss-20b']);
    expect(serverArgs({ ...full, platform: 'win32', help: '' })).not.toContain('--load-mode');
    expect(serverArgs({ ...full, platform: 'win32', vramMb: 8 * 1024 })).toEqual(['-hf', 'ggml-org/gpt-oss-20b-GGUF', '-ngl', '0', '-c', '32768', '-np', '2', '--cache-ram', '0', '--sleep-idle-seconds', '300', '--host', '127.0.0.1', '--port', '8090', '-a', 'gpt-oss-20b']);
    expect(serverArgs({ ...full, platform: 'linux' })).not.toContain('--load-mode');
    expect(serverArgs({ ...full, platform: 'darwin' })).not.toContain('--load-mode');
    expect(serverArgs({ ...full, platform: 'win32', model: 'D:\\llama-cache\\gpt-oss-20b-mxfp4.gguf', vramMb: 0 })).toEqual(expect.arrayContaining(['-m', 'D:\\llama-cache\\gpt-oss-20b-mxfp4.gguf', '-ngl', '99', '--load-mode', 'none']));
  });

  it('reads the build\'s --help once per binary and keeps it next to the install, rereading only when the binary changes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-llama-help-'));
    const server = path.join(dir, 'b12034-vulkan', 'llama-server.exe');
    await fs.mkdir(path.dirname(server), { recursive: true });
    await fs.writeFile(server, 'build one');
    const cacheFile = helpCacheFile(dir);
    expect(cacheFile).toBe(path.join(dir, 'server-help.json'));
    const calls: string[][] = [];
    const exec = async (command: string, args: string[]) => { calls.push([command, ...args]); return HELP_LOAD_MODE; };
    expect(await serverHelp({ server, cacheFile, exec })).toBe(HELP_LOAD_MODE);
    expect(await serverHelp({ server, cacheFile, exec })).toBe(HELP_LOAD_MODE);
    expect(calls).toEqual([[server, '--help']]);
    expect(JSON.parse(await fs.readFile(cacheFile, 'utf8'))).toMatchObject({ server, help: HELP_LOAD_MODE });
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(server, 'build two, a different size');
    expect(await serverHelp({ server, cacheFile, exec: async () => HELP_NO_MMAP })).toBe(HELP_NO_MMAP);
    expect(await serverHelp({ server, cacheFile, exec })).toBe(HELP_NO_MMAP);
    expect(calls).toHaveLength(1);
    await expect(serverHelp({ server: path.join(dir, 'missing'), cacheFile, exec })).rejects.toThrow();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lets a helper device listen only on a private or Tailscale address, because the RPC server has no password', () => {
    expect(helperArgs({ host: '192.168.1.20' })).toEqual(['-H', '192.168.1.20', '-p', '50052', '-c']);
    expect(helperArgs({ host: '100.101.1.2', port: 50060, cache: false })).toEqual(['-H', '100.101.1.2', '-p', '50060']);
    expect(() => helperArgs({ host: '0.0.0.0' })).toThrow(/never face the internet/);
    expect(() => helperArgs({ host: '8.8.8.8' })).toThrow(/not a private/);
    expect(() => helperArgs({})).toThrow(/LAN address/);
    expect([isPrivateHost('10.0.0.5'), isPrivateHost('172.20.1.1'), isPrivateHost('172.40.1.1')]).toEqual([true, true, false]);
  });

  it('recommends the largest listed model that fits the GPU memory, and reads speeds from the server reply', () => {
    expect(recommendModel(24).hf).toBe('ggml-org/Qwen3-32B-GGUF:Q4_K_M');
    expect(recommendModel(16).hf).toBe('ggml-org/gpt-oss-20b-GGUF');
    expect(recommendModel(1).hf).toBe(MODELS[0].hf);
    expect(speedOf({ timings: { prompt_n: 16, prompt_per_second: 22.83, predicted_per_second: 59.93 } })).toEqual({ promptTokens: 16, prefillPerSecond: 22.8, decodePerSecond: 59.9 });
    expect(speedOf({})).toBeNull();
  });

  it('installs: downloads the build, checks its sha256, unpacks it and records where the binaries are', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-llama-'));
    const body = Buffer.from('zip bytes');
    const sha = createHash('sha256').update(body).digest('hex');
    const release = { tag_name: 'b9', assets: ['a', 'b', 'c', 'llama-b9-bin-win-vulkan-x64.zip'].map((name) => ({ name, browser_download_url: `https://dl/${name}`, size: body.length, digest: `sha256:${sha}` })) };
    const fetchImpl = async (url: string) => (url.includes('/releases/') ? { ok: true, json: async () => release } : { ok: true, arrayBuffer: async () => body });
    const run = async (_c: string, args: string[]) => {
      const home = args[args.indexOf('-C') + 1];
      await fs.writeFile(path.join(home, 'llama-server.exe'), '');
      await fs.writeFile(path.join(home, 'ggml-rpc-server.exe'), '');
      return 0;
    };
    const installer = new LlamaCppInstaller({ dir, fetchImpl: fetchImpl as never, run, platform: 'win32', arch: 'x64' });
    expect(await installer.current()).toBeNull();
    const done = await installer.install();
    expect(done).toMatchObject({ tag: 'b9', gpu: 'vulkan', server: path.join(dir, 'b9-vulkan', 'llama-server.exe') });
    expect(await installer.current()).toMatchObject({ tag: 'b9' });
    await expect(installer.install({ gpu: 'metal' })).rejects.toThrow(/gpu must be one of vulkan, cuda, cpu/);
    const bad = new LlamaCppInstaller({ dir, fetchImpl: (async (url: string) => (url.includes('/releases/') ? { ok: true, json: async () => release } : { ok: true, arrayBuffer: async () => Buffer.from('tampered') })) as never, run, platform: 'win32', arch: 'x64' });
    await expect(bad.install()).rejects.toThrow(/checksum mismatch/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
