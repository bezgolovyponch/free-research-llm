import { describe, expect, it } from 'vitest';
import { PC_BIG_MODEL_MIN_MB, pcSetupCommand, pcSetupScript } from '../../src/local/pcsetup.mjs';

describe('pcSetupScript', () => {
  it('downloads the matching llama.cpp build, picks a model by graphics memory and serves it on the network', () => {
    const script = pcSetupScript();
    expect(script).toContain('llama-$tag-bin-win-cuda-12.4-x64.zip');
    expect(script).toContain('cudart-llama-bin-win-cuda-12.4-x64.zip');
    expect(script).toContain('llama-$tag-bin-win-vulkan-x64.zip');
    expect(script).toContain('https://github.com/ggml-org/llama.cpp/releases/download/$tag/$asset');
    expect(script).toContain(`$vramMB -ge ${PC_BIG_MODEL_MIN_MB}`);
    expect(script).toContain("'--host', '0.0.0.0', '--port', '8090'");
    expect(script).toContain("$tag = 'b11739'");
    expect(script).toContain('--list-devices');
    expect(script).toMatch(/found no usable graphics card/);
    expect(script.split('\r\n').length).toBeGreaterThan(15);
    expect(script).not.toMatch(/share=|token/i);
  });

  it('builds the one-line PowerShell command with the research link token', () => {
    expect(pcSetupCommand('http://192.168.5.25:4600', 'a b')).toBe('irm "http://192.168.5.25:4600/pc-setup.ps1?share=a%20b" | iex');
  });
});
