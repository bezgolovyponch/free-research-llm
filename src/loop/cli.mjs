#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { App, ROOT_DIR } from '../app.mjs';
import { KeychainSecrets } from '../secrets.mjs';
import { SelfImprover } from './improver.mjs';

const DEFAULT_TARGETS = [
  {
    id: 'cars-gap',
    template: 'car-arbitrage',
    question: 'Which used car models and age/mileage segments show a persistent price gap between Germany and Poland in 2026, and what is the net margin per car after transport, registration, Polish excise (3.1%/18.6%, HEV 1.55%/9.3%) and the VAT margin scheme?',
    constraints: { buyMarket: 'Germany', sellMarket: 'Poland' },
  },
  {
    id: 'cars-detector',
    template: 'car-arbitrage',
    question: 'How can a small reseller legally detect used car models whose resale value is rising (trend and model detector) from public listing data in Germany and Poland, and which data sources, exports or APIs permit automated access?',
    constraints: { buyMarket: 'Germany', sellMarket: 'Poland' },
  },
];

async function targets() {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT_DIR, 'loop', 'targets.json'), 'utf8'));
  } catch {
    await fs.mkdir(path.join(ROOT_DIR, 'loop'), { recursive: true });
    await fs.writeFile(path.join(ROOT_DIR, 'loop', 'targets.json'), JSON.stringify(DEFAULT_TARGETS, null, 2));
    return DEFAULT_TARGETS;
  }
}

await new KeychainSecrets().fillMissing(process.env);
process.env.FRL_PAID_CALL_LIMIT = '0';
const app = new App();
await app.refreshProviders();
if (!app.router.ready) {
  console.error('No free model provider is ready. Run ./keys.command first.');
  process.exit(1);
}
console.log(`[loop] free providers: ${app.status().route.deep.join(', ')} · Ctrl+C to stop`);
const improver = new SelfImprover({ root: ROOT_DIR, router: app.router, targets: await targets(), push: process.argv.includes('--push') });
const max = Number(process.argv.find((a) => a.startsWith('--iterations='))?.split('=')[1] ?? Infinity);
await improver.runForever({ maxIterations: max, pauseMs: Number(process.env.FRL_LOOP_PAUSE_MS ?? 60000) });
