import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 4610;
const dataDir = process.env.FRL_E2E_DATA_DIR ?? path.join(os.tmpdir(), `frl-e2e-${process.pid}`);
process.env.FRL_E2E_DATA_DIR = dataDir;

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/setup.mjs',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'iPhone 14 (WebKit)', use: { ...devices['iPhone 14'] } },
    { name: 'Pixel 7 (Chromium)', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node src/server.mjs',
    url: `http://127.0.0.1:${PORT}/api/status`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), HOST: '127.0.0.1', FRL_DEMO: '1', FRL_KEYCHAIN: '0', FRL_POLLINATIONS: '0', FRL_WIKIPEDIA: '0', FRL_PROVIDER_ORDER: 'pollinations', FRL_DATA_DIR: dataDir },
  },
});
