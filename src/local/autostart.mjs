import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function serveFile(root) {
  return path.join(root, 'data', 'llama', 'serve.json');
}

export async function rememberServe(root, { server, args, port }) {
  await fs.mkdir(path.dirname(serveFile(root)), { recursive: true });
  await fs.writeFile(serveFile(root), JSON.stringify({ server, args, port, savedAt: new Date().toISOString() }, null, 2));
}

export async function forgetServe(root) {
  await fs.rm(serveFile(root), { force: true });
}

export async function ensureLocalModel({ root, fetchImpl = fetch, spawnImpl = spawn }) {
  let plan;
  try {
    plan = JSON.parse(await fs.readFile(serveFile(root), 'utf8'));
  } catch {
    return { started: false, reason: 'no local model was set up' };
  }
  try {
    const res = await fetchImpl(`http://127.0.0.1:${plan.port}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) return { started: false, reason: 'already running' };
  } catch {
    plan.down = true;
  }
  const exists = await fs.access(plan.server).then(() => true, () => false);
  if (!exists) return { started: false, reason: `llama-server not found at ${plan.server}` };
  await fs.mkdir(path.join(root, 'data', 'logs'), { recursive: true });
  const out = await fs.open(path.join(root, 'data', 'logs', 'llama.out'), 'a');
  const child = spawnImpl(plan.server, plan.args, { detached: true, stdio: ['ignore', out.fd, out.fd] });
  child.unref?.();
  await out.close();
  return { started: true, pid: child.pid, port: plan.port };
}
