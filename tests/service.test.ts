import { describe, expect, it } from 'vitest';
import { SERVICE_LABEL, WINDOWS_TASK, accessLinks, lanAddresses, launchAgentPlist, systemdUnit, windowsServiceScript, windowsTaskArgs } from '../src/service.mjs';

describe('service', () => {
  it('writes a login service that starts the app with remote access and holds no secrets', () => {
    const plist = launchAgentPlist({ nodePath: '/opt/node', root: '/Users/m/frl & co', port: 4600, pathEnv: '/usr/bin' });
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain('<string>/Users/m/frl &amp; co/src/server.mjs</string>');
    expect(plist).toContain('<key>HOST</key><string>0.0.0.0</string>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('<key>FRL_SUPERVISED</key><string>1</string>');
    expect(plist).not.toMatch(/TOKEN|API_KEY/);
  });

  it('writes a hidden Windows logon task that restarts the app and holds no secrets', () => {
    const script = windowsServiceScript({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', root: "C:\\Users\\o'neil\\free-research-llm", port: 4600 });
    expect(script).toContain("$env:HOST = '0.0.0.0'");
    expect(script).toContain("Set-Location -LiteralPath 'C:\\Users\\o''neil\\free-research-llm'");
    expect(script).toContain('while ($true) {');
    expect(script).not.toMatch(/TOKEN|API_KEY/);
    const args = windowsTaskArgs('C:\\x\\data\\frl-service.ps1');
    expect(args.slice(0, 3)).toEqual(['/Create', '/TN', WINDOWS_TASK]);
    expect(args[4]).toBe('powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\\x\\data\\frl-service.ps1"');
    expect(args[4].length).toBeLessThan(262);
    expect(args).toContain('ONLOGON');
  });

  it('writes a systemd unit for a cloud server that reads encrypted credentials and trusts no proxy', () => {
    const unit = systemdUnit({ nodePath: '/usr/bin/node', root: '/home/me/free-research-llm', user: 'me', credentials: ['GROQ_API_KEY', 'FRL_ACCESS_TOKEN'] });
    expect(unit).toContain('Environment=FRL_BEHIND_PROXY=1');
    expect(unit).toContain('Environment=HOST=127.0.0.1');
    expect(unit).toContain('LoadCredentialEncrypted=GROQ_API_KEY:/etc/credstore.encrypted/GROQ_API_KEY');
    expect(unit).toContain('Restart=always');
    expect(unit).not.toMatch(/gsk_|=sk-/);
  });

  it('lists LAN addresses and builds token links for Wi-Fi and Tailscale', () => {
    const lan = lanAddresses({ en0: [{ family: 'IPv4', address: '192.168.1.5', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }], lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], awdl: [{ family: 'IPv4', address: '169.254.3.3', internal: false }] });
    expect(lan).toEqual(['192.168.1.5']);
    expect(accessLinks({ port: 4600, token: 'a+b', lan, tailscale: 'mac.tail1234.ts.net.' })).toEqual([
      { label: 'this Mac', url: 'http://127.0.0.1:4600' },
      { label: 'same Wi-Fi (phone, other PC)', url: 'http://192.168.1.5:4600/?token=a%2Bb' },
      { label: 'anywhere, via Tailscale', url: 'http://mac.tail1234.ts.net:4600/?token=a%2Bb' },
    ]);
    expect(accessLinks({ port: 4600, token: 't', tailscale: 'frl.tail1234.ts.net.', funnel: true }).at(-1)).toEqual({ label: 'anywhere, any device (HTTPS)', url: 'https://frl.tail1234.ts.net/?token=t' });
  });
});
