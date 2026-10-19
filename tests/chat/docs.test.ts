import { describe, expect, it } from 'vitest';
import { DocsIndex, splitSections, words } from '../../src/chat/docs.mjs';

const FILES: Record<string, string> = {
  '/r/WINDOWS.md': '# Run on Windows\n\n## 1 Install Node.js\n\nDownload from https://nodejs.org/en/download and run:\n\n```powershell\nwinget install OpenJS.NodeJS.LTS\n# a comment\nnode src/frl.mjs start\n```\n',
  '/r/CLOUD.md': '# Cloud\n\n## Always on for free\n\nUse a Google Cloud e2-micro VM. Then `tailscale funnel --bg 4600`.\n',
};

describe('DocsIndex', () => {
  it('finds the section that answers a question, with its links and commands', async () => {
    const docs = await new DocsIndex({ root: '/r', files: ['WINDOWS.md', 'CLOUD.md', 'MISSING.md'], readFile: async (p: string) => {
      if (!(p in FILES)) throw new Error('missing');
      return FILES[p];
    } }).load();
    const hits = docs.search('how do I install it on a windows PC?');
    expect(hits[0]).toMatchObject({ file: 'WINDOWS.md', heading: '1 Install Node.js' });
    expect(docs.search('keep it always on in the cloud for free')[0].file).toBe('CLOUD.md');
    expect(docs.search('zzzz')).toEqual([]);
    expect(docs.urls()).toEqual(['https://nodejs.org/en/download']);
    expect(docs.commands()).toEqual(['winget install OpenJS.NodeJS.LTS', 'node src/frl.mjs start', 'tailscale funnel --bg 4600']);
  });

  it('splits on headings outside code fences and drops filler words', () => {
    expect(splitSections('A.md', '# T\ntext\n```\n# not a heading\n```\n## U\nmore').map((s) => s.heading)).toEqual(['T', 'U']);
    expect(words('How do I run it on the PC?')).toEqual(['run', 'pc']);
  });
});
