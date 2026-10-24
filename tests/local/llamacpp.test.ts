import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LlamaCppInstaller, MODELS, aliasFor, assetNames, helperArgs, isPrivateHost, parseHelpers, pickAssets, recommendModel, serverArgs, speedOf } from '../../src/local/llamacpp.mjs';

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
    expect(serverArgs({ model: 'ggml-org/gpt-oss-20b-GGUF', helpers: ['192.168.1.20:50052'] })).toEqual(['-hf', 'ggml-org/gpt-oss-20b-GGUF', '-ngl', '99', '-c', '32768', '-np', '2', '--cache-ram', '0', '--sleep-idle-seconds', '300', '--host', '127.0.0.1', '--port', '8090', '-a', 'gpt-oss-20b', '--rpc', '192.168.1.20:50052']);
    expect(serverArgs({ model: 'C:\\models\\Qwen3-14B-Q4_K_M.gguf', split: '3,1' })).toEqual(expect.arrayContaining(['-m', 'C:\\models\\Qwen3-14B-Q4_K_M.gguf', '-a', 'Qwen3-14B-Q4_K_M', '-ts', '3,1']));
    expect(aliasFor('ggml-org/Qwen3-32B-GGUF:Q4_K_M')).toBe('Qwen3-32B');
    expect(() => serverArgs({})).toThrow(/choose a model/);
    expect(serverArgs({ model: 'ggml-org/Qwen3-4B-GGUF:Q4_K_M', ctx: 16384, parallel: 1, kv: 'q8_0' })).toEqual(['-hf', 'ggml-org/Qwen3-4B-GGUF:Q4_K_M', '-ngl', '99', '-c', '16384', '-np', '1', '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '--cache-ram', '0', '--sleep-idle-seconds', '300', '--host', '127.0.0.1', '--port', '8090', '-a', 'Qwen3-4B']);
    expect(() => serverArgs({ model: 'x', kv: 'q2' })).toThrow(/--kv takes/);
    expect(parseHelpers(' 192.168.1.20:50052 , mac.local:50052')).toEqual(['192.168.1.20:50052', 'mac.local:50052']);
    expect(() => parseHelpers('192.168.1.20')).toThrow(/host:port/);
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
