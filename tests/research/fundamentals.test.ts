import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FUNDAMENTALS } from '../../src/research/fundamentals.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

describe('fundamentals registry', () => {
  it('lists F1 to F14 in order with unique ids', () => {
    const ids = FUNDAMENTALS.map((item) => item.id);
    expect(ids).toEqual(Array.from({ length: 14 }, (_, i) => `F${i + 1}`));
    expect(new Set(ids).size).toBe(14);
  });

  it('points at exports that exist', async () => {
    for (const item of FUNDAMENTALS) {
      expect(item.enforcedBy.length).toBeGreaterThan(0);
      for (const [modulePath, exportName] of item.enforcedBy) {
        const file = pathToFileURL(path.resolve(repo, modulePath)).href;
        const mod = await import(/* @vite-ignore */ file);
        expect(mod[exportName], `${item.id} ${modulePath} ${exportName}`).toBeDefined();
      }
    }
  });

  it('is part of the documents the App chat answers from', async () => {
    const { APP_DOCS } = await import('../../src/chat/docs.mjs');
    expect(APP_DOCS).toContain('FOUNDATIONS.md');
  });

  it('is listed in FOUNDATIONS.md', () => {
    const doc = fs.readFileSync(path.resolve(repo, 'FOUNDATIONS.md'), 'utf8');
    for (const item of FUNDAMENTALS) {
      expect(doc, item.id).toContain(`| ${item.id} |`);
    }
  });
});
