import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ShareBook, shareAllows, shareLinks } from '../src/share.mjs';

const dirs: string[] = [];

async function bookFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-share-'));
  dirs.push(dir);
  return path.join(dir, 'shares.json');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('ShareBook', () => {
  it('creates one stable link per research, survives a restart and stores no token on disk', async () => {
    const file = await bookFile();
    const book = await new ShareBook({ file, secret: 'access-secret' }).load();
    expect(book.status('a')).toEqual({ enabled: false, since: null, token: null });
    const on = await book.enable('a');
    expect(on.enabled).toBe(true);
    expect(on.token).toMatch(/^[\w-]{32}$/);
    expect((await book.enable('a')).token).toBe(on.token);
    expect(book.match(on.token)).toBe('a');
    expect(book.match('wrong')).toBeNull();
    expect(await fs.readFile(file, 'utf8')).not.toContain(on.token);
    const reloaded = await new ShareBook({ file, secret: 'access-secret' }).load();
    expect(reloaded.match(on.token)).toBe('a');
    expect((await new ShareBook({ file, secret: 'rotated' }).load()).match(on.token)).toBeNull();
  });

  it('turning a link off revokes it for good; sharing again makes a different link', async () => {
    const book = await new ShareBook({ file: await bookFile(), secret: 's' }).load();
    const first = (await book.enable('a')).token;
    const second = (await book.enable('b')).token;
    expect((await book.revoke('a')).enabled).toBe(false);
    expect(book.match(first)).toBeNull();
    expect(book.match(second)).toBe('b');
    const again = (await book.enable('a')).token;
    expect(again).not.toBe(first);
    expect(book.match(again)).toBe('a');
  });

  it('refuses to share while remote access is off', async () => {
    const book = await new ShareBook({ file: await bookFile(), secret: '' }).load();
    expect(book.available).toBe(false);
    await expect(book.enable('a')).rejects.toThrow(/remote access is off/);
    expect(book.match('anything')).toBeNull();
  });
});

describe('shareAllows', () => {
  const allows = (method: string, pathname: string) => shareAllows({ method, pathname, projectId: 'p1' });

  it('opens the page, its status and everything inside the shared research', () => {
    for (const [m, p] of [['GET', '/'], ['GET', '/vendor/xterm.js'], ['GET', '/api/status'], ['GET', '/api/whoami'], ['GET', '/api/projects'], ['GET', '/api/projects/p1'], ['GET', '/api/projects/p1/events'], ['POST', '/api/projects/p1/chat'], ['POST', '/api/projects/p1/run'], ['POST', '/api/projects/p1/nodes/D1/children'], ['GET', '/api/projects/p1/report.md'], ['PATCH', '/api/projects/p1']]) expect(allows(m, p), `${m} ${p}`).toBe(true);
  });

  it('keeps other researches, owner actions and the rest of the app closed', () => {
    for (const [m, p] of [['DELETE', '/api/projects/p1'], ['GET', '/api/projects/p1/share'], ['POST', '/api/projects/p1/share'], ['GET', '/api/projects/p2'], ['POST', '/api/projects/p10/run'], ['POST', '/api/projects'], ['GET', '/api/chat'], ['POST', '/api/chat'], ['GET', '/api/terminal'], ['GET', '/api/router'], ['POST', '/api/keys'], ['GET', '/api/access'], ['GET', '/api/history'], ['GET', '/api/logs/model-calls'], ['POST', '/api/app/restart'], ['POST', '/api/improve-all'], ['GET', '/api/changes'], ['POST', '/api/status']]) expect(allows(m, p), `${m} ${p}`).toBe(false);
  });
});

describe('shareLinks', () => {
  it('puts the share token in the query and the research in the hash for every address', () => {
    expect(shareLinks([{ label: 'same Wi-Fi (phone, other PC)', url: 'http://192.168.1.5:4600' }], { projectId: 'p1', token: 'tok' })).toEqual([{ label: 'same Wi-Fi (phone, other PC)', url: 'http://192.168.1.5:4600/?share=tok#p=p1' }]);
  });
});
