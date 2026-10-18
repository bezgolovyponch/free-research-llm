import { describe, expect, it } from 'vitest';
import { SERVICE_LABEL, accessLinks, lanAddresses, launchAgentPlist } from '../src/service.mjs';

describe('service', () => {
  it('writes a login service that starts the app with remote access and holds no secrets', () => {
    const plist = launchAgentPlist({ nodePath: '/opt/node', root: '/Users/m/frl & co', port: 4600, pathEnv: '/usr/bin' });
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain('<string>/Users/m/frl &amp; co/src/server.mjs</string>');
    expect(plist).toContain('<key>HOST</key><string>0.0.0.0</string>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).not.toMatch(/TOKEN|API_KEY/);
  });

  it('lists LAN addresses and builds token links for Wi-Fi and Tailscale', () => {
    const lan = lanAddresses({ en0: [{ family: 'IPv4', address: '192.168.1.5', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }], lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], awdl: [{ family: 'IPv4', address: '169.254.3.3', internal: false }] });
    expect(lan).toEqual(['192.168.1.5']);
    expect(accessLinks({ port: 4600, token: 'a+b', lan, tailscale: 'mac.tail1234.ts.net.' })).toEqual([
      { label: 'this Mac', url: 'http://127.0.0.1:4600' },
      { label: 'same Wi-Fi (phone, other PC)', url: 'http://192.168.1.5:4600/?token=a%2Bb' },
      { label: 'anywhere, via Tailscale', url: 'http://mac.tail1234.ts.net:4600/?token=a%2Bb' },
    ]);
  });
});
