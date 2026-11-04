import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOCK_FILE_NAME = 'frl-quality.lock';
export const LOCK_WAIT_MS = 15 * 60 * 1000;
export const LOCK_POLL_MS = 2000;

export function qualityLockPath(tmpdir = os.tmpdir()) {
  return path.join(tmpdir, LOCK_FILE_NAME);
}

export function lockPid(content) {
  const pid = Number(String(content ?? '').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readLock(fsImpl, file) {
  try {
    return fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function staleLock(content, isAlive) {
  const pid = lockPid(content);
  if (pid === null) return true;
  return !isAlive(pid);
}

export function acquireQualityLock(options = {}) {
  const fsImpl = options.fs ?? fs;
  const file = options.file ?? qualityLockPath();
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? pidAlive;
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? LOCK_POLL_MS;
  const sleep = options.sleep ?? sleepSync;
  const now = options.now ?? (() => Date.now());
  const started = now();
  let holder = null;
  for (;;) {
    const content = readLock(fsImpl, file);
    if (content !== null) {
      const held = lockPid(content);
      if (held !== null && held !== pid && isAlive(held)) {
        holder = held;
        if (now() - started >= waitMs) return { acquired: false, file, holder, waited: true };
        sleep(pollMs);
        continue;
      }
      fsImpl.rmSync(file, { force: true });
    }
    try {
      fsImpl.writeFileSync(file, `${pid}\n`, { flag: 'wx' });
      return { acquired: true, file, pid };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (now() - started >= waitMs) return { acquired: false, file, holder, waited: true };
      sleep(pollMs);
    }
  }
}

export function releaseQualityLock(options = {}) {
  const fsImpl = options.fs ?? fs;
  const file = options.file ?? qualityLockPath();
  const pid = options.pid ?? process.pid;
  const content = readLock(fsImpl, file);
  if (content === null || lockPid(content) !== pid) return false;
  fsImpl.rmSync(file, { force: true });
  return true;
}
