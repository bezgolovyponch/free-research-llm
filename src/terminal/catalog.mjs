export const CONSOLE_COMMANDS = [
  { id: 'status', group: 'App', label: 'Status', run: 'node src/frl.mjs status', what: 'is the app running, which models and search engines are connected' },
  { id: 'links', group: 'App', label: 'Links for other devices', run: 'node src/frl.mjs url', what: 'links for this computer, the same Wi-Fi and Tailscale, with the access token' },
  { id: 'restart', group: 'App', label: 'Restart app', run: 'node src/frl.mjs restart', what: 'save running work and restart the app (always-on service only)' },
  { id: 'logs', group: 'App', label: 'App log', run: 'node src/frl.mjs logs', what: 'last lines of the app log' },
  { id: 'install', group: 'Always on', label: 'Install always-on', run: 'node src/frl.mjs install', what: 'start the app at login and restart it if it stops (macOS, Windows, Linux)' },
  { id: 'uninstall', group: 'Always on', label: 'Remove always-on', run: 'node src/frl.mjs uninstall', what: 'remove the login service' },
  { id: 'funnel', group: 'Always on', label: 'Public HTTPS link', run: 'tailscale funnel --bg 4600', what: 'publish the app on your Tailscale HTTPS address so any device can open it with the token link' },
  { id: 'keys-setup', group: 'Keys', label: 'Add keys', run: 'node src/frl.mjs keys setup', what: 'paste free model and search keys; each is tested and saved in the system key store' },
  { id: 'keys-check', group: 'Keys', label: 'Check keys', run: 'node src/frl.mjs keys check', what: 'test every saved key and repair keys cut off while pasting' },
  { id: 'keys-list', group: 'Keys', label: 'List keys', run: 'node src/frl.mjs keys list', what: 'which keys are saved (masked)' },
  { id: 'keys-export', group: 'Keys', label: 'Export keys', run: 'node src/frl.mjs keys export', what: 'encrypted, passphrase-protected bundle of your keys for another computer' },
  { id: 'keys-import', group: 'Keys', label: 'Import keys', run: 'node src/frl.mjs keys import', what: 'paste a bundle from another computer' },
  { id: 'searxng', group: 'Keys', label: 'Start SearXNG search', run: 'node src/frl.mjs searxng', what: 'unlimited free web search in Docker (Docker Desktop must be running); saves its address' },
  { id: 'local-install', group: 'Local GPU', label: 'Install llama.cpp', run: 'node src/frl.mjs local install', what: 'download the official llama.cpp build for this computer (Vulkan on Windows), checksum-verified' },
  { id: 'local-models', group: 'Local GPU', label: 'Which model fits', run: 'node src/frl.mjs local models', what: 'models by GPU memory, with the start command' },
  { id: 'local-status', group: 'Local GPU', label: 'Local model status', run: 'node src/frl.mjs local status', what: 'is the local model server running' },
  { id: 'local-bench', group: 'Local GPU', label: 'Local speed test', run: 'node src/frl.mjs local bench', what: 'measure reading (prefill) and writing (decode) speed of the local model' },
  { id: 'update', group: 'Code', label: 'Update from GitHub', run: 'node src/frl.mjs update', what: 'pull the newest version and install it' },
  { id: 'quality', group: 'Code', label: 'Quality gate', run: 'npm run quality', what: 'run every check the app must pass before a change ships' },
  { id: 'claude', group: 'Code', label: 'Claude Code', run: 'claude', what: 'open Claude Code here to change the app (uses your Claude plan, not the free keys)' },
];

export function commandById(id) {
  return CONSOLE_COMMANDS.find((c) => c.id === id) ?? null;
}
