import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('methods gate', () => {
  it('methods.json exists and has M1-M16', async () => {
    const methodsPath = path.join(ROOT, 'src', 'research', 'methods.json');
    const content = await fs.readFile(methodsPath, 'utf8');
    const methods = JSON.parse(content);
    expect(methods.length).toBe(16);
    const ids = methods.map((m) => m.id);
    for (let i = 1; i <= 16; i++) {
      expect(ids).toContain(`M${i}`);
    }
  });

  it('every verified entry has a fixture with the quote (whitespace-normalised)', async () => {
    const methodsPath = path.join(ROOT, 'src', 'research', 'methods.json');
    const content = await fs.readFile(methodsPath, 'utf8');
    const methods = JSON.parse(content);
    const verified = methods.filter((m) => m.status === 'verified');

    function normalizeWhitespace(text) {
      return text.replace(/\s+/g, ' ').trim();
    }

    for (const method of verified) {
      const fixturePath = path.join(ROOT, 'tests', 'fixtures', 'methods', `${method.id}.txt`);
      const fixture = await fs.readFile(fixturePath, 'utf8');
      const normQuote = normalizeWhitespace(method.quote);
      const normFixture = normalizeWhitespace(fixture);
      expect(normFixture).toContain(normQuote);
    }
  });

  it('supporting entries have no fixture requirement', async () => {
    const methodsPath = path.join(ROOT, 'src', 'research', 'methods.json');
    const content = await fs.readFile(methodsPath, 'utf8');
    const methods = JSON.parse(content);
    const supporting = methods.filter((m) => m.status === 'supporting');
    expect(supporting.map((m) => m.id)).toEqual(['M4', 'M5']);
    for (const method of supporting) {
      expect(method.quote).toBe('not verified on the original text');
    }
  });
});