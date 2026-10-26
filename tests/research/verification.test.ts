import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyVerification, fitsOf, fitsSignature, readVerification } from '../../src/research/verification.mjs';
import { candidateDeliverables } from '../../src/research/candidates.mjs';

const row = (url: string, tier: string) => ({ url, title: url, price: 5000, currency: 'EUR', plan: { tier } });
const table = { tiers: { fits: 3 }, keptCount: 3, kept: [row('a', 'fits'), row('b', 'fits'), row('c', 'fits'), row('d', 'trade-off')] };
const record = { at: '2026-10-26T18:00:00Z', results: [
  { url: 'a', verdict: 'confirmed', checks: [{ check: 'price on the page', status: 'confirmed', detail: 'page 5000, app 5000' }] },
  { url: 'b', verdict: 'refuted', checks: [{ check: 'sea within 20 km', status: 'refuted', detail: 'no coastline within 25 km' }, { check: 'location source', status: 'unconfirmed', detail: 'the app\'s point was used' }] },
] };

describe('external verification on the app side', () => {
  it('counts only plots the external verifier confirmed; refuted and unchecked ones never count (fail-closed)', () => {
    const out = applyVerification(table, record);
    expect(out.keptCount).toBe(1);
    expect(out.verification).toEqual({ at: '2026-10-26T18:00:00Z', fits: 3, confirmed: 1, refuted: 1, unconfirmed: 0, pending: 1 });
    expect(out.kept.find((r: { url: string }) => r.url === 'b').verified).toEqual({ verdict: 'refuted', failed: ['sea within 20 km: refuted (no coastline within 25 km)'], at: '2026-10-26T18:00:00Z' });
    expect(out.kept.find((r: { url: string }) => r.url === 'c').verified.verdict).toBe('pending');
    expect(out.kept.find((r: { url: string }) => r.url === 'd').verified).toBeUndefined();
    expect(candidateDeliverables(out).map((d: { url: string }) => d.url)).toEqual(['a']);
    expect(applyVerification(table, null).keptCount).toBe(0);
    expect(applyVerification({ kept: [] }, record)).toEqual({ kept: [] });
  });

  it('knows when the set of fits changed, so the verifier runs again only then', () => {
    expect(fitsOf(table)).toEqual(['a', 'b', 'c']);
    expect(fitsSignature(table)).toBe(fitsSignature({ kept: [...table.kept].reverse() }));
    expect(fitsSignature(table)).not.toBe(fitsSignature({ kept: table.kept.slice(1) }));
  });

  it('reads the verifier\'s record read-only and treats a missing or broken file as no verification', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frl-verif-'));
    await fs.writeFile(path.join(dir, 'p1.json'), JSON.stringify(record));
    await fs.writeFile(path.join(dir, 'p2.json'), '{broken');
    expect((await readVerification(dir, 'p1'))?.results).toHaveLength(2);
    expect(await readVerification(dir, 'p2')).toBeNull();
    expect(await readVerification(dir, 'missing')).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
