export const SERVICE_LABEL = 'com.free-research-llm.app';
export const WINDOWS_TASK = 'FreeResearchLLM';
export const SYSTEMD_UNIT = 'free-research-llm.service';

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function launchAgentPlist({ nodePath, root, port = 4600, pathEnv = '' }) {
  const env = { HOST: '0.0.0.0', PORT: String(port), PATH: pathEnv, FRL_SUPERVISED: '1' };
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

export function accessLinks({ port = 4600, token = '', lan = [], tailscale = '', funnel = false }) {
  const withToken = (base) => (token ? `${base}/?token=${encodeURIComponent(token)}` : base);
  const name = tailscale.replace(/\.$/, '');
  return [
    { label: 'this Mac', url: `http://127.0.0.1:${port}` },
    ...lan.map((ip) => ({ label: 'same Wi-Fi (phone, other PC)', url: withToken(`http://${ip}:${port}`) })),
    ...(name && !funnel ? [{ label: 'anywhere, via Tailscale', url: withToken(`http://${name}:${port}`) }] : []),
    ...(name && funnel ? [{ label: 'anywhere, any device (HTTPS)', url: withToken(`https://${name}`) }] : []),
  ];
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function windowsServiceScript({ nodePath, root, port = 4600 }) {
  return [
    `$env:HOST = '0.0.0.0'`,
    `$env:PORT = '${Number(port)}'`,
    `$env:FRL_SUPERVISED = '1'`,
    `Set-Location -LiteralPath ${psQuote(root)}`,
    `New-Item -ItemType Directory -Force -Path (Join-Path ${psQuote(root)} 'data\\logs') | Out-Null`,
    'while ($true) {',
    `  & ${psQuote(nodePath)} (Join-Path ${psQuote(root)} 'src\\server.mjs') *>> (Join-Path ${psQuote(root)} 'data\\logs\\server.out')`,
    '  Start-Sleep -Seconds 5',
    '}',
    '',
  ].join('\r\n');
}

export function windowsTaskArgs(scriptPath) {
  return ['/Create', '/TN', WINDOWS_TASK, '/TR', `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}"`, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F'];
}

export function systemdUnit({ nodePath, root, user, port = 4600, credentials = [] }) {
  return `[Unit]
Description=Free Research LLM
After=network-online.target
Wants=network-online.target

[Service]
User=${user}
WorkingDirectory=${root}
Environment=HOST=127.0.0.1
Environment=PORT=${Number(port)}
Environment=FRL_SUPERVISED=1
Environment=FRL_BEHIND_PROXY=1
Environment=FRL_SECRET_STORE=systemd
ExecStart=${nodePath} ${root}/src/server.mjs
Restart=always
RestartSec=5
${credentials.map((name) => `LoadCredentialEncrypted=${name}:/etc/credstore.encrypted/${name}`).join('\n')}

[Install]
WantedBy=multi-user.target
`;
}
