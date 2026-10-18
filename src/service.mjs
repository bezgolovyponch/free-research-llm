export const SERVICE_LABEL = 'com.free-research-llm.app';

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function launchAgentPlist({ nodePath, root, port = 4600, pathEnv = '' }) {
  const env = { HOST: '0.0.0.0', PORT: String(port), PATH: pathEnv };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(`${root}/src/server.mjs`)}</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(`${root}/data/logs/server.out`)}</string>
  <key>StandardErrorPath</key><string>${xml(`${root}/data/logs/server.out`)}</string>
</dict>
</plist>
`;
}

export function lanAddresses(interfaces) {
  return Object.values(interfaces).flat().filter((i) => i && i.family === 'IPv4' && !i.internal && !/^169\.254\./.test(i.address)).map((i) => i.address);
}

export function accessLinks({ port = 4600, token = '', lan = [], tailscale = '' }) {
  const withToken = (base) => (token ? `${base}/?token=${encodeURIComponent(token)}` : base);
  return [
    { label: 'this Mac', url: `http://127.0.0.1:${port}` },
    ...lan.map((ip) => ({ label: 'same Wi-Fi (phone, other PC)', url: withToken(`http://${ip}:${port}`) })),
    ...(tailscale ? [{ label: 'anywhere, via Tailscale', url: withToken(`http://${tailscale.replace(/\.$/, '')}:${port}`) }] : []),
  ];
}
