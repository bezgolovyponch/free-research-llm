import { describe, expect, it } from 'vitest';
import { acquireQualityLock, lockPid, qualityLockPath, releaseQualityLock, staleLock } from '../../scripts/quality-lock.mjs';

type FakeFs = {
  files: Map<string, string>;
  readFileSync: (file: string, encoding: string) => string;
  writeFileSync: (file: string, data: string, options?: { flag?: string }) => void;
  rmSync: (file: string) => void;
};

function fakeFs(seed: Record<string, string> = {}): FakeFs {
  const files = new Map(Object.entries(seed));
  return {
    files,
    readFileSync(file: string) {
      if (!files.has(file)) {
        const error = new Error('ENOENT') as Error & { code: string };
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file) as string;
    },
    writeFileSync(file: string, data: string, options?: { flag?: string }) {
      if (options?.flag === 'wx' && files.has(file)) {
        const error = new Error('EEXIST') as Error & { code: string };
        error.code = 'EEXIST';
        throw error;
      }
      files.set(file, data);
    },
    rmSync(file: string) {
      files.delete(file);
    },
  };
}

const LOCK = '/tmp/frl-quality.lock';

describe('quality lock file', () => {
  it('lives in the temp dir under a fixed name', () => {
    expect(qualityLockPath('/tmp')).toBe('/tmp/frl-quality.lock');
  });

  it('reads the pid out of the lock file', () => {
    expect(lockPid('4321\n')).toBe(4321);
    expect(lockPid('not a pid')).toBeNull();
  });

  it('calls a lock stale when its pid is no longer alive', () => {
    expect(staleLock('4321\n', () => false)).toBe(true);
    expect(staleLock('4321\n', () => true)).toBe(false);
    expect(staleLock('garbage', () => true)).toBe(true);
  });

  it('takes the lock and records its pid', () => {
    const fsImpl = fakeFs();
    const result = acquireQualityLock({ fs: fsImpl, file: LOCK, pid: 100, isAlive: () => true });
    expect(result).toMatchObject({ acquired: true, pid: 100 });
    expect(fsImpl.files.get(LOCK)).toBe('100\n');
  });

  it('waits for the running gate instead of failing', () => {
    const fsImpl = fakeFs({ [LOCK]: '100\n' });
    let slept = 0;
    const result = acquireQualityLock({
      fs: fsImpl,
      file: LOCK,
      pid: 200,
      isAlive: (pid: number) => pid === 100,
      sleep: () => {
        slept += 1;
        fsImpl.files.delete(LOCK);
      },
    });
    expect(slept).toBe(1);
    expect(result).toMatchObject({ acquired: true, pid: 200 });
    expect(fsImpl.files.get(LOCK)).toBe('200\n');
  });

  it('polls every 2 s while it waits', () => {
    const fsImpl = fakeFs({ [LOCK]: '100\n' });
    const waits: number[] = [];
    acquireQualityLock({
      fs: fsImpl,
      file: LOCK,
      pid: 200,
      isAlive: (pid: number) => pid === 100,
      pollMs: 2000,
      sleep: (ms: number) => {
        waits.push(ms);
        fsImpl.files.delete(LOCK);
      },
    });
    expect(waits).toEqual([2000]);
  });

  it('gives up after the wait limit and names the holder', () => {
    const fsImpl = fakeFs({ [LOCK]: '100\n' });
    let clock = 0;
    const result = acquireQualityLock({
      fs: fsImpl,
      file: LOCK,
      pid: 200,
      isAlive: (pid: number) => pid === 100,
      waitMs: 2000,
      now: () => (clock += 1000),
      sleep: () => {},
    });
    expect(result).toMatchObject({ acquired: false, holder: 100, waited: true });
  });

  it('removes a stale lock left by a dead gate and takes it over', () => {
    const fsImpl = fakeFs({ [LOCK]: '999\n' });
    const result = acquireQualityLock({ fs: fsImpl, file: LOCK, pid: 200, isAlive: () => false });
    expect(result).toMatchObject({ acquired: true, pid: 200 });
    expect(fsImpl.files.get(LOCK)).toBe('200\n');
  });

  it('releases only its own lock', () => {
    const fsImpl = fakeFs({ [LOCK]: '100\n' });
    expect(releaseQualityLock({ fs: fsImpl, file: LOCK, pid: 200 })).toBe(false);
    expect(fsImpl.files.get(LOCK)).toBe('100\n');
    expect(releaseQualityLock({ fs: fsImpl, file: LOCK, pid: 100 })).toBe(true);
    expect(fsImpl.files.has(LOCK)).toBe(false);
  });
});
