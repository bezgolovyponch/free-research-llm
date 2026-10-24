import { describe, expect, it } from 'vitest';
import { FIREWALL_RULE, PC_BIG_MODEL_MIN_MB, pcSetupCommand, pcSetupScript } from '../../src/local/pcsetup.mjs';

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
    expect(script).toContain("'--cache-ram', '0', '--sleep-idle-seconds', '300'");
    expect(script).toMatch(/found no usable graphics card/);
    expect(script.split('\r\n').length).toBeGreaterThan(15);
    expect(script).not.toMatch(/share=|token/i);
  });

  it('keeps the model server running after a restart, opens the firewall port and checks that it answers', () => {
    const lines = pcSetupScript().split('\r\n');
    expect(lines.every((l) => !l.includes('\n'))).toBe(true);
    expect(lines).toContain("$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'frl-llama.cmd'");
    expect(lines).toContain(`Set-Content -Path $startup -Encoding ASCII -Value @('@echo off', ('cd /d "{0}"' -f $server.DirectoryName), ('start "frl-llama" /min "{0}" {1}' -f $server.FullName, ($serverArgs -join ' ')))`);
    expect(lines).toContain('Start-Process -FilePath $server.FullName -ArgumentList $serverArgs -WorkingDirectory $server.DirectoryName -WindowStyle Minimized');
    expect(lines).toContain(`$rule = '${FIREWALL_RULE}'`);
    const firewall = lines.find((l) => l.startsWith('if ($admin)'))!;
    expect(firewall).toContain('New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort 8090 -Action Allow -Profile Private,Domain');
    expect(firewall).toContain('open PowerShell as administrator once and run');
    expect(lines.find((l) => l.startsWith('$public = '))).toContain("NetworkCategory -eq 'Public'");
    expect(lines.find((l) => l.startsWith('for ($i = 0; $i -lt 120'))).toContain("Invoke-RestMethod -Uri 'http://127.0.0.1:8090/v1/models'");
  });

  it('builds the one-line PowerShell command with the research link token', () => {
    expect(pcSetupCommand('http://192.168.5.25:4600', 'a b')).toBe('irm "http://192.168.5.25:4600/pc-setup.ps1?share=a%20b" | iex');
  });
});
